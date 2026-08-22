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
import { PricingEngine } from "./backend/pricing-engine.js";
import { GenChart } from "./gen-chart.js";
import type {
  HotelComparisonFeature,
  HotelComparisonRow,
  HotelSearchCriteria,
  HotelSearchResult,
} from "./hotel-types.js";
import {
  endChatInstruction,
  fillPrompt,
  hotelPrompt,
} from "./prompt/hotel-prompt.js";
import {
  HotelLanggraphState,
  type HotelLanggraphPhase,
  type HotelLanggraphRoute,
  type HotelLanggraphStateType,
  type HotelLanggraphStateUpdate,
} from "./hotel-langgraph.state.js";
import {
  MemoryHotelSessionStore,
  createHotelSessionStoreFromEnvironment,
  hydrateHotelState,
  serializeHotelState,
  type HotelSessionDocument,
  type HotelSessionStore,
} from "./hotel-session-store.js";

type HotelStage = "explore" | "present" | "compare";
type HotelMessageKey =
  | "exploreMessages"
  | "presentMessages"
  | "compareMessages";
type ToolCall = NonNullable<AIMessage["tool_calls"]>[number];

export type HotelBoundModel = {
  invoke(messages: readonly BaseMessage[]): Promise<BaseMessage>;
};

export type HotelModelFactory = (
  stage: HotelStage,
  tools: readonly StructuredToolInterface[],
) => HotelBoundModel;

type HotelLanggraphRunInput = {
  userMessage?: string;
  config?: Record<string, unknown>;
  sessionId?: string;
};

type HotelLanggraphRunResult = {
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

type HotelLanggraphDeleteSessionResult = {
  status: number;
  body: { success: boolean; session?: string; message?: string };
};

const captureChoicesSchema = z.object({
  json: z.string().min(2).describe("The complete HotelJSON object as JSON"),
});
const chosenHotelSchema = z.object({ hotelName: z.string().min(1) });
const searchAgainSchema = z.object({ isSearch: z.boolean() });
const goCompareSchema = z.object({ hotelsToCompare: z.array(z.string()) });
const generateComparisonSchema = z.object({
  hotels: z.array(z.string()).min(1),
  feature: z.enum(["price", "roomType", "amenities", "distance"]),
});
const resumeBookingSchema = z.object({ isResumed: z.boolean() });
const terminateSessionSchema = z.object({}).passthrough();

const captureChoicesTool = tool(async (input) => input, {
  name: "capture_choices",
  description: "Capture the complete hotel search criteria and run the search.",
  schema: captureChoicesSchema,
});
const chosenHotelTool = tool(async (input) => input, {
  name: "chosen_hotel",
  description: "Book one hotel from the presented search results.",
  schema: chosenHotelSchema,
});
const searchAgainTool = tool(async (input) => input, {
  name: "search_again",
  description: "Return to the search criteria and apply the user's changes.",
  schema: searchAgainSchema,
});
const goCompareTool = tool(async (input) => input, {
  name: "go_compare",
  description: "Compare selected hotels from the presented results.",
  schema: goCompareSchema,
});
const generateComparisonTool = tool(async (input) => input, {
  name: "generate_comparison",
  description: "Generate one hotel comparison for one supported feature.",
  schema: generateComparisonSchema,
});
const resumeBookingTool = tool(async (input) => input, {
  name: "resume_booking",
  description: "Return to the current hotel list to book a hotel.",
  schema: resumeBookingSchema,
});
const terminateSessionTool = tool(async (input) => input, {
  name: "terminate_session",
  description: "End the hotel conversation when the user explicitly asks to stop.",
  schema: terminateSessionSchema,
});

const stageTools: Record<HotelStage, readonly StructuredToolInterface[]> = {
  explore: [captureChoicesTool, terminateSessionTool],
  present: [
    chosenHotelTool,
    searchAgainTool,
    goCompareTool,
    terminateSessionTool,
  ],
  compare: [
    generateComparisonTool,
    resumeBookingTool,
    terminateSessionTool,
  ],
};

/**
 * Pure LangGraph implementation of the Hilton hotel workflow.
 */
export class HotelLanggraph {
  readonly name = "HotelLanggraph";

  private readonly models: Record<HotelStage, HotelBoundModel>;
  private readonly compiledGraph: ReturnType<HotelLanggraph["buildGraph"]>;

  constructor(
    modelFactory: HotelModelFactory = createOpenAiModel,
    private readonly sessionStore: HotelSessionStore =
      new MemoryHotelSessionStore(),
    private readonly sessionExpiration = sessionExpirationMs(),
  ) {
    this.models = {
      explore: modelFactory("explore", stageTools.explore),
      present: modelFactory("present", stageTools.present),
      compare: modelFactory("compare", stageTools.compare),
    };
    this.compiledGraph = this.buildGraph();
  }

  static async createFromEnvironment(
    modelFactory: HotelModelFactory = createOpenAiModel,
  ): Promise<HotelLanggraph> {
    return new HotelLanggraph(
      modelFactory,
      await createHotelSessionStoreFromEnvironment(),
      sessionExpirationMs(),
    );
  }

  get sessionStoreKind(): HotelSessionStore["kind"] {
    return this.sessionStore.kind;
  }

  async run(input: HotelLanggraphRunInput): Promise<HotelLanggraphRunResult> {
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
        ? hydrateHotelState(previousDocument.state)
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
        graphName: "HotelLanggraph",
        state: serializeHotelState(result),
        createdAt: previousDocument?.createdAt ?? now,
        modifiedAt: now,
        expireAfter: this.sessionExpiration,
      });
      return successResult(
        session,
        result.response,
        result.completed,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 400,
        session,
        body: {
          success: false,
          completed: false,
          message,
          session,
        },
      };
    }
  }

  async hasSession(sessionId: string): Promise<boolean> {
    const session = validateSessionId(sessionId);
    return (await this.loadSession(session)) !== undefined;
  }

  async getSessionState(
    sessionId: string,
  ): Promise<HotelLanggraphStateType | undefined> {
    const document = await this.loadSession(validateSessionId(sessionId));
    return document ? hydrateHotelState(document.state) : undefined;
  }

  async deleteSession(
    sessionId?: string,
  ): Promise<HotelLanggraphDeleteSessionResult> {
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

  private async loadSession(
    sessionId: string,
  ): Promise<HotelSessionDocument | undefined> {
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
    return new StateGraph(HotelLanggraphState)
      .addNode("exploreAgent", this.exploreAgent)
      .addNode("exploreTools", this.exploreTools)
      .addNode("presentAgent", this.presentAgent)
      .addNode("presentTools", this.presentTools)
      .addNode("compareAgent", this.compareAgent)
      .addNode("compareTools", this.compareTools)
      .addConditionalEdges(START, routeFromPhase, {
        exploreAgent: "exploreAgent",
        presentAgent: "presentAgent",
        compareAgent: "compareAgent",
        end: END,
      })
      .addConditionalEdges("exploreAgent", routeAfterExploreAgent, {
        exploreTools: "exploreTools",
        end: END,
      })
      .addConditionalEdges("presentAgent", routeAfterPresentAgent, {
        presentTools: "presentTools",
        end: END,
      })
      .addConditionalEdges("compareAgent", routeAfterCompareAgent, {
        compareTools: "compareTools",
        end: END,
      })
      .addConditionalEdges("exploreTools", routeAfterTools, {
        exploreAgent: "exploreAgent",
        presentAgent: "presentAgent",
        compareAgent: "compareAgent",
        end: END,
      })
      .addConditionalEdges("presentTools", routeAfterTools, {
        exploreAgent: "exploreAgent",
        presentAgent: "presentAgent",
        compareAgent: "compareAgent",
        end: END,
      })
      .addConditionalEdges("compareTools", routeAfterTools, {
        exploreAgent: "exploreAgent",
        presentAgent: "presentAgent",
        compareAgent: "compareAgent",
        end: END,
      })
      .compile();
  }

  private readonly exploreAgent = async (
    state: HotelLanggraphStateType,
  ): Promise<HotelLanggraphStateUpdate> => {
    const criteria = criteriaFor(state.criteria);
    const prompt = `${hotelPrompt.role}\n\n${fillPrompt(hotelPrompt.explore, {
      HOTEL_JSON: JSON.stringify(criteria),
    })}\n\n${endChatInstruction}`;
    return this.callAgent(
      state,
      "explore",
      "exploreMessages",
      prompt,
      { criteria },
    );
  };

  private readonly presentAgent = async (
    state: HotelLanggraphStateType,
  ): Promise<HotelLanggraphStateUpdate> => {
    const prompt = `${hotelPrompt.role}\n\n${fillPrompt(hotelPrompt.present, {
      HOTEL_FOUND_INFO: JSON.stringify(state.hotelFound),
    })}\n\nResolve a hotel number to the corresponding hotelName before calling a tool. ${
      state.inputConsumed
        ? "This stage has just been entered. Present the current hotel list even if earlier history contains another request."
        : "Handle the user's current booking, comparison, or search-change request."
    }\n\n${endChatInstruction}`;
    return this.callAgent(
      state,
      "present",
      "presentMessages",
      prompt,
    );
  };

  private readonly compareAgent = async (
    state: HotelLanggraphStateType,
  ): Promise<HotelLanggraphStateUpdate> => {
    const prompt = `${hotelPrompt.role}\n\n${fillPrompt(hotelPrompt.compare, {
      ChosenHotels: JSON.stringify(state.selectedHotels),
      AvailableHotels: JSON.stringify(state.availableHotels),
    })}\n\n${endChatInstruction}`;
    return this.callAgent(
      state,
      "compare",
      "compareMessages",
      prompt,
    );
  };

  private async callAgent(
    state: HotelLanggraphStateType,
    stage: HotelStage,
    messageKey: HotelMessageKey,
    prompt: string,
    extra: HotelLanggraphStateUpdate = {},
  ): Promise<HotelLanggraphStateUpdate> {
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
      ...extra,
      [messageKey]: [...inputMessages, response],
      inputConsumed: true,
      response: messageText(response),
      route: "end",
    };
  }

  private readonly exploreTools = async (
    state: HotelLanggraphStateType,
  ): Promise<HotelLanggraphStateUpdate> => {
    const call = latestToolCall(state.exploreMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("exploreMessages", call);
    }
    if (call.name !== "capture_choices") {
      return invalidToolUpdate(
        "exploreMessages",
        call,
        `Tool '${call.name}' is not available while collecting criteria.`,
        "exploreAgent",
      );
    }

    let parsed: z.infer<typeof captureChoicesSchema>;
    try {
      parsed = captureChoicesSchema.parse(call.args);
    } catch (error) {
      return invalidToolUpdate(
        "exploreMessages",
        call,
        zodError(error),
        "exploreAgent",
      );
    }
    let submitted: unknown;
    try {
      submitted = JSON.parse(parsed.json);
    } catch {
      return invalidToolUpdate(
        "exploreMessages",
        call,
        "The search criteria must be valid JSON.",
        "exploreAgent",
      );
    }
    const current = criteriaFor(state.criteria);
    const normalized = normalizeCriteria(submitted, current);
    if ("error" in normalized) {
      return invalidToolUpdate(
        "exploreMessages",
        call,
        normalized.error,
        "exploreAgent",
      );
    }
    const criteria = normalized.criteria;
    const results = PricingEngine.searchHotel(
      parseDate(criteria.cDate.start),
      parseDate(criteria.cDate.end),
      criteria.cAmenities,
      criteria.cRoomType,
      numberOrUndefined(criteria.cPriceRange.max),
      numberOrUndefined(criteria.cPriceRange.min),
      numberOrUndefined(criteria.cDistance.airport),
      numberOrUndefined(criteria.cDistance.cityCenter),
    );
    if (results.length === 0) {
      return {
        criteria,
        exploreMessages: toolResult(call, {
          accepted: true,
          found: 0,
          message: "No hotel found. Adjust the criteria and try again.",
        }),
        route: "exploreAgent",
        response: "",
      };
    }
    return {
      criteria,
      hotelFound: results,
      availableHotels: results.map((hotel) => hotel.hotelName),
      phase: "present",
      presentMessages: new HumanMessage(
        "Present the current hotel choices and booking options.",
      ),
      exploreMessages: toolResult(call, {
        accepted: true,
        found: results.length,
      }),
      route: "presentAgent",
      response: "",
    };
  };

  private readonly presentTools = async (
    state: HotelLanggraphStateType,
  ): Promise<HotelLanggraphStateUpdate> => {
    const call = latestToolCall(state.presentMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("presentMessages", call);
    }
    if (call.name === "chosen_hotel") {
      let parsed: z.infer<typeof chosenHotelSchema>;
      try {
        parsed = chosenHotelSchema.parse(call.args);
      } catch (error) {
        return invalidToolUpdate(
          "presentMessages",
          call,
          zodError(error),
          "presentAgent",
        );
      }
      const exact = state.hotelFound.find(
        (hotel) => hotel.hotelName === parsed.hotelName.trim(),
      );
      if (!exact) {
        return invalidToolUpdate(
          "presentMessages",
          call,
          "Choose one hotel from the current search results.",
          "presentAgent",
        );
      }
      const confirmationNumber = Math.floor(100000 + Math.random() * 900000);
      const response = `${exact.hotelName} is booked. Your confirmation number is ${confirmationNumber}. Thank you for choosing Hilton.`;
      return {
        presentMessages: toolResult(call, {
          accepted: true,
          hotelName: exact.hotelName,
        }),
        bookedHotel: exact.hotelName,
        confirmationNumber,
        completed: true,
        phase: "terminal",
        response,
        route: "end",
      };
    }
    if (call.name === "search_again") {
      let parsed: z.infer<typeof searchAgainSchema>;
      try {
        parsed = searchAgainSchema.parse(call.args);
      } catch (error) {
        return invalidToolUpdate(
          "presentMessages",
          call,
          zodError(error),
          "presentAgent",
        );
      }
      if (!parsed.isSearch) {
        return invalidToolUpdate(
          "presentMessages",
          call,
          "Search was not requested.",
          "presentAgent",
        );
      }
      return {
        presentMessages: toolResult(call, { accepted: true }),
        exploreMessages: new HumanMessage(
          "Review and update the hotel search criteria.",
        ),
        phase: "explore",
        inputConsumed: false,
        response: "",
        route: "exploreAgent",
      };
    }
    if (call.name === "go_compare") {
      let parsed: z.infer<typeof goCompareSchema>;
      try {
        parsed = goCompareSchema.parse(call.args);
      } catch (error) {
        return invalidToolUpdate(
          "presentMessages",
          call,
          zodError(error),
          "presentAgent",
        );
      }
      const available = state.hotelFound.map((hotel) => hotel.hotelName);
      const selected = uniqueTrimmed(parsed.hotelsToCompare);
      const invalid = selected.filter((name) => !available.includes(name));
      if (invalid.length > 0) {
        return invalidToolUpdate(
          "presentMessages",
          call,
          `These hotels are not in the current results: ${invalid.join(", ")}.`,
          "presentAgent",
        );
      }
      return {
        presentMessages: toolResult(call, {
          accepted: true,
          hotels: selected,
        }),
        compareMessages: new HumanMessage(
          "Choose hotels and one feature to compare.",
        ),
        availableHotels: available,
        selectedHotels: selected,
        phase: "compare",
        inputConsumed: false,
        response: "",
        route: "compareAgent",
      };
    }
    return invalidToolUpdate(
      "presentMessages",
      call,
      `Tool '${call.name}' is not available while presenting hotels.`,
      "presentAgent",
    );
  };

  private readonly compareTools = async (
    state: HotelLanggraphStateType,
  ): Promise<HotelLanggraphStateUpdate> => {
    const call = latestToolCall(state.compareMessages);
    if (!call) return { route: "end" };
    if (call.name === "terminate_session") {
      return terminateUpdate("compareMessages", call);
    }
    if (call.name === "resume_booking") {
      let parsed: z.infer<typeof resumeBookingSchema>;
      try {
        parsed = resumeBookingSchema.parse(call.args);
      } catch (error) {
        return invalidToolUpdate(
          "compareMessages",
          call,
          zodError(error),
          "compareAgent",
        );
      }
      if (!parsed.isResumed) {
        return invalidToolUpdate(
          "compareMessages",
          call,
          "Booking was not resumed.",
          "compareAgent",
        );
      }
      return {
        compareMessages: toolResult(call, { accepted: true }),
        presentMessages: new HumanMessage(
          "Present the current hotel choices so the user can book.",
        ),
        phase: "present",
        inputConsumed: true,
        response: "",
        route: "presentAgent",
      };
    }
    if (call.name !== "generate_comparison") {
      return invalidToolUpdate(
        "compareMessages",
        call,
        `Tool '${call.name}' is not available while comparing hotels.`,
        "compareAgent",
      );
    }
    let parsed: z.infer<typeof generateComparisonSchema>;
    try {
      parsed = generateComparisonSchema.parse(call.args);
    } catch (error) {
      return invalidToolUpdate(
        "compareMessages",
        call,
        zodError(error),
        "compareAgent",
      );
    }
    const selected = uniqueTrimmed(parsed.hotels);
    const invalid = selected.filter(
      (hotel) => !state.availableHotels.includes(hotel),
    );
    if (invalid.length > 0) {
      return invalidToolUpdate(
        "compareMessages",
        call,
        `These hotels are not available: ${invalid.join(", ")}.`,
        "compareAgent",
      );
    }
    const documents = PricingEngine.fetchHotels(selected);
    if (documents.length !== selected.length) {
      return invalidToolUpdate(
        "compareMessages",
        call,
        "One or more selected hotels could not be loaded.",
        "compareAgent",
      );
    }
    const rows = comparisonRows(
      documents,
      parsed.feature,
      state.hotelFound,
      state.criteria,
    );
    const comparison =
      parsed.feature === "amenities" || parsed.feature === "roomType"
        ? GenChart.comparisonRows(rows)
        : rows;
    const response = `${GenChart.getChart(comparison)}\nAnother comparison or ready to book?`;
    return {
      compareMessages: toolResult(call, {
        accepted: true,
        hotels: selected,
        feature: parsed.feature,
      }),
      selectedHotels: selected,
      lastComparison: comparison,
      response,
      route: "end",
    };
  };
}

function createOpenAiModel(
  stage: HotelStage,
  tools: readonly StructuredToolInterface[],
): HotelBoundModel {
  const model = new ChatOpenAI({
    model: stage === "present" ? "gpt-4o" : "gpt-5.1",
    maxRetries: 3,
    ...(stage === "present" ? { temperature: 0.5 } : {}),
    ...(stage === "explore" || stage === "compare"
      ? { reasoningEffort: "low" as const }
      : {}),
  });
  const bound = model.bindTools([...tools]);
  return {
    async invoke(messages) {
      return bound.invoke([...messages]);
    },
  };
}

function routeFromPhase(state: HotelLanggraphStateType): HotelLanggraphRoute {
  if (state.completed || state.phase === "terminal") return "end";
  return `${state.phase}Agent` as HotelLanggraphRoute;
}

function routeAfterExploreAgent(
  state: HotelLanggraphStateType,
): "exploreTools" | "end" {
  return hasToolCall(state.exploreMessages) ? "exploreTools" : "end";
}

function routeAfterPresentAgent(
  state: HotelLanggraphStateType,
): "presentTools" | "end" {
  return hasToolCall(state.presentMessages) ? "presentTools" : "end";
}

function routeAfterCompareAgent(
  state: HotelLanggraphStateType,
): "compareTools" | "end" {
  return hasToolCall(state.compareMessages) ? "compareTools" : "end";
}

function routeAfterTools(state: HotelLanggraphStateType): HotelLanggraphRoute {
  return state.route;
}

function hasToolCall(messages: readonly BaseMessage[]): boolean {
  return latestToolCall(messages) !== undefined;
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
  messageKey: HotelMessageKey,
  call: ToolCall,
  error: string,
  route: HotelLanggraphRoute,
): HotelLanggraphStateUpdate {
  return {
    [messageKey]: toolResult(call, { accepted: false, error }),
    response: "",
    route,
  };
}

function terminateUpdate(
  messageKey: HotelMessageKey,
  call: ToolCall,
): HotelLanggraphStateUpdate {
  return {
    [messageKey]: toolResult(call, { accepted: true }),
    completed: true,
    phase: "terminal",
    response:
      "Thank you for choosing Hilton. Please visit http://www.hilton.com or call 1-888-4HONORS for further assistance.",
    route: "end",
  };
}

function criteriaFor(
  saved: HotelSearchCriteria | undefined,
): HotelSearchCriteria {
  const template = structuredClone(
    hotelPrompt.exploreTemplate,
  ) as HotelSearchCriteria;
  return {
    ...template,
    ...saved,
    currentDate:
      saved?.currentDate ??
      process.env.HOTEL_GRAPH_CURRENT_DATE ??
      process.env.HOTEL_FLOW_CURRENT_DATE ??
      new Date().toISOString(),
    cPriceRange: { ...template.cPriceRange, ...saved?.cPriceRange },
    cDistance: { ...template.cDistance, ...saved?.cDistance },
    cDate: { ...template.cDate, ...saved?.cDate },
  };
}

function normalizeCriteria(
  value: unknown,
  current: HotelSearchCriteria,
): { criteria: HotelSearchCriteria } | { error: string } {
  if (!isRecord(value)) return { error: "HotelJSON must be an object." };
  const date = isRecord(value.cDate) ? value.cDate : {};
  const start = stringOrNull(date.start);
  const end = stringOrNull(date.end);
  if (!start || !end) {
    return { error: "A check-in and check-out date are required." };
  }
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    endDate <= startDate
  ) {
    return { error: "Check-out must be a valid date after check-in." };
  }
  const price = isRecord(value.cPriceRange) ? value.cPriceRange : {};
  const distance = isRecord(value.cDistance) ? value.cDistance : {};
  const roomTypes = stringArray(value.cRoomType).filter((candidate) =>
    current.roomType.includes(candidate),
  );
  const amenities = stringArray(value.cAmenities).filter((candidate) =>
    current.amenities.includes(candidate),
  );
  const dateArray = stringArray(value.cDateArray);
  return {
    criteria: {
      ...current,
      cDate: { start, end },
      cDateArray:
        dateArray.length > 0
          ? dateArray
          : PricingEngine.enumerateDateStrings(startDate, endDate),
      cRoomType: roomTypes,
      cAmenities: amenities,
      cPriceRange: {
        min: finiteNumberOrNull(price.min),
        max: finiteNumberOrNull(price.max),
      },
      cDistance: {
        cityCenter: finiteNumberOrNull(distance.cityCenter),
        airport: finiteNumberOrNull(distance.airport),
      },
    },
  };
}

function comparisonRows(
  documents: ReturnType<typeof PricingEngine.fetchHotels>,
  feature: HotelComparisonFeature,
  results: HotelSearchResult[],
  criteria: HotelSearchCriteria | undefined,
): HotelComparisonRow[] {
  return documents.map((hotel) => {
    if (feature === "amenities") {
      return { hotelName: hotel.hotelName, ...hotel.amenities };
    }
    if (feature === "roomType") {
      return {
        hotelName: hotel.hotelName,
        ...GenChart.roomTypes(hotel.roomType),
      };
    }
    if (feature === "distance") {
      return {
        hotelName: hotel.hotelName,
        cityCenter: formatMiles(hotel.cityCenter),
        airport: formatMiles(hotel.airport),
      };
    }
    const result = results.find((candidate) =>
      candidate.hotelName === hotel.hotelName
    );
    return {
      hotelName: hotel.hotelName,
      ...Object.fromEntries(
        (criteria?.cDateArray ?? []).map((date, index) => [
          date,
          GenChart.formatCurrency(result?.prices[index] ?? 0),
        ]),
      ),
      total: GenChart.formatCurrency(result?.total ?? 0),
    };
  });
}

function successResult(
  session: string,
  message: string,
  completed: boolean,
): HotelLanggraphRunResult {
  return {
    status: 200,
    session,
    body: {
      success: true,
      completed,
      message,
      bot: message,
      session,
    },
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

function sessionExpirationMs(value = process.env.SESSION_EXPIRATION): number {
  const configured = Number(value ?? "50000");
  return Number.isFinite(configured) && configured > 0 ? configured : 50000;
}

function zodError(error: unknown): string {
  return error instanceof z.ZodError
    ? error.issues.map((issue) => issue.message).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
}

function uniqueTrimmed(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrUndefined(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

function parseDate(value: string | null): Date {
  return new Date(value ?? Number.NaN);
}

function formatMiles(distance: number | undefined): string {
  return distance === undefined ? "N/A" : `${distance} mi`;
}
