import { END } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  TerminateSessionNode,
  type GraphDefinition,
  type LlmGateway,
  type SessionDocument,
} from "@picoflow/ezgraph";
import {
  QuoteGraphState,
  type QuoteGraphStateType,
} from "./quote-graph.state.js";
import { CoverageNode } from "./nodes/coverage.node.js";
import { DriverNode } from "./nodes/driver.node.js";
import { HistoryNode } from "./nodes/history.node.js";
import { QuoteNode } from "./nodes/quote.node.js";
import { VehicleNode } from "./nodes/vehicle.node.js";

const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * Guided car-insurance quoting: driver, vehicle, history, coverage, and quote
 * stages. Collection runs on a small model (gpt-4o-mini); only the quote
 * presentation overrides to a stronger one (gpt-5.1).
 */
export class QuoteGraph extends BaseGraph<QuoteGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("openai:gpt-4o-mini", {
        retries: 3,
        temperature: 0.2,
      }),
      endNode: GRAPH_END_NODE,
      initialHistorySpace: "quote-intake",
      historySpaces: [
        [DriverNode, "quote-intake"],
        [VehicleNode, "quote-intake"],
        [HistoryNode, "quote-incidents"],
        [CoverageNode, "quote-intake"],
        [QuoteNode, "quote-present"],
        [TerminateSessionNode, "quote-terminal"],
      ],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, QuoteGraph.getGraphDefinition());
  }

  /** Idle quote sessions start over; rates are not held indefinitely. */
  protected override async onRestoreSessionDoc(
    sessionDoc: SessionDocument<QuoteGraphStateType>,
  ): Promise<SessionDocument<QuoteGraphStateType> | null> {
    if (this.idleMs(sessionDoc) >= readMs("QUOTE_GRAPH_IDLE_MS", DEFAULT_IDLE_MS)) {
      return null;
    }
    return sessionDoc;
  }

  protected buildGraph() {
    const graph = this.createStateGraph(QuoteGraphState);
    graph.registerTurnNodes(
      DriverNode,
      VehicleNode,
      HistoryNode,
      CoverageNode,
      QuoteNode,
      TerminateSessionNode,
    );
    graph.configAutoRoute();
    graph.addEdge(TerminateSessionNode, END);
    return graph.compile();
  }
}

function readMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
