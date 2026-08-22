import { z } from "zod";
import {
  GraphNode,
  ModelCatalog,
  type GraphLlmConfigOverride,
  type GraphNodeUpdate,
} from "ezgraph";
import { OrderBook } from "../backend/order-book.js";
import { deterministicTurn } from "../deterministic-turn.js";
import type {
  BillingDispute,
  EscalationTicket,
  SupportGraphStateType,
} from "../support-graph.state.js";
import { supportPrompt } from "../prompt/support-prompt.js";
import { TriageNode } from "./triage.node.js";

const EscalationTicketDraft = z.object({
  category: z.enum([
    "duplicate_charge",
    "wrong_amount",
    "missing_refund",
    "payment_method",
    "other",
  ]),
  summary: z.string().min(1),
  customerImpact: z.enum(["low", "medium", "high"]),
  requestedRemedy: z.string().min(1),
  amountInDispute: z.number(),
});

type EscalateNodeState = {
  dispute?: BillingDispute;
  ticket?: EscalationTicket;
};

/**
 * The in-turn ticket writer.
 *
 * BillingNode routes here with `.via(EscalateNode)`, so this runs inside the
 * same user turn. It is the one node in this graph that uses
 * `llmGateway.structured()`: a single schema-validated model call, no tool
 * loop and no user-facing text. Token usage is reported through the outcome
 * builder so the graph's accounting stays complete.
 *
 * Its history space is the billing transcript, which is exactly the evidence
 * the ticket has to summarize.
 */
export class EscalateNode extends GraphNode<
  SupportGraphStateType,
  EscalateNodeState
> {
  getPrompt(_state: SupportGraphStateType): string {
    return supportPrompt.escalate;
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-4o", { retries: 3 });
  }

  async run(
    state: SupportGraphStateType,
  ): Promise<GraphNodeUpdate<SupportGraphStateType>> {
    const dispute = this.state(state).dispute;
    if (!dispute) {
      throw new Error("EscalateNode requires a captured dispute from BillingNode.");
    }
    const order = OrderBook.find(dispute.orderId);
    if (!order) {
      throw new Error(`EscalateNode cannot load order '${dispute.orderId}'.`);
    }

    const draft = await this.llmGateway.structured(
      EscalationTicketDraft,
      this.getPrompt(state),
      JSON.stringify({
        order: {
          orderId: order.orderId,
          placedAt: order.placedAt,
          paymentMethod: `${order.paymentMethod.brand} ending ${order.paymentMethod.last4}`,
          charges: order.charges,
        },
        dispute,
      }),
      "escalation_ticket",
      this.llmConfig(),
      this.history(state),
    );

    const ticket: EscalationTicket = {
      ...draft.value,
      // The ledger owns the disputed amount; the draft only describes it.
      amountInDispute: dispute.amountInDispute,
      ticketId: generateTicketId(),
      openedAt: new Date().toISOString(),
    };
    return this.resumeAt(TriageNode, deterministicTurn(draft.usage))
      .withState({ ticket })
      .withStateFor(TriageNode, {
        tickets: [...(state.nodes.TriageNode?.tickets ?? []), ticket],
      });
  }
}

function generateTicketId(): string {
  return `ESC-${Math.floor(10000 + Math.random() * 90000)}`;
}
