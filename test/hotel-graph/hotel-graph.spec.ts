import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  createSessionLogs,
  modelExecution,
  withSessionLogs,
  type GraphLlmConfig,
  type LlmGateway,
  type LlmGatewayTool,
  type LlmGatewayToolCall,
  type ModelResult,
  type SessionDocument,
} from "ezgraph";
import { HotelGraph } from "../../src/graphs/hotel-graph/hotel-graph.js";
import type { HotelGraphStateType } from "../../src/graphs/hotel-graph/hotel-graph.state.js";

const criteria = {
  currentDate: "2027-07-15T00:00:00.000Z",
  amenities: ["freeWiFi", "freeParking"],
  roomType: ["one bed", "two beds", "suite"],
  cAmenities: ["freeWiFi", "freeParking"],
  cRoomType: ["two beds"],
  cPriceRange: { min: null, max: 700 },
  cDistance: { cityCenter: null, airport: null },
  cDate: { start: "2027-08-01", end: "2027-08-08" },
  cDateArray: [
    "2027-08-01",
    "2027-08-02",
    "2027-08-03",
    "2027-08-04",
    "2027-08-05",
    "2027-08-06",
    "2027-08-07",
    "2027-08-08",
  ],
  hotelFound: [],
};

const selectedHotels = [
  "Hampton Inn Portland-Airport",
  "Hampton Inn Portland/Clackamas",
  "Hampton Inn Sherwood Portland",
];

describe("HotelGraph", () => {
  it("searches, compares, resumes booking, and completes a booking", async () => {
    const graph = new HotelGraph(new HotelScriptedGateway());

    let state = await invoke(graph, undefined, "search with these criteria");
    assert.equal(state.currentNode, "PresentNode");
    assert.match(state.response, /hotel choices/i);
    assert.equal(state.nodes.PresentNode?.hotelFound?.length, 9);
    assert.deepEqual(
      state.nodes.PresentNode?.hotelFound
        ?.slice(0, 2)
        .map(({ hotelName }) => hotelName),
      ["Hampton Inn & Suites Portland Tigard", "Hampton Inn Portland-Airport"],
    );

    state = await invoke(graph, state, "compare hotels 2, 5, and 8 on price");
    assert.equal(state.currentNode, "CompareNode");
    assert.match(state.response, /Hampton Inn Portland-Airport/);
    assert.match(state.response, /Hampton Inn Portland\/Clackamas/);
    assert.match(state.response, /Hampton Inn Sherwood Portland/);
    assert.match(state.response, /2027-08-01/);
    assert.deepEqual(state.nodes.CompareNode?.selectedHotels, selectedHotels);

    state = await invoke(graph, state, "resume booking");
    assert.equal(state.currentNode, "PresentNode");
    assert.match(state.response, /hotel choices/i);

    state = await invoke(graph, state, "8");
    assert.equal(state.completed, true);
    assert.equal(state.currentNode, "end");
    assert.equal(
      state.nodes.PresentNode?.hotel,
      "Hampton Inn Sherwood Portland",
    );
    assert.match(state.response, /confirmation number is \d{6}/i);
  });
});

describe("HotelGraph tool arguments", () => {
  it("rejects a malformed criteria payload and lets the model retry", async () => {
    const gateway = new MalformedCriteriaGateway();
    const graph = new HotelGraph(gateway);
    const logs = createSessionLogs();

    const state = await withSessionLogs(logs, () =>
      invoke(graph, undefined, "search with these criteria"),
    );

    assert.equal(gateway.captureAttempts, 2);
    assert.equal(state.currentNode, "PresentNode");
    assert.equal(state.nodes.PresentNode?.hotelFound?.length, 9);
    assert.equal(logs.warnings.length, 1);
    assert.equal(logs.warnings[0]?.node, "ExploreNode");
    assert.equal(logs.warnings[0]?.tool, "capture_choices");
    assert.match(String(logs.warnings[0]?.tool_call), /^json: /);
  });
});

describe("HotelGraph empty model responses", () => {
  it("answers a safety-blocked turn instead of nudging or failing", async () => {
    const gateway = new BlockedGateway("SAFETY");
    const graph = new HotelGraph(gateway);
    const logs = createSessionLogs();

    const state = await withSessionLogs(logs, () =>
      invoke(graph, undefined, "something the provider refuses"),
    );

    assert.equal(gateway.agentCalls, 1, "a blocked turn must not be retried");
    assert.equal(state.currentNode, "ExploreNode");
    assert.match(state.response, /can't help with that request/i);
    assert.equal(logs.warnings.length, 1);
    assert.match(
      String(logs.warnings[0]?.empty_model_response),
      /category=blocked provider=SAFETY/,
    );
    assert.equal(logs.warnings[0]?.retried, false);
  });

  it("still fails a turn the node does not claim", async () => {
    const graph = new HotelGraph(new BlockedGateway("MAX_TOKENS"));

    await assert.rejects(
      withSessionLogs(createSessionLogs(), () =>
        invoke(graph, undefined, "plan a very long itinerary"),
      ),
      /empty response \(category=truncated/,
    );
  });
});

describe("HotelGraph session policy", () => {
  it("keeps a reservation session that is still inside the idle window", async () => {
    const graph = new HotelGraph(new HotelScriptedGateway());
    const restored = await graph.restoreSessionDoc(hotelSession(60_000));
    assert.ok(restored);
    assert.equal(restored.graph.currentNode, "PresentNode");
  });

  it("starts a new run after the hotel idle window", async () => {
    const graph = new HotelGraph(new HotelScriptedGateway());
    assert.equal(await graph.restoreSessionDoc(hotelSession(45 * 60_000)), null);
  });
});

function hotelSession(
  idleMs: number,
): SessionDocument<HotelGraphStateType> {
  const modifiedAt = new Date(Date.now() - idleMs).toISOString();
  return {
    version: 16,
    revision: 0,
    id: "hotel-policy-session",
    status: "in_progress",
    tokens: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      tool_input_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
    },
    errors: [],
    warnings: [],
    createdAt: modifiedAt,
    modifiedAt,
    graph: {
      id: "HotelGraph",
      schemaVersion: 1,
      currentNode: "PresentNode",
      config: {},
      histories: {},
      model: {
        name: "openai:gpt-4o",
        family: "chat",
        params: { retries: 3 },
      },
      nodes: {},
    },
  };
}

async function invoke(
  graph: HotelGraph,
  state: HotelGraphStateType | undefined,
  input: string,
): Promise<HotelGraphStateType> {
  return graph.graph.invoke({
    ...graph.prepareInput(state, new HumanMessage(input)),
    inputConsumed: false,
    response: "",
  });
}

class HotelScriptedGateway implements LlmGateway {
  async structured<T extends Record<string, unknown>>(): Promise<
    ModelResult<T>
  > {
    throw new Error("Hotel test does not use structured generation.");
  }

  async generate(): Promise<ModelResult<string>> {
    throw new Error("Hotel test does not use simple generation.");
  }

  async respond(): Promise<ModelResult<string>> {
    throw new Error("Hotel test does not use response generation.");
  }

  async toolCall(): Promise<ModelResult<LlmGatewayToolCall | undefined>> {
    throw new Error("Hotel test does not use standalone tool calls.");
  }

  async agent(
    _systemPrompt: string,
    history: readonly BaseMessage[],
    tools: readonly LlmGatewayTool[],
    config?: GraphLlmConfig,
  ): Promise<ModelResult<AIMessage>> {
    const activeConfig = config ?? HotelGraph.getGraphDefinition().llmConfig;
    const input = latestHumanText(history);
    const names = new Set(tools.map(({ name }) => name));

    if (names.has("capture_choices")) {
      return result(
        toolCall("capture", "capture_choices", {
          json: JSON.stringify(criteria),
        }),
        activeConfig,
      );
    }
    if (names.has("generate_comparison")) {
      if (/resume booking/i.test(input)) {
        return result(
          toolCall("resume", "resume_booking", { isResumed: true }),
          activeConfig,
        );
      }
      return result(
        toolCall("compare", "generate_comparison", {
          hotels: selectedHotels,
          feature: "price",
        }),
        activeConfig,
      );
    }
    if (names.has("chosen_hotel")) {
      if (/compare hotels/i.test(input)) {
        return result(
          toolCall("go-compare", "go_compare", {
            hotelsToCompare: selectedHotels,
          }),
          activeConfig,
        );
      }
      if (input.trim() === "8") {
        return result(
          toolCall("book", "chosen_hotel", {
            hotelName: "Hampton Inn Sherwood Portland",
          }),
          activeConfig,
        );
      }
      return result(
        new AIMessage(
          "Here are your current hotel choices. You can book, compare, or search again.",
        ),
        activeConfig,
      );
    }
    throw new Error(`Unexpected hotel test stage for input '${input}'.`);
  }
}

/** Sends an unparseable criteria payload once before submitting valid criteria. */
class MalformedCriteriaGateway extends HotelScriptedGateway {
  captureAttempts = 0;

  override async agent(
    systemPrompt: string,
    history: readonly BaseMessage[],
    tools: readonly LlmGatewayTool[],
    config?: GraphLlmConfig,
  ): Promise<ModelResult<AIMessage>> {
    if (tools.some(({ name }) => name === "capture_choices")) {
      this.captureAttempts += 1;
      if (this.captureAttempts === 1) {
        return result(
          toolCall("capture-bad", "capture_choices", { json: '{"cDate":' }),
          config ?? HotelGraph.getGraphDefinition().llmConfig,
        );
      }
    }
    return super.agent(systemPrompt, history, tools, config);
  }
}

/** Returns an empty candidate carrying the provider's own reason for it. */
class BlockedGateway extends HotelScriptedGateway {
  agentCalls = 0;

  constructor(private readonly finishReason: string) {
    super();
  }

  override async agent(
    _systemPrompt: string,
    _history: readonly BaseMessage[],
    _tools: readonly LlmGatewayTool[],
    config?: GraphLlmConfig,
  ): Promise<ModelResult<AIMessage>> {
    this.agentCalls += 1;
    return result(
      new AIMessage({
        content: "",
        response_metadata: { finish_reason: this.finishReason },
      }),
      config ?? HotelGraph.getGraphDefinition().llmConfig,
    );
  }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id, name, args, type: "tool_call" }],
  });
}

function result<T>(value: T, config: GraphLlmConfig): ModelResult<T> {
  return {
    value,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      tool_input_tokens: 0,
      cached_input_tokens: 0,
      total_tokens: 0,
    },
    execution: modelExecution(config),
  };
}

function latestHumanText(history: readonly BaseMessage[]): string {
  const message = [...history]
    .reverse()
    .find((candidate) => HumanMessage.isInstance(candidate));
  return message && typeof message.content === "string" ? message.content : "";
}
