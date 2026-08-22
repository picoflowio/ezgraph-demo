import { END } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  TerminateSessionNode,
  type GraphDefinition,
  type LlmGateway,
} from "ezgraph";
import {
  HotelGraphState,
  type HotelGraphStateType,
} from "./hotel-graph.state.js";
import { CompareNode } from "./nodes/compare.node.js";
import { ExploreNode } from "./nodes/explore.node.js";
import { PresentNode } from "./nodes/present.node.js";

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
