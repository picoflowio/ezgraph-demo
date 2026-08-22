import { HumanMessage } from "@langchain/core/messages";
import { GraphNode, type GraphNodeUpdate } from "ezgraph";
import { OrderBook } from "../backend/order-book.js";
import {
  PolicyEngine,
  type Adjudication,
  type AdjudicationDecision,
} from "../backend/policy-engine.js";
import { deterministicTurn } from "../deterministic-turn.js";
import type {
  RefundRecord,
  ReturnRequest,
  SupportGraphStateType,
} from "../support-graph.state.js";
import { ApprovalNode } from "./approval.node.js";
import { ReturnsNode } from "./returns.node.js";
import { TriageNode } from "./triage.node.js";

type AdjudicateNodeState = {
  request?: ReturnRequest;
  decision?: AdjudicationDecision;
  adjudication?: Adjudication;
};

/**
 * The in-turn adjudicator.
 *
 * ReturnsNode routes here with `.via(AdjudicateNode)`, so this node runs
 * inside the same user turn, before any stage produces a reply. It calls no
 * model at all: eligibility and every amount come from PolicyEngine, and the
 * resulting decision drives an explicit `graph.branch()` whose route labels
 * are checked at compile time against `route()`.
 *
 * - `auto`   the refund is inside agent authority and is committed here.
 * - `review` the refund needs the customer's explicit confirmation first.
 * - `deny`   policy refuses the request; ReturnsNode explains why.
 */
export class AdjudicateNode extends GraphNode<
  SupportGraphStateType,
  AdjudicateNodeState
> {
  /** Never sent to a model. This node is deterministic by design. */
  getPrompt(_state: SupportGraphStateType): string {
    return "Deterministic return adjudication. No model turn is taken in this node.";
  }

  /** Compile-time source of truth for the branch labels in SupportGraph. */
  override route(state: SupportGraphStateType): AdjudicationDecision {
    return this.state(state).decision ?? "deny";
  }

  async run(
    state: SupportGraphStateType,
  ): Promise<GraphNodeUpdate<SupportGraphStateType>> {
    const request = this.state(state).request;
    if (!request) {
      throw new Error("AdjudicateNode requires a return request from ReturnsNode.");
    }
    const order = OrderBook.find(request.orderId);
    if (!order) {
      throw new Error(`AdjudicateNode cannot load order '${request.orderId}'.`);
    }

    const returnedLineIds = state.nodes.ReturnsNode?.returnedLineIds ?? [];
    const adjudication = PolicyEngine.adjudicate(
      order,
      request.lineIds,
      request.reason,
      returnedLineIds,
    );
    const turn = deterministicTurn();

    if (adjudication.decision === "deny") {
      return this.resumeAt(ReturnsNode, turn)
        .withState({ decision: "deny", adjudication })
        .withStateFor(ReturnsNode, { lastDenial: adjudication.reasons })
        .withHistory(
          "support-returns",
          new HumanMessage(
            "The return request was refused by policy. Explain every reason in LastDenial plainly and offer what is still available.",
          ),
        );
    }

    const quote = adjudication.quote;
    if (!quote) {
      throw new Error(
        `AdjudicateNode produced a '${adjudication.decision}' decision without a refund quote.`,
      );
    }

    if (adjudication.decision === "review") {
      return this.resumeAt(ApprovalNode, turn)
        .withState({ decision: "review", adjudication })
        .withStateFor(ApprovalNode, {
          pending: { request, quote, reasons: adjudication.reasons },
        })
        .withHistory(
          "support-approval",
          new HumanMessage(
            "Present the pending refund breakdown and ask the customer to confirm or decline it.",
          ),
        );
    }

    // Inside agent authority: commit the refund here and report it at the hub.
    const refund: RefundRecord = {
      rma: generateRma(),
      orderId: order.orderId,
      lineIds: request.lineIds,
      netRefund: quote.netRefund,
      refundTarget: quote.refundTarget,
      authority: "agent",
    };
    return this.resumeAt(TriageNode, turn)
      .withState({ decision: "auto", adjudication })
      .withStateFor(TriageNode, {
        refunds: [...(state.nodes.TriageNode?.refunds ?? []), refund],
      })
      .withStateFor(ReturnsNode, {
        returnedLineIds: [...returnedLineIds, ...request.lineIds],
      })
      .withHistory(
        "support-triage",
        new HumanMessage(
          "A refund was just issued. Report the RMA number and net refund from Case, then ask what else the customer needs.",
        ),
      );
  }
}

function generateRma(): string {
  return `RMA-${Math.floor(100000 + Math.random() * 900000)}`;
}
