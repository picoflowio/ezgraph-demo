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
  HotelGraphState,
  type HotelGraphStateType,
} from "./hotel-graph.state.js";
import { CompareNode } from "./nodes/compare.node.js";
import { ExploreNode } from "./nodes/explore.node.js";
import { PresentNode } from "./nodes/present.node.js";

const DEFAULT_IDLE_MS = 30 * 60_000;

/** Portland Hilton search, comparison, and booking workflow ported from HotelFlow. */
export class HotelGraph extends BaseGraph<HotelGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("openai:gpt-4o", { retries: 3 }),
      endNode: GRAPH_END_NODE,
      initialHistorySpace: "hotel-explore",
      historySpaces: [
        [ExploreNode, "hotel-explore"],
        [PresentNode, "hotel-present"],
        [CompareNode, "hotel-compare"],
        [TerminateSessionNode, "hotel-terminal"],
      ],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, HotelGraph.getGraphDefinition());
  }

  /** Idle reservation chats start over; booking state is not kept indefinitely. */
  protected override async onRestoreSessionDoc(
    sessionDoc: SessionDocument<HotelGraphStateType>,
  ): Promise<SessionDocument<HotelGraphStateType> | null> {
    if (this.idleMs(sessionDoc) >= readMs("HOTEL_GRAPH_IDLE_MS", DEFAULT_IDLE_MS)) {
      return null;
    }
    return sessionDoc;
  }

  protected buildGraph() {
    const graph = this.createStateGraph(HotelGraphState);
    graph.registerTurnNodes(
      ExploreNode,
      PresentNode,
      CompareNode,
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
