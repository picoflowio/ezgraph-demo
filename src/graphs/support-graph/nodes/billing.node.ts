import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import { OrderBook, type Order, type OrderCharge } from "../backend/order-book.js";
import { GenReceipt } from "../gen-receipt.js";
import type {
  BillingDispute,
  SupportGraphStateType,
} from "../support-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  supportPrompt,
} from "../prompt/support-prompt.js";
import { EscalateNode } from "./escalate.node.js";
import { TriageNode } from "./triage.node.js";

type BillingNodeState = { dispute?: BillingDispute };
type BillingContext = {
  order: Order;
  duplicates: OrderCharge[];
  dispute?: BillingDispute;
  done: boolean;
};
type OpenDisputeInput = {
  chargeIds: string[];
  description: string;
  amountInDispute: number;
};
type EndBillingRequestInput = { done: boolean };

/**
 * Captures a charge dispute.
 *
 * This stage never issues a credit. It validates the charge IDs against the
 * order, recomputes the disputed amount from the ledger rather than trusting
 * the model's arithmetic, and hands the record to EscalateNode.
 */
export class BillingNode extends ConversationNode<
  SupportGraphStateType,
  BillingNodeState,
  BillingContext
> {
  getPrompt(state: SupportGraphStateType): string {
    const order = requireOrder(state);
    return `${supportPrompt.role}\n\n${fillPrompt(supportPrompt.billing, {
      ORDER: JSON.stringify({
        orderId: order.orderId,
        placedAt: order.placedAt,
        paymentMethod: `${order.paymentMethod.brand} ending ${order.paymentMethod.last4}`,
      }),
      CHARGES: JSON.stringify(order.charges),
      DUPLICATES: JSON.stringify(OrderBook.duplicateCharges(order)),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<OpenDisputeInput>
    | ToolDefinition<EndBillingRequestInput>
  )[] {
    return [
      {
        name: "open_dispute",
        description:
          "Record the disputed charges and open a billing escalation ticket.",
        schema: z.object({
          chargeIds: z
            .array(z.string().min(1))
            .min(1)
            .describe("chargeId values taken from the order ledger"),
          description: z
            .string()
            .min(1)
            .describe("What the customer reported, in one or two sentences"),
          amountInDispute: z
            .number()
            .describe("Summed amount of the disputed charges"),
        }),
      },
      {
        name: "end_billing_request",
        description: "Leave the billing stage and go back to the support agent.",
        schema: z.object({ done: z.boolean() }),
      },
    ];
  }

  @Tool("open_dispute")
  async openDispute(
    { chargeIds, description, amountInDispute }: OpenDisputeInput,
    context: BillingContext,
  ): Promise<ConversationToolResult> {
    const ledger = new Map(
      context.order.charges.map((charge) => [
        charge.chargeId.toUpperCase(),
        charge,
      ]),
    );
    const selected = [
      ...new Set(chargeIds.map((chargeId) => chargeId.trim().toUpperCase())),
    ];
    const unknown = selected.filter((chargeId) => !ledger.has(chargeId));
    if (unknown.length > 0) {
      return this.toolResult({
        accepted: false,
        error: `These charges are not on order ${context.order.orderId}: ${unknown.join(", ")}.`,
      });
    }
    // The ledger owns the arithmetic. A model-supplied total is only a hint.
    const ledgerAmount = round(
      selected.reduce(
        (total, chargeId) => total + (ledger.get(chargeId)?.amount ?? 0),
        0,
      ),
    );
    return this.toolResult({
      accepted: true,
      chargeIds: selected,
      amountInDispute: ledgerAmount,
      ...(round(amountInDispute) === ledgerAmount
        ? {}
        : {
            note: `The disputed total was corrected to ${GenReceipt.formatCurrency(ledgerAmount)} from the order ledger.`,
          }),
    })
      .withContext({
        dispute: {
          orderId: context.order.orderId,
          chargeIds: selected,
          description: description.trim(),
          amountInDispute: ledgerAmount,
        },
      })
      .haltAfterBatch();
  }

  @Tool("end_billing_request")
  async endBillingRequest(
    { done }: EndBillingRequestInput,
    _context: BillingContext,
  ): Promise<ConversationToolResult> {
    if (!done) return this.toolResult({ accepted: false });
    return this.toolResult({ accepted: true })
      .withContext({ done: true })
      .haltAfterBatch();
  }

  protected createContext(state: SupportGraphStateType): BillingContext {
    const order = requireOrder(state);
    return {
      order,
      duplicates: OrderBook.duplicateCharges(order),
      done: false,
    };
  }

  protected nextStep(
    _state: SupportGraphStateType,
    context: BillingContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<SupportGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.dispute) {
      // EscalateNode writes the ticket in this same turn, then the fixed edge
      // hands the reply back to the hub.
      return this.advance(TriageNode, conversation)
        .via(EscalateNode)
        .withState({ dispute: context.dispute })
        .withStateFor(EscalateNode, { dispute: context.dispute })
        .withHistory(
          "support-triage",
          new HumanMessage(
            "A billing escalation ticket was just opened. Report the ticket ID and category from Case, then ask what else the customer needs.",
          ),
        );
    }
    if (context.done) {
      return this.advance(TriageNode, conversation).withHistory(
        "support-triage",
        new HumanMessage(
          "The customer is finished with the billing question. Ask what else they need.",
        ),
      );
    }
    return this.stay(conversation);
  }
}

function requireOrder(state: SupportGraphStateType): Order {
  const verified = state.nodes.TriageNode?.order;
  const order = verified ? OrderBook.find(verified.orderId) : undefined;
  if (!order) {
    throw new Error("BillingNode requires a verified order from TriageNode.");
  }
  return order;
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}
