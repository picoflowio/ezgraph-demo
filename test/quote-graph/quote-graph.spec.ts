import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  modelExecution,
  type GraphLlmConfig,
  type LlmGateway,
  type LlmGatewayTool,
  type LlmGatewayToolCall,
  type ModelResult,
  type SessionDocument,
} from "ezgraph";
import {
  RatingEngine,
  validateCoverageSelection,
  type RatingSubject,
} from "../../src/graphs/quote-graph/backend/rating-engine.js";
import { VehicleCatalog } from "../../src/graphs/quote-graph/backend/vehicle-catalog.js";
import { QuoteGraph } from "../../src/graphs/quote-graph/quote-graph.js";
import type {
  CoverageSelection,
  QuoteGraphStateType,
} from "../../src/graphs/quote-graph/quote-graph.state.js";

process.env.QUOTE_GRAPH_CURRENT_DATE = "2027-06-01T00:00:00.000Z";
const QUOTE_DATE = new Date("2027-06-01T00:00:00.000Z");

const subject: RatingSubject = {
  driver: {
    fullName: "Jamie Rivera",
    dateOfBirth: "1993-04-12",
    licenseState: "OR",
    licenseStatus: "valid",
    yearsLicensed: 10,
  },
  vehicle: VehicleCatalog.fetch("2019-toyota-camry-se")!,
  use: {
    vehicleId: "2019-toyota-camry-se",
    ownership: "finance",
    annualMileage: 12000,
    parking: "driveway",
  },
  history: {
    currentlyInsured: true,
    coverageLapse: false,
    incidents: [{ type: "violation", date: "2026-03" }],
  },
};

const selectedCoverage: CoverageSelection = {
  liability: "standard",
  collisionDeductible: 500,
  comprehensiveDeductible: 500,
  extras: ["rental"],
  startDate: "2027-06-15",
};

describe("RatingEngine", () => {
  it("computes a deterministic risk factor and premium", () => {
    const factor = RatingEngine.riskFactor(subject, QUOTE_DATE);
    // 1.0 (age 34) × 1.06 (risk group 2) × 1.15 (one violation) × 0.95 (insured)
    assert.ok(Math.abs(factor - 1.15805) < 1e-9);
    assert.equal(
      RatingEngine.monthlyPremium(subject, selectedCoverage, QUOTE_DATE),
      140.43,
    );
  });

  it("orders the tiers saver < selected < shield", () => {
    const tiers = RatingEngine.quoteTiers(subject, selectedCoverage, QUOTE_DATE);
    assert.deepEqual(
      tiers.map(({ tier }) => tier),
      ["saver", "selected", "shield"],
    );
    assert.ok(tiers[0]!.monthlyPremium < tiers[1]!.monthlyPremium);
    assert.ok(tiers[1]!.monthlyPremium < tiers[2]!.monthlyPremium);
  });

  it("rejects liability-only coverage on a financed vehicle", () => {
    const error = validateCoverageSelection(
      { ...selectedCoverage, collisionDeductible: null, comprehensiveDeductible: null },
      "finance",
      QUOTE_DATE,
    );
    assert.match(String(error), /lender/i);
  });
});

describe("QuoteGraph", () => {
  it("collects driver, vehicle, history, and coverage, then quotes, adjusts, and accepts", async () => {
    const graph = new QuoteGraph(new QuoteScriptedGateway());

    let state = await invoke(
      graph,
      undefined,
      "I need a quote for my car. I'm Jamie Rivera, born April 12 1993, licensed in Oregon for 10 years, valid license.",
    );
    assert.equal(state.currentNode, "VehicleNode");
    assert.equal(state.nodes.DriverNode?.driver?.fullName, "Jamie Rivera");
    assert.match(state.response, /vehicle/i);

    state = await invoke(graph, state, "I drive a 2019 Toyota Camry.");
    assert.equal(state.currentNode, "VehicleNode");
    assert.match(state.response, /LE, SE, and XSE/);
    assert.equal(state.nodes.VehicleNode?.resolvedVehicleId, undefined);

    state = await invoke(
      graph,
      state,
      "It's the SE. I finance it, drive about 12000 miles a year, and park in the driveway.",
    );
    assert.equal(state.currentNode, "HistoryNode");
    assert.deepEqual(state.nodes.VehicleNode?.vehicle, subject.use);
    assert.match(state.response, /accidents|insured/i);

    state = await invoke(
      graph,
      state,
      "I'm currently insured with no lapse. One speeding ticket in March 2026.",
    );
    assert.equal(state.currentNode, "CoverageNode");
    assert.deepEqual(state.nodes.HistoryNode?.history, subject.history);
    assert.match(state.response, /coverage/i);

    state = await invoke(
      graph,
      state,
      "Standard liability, but liability only — no deductibles. Start June 15.",
    );
    assert.equal(state.currentNode, "CoverageNode");
    assert.match(state.response, /lender/i);
    assert.equal(state.nodes.CoverageNode?.coverage, undefined);

    state = await invoke(
      graph,
      state,
      "Fine — $500 deductibles on both, plus rental reimbursement.",
    );
    assert.equal(state.currentNode, "QuoteNode");
    assert.deepEqual(state.nodes.CoverageNode?.coverage, selectedCoverage);
    assert.deepEqual(
      state.nodes.QuoteNode?.tiers,
      RatingEngine.quoteTiers(subject, selectedCoverage, QUOTE_DATE),
    );
    assert.match(state.response, /quote options/i);

    state = await invoke(
      graph,
      state,
      "What if I raise both deductibles to $1000?",
    );
    const adjustedCoverage: CoverageSelection = {
      ...selectedCoverage,
      collisionDeductible: 1000,
      comprehensiveDeductible: 1000,
    };
    const adjustedTiers = RatingEngine.quoteTiers(
      subject,
      adjustedCoverage,
      QUOTE_DATE,
    );
    assert.equal(state.currentNode, "QuoteNode");
    assert.deepEqual(state.nodes.CoverageNode?.coverage, adjustedCoverage);
    assert.deepEqual(state.nodes.QuoteNode?.tiers, adjustedTiers);
    assert.match(
      state.response,
      new RegExp(`\\$${adjustedTiers[1]!.monthlyPremium.toFixed(2).replace(".", "\\.")}/mo`),
    );

    state = await invoke(graph, state, "Let's accept the selected option.");
    assert.equal(state.completed, true);
    assert.equal(state.currentNode, "end");
    assert.equal(state.nodes.QuoteNode?.acceptedTier, "selected");
    assert.match(String(state.nodes.QuoteNode?.referenceNumber), /^QT-\d{6}$/);
    assert.match(state.response, /QT-\d{6}/);
    assert.match(
      state.response,
      new RegExp(`\\$${adjustedTiers[1]!.monthlyPremium.toFixed(2).replace(".", "\\.")}/month`),
    );
  });

  it("rejects a suspended license and stays in the driver stage", async () => {
    const graph = new QuoteGraph(new QuoteScriptedGateway());

    const state = await invoke(
      graph,
      undefined,
      "My license is currently suspended but I'd like a quote. Casey Morgan, born 1990-01-15, Oregon, 8 years licensed.",
    );

    assert.equal(state.currentNode, "DriverNode");
    assert.equal(state.nodes.DriverNode?.driver, undefined);
    assert.match(state.response, /suspended/i);
  });
});

describe("QuoteGraph session policy", () => {
  it("keeps a quote session inside the idle window", async () => {
    const graph = new QuoteGraph(new QuoteScriptedGateway());
    const restored = await graph.restoreSessionDoc(quoteSession(60_000));
    assert.ok(restored);
    assert.equal(restored.graph.currentNode, "CoverageNode");
  });

  it("starts a new run after the idle window", async () => {
    const graph = new QuoteGraph(new QuoteScriptedGateway());
    assert.equal(await graph.restoreSessionDoc(quoteSession(45 * 60_000)), null);
  });
});

function quoteSession(idleMs: number): SessionDocument<QuoteGraphStateType> {
  const modifiedAt = new Date(Date.now() - idleMs).toISOString();
  return {
    version: 16,
    revision: 0,
    id: "quote-policy-session",
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
      id: "QuoteGraph",
      schemaVersion: 1,
      currentNode: "CoverageNode",
      config: {},
      histories: {},
      model: {
        name: "openai:gpt-4o-mini",
        family: "chat",
        params: { retries: 3, temperature: 0.2 },
      },
      nodes: {},
    },
  };
}

async function invoke(
  graph: QuoteGraph,
  state: QuoteGraphStateType | undefined,
  input: string,
): Promise<QuoteGraphStateType> {
  return graph.graph.invoke({
    ...graph.prepareInput(state, new HumanMessage(input)),
    inputConsumed: false,
    response: "",
  });
}

/** Plays the customer-side model for the full quote conversation. */
class QuoteScriptedGateway implements LlmGateway {
  async structured<T extends Record<string, unknown>>(): Promise<ModelResult<T>> {
    throw new Error("Quote test does not use structured generation.");
  }

  async generate(): Promise<ModelResult<string>> {
    throw new Error("Quote test does not use simple generation.");
  }

  async respond(): Promise<ModelResult<string>> {
    throw new Error("Quote test does not use response generation.");
  }

  async toolCall(): Promise<ModelResult<LlmGatewayToolCall | undefined>> {
    throw new Error("Quote test does not use standalone tool calls.");
  }

  async agent(
    _systemPrompt: string,
    history: readonly BaseMessage[],
    tools: readonly LlmGatewayTool[],
    config?: GraphLlmConfig,
  ): Promise<ModelResult<AIMessage>> {
    const activeConfig = config ?? QuoteGraph.getGraphDefinition().llmConfig;
    const names = new Set(tools.map(({ name }) => name));
    const input = latestHumanText(history);
    const lastTool = latestToolOutput(history);

    if (names.has("capture_driver")) {
      if (lastTool) {
        return result(
          new AIMessage(
            "I'm sorry — we can't offer a quote while the license is suspended.",
          ),
          activeConfig,
        );
      }
      if (/suspended/i.test(input)) {
        return result(
          toolCall("driver-suspended", "capture_driver", {
            fullName: "Casey Morgan",
            dateOfBirth: "1990-01-15",
            licenseState: "OR",
            licenseStatus: "suspended",
            yearsLicensed: 8,
          }),
          activeConfig,
        );
      }
      return result(
        toolCall("driver", "capture_driver", {
          fullName: "Jamie Rivera",
          dateOfBirth: "1993-04-12",
          licenseState: "OR",
          licenseStatus: "valid",
          yearsLicensed: 10,
        }),
        activeConfig,
      );
    }

    if (names.has("resolve_vehicle")) {
      if (lastTool?.needsTrim) {
        return result(
          new AIMessage(
            "That Camry comes in LE, SE, and XSE trims — which one is yours?",
          ),
          activeConfig,
        );
      }
      if (lastTool?.accepted === true && lastTool.vehicle) {
        return result(
          toolCall("use", "capture_vehicle_use", {
            vehicleId: (lastTool.vehicle as { id: string }).id,
            ownership: "finance",
            annualMileage: 12000,
            parking: "driveway",
          }),
          activeConfig,
        );
      }
      if (/\bSE\b/i.test(input)) {
        return result(
          toolCall("resolve-trim", "resolve_vehicle", {
            year: 2019,
            make: "Toyota",
            model: "Camry",
            trim: "SE",
          }),
          activeConfig,
        );
      }
      if (/camry/i.test(input)) {
        return result(
          toolCall("resolve", "resolve_vehicle", {
            year: 2019,
            make: "Toyota",
            model: "Camry",
          }),
          activeConfig,
        );
      }
      return result(
        new AIMessage(
          "What vehicle will we be insuring? Year, make, and model, please.",
        ),
        activeConfig,
      );
    }

    if (names.has("capture_history")) {
      if (/ticket/i.test(input)) {
        return result(
          toolCall("history", "capture_history", {
            currentlyInsured: true,
            coverageLapse: false,
            incidents: [{ type: "violation", date: "2026-03" }],
          }),
          activeConfig,
        );
      }
      return result(
        new AIMessage(
          "Are you currently insured, and have you had any accidents, tickets, or claims in the last five years?",
        ),
        activeConfig,
      );
    }

    if (names.has("select_coverage")) {
      if (lastTool && lastTool.accepted === false) {
        return result(
          new AIMessage(
            `We can't do that: ${String(lastTool.error)} What deductibles would you like?`,
          ),
          activeConfig,
        );
      }
      if (/liability only/i.test(input)) {
        return result(
          toolCall("coverage-bad", "select_coverage", {
            liability: "standard",
            collisionDeductible: null,
            comprehensiveDeductible: null,
            extras: [],
            startDate: "2027-06-15",
          }),
          activeConfig,
        );
      }
      if (/500/.test(input)) {
        return result(
          toolCall("coverage", "select_coverage", {
            liability: "standard",
            collisionDeductible: 500,
            comprehensiveDeductible: 500,
            extras: ["rental"],
            startDate: "2027-06-15",
          }),
          activeConfig,
        );
      }
      return result(
        new AIMessage(
          "Let's pick coverage: liability level, deductibles, extras, and a start date.",
        ),
        activeConfig,
      );
    }

    if (names.has("accept_quote")) {
      if (/accept/i.test(input)) {
        return result(
          toolCall("accept", "accept_quote", { tier: "selected" }),
          activeConfig,
        );
      }
      if (/1000|1,000/.test(input)) {
        return result(
          toolCall("adjust", "adjust_quote", {
            collisionDeductible: 1000,
            comprehensiveDeductible: 1000,
          }),
          activeConfig,
        );
      }
      return result(
        new AIMessage(
          "Here are your quote options — Saver, Your selection, and Shield. Which would you like?",
        ),
        activeConfig,
      );
    }

    throw new Error(`Unexpected quote test stage for input '${input}'.`);
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

function latestToolOutput(
  history: readonly BaseMessage[],
): Record<string, unknown> | undefined {
  const last = history.at(-1);
  if (!last || !ToolMessage.isInstance(last)) return undefined;
  try {
    const parsed = JSON.parse(String(last.content)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
