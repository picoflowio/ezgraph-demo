import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  ModelCatalog,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphLlmConfigOverride,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import { PolicyEngine, type ReturnReason } from "../backend/policy-engine.js";
import type {
  ReturnRequest,
  SupportGraphStateType,
  VerifiedOrder,
} from "../support-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  supportPrompt,
} from "../prompt/support-prompt.js";
import { AdjudicateNode } from "./adjudicate.node.js";
import { ApprovalNode } from "./approval.node.js";
import { TriageNode } from "./triage.node.js";

type ReturnsNodeState = {
  returnedLineIds?: string[];
  lastDenial?: string[];
};
type ReturnsContext = {
  order: VerifiedOrder;
  returnedLineIds: string[];
  request?: ReturnRequest;
  done: boolean;
};
type RequestReturnInput = {
  lineIds: string[];
  reason: ReturnReason;
  note?: string | undefined;
};
type EndReturnRequestInput = { done: boolean };

/**
 * Collects which line items are coming back and why.
 *
 * This stage deliberately cannot decide anything. It validates that the model
 * selected real line items, then hands the request to AdjudicateNode, which
 * applies the policy and the money in the same turn.
 */
export class ReturnsNode extends ConversationNode<
  SupportGraphStateType,
  ReturnsNodeState,
  ReturnsContext
> {
  getPrompt(state: SupportGraphStateType): string {
    const local = this.state(state);
    const order = requireOrder(state);
    const returned = new Set(
      (local.returnedLineIds ?? []).map((lineId) => lineId.toUpperCase()),
    );
    return `${supportPrompt.role}\n\n${fillPrompt(supportPrompt.returns, {
      ORDER: JSON.stringify({
        ...order,
        lineItems: order.lineItems.filter(
          (item) => item.returnable && !returned.has(item.lineId.toUpperCase()),
        ),
      }),
      RETURN_POLICY: JSON.stringify({
        apparel: PolicyEngine.returnWindowDays("apparel"),
        footwear: PolicyEngine.returnWindowDays("footwear"),
        gear: PolicyEngine.returnWindowDays("gear"),
        electronics: PolicyEngine.returnWindowDays("electronics"),
      }),
      RETURNED: JSON.stringify(local.returnedLineIds ?? []),
      LAST_DENIAL: JSON.stringify(local.lastDenial ?? []),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<RequestReturnInput>
    | ToolDefinition<EndReturnRequestInput>
  )[] {
    return [
      {
        name: "request_return",
        description:
          "Submit the selected line items and one reason code for eligibility and refund adjudication.",
        schema: z.object({
          lineIds: z
            .array(z.string().min(1))
            .min(1)
            .describe("lineId values taken from the order"),
          reason: z.enum([
            "damaged",
            "wrong_item",
            "too_small",
            "too_large",
            "not_as_described",
            "no_longer_needed",
          ]),
          note: z.string().optional().describe("Short verbatim customer detail"),
        }),
      },
      {
        name: "end_return_request",
        description: "Leave the return stage and go back to the support agent.",
        schema: z.object({ done: z.boolean() }),
      },
    ];
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-5.1", {
      retries: 3,
      reasoningEffort: "low",
    });
  }

  @Tool("request_return")
  async requestReturn(
    { lineIds, reason, note }: RequestReturnInput,
    context: ReturnsContext,
  ): Promise<ConversationToolResult> {
    const known = new Set(
      context.order.lineItems.map((item) => item.lineId.toUpperCase()),
    );
    const selected = [
      ...new Set(lineIds.map((lineId) => lineId.trim().toUpperCase())),
    ];
    const unknown = selected.filter((lineId) => !known.has(lineId));
    if (unknown.length > 0) {
      return this.toolResult({
        accepted: false,
        error: `These line items are not on order ${context.order.orderId}: ${unknown.join(", ")}.`,
      });
    }
    const repeated = selected.filter((lineId) =>
      context.returnedLineIds
        .map((returned) => returned.toUpperCase())
        .includes(lineId),
    );
    if (repeated.length > 0) {
      return this.toolResult({
        accepted: false,
        error: `These line items were already returned during this conversation: ${repeated.join(", ")}.`,
      });
    }
    const trimmed = note?.trim();
    return this.toolResult({ accepted: true, lineIds: selected, reason })
      .withContext({
        request: {
          orderId: context.order.orderId,
          lineIds: selected,
          reason,
          ...(trimmed ? { note: trimmed } : {}),
        },
      })
      .haltAfterBatch();
  }

  @Tool("end_return_request")
  async endReturnRequest(
    { done }: EndReturnRequestInput,
    _context: ReturnsContext,
  ): Promise<ConversationToolResult> {
    if (!done) return this.toolResult({ accepted: false });
    return this.toolResult({ accepted: true })
      .withContext({ done: true })
      .haltAfterBatch();
  }

  protected createContext(state: SupportGraphStateType): ReturnsContext {
    return {
      order: requireOrder(state),
      returnedLineIds: this.state(state).returnedLineIds ?? [],
      done: false,
    };
  }

  protected nextStep(
    _state: SupportGraphStateType,
    context: ReturnsContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<SupportGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.request) {
      // ApprovalNode is the safe resume point while adjudication is unknown.
      // AdjudicateNode runs first in this same turn and replaces it with the
      // node its own decision selects.
      return this.advance(ApprovalNode, conversation)
        .via(AdjudicateNode)
        .withState({ lastDenial: [] })
        .withStateFor(AdjudicateNode, { request: context.request });
    }
    if (context.done) {
      return this.advance(TriageNode, conversation).withHistory(
        "support-triage",
        new HumanMessage(
          "The customer is finished with the return request. Ask what else they need.",
        ),
      );
    }
    return this.stay(conversation);
  }
}

function requireOrder(state: SupportGraphStateType): VerifiedOrder {
  const order = state.nodes.TriageNode?.order;
  if (!order) {
    throw new Error("ReturnsNode requires a verified order from TriageNode.");
  }
  return order;
}
