import { END } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  TerminateSessionNode,
  type DecisionErrorContext,
  type GraphDefinition,
  type GraphNodeResponse,
  type LlmGateway,
} from "@picoflow/ezgraph";
import { AmenityNode } from "./nodes/amenity.node.js";
import { BudgetNode } from "./nodes/budget.node.js";
import { CriteriaReadinessDecisionNode } from "./nodes/criteria-readiness-decision.node.js";
import { DateRangeNode } from "./nodes/date-range.node.js";
import { DistanceNode } from "./nodes/distance.node.js";
import { PresentNode } from "./nodes/present.node.js";
import { PresentationDecisionNode } from "./nodes/presentation-decision.node.js";
import { RoomTypeNode } from "./nodes/room-type.node.js";
import { RouterDecisionNode } from "./nodes/router-decision.node.js";
import { SearchHotelsNode } from "./nodes/search-hotels.node.js";
import {
  DecisionHotelGraphState,
  type DecisionHotelGraphStateType,
} from "./decision-hotel-graph.state.js";
import {
  criteriaFallback,
  presentationFallback,
  routerFallback,
} from "./decision-fallbacks.js";
import { CriteriaHelper } from "./criteria-helper.js";

CriteriaHelper.registerCriteriaNodes({
  dates: DateRangeNode,
  budget: BudgetNode,
  room_type: RoomTypeNode,
  amenities: AmenityNode,
  distance: DistanceNode,
});

export class DecisionHotelGraph extends BaseGraph<DecisionHotelGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("openai:gpt-4o", {
        retries: 2,
        temperature: 0,
      }),
      decisionConfig: {
        provider: "typesafe",
        model: "jev-latest",
        timeoutMs: 15_000,
        maxRetries: 2,
      },
      endNode: GRAPH_END_NODE,
      llmTimeoutMs: 60_000,
      initialHistorySpace: "hotel-intake",
      historySpaces: [
        [RouterDecisionNode, "hotel-intake"],
        [DateRangeNode, "hotel-intake"],
        [BudgetNode, "hotel-intake"],
        [RoomTypeNode, "hotel-intake"],
        [AmenityNode, "hotel-intake"],
        [DistanceNode, "hotel-intake"],
        [CriteriaReadinessDecisionNode, "hotel-intake"],
        [PresentNode, "hotel-present"],
        [PresentationDecisionNode, "hotel-present"],
        [TerminateSessionNode, "hotel-terminal"],
      ],
    };
  }
  constructor(gateway: LlmGateway) {
    super(gateway, DecisionHotelGraph.getGraphDefinition());
  }

  protected buildGraph() {
    const graph = this.createStateGraph(DecisionHotelGraphState);
    graph.registerTurnNodes(
      RouterDecisionNode,
      DateRangeNode,
      BudgetNode,
      RoomTypeNode,
      AmenityNode,
      DistanceNode,
      CriteriaReadinessDecisionNode,
      SearchHotelsNode,
      PresentNode,
      PresentationDecisionNode,
      TerminateSessionNode,
    );
    graph.addEdge(TerminateSessionNode, END);
    return graph.compile();
  }

  protected override onDecisionError(
    context: DecisionErrorContext<DecisionHotelGraphStateType>,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    if (context.nodeId === RouterDecisionNode.id())
      return routerFallback(context.state);
    if (context.nodeId === CriteriaReadinessDecisionNode.id())
      return criteriaFallback(context.state);
    if (context.nodeId === PresentationDecisionNode.id())
      return presentationFallback(context.state);
    throw context.error;
  }
}
