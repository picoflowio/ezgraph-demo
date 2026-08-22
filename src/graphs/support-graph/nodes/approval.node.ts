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
import { GenReceipt } from "../gen-receipt.js";
import type {
  PendingRefund,
  RefundRecord,
  SupportGraphStateType,
} from "../support-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  supportPrompt,
} from "../prompt/support-prompt.js";
import { ReturnsNode } from "./returns.node.js";
import { TriageNode } from "./triage.node.js";

type ApprovalNodeState = {
  pending?: PendingRefund | undefined;
  decidedAt?: string;
};
type ApprovalContext = {
  pending: PendingRefund;
  confirmed: boolean;
  declined: boolean;
};
type ConfirmRefundInput = { confirmed: boolean };
type DeclineRefundInput = { declined: boolean };

/**
 * The human-in-the-loop gate.
 *
 * A refund that exceeds agent authority or carries a deduction is held here as
 * pending state. `stay()` ends the invocation and the persisted `currentNode`
 * brings the next request straight back to this node, so the irreversible
 * action waits indefinitely for a person without a checkpointer, an interrupt,
 * or a resume protocol. Only an unambiguous confirmation commits it.
 */
export class ApprovalNode extends ConversationNode<
  SupportGraphStateType,
  ApprovalNodeState,
  ApprovalContext
> {
  getPrompt(state: SupportGraphStateType): string {
    const pending = requirePending(state, this.state(state).pending);
    return `${supportPrompt.role}\n\n${fillPrompt(supportPrompt.approval, {
      PENDING: JSON.stringify({
        orderId: pending.request.orderId,
        lineIds: pending.request.lineIds,
        reason: pending.request.reason,
        reasons: pending.reasons,
      }),
      BREAKDOWN: GenReceipt.quoteTable(pending.quote),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<ConfirmRefundInput>
    | ToolDefinition<DeclineRefundInput>
  )[] {
    return [
      {
        name: "confirm_refund",
        description:
          "Commit the pending refund. Call this only after an unambiguous customer approval of this exact amount.",
        schema: z.object({ confirmed: z.boolean() }),
      },
      {
        name: "decline_refund",
        description:
          "Abandon the pending refund and return to the return stage.",
        schema: z.object({ declined: z.boolean() }),
      },
    ];
  }

  /** The gate that commits money gets the strongest model in the graph. */
  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-5.1", {
      retries: 3,
      reasoningEffort: "low",
    });
  }

  @Tool("confirm_refund")
  async confirmRefund(
    { confirmed }: ConfirmRefundInput,
    _context: ApprovalContext,
  ): Promise<ConversationToolResult> {
    if (!confirmed) {
      return this.toolResult({
        accepted: false,
        error: "Only an explicit confirmation commits this refund.",
      });
    }
    return this.toolResult({ accepted: true })
      .withContext({ confirmed: true })
      .haltAfterBatch();
  }

  @Tool("decline_refund")
  async declineRefund(
    { declined }: DeclineRefundInput,
    _context: ApprovalContext,
  ): Promise<ConversationToolResult> {
    if (!declined) return this.toolResult({ accepted: false });
    return this.toolResult({ accepted: true })
      .withContext({ declined: true })
      .haltAfterBatch();
  }

  protected createContext(state: SupportGraphStateType): ApprovalContext {
    return {
      pending: requirePending(state, this.state(state).pending),
      confirmed: false,
      declined: false,
    };
  }

  protected nextStep(
    state: SupportGraphStateType,
    context: ApprovalContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<SupportGraphStateType> {
    // Quitting leaves the gate closed. The pending action is never committed
    // by silence, only by an explicit confirmation.
    if (conversation.quitRequested) return this.quit(conversation);

    if (context.confirmed) {
      const { request, quote } = context.pending;
      const refund: RefundRecord = {
        rma: generateRma(),
        orderId: request.orderId,
        lineIds: request.lineIds,
        netRefund: quote.netRefund,
        refundTarget: quote.refundTarget,
        authority: "customer_confirmed",
      };
      return this.advance(TriageNode, conversation)
        .withState({ pending: undefined, decidedAt: new Date().toISOString() })
        .withStateFor(TriageNode, {
          refunds: [...(state.nodes.TriageNode?.refunds ?? []), refund],
        })
        .withStateFor(ReturnsNode, {
          returnedLineIds: [
            ...(state.nodes.ReturnsNode?.returnedLineIds ?? []),
            ...request.lineIds,
          ],
        })
        .withHistory(
          "support-triage",
          new HumanMessage(
            "The customer confirmed the refund and it was issued. Report the RMA number and net refund from Case, then ask what else they need.",
          ),
        );
    }

    if (context.declined) {
      return this.advance(ReturnsNode, conversation)
        .withState({ pending: undefined, decidedAt: new Date().toISOString() })
        .withHistory(
          "support-returns",
          new HumanMessage(
            "The customer declined the deducted refund. Do not resubmit the same request. Offer another eligible item or end the return request.",
          ),
        );
    }

    return this.stay(conversation);
  }
}

function requirePending(
  _state: SupportGraphStateType,
  pending: PendingRefund | undefined,
): PendingRefund {
  if (!pending) {
    throw new Error("ApprovalNode requires a pending refund from AdjudicateNode.");
  }
  return pending;
}

function generateRma(): string {
  return `RMA-${Math.floor(100000 + Math.random() * 900000)}`;
}
