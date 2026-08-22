import { END } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  TerminateSessionNode,
  type GraphDefinition,
  type LlmGateway,
  type SessionDocument,
} from "ezgraph";
import {
  SupportGraphState,
  type SupportGraphNodes,
  type SupportGraphStateType,
} from "./support-graph.state.js";
import { AdjudicateNode } from "./nodes/adjudicate.node.js";
import { ApprovalNode } from "./nodes/approval.node.js";
import { BillingNode } from "./nodes/billing.node.js";
import { EscalateNode } from "./nodes/escalate.node.js";
import { ReturnsNode } from "./nodes/returns.node.js";
import { TriageNode } from "./nodes/triage.node.js";

const DEFAULT_IDLE_MS = 30 * 60_000;
const DEFAULT_APPROVAL_HOLD_MS = 10 * 60_000;
const APPROVAL_HISTORY_SPACE = "support-approval";

/**
 * Northwind Outfitters post-purchase support.
 *
 * A hub-and-spoke topology rather than a wizard: TriageNode owns customer
 * identity and the case record, specialists handle one department each, and
 * every specialist returns to the hub. Two worker nodes run inside a turn -
 * AdjudicateNode decides refunds deterministically and drives an explicit
 * `branch()`, and EscalateNode writes a schema-validated ticket.
 */
export class SupportGraph extends BaseGraph<SupportGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("openai:gpt-4o", { retries: 3 }),
      endNode: GRAPH_END_NODE,
      initialHistorySpace: "support-triage",
      historySpaces: [
        [TriageNode, "support-triage"],
        [ReturnsNode, "support-returns"],
        // The adjudicator reads and annotates the return transcript.
        [AdjudicateNode, "support-returns"],
        [ApprovalNode, APPROVAL_HISTORY_SPACE],
        [BillingNode, "support-billing"],
        // The ticket writer summarizes exactly the billing transcript.
        [EscalateNode, "support-billing"],
        [TerminateSessionNode, "support-terminal"],
      ],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, SupportGraph.getGraphDefinition());
  }

  /**
   * The support-specific session policy.
   *
   * A support case is not a chat session, so it gets its own idle window.
   * More importantly, an unanswered irreversible action must not wait forever:
   * a refund gate held past its hold window is released, its stale
   * confirmation transcript is dropped, and the customer resumes at the hub
   * rather than mid-approval.
   */
  protected override async onRestoreSessionDoc(
    sessionDoc: SessionDocument<SupportGraphStateType>,
  ): Promise<SessionDocument<SupportGraphStateType> | null> {
    const idleMs = this.idleMs(sessionDoc);
    if (idleMs >= readMs("SUPPORT_GRAPH_IDLE_MS", DEFAULT_IDLE_MS)) return null;

    const holdingApproval =
      sessionDoc.graph.currentNode === ApprovalNode.name &&
      idleMs >= readMs("SUPPORT_GRAPH_APPROVAL_HOLD_MS", DEFAULT_APPROVAL_HOLD_MS);
    if (!holdingApproval) return sessionDoc;

    const released: SupportGraphNodes["ApprovalNode"] = {
      ...sessionDoc.graph.nodes?.ApprovalNode,
      pending: undefined,
    };
    return {
      ...sessionDoc,
      graph: {
        ...sessionDoc.graph,
        currentNode: TriageNode.name,
        nodes: { ...sessionDoc.graph.nodes, ApprovalNode: released },
        histories: {
          ...sessionDoc.graph.histories,
          [APPROVAL_HISTORY_SPACE]: [],
        },
      },
    };
  }

  protected buildGraph() {
    const graph = this.createStateGraph(SupportGraphState);
    // Worker nodes run inside a turn and never receive a user message.
    graph.nodes(AdjudicateNode, EscalateNode);
    graph.registerTurnNodes(
      TriageNode,
      ReturnsNode,
      BillingNode,
      ApprovalNode,
      TerminateSessionNode,
    );
    graph.configAutoRoute();
    // The only explicit branch in this graph. Its labels are checked at
    // compile time against AdjudicateNode.route().
    graph.branch(AdjudicateNode, {
      auto: TriageNode,
      review: ApprovalNode,
      deny: ReturnsNode,
    });
    graph.addEdge(EscalateNode, TriageNode);
    graph.addEdge(TerminateSessionNode, END);
    return graph.compile();
  }
}

function readMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
