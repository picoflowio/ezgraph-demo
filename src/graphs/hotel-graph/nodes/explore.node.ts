import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  ModelCatalog,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphLlmConfigOverride,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import { PricingEngine } from "../backend/pricing-engine.js";
import type {
  HotelGraphStateType,
  HotelSearchCriteria,
  HotelSearchResult,
} from "../hotel-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  hotelPrompt,
} from "../prompt/hotel-prompt.js";
import { PresentNode } from "./present.node.js";

type ExploreContext = {
  criteria: HotelSearchCriteria;
  results?: HotelSearchResult[];
};

export class ExploreNode extends ConversationNode<
  HotelGraphStateType,
  { criteria?: HotelSearchCriteria },
  ExploreContext
> {
  getPrompt(state: HotelGraphStateType): string {
    const criteria = this.criteria(state);
    return `${hotelPrompt.role}\n\n${fillPrompt(hotelPrompt.explore, {
      HOTEL_JSON: JSON.stringify(criteria),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly ToolDefinition<{ json: string }>[] {
    return [
      {
        name: "capture_choices",
        description:
          "Capture the complete hotel search criteria and run the search.",
        schema: z.object({
          json: z
            .string()
            .min(2)
            .describe("The complete HotelJSON object as JSON"),
        }),
      },
    ];
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-5.1", {
      retries: 3,
      reasoningEffort: "low",
    });
  }

  @Tool("capture_choices")
  async captureChoices(
    { json }: { json: string },
    context: ExploreContext,
  ): Promise<ConversationToolResult> {
    let submitted: unknown;
    try {
      submitted = JSON.parse(json);
    } catch {
      return {
        output: {
          accepted: false,
          error: "The search criteria must be valid JSON.",
        },
      };
    }

    const normalized = this.normalizeCriteria(submitted, context.criteria);
    if ("error" in normalized) {
      return { output: { accepted: false, error: normalized.error } };
    }
    context.criteria = normalized.criteria;
    const { cDate, cAmenities, cRoomType, cPriceRange, cDistance } =
      context.criteria;
    const results = PricingEngine.searchHotel(
      parseDate(cDate.start),
      parseDate(cDate.end),
      cAmenities,
      cRoomType,
      numberOrUndefined(cPriceRange.max),
      numberOrUndefined(cPriceRange.min),
      numberOrUndefined(cDistance.airport),
      numberOrUndefined(cDistance.cityCenter),
    );
    if (results.length === 0) {
      return {
        output: {
          accepted: true,
          found: 0,
          message: "No hotel found. Adjust the criteria and try again.",
        },
      };
    }
    context.results = results;
    return {
      output: { accepted: true, found: results.length },
      stopAfterBatch: true,
    };
  }

  protected createContext(state: HotelGraphStateType): ExploreContext {
    return { criteria: this.criteria(state) };
  }

  protected nextStep(
    _state: HotelGraphStateType,
    context: ExploreContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<HotelGraphStateType> {
    if (conversation.quitRequested) {
      return this.quit(conversation).withState({ criteria: context.criteria });
    }
    if (context.results) {
      return this.advance(PresentNode, conversation)
        .withState({ criteria: context.criteria })
        .withStateFor(PresentNode, { hotelFound: context.results })
        .withHistory(
          "hotel-present",
          new HumanMessage(
            "Present the current hotel choices and booking options.",
          ),
        );
    }
    return this.stay(conversation).withState({ criteria: context.criteria });
  }

  private criteria(state: HotelGraphStateType): HotelSearchCriteria {
    const template = structuredClone(
      hotelPrompt.exploreTemplate,
    ) as HotelSearchCriteria;
    const saved = this.state(state).criteria;
    return {
      ...template,
      ...saved,
      currentDate:
        saved?.currentDate ??
        process.env.HOTEL_GRAPH_CURRENT_DATE ??
        process.env.HOTEL_FLOW_CURRENT_DATE ??
        new Date().toISOString(),
      cPriceRange: {
        ...template.cPriceRange,
        ...saved?.cPriceRange,
      },
      cDistance: { ...template.cDistance, ...saved?.cDistance },
      cDate: { ...template.cDate, ...saved?.cDate },
    };
  }

  private normalizeCriteria(
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
