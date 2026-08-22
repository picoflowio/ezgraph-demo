import { END } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  SessionDocument,
  TerminateSessionNode,
  type GraphDefinition,
  type LlmGateway,
} from "ezgraph";
import { DemoGraphState, type DemoGraphStateType } from "./demo-graph.state.js";
import { AddressNode } from "./nodes/address.node.js";
import { Child1Node } from "./nodes/child1.node.js";
import { Child2Node } from "./nodes/child2.node.js";
import { DobNode } from "./nodes/dob.node.js";
import { FavoritesNode } from "./nodes/favorites.node.js";
import { FooLogicNode } from "./nodes/foo-logic.node.js";
import { GooLogicNode } from "./nodes/goo-logic.node.js";
import { InContextNode } from "./nodes/in-context.node.js";
import { NameNode } from "./nodes/name.node.js";
import { ManualConcurrentNode } from "./nodes/manual-concurrent.node.js";
import { ParallelNode } from "./nodes/parallel.node.js";
import { WeatherNode } from "./nodes/weather.node.js";

export class DemoGraph extends BaseGraph<DemoGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("google:gemini-3.1-flash-lite", {
        retries: 3,
        temperature: 0.2,
      }),
      endNode: GRAPH_END_NODE,
      maxAgentRounds: 8,
      historySpaces: [
        [WeatherNode, "default"],
        [FavoritesNode, "favorites"],
        [NameNode, "name"],
        [InContextNode, "isolated"],
        [DobNode, "dob"],
        [AddressNode, "address"],
        [TerminateSessionNode, "terminal"],
      ],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, DemoGraph.getGraphDefinition());
  }

  protected buildGraph() {
    const graph = this.createStateGraph(DemoGraphState);
    graph.nodes(
      WeatherNode,
      FooLogicNode,
      GooLogicNode,
      FavoritesNode,
      NameNode,
      InContextNode,
      ParallelNode,
      Child1Node,
      Child2Node,
      ManualConcurrentNode,
      DobNode,
      AddressNode,
      TerminateSessionNode,
    );

    // Register user-turn entries. START dispatches from persisted currentNode
    // and maps the terminal state to END.
    graph.registerTurns(
      WeatherNode,
      FavoritesNode,
      NameNode,
      InContextNode,
      DobNode,
      AddressNode,
      TerminateSessionNode,
    );

    // Conversation outcomes now carry their routing intent. Normal stay,
    // advance, quit, and finish outcomes route automatically; exceptional
    // same-invocation detours are declared with outcomeBuilder.via(...).
    graph.configAutoRoute();

    // addEdge() declares unconditional traversal for internal graph work:
    // worker pipelines, fan-out, joins, and terminal edges. It is separate
    // from outcome routing because these nodes do not choose a next stage.
    graph.addEdge(FooLogicNode, GooLogicNode);
    graph.addEdge(GooLogicNode, FavoritesNode);
    graph.addEdge(InContextNode, ParallelNode);
    graph.addEdge(ParallelNode, Child1Node);
    graph.addEdge(ParallelNode, Child2Node);
    graph.addEdge(Child1Node, DobNode);
    graph.addEdge(Child2Node, DobNode);
    graph.addEdge(ManualConcurrentNode, END);
    graph.addEdge(TerminateSessionNode, END);

    /*
     * Lower-level equivalent retained as documentation. These branchBy()
     * declarations show the explicit topology that autoRouteOutcomes() and
     * outcomeBuilder.via(...) replace. Do not enable them while automatic
     * outcome routing is active for the same source nodes.
     *
     * graph.branchBy(WeatherNode, {
     *   cases: [
     *     { when: FavoritesNode, routeTo: FooLogicNode },
     *     { when: TerminateSessionNode, routeTo: TerminateSessionNode },
     *   ],
     *   otherwise: END,
     * });
     * graph.branchBy(FavoritesNode, {
     *   cases: [
     *     { when: NameNode, routeTo: NameNode },
     *     { when: TerminateSessionNode, routeTo: TerminateSessionNode },
     *   ],
     *   otherwise: END,
     * });
     * graph.branchBy(NameNode, {
     *   cases: [
     *     { when: InContextNode, routeTo: InContextNode },
     *     { when: TerminateSessionNode, routeTo: TerminateSessionNode },
     *   ],
     *   otherwise: END,
     * });
     * graph.branchBy(DobNode, {
     *   cases: [
     *     { when: AddressNode, routeTo: AddressNode },
     *     { when: TerminateSessionNode, routeTo: TerminateSessionNode },
     *   ],
     *   otherwise: END,
     * });
     * graph.branchBy(AddressNode, {
     *   cases: [
     *     { when: TerminateSessionNode, routeTo: TerminateSessionNode },
     *     { when: GRAPH_END_NODE, routeTo: ManualConcurrentNode },
     *   ],
     *   otherwise: END,
     * });
     */

    return graph.compile();
  }

  protected async onRestoreSessionDoc(
    sessionDoc: SessionDocument<DemoGraphStateType>,
  ): Promise<SessionDocument<DemoGraphStateType> | null> {
    // Graph-owned policy. The framework default keeps the document; return
    // null here to start a new run for this session id (for example after
    // a long idle).
    return sessionDoc;
  }
}
