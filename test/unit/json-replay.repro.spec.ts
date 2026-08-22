import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BaseGraph,
  GRAPH_END_NODE,
  GraphEngine,
  GraphNode,
  GraphState,
  ModelCatalog,
  SessionManager,
  type GraphDefinition,
  type GraphNodeUpdate,
  type LlmGateway,
} from "ezgraph";

type ReplayStateType = GraphState;

class EmitJsonNode extends GraphNode<ReplayStateType> {
  getPrompt(): string {
    return "unused";
  }

  override async run(): Promise<GraphNodeUpdate<ReplayStateType>> {
    return this.complete('{"vendor_name":"ACME Inc"}');
  }
}

class JsonReplayGraph extends BaseGraph<ReplayStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("scripted:scripted-model", { retries: 0 }),
      endNode: GRAPH_END_NODE,
      requiresUserMessage: false,
      responseMode: "json",
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, JsonReplayGraph.getGraphDefinition());
  }

  protected buildGraph() {
    const graph = this.createStateGraph(GraphState);
    graph.nodes(EmitJsonNode);
    graph.registerTurns(EmitJsonNode);
    return graph;
  }
}

describe("json-mode completed session replay", () => {
  it("shows what a second request against a finished session returns", async () => {
    const engine = new GraphEngine({
      sessionManager: new SessionManager(),
      llmGatewayFactory: () => ({}) as LlmGateway,
      graphs: [JsonReplayGraph],
    });
    const sessionId = "json-replay-session";

    const first = await engine.run({
      graphName: "JsonReplayGraph",
      sessionId,
    });
    console.log("FIRST", first.status, JSON.stringify(first.body));
    const afterFirst = await engine.getSession(sessionId);
    console.log("FIRST STATUS", afterFirst?.status, afterFirst?.revision);

    const second = await engine.run({
      graphName: "JsonReplayGraph",
      sessionId,
    });
    console.log("SECOND", second.status, JSON.stringify(second.body));
    const afterSecond = await engine.getSession(sessionId);
    console.log(
      "SECOND STATUS",
      afterSecond?.status,
      afterSecond?.revision,
      JSON.stringify(afterSecond?.errors),
    );

    assert.ok(first);
  });
});
