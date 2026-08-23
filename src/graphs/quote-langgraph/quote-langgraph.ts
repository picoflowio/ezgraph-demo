import { randomUUID } from "node:crypto";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import {
  monthsBetween,
  parseUtcDate,
  parseUtcMonth,
  quoteNow,
  yearsBetween,
} from "./backend/quote-clock.js";
import {
  RatingEngine,
  buildRatingSubject,
  validateCoverageSelection,
} from "./backend/rating-engine.js";
import { VehicleCatalog } from "./backend/vehicle-catalog.js";
import {
  endChatInstruction,
  fillPrompt,
  quotePrompt,
} from "./prompt/quote-prompt.js";
import type {
  CoverageSelection,
  QuoteTier,
  QuoteTierName,
} from "./quote-types.js";
import {
  QuoteLanggraphState,
  type QuoteLanggraphRoute,
  type QuoteLanggraphStateType,
  type QuoteLanggraphStateUpdate,
} from "./quote-langgraph.state.js";
import {
  MemoryQuoteSessionStore,
  createQuoteSessionStoreFromEnvironment,
  hydrateQuoteState,
  serializeQuoteState,
  type QuoteSessionDocument,
  type QuoteSessionStore,
} from "./quote-session-store.js";

type QuoteStage = "driver" | "vehicle" | "history" | "coverage" | "quote";
type QuoteMessageKey =
  | "intakeMessages"
  | "incidentsMessages"
  | "presentMessages";
type ToolCall = NonNullable<AIMessage["tool_calls"]>[number];

export type QuoteBoundModel = {
  invoke(messages: readonly BaseMessage[]): Promise<BaseMessage>;
};

export type QuoteModelFactory = (
  stage: QuoteStage,
  tools: readonly StructuredToolInterface[],
) => QuoteBoundModel;

type QuoteLanggraphRunInput = {
  userMessage?: string;
  config?: Record<string, unknown>;
  sessionId?: string;
};

type QuoteLanggraphRunResult = {
  status: number;
  body: {
    success: boolean;
    completed: boolean;
    message: string;
    bot?: string;
    session?: string;
  };
  session?: string;
};

type QuoteLanggraphDeleteSessionResult = {
  status: number;
  body: { success: boolean; session?: string; message?: string };
};

/** The intake channel carries driver, vehicle, and coverage; history and quote are isolated. */
const stageMessageKey: Record<QuoteStage, QuoteMessageKey> = {
  driver: "intakeMessages",
  vehicle: "intakeMessages",
  history: "incidentsMessages",
  coverage: "intakeMessages",
  quote: "presentMessages",
};

const deductibleSchema = z.union([
  z.literal(250),
  z.literal(500),
  z.literal(1000),
  z.null(),
]);

const captureDriverSchema = z.object({
  fullName: z.string().min(2),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  licenseState: z.string().length(2),
  licenseStatus: z.enum(["valid", "permit", "suspended"]),
  yearsLicensed: z.number().int().min(0),
});
const resolveVehicleSchema = z.object({
  year: z.number().int().min(1990).max(2035),
  make: z.string().min(1),
  model: z.string().min(1),
  trim: z.string().min(1).optional(),
});
const captureVehicleUseSchema = z.object({
  vehicleId: z.string().min(1),
  ownership: z.enum(["own", "finance", "lease"]),
  annualMileage: z.number().int().min(1000).max(60000),
  parking: z.enum(["garage", "driveway", "street"]),
});
const captureHistorySchema = z.object({
  currentlyInsured: z.boolean(),
  coverageLapse: z.boolean(),
  incidents: z
    .array(
      z.object({
        type: z.enum([
          "at-fault-accident",
          "not-at-fault-accident",
          "violation",
          "comprehensive-claim",
        ]),
        date: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
      }),
    )
    .max(10),
});
const selectCoverageSchema = z.object({
  liability: z.enum(["state-minimum", "standard", "premium"]),
  collisionDeductible: deductibleSchema,
  comprehensiveDeductible: deductibleSchema,
  extras: z.array(z.enum(["rental", "roadside"])).max(2),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
});
const adjustQuoteSchema = z.object({
  liability: z.enum(["state-minimum", "standard", "premium"]).optional(),
  collisionDeductible: deductibleSchema.optional(),
  comprehensiveDeductible: deductibleSchema.optional(),
  extras: z.array(z.enum(["rental", "roadside"])).max(2).optional(),
});
const acceptQuoteSchema = z.object({
  tier: z.enum(["saver", "selected", "shield"]),
});
const reviseCoverageSchema = z.object({ isRevise: z.boolean() });
const terminateSessionSchema = z.object({}).passthrough();

const captureDriverTool = tool(async (input) => input, {
  name: "capture_driver",
  description: "Capture the primary driver's identity and license details.",
  schema: captureDriverSchema,
});
const resolveVehicleTool = tool(async (input) => input, {
  name: "resolve_vehicle",
  description:
    "Look the vehicle up in the ratable-vehicle catalog by year, make, and model.",
  schema: resolveVehicleSchema,
});
const captureVehicleUseTool = tool(async (input) => input, {
  name: "capture_vehicle_use",
  description:
    "Capture ownership, mileage, and parking for the resolved vehicle.",
  schema: captureVehicleUseSchema,
});
const captureHistoryTool = tool(async (input) => input, {
  name: "capture_history",
  description:
    "Capture prior insurance status and all incidents from the last five years.",
  schema: captureHistorySchema,
});
const selectCoverageTool = tool(async (input) => input, {
  name: "select_coverage",
  description:
    "Capture the complete coverage selection and produce quote tiers.",
  schema: selectCoverageSchema,
});
const adjustQuoteTool = tool(async (input) => input, {
  name: "adjust_quote",
  description:
    "Recompute the quote tiers after changing deductibles, liability, or extras.",
  schema: adjustQuoteSchema,
});
const acceptQuoteTool = tool(async (input) => input, {
  name: "accept_quote",
  description: "Accept one presented quote tier and finish the quote.",
  schema: acceptQuoteSchema,
});
const reviseCoverageTool = tool(async (input) => input, {
  name: "revise_coverage",
  description: "Return to the coverage stage to rework the selections.",
  schema: reviseCoverageSchema,
});
const terminateSessionTool = tool(async (input) => input, {
  name: "terminate_session",
  description:
    "End the quote conversation when the user explicitly asks to stop.",
  schema: terminateSessionSchema,
});

const stageTools: Record<QuoteStage, readonly StructuredToolInterface[]> = {
  driver: [captureDriverTool, terminateSessionTool],
  vehicle: [resolveVehicleTool, captureVehicleUseTool, terminateSessionTool],
  history: [captureHistoryTool, terminateSessionTool],
  coverage: [selectCoverageTool, terminateSessionTool],
  quote: [
    adjustQuoteTool,
    acceptQuoteTool,
    reviseCoverageTool,
    terminateSessionTool,
  ],
};

const TIER_LABELS: Record<QuoteTierName, string> = {
  saver: "Saver",
  selected: "Your selection",
  shield: "Shield",
};

/** Reads naturally inside the acceptance sentence, unlike the list labels. */
const ACCEPTED_TIER_PHRASES: Record<QuoteTierName, string> = {
  saver: "the Saver tier",
  selected: "your selected coverage",
  shield: "the Shield tier",
};

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

const GOODBYE =
  "Thanks for considering Sequoia Auto Insurance. Visit sequoia-auto.example.com or call 1-888-555-0150 whenever you'd like to pick this back up.";

/**
 * Pure LangGraph implementation of the Sequoia Auto Insurance quoting
 * workflow. It matches QuoteGraph's behavior without importing EZGraph.
 */
export class QuoteLanggraph {
  readonly name = "QuoteLanggraph";

  private readonly models: Record<QuoteStage, QuoteBoundModel>;
  private readonly compiledGraph: ReturnType<QuoteLanggraph["buildGraph"]>;

  constructor(
    modelFactory: QuoteModelFactory = createOpenAiModel,
    private readonly sessionStore: QuoteSessionStore =
      new MemoryQuoteSessionStore(),
    private readonly sessionExpiration = sessionIdleMs(),
  ) {
    this.models = {
      driver: modelFactory("driver", stageTools.driver),
      vehicle: modelFactory("vehicle", stageTools.vehicle),
      history: modelFactory("history", stageTools.history),
      coverage: modelFactory("coverage", stageTools.coverage),
      quote: modelFactory("quote", stageTools.quote),
    };
    this.compiledGraph = this.buildGraph();
  }

  static async createFromEnvironment(
    modelFactory: QuoteModelFactory = createOpenAiModel,
  ): Promise<QuoteLanggraph> {
    return new QuoteLanggraph(
      modelFactory,
      await createQuoteSessionStoreFromEnvironment(),
      sessionIdleMs(),
    );
  }

  get sessionStoreKind(): QuoteSessionStore["kind"] {
    return this.sessionStore.kind;
  }

  async run(input: QuoteLanggraphRunInput): Promise<QuoteLanggraphRunResult> {
    const userMessage =
      typeof input.userMessage === "string" ? input.userMessage.trim() : "";
    if (!userMessage) {
      return {
        status: 400,
        body: {
          success: false,
          completed: false,
          message: "userMessage must be a non-empty string.",
        },
      };
    }

    let session: string;
    try {
      session = input.sessionId
        ? validateSessionId(input.sessionId)
        : randomUUID();
    } catch (error) {
      return {
        status: 400,
        body: {
          success: false,
          completed: false,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    try {
      const previousDocument = await this.loadSession(session);
      const previous = previousDocument
        ? hydrateQuoteState(previousDocument.state)
        : undefined;
      if (previous?.completed) {
        return successResult(
          session,
          "This conversation is already complete.",
          true,
        );
      }

      const result = await this.compiledGraph.invoke(
        {
          ...(previous ?? {}),
          userInput: userMessage,
          inputConsumed: false,
          response: "",
          config: { ...(previous?.config ?? {}), ...(input.config ?? {}) },
        },
        { recursionLimit: 50 },
      );
      const now = new Date().toISOString();
      await this.sessionStore.set({
        version: 1,
        id: session,
        graphName: "QuoteLanggraph",
        state: serializeQuoteState(result),
        createdAt: previousDocument?.createdAt ?? now,
        modifiedAt: now,
        expireAfter: this.sessionExpiration,
      });
      return successResult(session, result.response, result.completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 400,
        session,
        body: { success: false, completed: false, message, session },
      };
    }
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return (await this.loadSession(validateSessionId(sessionId))) !== undefined;
  }

  async getSessionState(
    sessionId: string,
  ): Promise<QuoteLanggraphStateType | undefined> {
    const document = await this.loadSession(validateSessionId(sessionId));
    return document ? hydrateQuoteState(document.state) : undefined;
  }

  async deleteSession(
    sessionId?: string,
  ): Promise<QuoteLanggraphDeleteSessionResult> {
    if (!sessionId) {
      return {
        status: 400,
        body: { success: false, message: "SESSION_ID is required." },
      };
    }
    try {
      const session = validateSessionId(sessionId);
      await this.sessionStore.delete(session);
      return { status: 200, body: { success: true, session } };
    } catch (error) {
      return {
        status: 400,
        body: {
          success: false,
          session: sessionId,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async close(): Promise<void> {
    await this.sessionStore.close();
  }

  /** Idle quote sessions start over; rates are not held indefinitely. */
  private async loadSession(
    sessionId: string,
  ): Promise<QuoteSessionDocument | undefined> {
    const document = await this.sessionStore.get(sessionId);
    if (!document) return undefined;
    if (document.graphName !== this.name) {
      throw new Error(
        `Session '${sessionId}' belongs to graph '${document.graphName}', not '${this.name}'.`,
      );
    }
    const modifiedAt = Date.parse(document.modifiedAt);
    if (
      Number.isFinite(modifiedAt) &&
      Date.now() - modifiedAt >= document.expireAfter
    ) {
      await this.sessionStore.delete(sessionId);
      return undefined;
    }
    return document;
  }

  private buildGraph() {
    return new StateGraph(QuoteLanggraphState)
      .addNode("driverAgent", this.driverAgent)
      .addNode("driverTools", this.driverTools)
      .addNode("vehicleAgent", this.vehicleAgent)
      .addNode("vehicleTools", this.vehicleTools)
      .addNode("historyAgent", this.historyAgent)
      .addNode("historyTools", this.historyTools)
      .addNode("coverageAgent", this.coverageAgent)
      .addNode("coverageTools", this.coverageTools)
      .addNode("quoteAgent", this.quoteAgent)
      .addNode("quoteTools", this.quoteTools)
      .addConditionalEdges(START, routeFromPhase, agentRoutes)
      .addConditionalEdges(
        "driverAgent",
        (state) => afterAgent(state, "driver"),
        { driverTools: "driverTools", end: END },
      )
      .addConditionalEdges(
        "vehicleAgent",
        (state) => afterAgent(state, "vehicle"),
        { vehicleTools: "vehicleTools", end: END },
      )
      .addConditionalEdges(
        "historyAgent",
        (state) => afterAgent(state, "history"),
        { historyTools: "historyTools", end: END },
      )
      .addConditionalEdges(
        "coverageAgent",
        (state) => afterAgent(state, "coverage"),
        { coverageTools: "coverageTools", end: END },
      )
      .addConditionalEdges(
        "quoteAgent",
        (state) => afterAgent(state, "quote"),
        { quoteTools: "quoteTools", end: END },
      )
      .addConditionalEdges("driverTools", routeAfterTools, agentRoutes)
      .addConditionalEdges("vehicleTools", routeAfterTools, agentRoutes)
      .addConditionalEdges("historyTools", routeAfterTools, agentRoutes)
      .addConditionalEdges("coverageTools", routeAfterTools, agentRoutes)
      .addConditionalEdges("quoteTools", routeAfterTools, agentRoutes)
      .compile();
  }

  private readonly driverAgent = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const prompt = stagePrompt(
      fillPrompt(quotePrompt.driver, { CURRENT_DATE: today() }),
    );
    return this.callAgent(state, "driver", prompt);
  };

  private readonly vehicleAgent = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const resolved = state.resolvedVehicleId
      ? VehicleCatalog.fetch(state.resolvedVehicleId)
      : undefined;
    const prompt = stagePrompt(
      fillPrompt(quotePrompt.vehicle, {
        RESOLVED_VEHICLE: JSON.stringify(resolved ?? null),
      }),
    );
    return this.callAgent(state, "vehicle", prompt);
  };

  private readonly historyAgent = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const prompt = stagePrompt(
      fillPrompt(quotePrompt.history, { CURRENT_DATE: today() }),
    );
    return this.callAgent(state, "history", prompt);
  };

  private readonly coverageAgent = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const prompt = stagePrompt(
      fillPrompt(quotePrompt.coverage, {
        CURRENT_DATE: today(),
        OWNERSHIP: state.vehicle?.ownership ?? "own",
      }),
    );
    return this.callAgent(state, "coverage", prompt);
  };

  private readonly quoteAgent = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const prompt = stagePrompt(
      fillPrompt(quotePrompt.quote, {
        TIERS_JSON: JSON.stringify(state.tiers),
      }),
    );
    return this.callAgent(state, "quote", prompt);
  };

  private async callAgent(
    state: QuoteLanggraphStateType,
    stage: QuoteStage,
    prompt: string,
  ): Promise<QuoteLanggraphStateUpdate> {
    const messageKey = stageMessageKey[stage];
    const inputMessages = state.inputConsumed
      ? []
      : [new HumanMessage(state.userInput)];
    const response = await this.models[stage].invoke([
      new SystemMessage(prompt),
      ...state[messageKey],
      ...inputMessages,
    ]);
    if (!AIMessage.isInstance(response)) {
      throw new Error(`${stage} model returned a non-AI message.`);
    }
    return {
      [messageKey]: [...inputMessages, response],
      inputConsumed: true,
      response: messageText(response),
      route: "end",
    };
  }

  private readonly driverTools = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const call = latestToolCall(state.intakeMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("intakeMessages", call);
    }
    if (call.name !== "capture_driver") {
      return invalidToolUpdate(
        "intakeMessages",
        call,
        `Tool '${call.name}' is not available while collecting driver details.`,
        "driverAgent",
      );
    }
    let parsed: z.infer<typeof captureDriverSchema>;
    try {
      parsed = captureDriverSchema.parse(call.args);
    } catch (error) {
      return invalidToolUpdate(
        "intakeMessages",
        call,
        zodError(error),
        "driverAgent",
      );
    }

    const licenseState = parsed.licenseState.toUpperCase();
    const reject = (error: string) =>
      invalidToolUpdate("intakeMessages", call, error, "driverAgent");
    if (!US_STATE_CODES.has(licenseState)) {
      return reject(`'${parsed.licenseState}' is not a U.S. state code.`);
    }
    if (parsed.licenseStatus === "suspended") {
      return reject(
        "We cannot offer a quote while the driver's license is suspended.",
      );
    }
    const birthDate = parseUtcDate(parsed.dateOfBirth);
    if (!birthDate) {
      return reject(
        "dateOfBirth must be a real calendar date in YYYY-MM-DD form.",
      );
    }
    const now = quoteNow();
    if (birthDate > now) return reject("The date of birth cannot be in the future.");
    const age = yearsBetween(birthDate, now);
    if (age < 16) return reject("The primary driver must be at least 16 years old.");
    if (age > 100) {
      return reject("Check the date of birth; the driver's age exceeds 100.");
    }
    if (parsed.yearsLicensed > age - 15) {
      return reject(
        `${parsed.yearsLicensed} licensed years is inconsistent with a ${age}-year-old driver.`,
      );
    }

    const driver = {
      fullName: parsed.fullName.trim(),
      dateOfBirth: parsed.dateOfBirth,
      licenseState,
      licenseStatus: parsed.licenseStatus,
      yearsLicensed: parsed.yearsLicensed,
    };
    return {
      driver,
      intakeMessages: toolResult(call, { accepted: true, driver }),
      phase: "vehicle",
      response: "",
      route: "vehicleAgent",
    };
  };

  private readonly vehicleTools = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const call = latestToolCall(state.intakeMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("intakeMessages", call);
    }
    const reject = (error: string) =>
      invalidToolUpdate("intakeMessages", call, error, "vehicleAgent");

    if (call.name === "resolve_vehicle") {
      let parsed: z.infer<typeof resolveVehicleSchema>;
      try {
        parsed = resolveVehicleSchema.parse(call.args);
      } catch (error) {
        return reject(zodError(error));
      }
      const matches = VehicleCatalog.search(parsed);
      if (matches.length === 0) {
        const years = VehicleCatalog.yearsFor(parsed.make, parsed.model);
        return reject(
          years.length > 0
            ? `No ${parsed.year} ${parsed.make} ${parsed.model} is in the catalog; supported years for that model: ${years.join(", ")}.`
            : `That vehicle cannot be rated. Supported vehicles: ${VehicleCatalog.summarize()}.`,
        );
      }
      if (matches.length > 1) {
        return {
          intakeMessages: toolResult(call, {
            accepted: false,
            needsTrim: true,
            candidates: matches.map((candidate) => ({
              vehicleId: candidate.id,
              trim: candidate.trim,
            })),
            error: "Several trims match; ask the customer which one.",
          }),
          response: "",
          route: "vehicleAgent",
        };
      }
      const vehicle = matches[0]!;
      return {
        resolvedVehicleId: vehicle.id,
        intakeMessages: toolResult(call, { accepted: true, vehicle }),
        response: "",
        route: "vehicleAgent",
      };
    }

    if (call.name !== "capture_vehicle_use") {
      return reject(
        `Tool '${call.name}' is not available while collecting vehicle details.`,
      );
    }
    let parsed: z.infer<typeof captureVehicleUseSchema>;
    try {
      parsed = captureVehicleUseSchema.parse(call.args);
    } catch (error) {
      return reject(zodError(error));
    }
    if (parsed.vehicleId !== state.resolvedVehicleId) {
      return reject(
        "Resolve the vehicle with resolve_vehicle before capturing its use.",
      );
    }
    const use = {
      vehicleId: parsed.vehicleId,
      ownership: parsed.ownership,
      annualMileage: parsed.annualMileage,
      parking: parsed.parking,
    };
    return {
      vehicle: use,
      intakeMessages: toolResult(call, { accepted: true, use }),
      incidentsMessages: new HumanMessage(
        "Collect the driving and insurance history.",
      ),
      phase: "history",
      response: "",
      route: "historyAgent",
    };
  };

  private readonly historyTools = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const call = latestToolCall(state.incidentsMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("incidentsMessages", call);
    }
    const reject = (error: string) =>
      invalidToolUpdate("incidentsMessages", call, error, "historyAgent");
    if (call.name !== "capture_history") {
      return reject(
        `Tool '${call.name}' is not available while collecting history.`,
      );
    }
    let parsed: z.infer<typeof captureHistorySchema>;
    try {
      parsed = captureHistorySchema.parse(call.args);
    } catch (error) {
      return reject(zodError(error));
    }

    const now = quoteNow();
    for (const [index, incident] of parsed.incidents.entries()) {
      const month = parseUtcMonth(incident.date);
      if (!month) {
        return reject(
          `Incident ${index + 1}: '${incident.date}' is not a real month.`,
        );
      }
      if (month > now) {
        return reject(`Incident ${index + 1} is dated in the future.`);
      }
      if (monthsBetween(month, now) > 60) {
        return reject(
          `Incident ${index + 1} is more than five years old; only the last five years affect this quote — drop it.`,
        );
      }
    }

    return {
      history: {
        currentlyInsured: parsed.currentlyInsured,
        coverageLapse: parsed.coverageLapse,
        incidents: parsed.incidents,
      },
      incidentsMessages: toolResult(call, { accepted: true }),
      intakeMessages: new HumanMessage(
        "The history stage is complete. Collect the coverage preferences.",
      ),
      phase: "coverage",
      response: "",
      route: "coverageAgent",
    };
  };

  private readonly coverageTools = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const call = latestToolCall(state.intakeMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("intakeMessages", call);
    }
    const reject = (error: string) =>
      invalidToolUpdate("intakeMessages", call, error, "coverageAgent");
    if (call.name !== "select_coverage") {
      return reject(
        `Tool '${call.name}' is not available while selecting coverage.`,
      );
    }
    let parsed: z.infer<typeof selectCoverageSchema>;
    try {
      parsed = selectCoverageSchema.parse(call.args);
    } catch (error) {
      return reject(zodError(error));
    }
    const use = state.vehicle;
    if (!use) {
      return reject(
        "Vehicle details are missing; complete the vehicle stage first.",
      );
    }
    const coverage: CoverageSelection = {
      liability: parsed.liability,
      collisionDeductible: parsed.collisionDeductible,
      comprehensiveDeductible: parsed.comprehensiveDeductible,
      extras: [...new Set(parsed.extras)],
      startDate: parsed.startDate,
    };
    const now = quoteNow();
    const error = validateCoverageSelection(coverage, use.ownership, now);
    if (error) return reject(error);
    const rating = buildRatingSubject({
      driver: state.driver,
      use,
      history: state.history,
    });
    if ("error" in rating) return reject(rating.error);

    return {
      coverage,
      tiers: RatingEngine.quoteTiers(rating.subject, coverage, now),
      intakeMessages: toolResult(call, { accepted: true }),
      presentMessages: new HumanMessage("Present the quote tiers."),
      phase: "quote",
      response: "",
      route: "quoteAgent",
    };
  };

  private readonly quoteTools = async (
    state: QuoteLanggraphStateType,
  ): Promise<QuoteLanggraphStateUpdate> => {
    const call = latestToolCall(state.presentMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("presentMessages", call);
    }
    const reject = (error: string) =>
      invalidToolUpdate("presentMessages", call, error, "quoteAgent");

    if (call.name === "accept_quote") {
      let parsed: z.infer<typeof acceptQuoteSchema>;
      try {
        parsed = acceptQuoteSchema.parse(call.args);
      } catch (error) {
        return reject(zodError(error));
      }
      const tier = state.tiers.find(
        (candidate) => candidate.tier === parsed.tier,
      );
      if (!tier) return reject("That tier is not part of the current quote.");
      const referenceNumber = `QT-${Math.floor(100000 + Math.random() * 900000)}`;
      return {
        presentMessages: toolResult(call, { accepted: true }),
        acceptedTier: tier.tier,
        referenceNumber,
        completed: true,
        phase: "terminal",
        response: `You're all set — ${ACCEPTED_TIER_PHRASES[tier.tier]} (${TIER_LABELS[tier.tier]}) is locked in at ${usd(tier.monthlyPremium)}/month starting ${tier.coverage.startDate}. Your quote reference is ${referenceNumber}.`,
        route: "end",
      };
    }

    if (call.name === "revise_coverage") {
      let parsed: z.infer<typeof reviseCoverageSchema>;
      try {
        parsed = reviseCoverageSchema.parse(call.args);
      } catch (error) {
        return reject(zodError(error));
      }
      if (!parsed.isRevise) return reject("Coverage revision was not requested.");
      return {
        presentMessages: toolResult(call, { accepted: true }),
        intakeMessages: new HumanMessage(
          "Review and update the coverage selections.",
        ),
        phase: "coverage",
        // Forward the customer's current message into the coverage stage.
        inputConsumed: false,
        response: "",
        route: "coverageAgent",
      };
    }

    if (call.name !== "adjust_quote") {
      return reject(
        `Tool '${call.name}' is not available while presenting the quote.`,
      );
    }
    let parsed: z.infer<typeof adjustQuoteSchema>;
    try {
      parsed = adjustQuoteSchema.parse(call.args);
    } catch (error) {
      return reject(zodError(error));
    }
    if (
      parsed.liability === undefined &&
      parsed.collisionDeductible === undefined &&
      parsed.comprehensiveDeductible === undefined &&
      parsed.extras === undefined
    ) {
      return reject("Provide at least one coverage change to adjust.");
    }
    const current = state.coverage;
    const use = state.vehicle;
    if (!current || !use) {
      return reject("There is no coverage selection to adjust yet.");
    }
    const next: CoverageSelection = {
      ...current,
      ...(parsed.liability === undefined ? {} : { liability: parsed.liability }),
      ...(parsed.collisionDeductible === undefined
        ? {}
        : { collisionDeductible: parsed.collisionDeductible }),
      ...(parsed.comprehensiveDeductible === undefined
        ? {}
        : { comprehensiveDeductible: parsed.comprehensiveDeductible }),
      ...(parsed.extras === undefined
        ? {}
        : { extras: [...new Set(parsed.extras)] }),
    };
    const now = quoteNow();
    const error = validateCoverageSelection(next, use.ownership, now);
    if (error) return reject(error);
    const rating = buildRatingSubject({
      driver: state.driver,
      use,
      history: state.history,
    });
    if ("error" in rating) return reject(rating.error);
    const tiers = RatingEngine.quoteTiers(rating.subject, next, now);
    return {
      coverage: next,
      tiers,
      presentMessages: toolResult(call, { accepted: true }),
      response: `Here is the updated quote:\n${formatTiers(tiers)}\nAdjust anything else, accept a tier, or rework the coverage.`,
      route: "end",
    };
  };
}

function createOpenAiModel(
  stage: QuoteStage,
  tools: readonly StructuredToolInterface[],
): QuoteBoundModel {
  // Collection runs on a small model; only the quote stage pays for a
  // stronger one, mirroring QuoteNode's per-node override.
  const presentsQuote = stage === "quote";
  const model = new ChatOpenAI({
    model: presentsQuote ? "gpt-5.1" : "gpt-4o-mini",
    maxRetries: 3,
    ...(presentsQuote
      ? { reasoningEffort: "low" as const }
      : { temperature: 0.2 }),
  });
  const bound = model.bindTools([...tools]);
  return {
    async invoke(messages) {
      return bound.invoke([...messages]);
    },
  };
}

const agentRoutes = {
  driverAgent: "driverAgent",
  vehicleAgent: "vehicleAgent",
  historyAgent: "historyAgent",
  coverageAgent: "coverageAgent",
  quoteAgent: "quoteAgent",
  end: END,
} as const;

function routeFromPhase(state: QuoteLanggraphStateType): QuoteLanggraphRoute {
  if (state.completed || state.phase === "terminal") return "end";
  return `${state.phase}Agent` as QuoteLanggraphRoute;
}

function afterAgent(
  state: QuoteLanggraphStateType,
  stage: QuoteStage,
): `${QuoteStage}Tools` | "end" {
  return latestToolCall(state[stageMessageKey[stage]])
    ? (`${stage}Tools` as const)
    : "end";
}

function routeAfterTools(state: QuoteLanggraphStateType): QuoteLanggraphRoute {
  return state.route;
}

function latestToolCall(messages: readonly BaseMessage[]): ToolCall | undefined {
  const message = [...messages]
    .reverse()
    .find((candidate) => AIMessage.isInstance(candidate));
  return (
    message?.tool_calls?.find((call) => call.name === "terminate_session") ??
    message?.tool_calls?.[0]
  );
}

function toolResult(
  call: ToolCall,
  output: Record<string, unknown>,
): ToolMessage {
  return new ToolMessage({
    name: call.name,
    content: JSON.stringify(output),
    tool_call_id: call.id ?? `${call.name}-result`,
  });
}

function invalidToolUpdate(
  messageKey: QuoteMessageKey,
  call: ToolCall,
  error: string,
  route: QuoteLanggraphRoute,
): QuoteLanggraphStateUpdate {
  return {
    [messageKey]: toolResult(call, { accepted: false, error }),
    response: "",
    route,
  };
}

function terminateUpdate(
  messageKey: QuoteMessageKey,
  call: ToolCall,
): QuoteLanggraphStateUpdate {
  return {
    [messageKey]: toolResult(call, { accepted: true }),
    completed: true,
    phase: "terminal",
    response: GOODBYE,
    route: "end",
  };
}

function stagePrompt(stageSection: string): string {
  return `${quotePrompt.role}\n\n${stageSection}\n\n${endChatInstruction}`;
}

function today(): string {
  return quoteNow().toISOString().slice(0, 10);
}

function formatTiers(tiers: QuoteTier[]): string {
  return tiers
    .map(
      (tier, index) =>
        `${index + 1}. ${TIER_LABELS[tier.tier]} — ${describeCoverage(tier.coverage)}: ${usd(tier.monthlyPremium)}/mo`,
    )
    .join("\n");
}

function describeCoverage(coverage: CoverageSelection): string {
  const deductibles =
    coverage.collisionDeductible === null
      ? "liability only"
      : `$${coverage.collisionDeductible}/$${coverage.comprehensiveDeductible} deductibles`;
  const extras =
    coverage.extras.length === 0 ? "no extras" : coverage.extras.join(" + ");
  return `${coverage.liability} liability, ${deductibles}, ${extras}`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function successResult(
  session: string,
  message: string,
  completed: boolean,
): QuoteLanggraphRunResult {
  return {
    status: 200,
    session,
    body: { success: true, completed, message, bot: message, session },
  };
}

function messageText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) =>
      typeof part === "string"
        ? part
        : "text" in part && typeof part.text === "string"
          ? part.text
          : "",
    )
    .join("");
}

function validateSessionId(value: string): string {
  const session = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session)) {
    throw new Error(
      "SESSION_ID must be 1-128 letters, numbers, underscores, or hyphens.",
    );
  }
  return session;
}

function sessionIdleMs(value = process.env.QUOTE_LANGGRAPH_IDLE_MS): number {
  const configured = Number(value ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 30 * 60_000;
}

function zodError(error: unknown): string {
  return error instanceof z.ZodError
    ? error.issues.map((issue) => issue.message).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
}
