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
import { GenChart } from "../gen-chart.js";
import type {
  HotelGraphStateType,
  HotelSearchCriteria,
} from "../hotel-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  hotelPrompt,
} from "../prompt/hotel-prompt.js";
import { PresentNode } from "./present.node.js";

type ComparisonFeature = "price" | "roomType" | "amenities" | "distance";
type GenerateComparisonInput = {
  hotels: string[];
  feature: ComparisonFeature;
};
type ResumeBookingInput = { isResumed: boolean };
type ComparisonRow = Record<string, string | number>;
type CompareContext = {
  availableHotels: string[];
  selectedHotels: string[];
  comparison?: ComparisonRow[];
  response?: string;
  resume: boolean;
};

export class CompareNode extends ConversationNode<
  HotelGraphStateType,
  {
    availableHotels?: string[];
    selectedHotels?: string[];
    lastComparison?: ComparisonRow[];
  },
  CompareContext
> {
  getPrompt(state: HotelGraphStateType): string {
    const local = this.state(state);
    return `${hotelPrompt.role}\n\n${fillPrompt(hotelPrompt.compare, {
      ChosenHotels: JSON.stringify(local.selectedHotels ?? []),
      AvailableHotels: JSON.stringify(local.availableHotels ?? []),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<GenerateComparisonInput>
    | ToolDefinition<ResumeBookingInput>
  )[] {
    return [
      {
        name: "generate_comparison",
        description: "Generate one hotel comparison for one supported feature.",
        schema: z.object({
          hotels: z.array(z.string()).min(1),
          feature: z.enum(["price", "roomType", "amenities", "distance"]),
        }),
      },
      {
        name: "resume_booking",
        description: "Return to the current hotel list to book a hotel.",
        schema: z.object({ isResumed: z.boolean() }),
      },
    ];
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-5.1", {
      retries: 3,
      reasoningEffort: "low",
    });
  }

  @Tool("generate_comparison")
  async generateComparison(
    { hotels, feature }: GenerateComparisonInput,
    context: CompareContext,
    state: HotelGraphStateType,
  ): Promise<ConversationToolResult> {
    const selected = [...new Set(hotels.map((hotel) => hotel.trim()))];
    const invalid = selected.filter(
      (hotel) => !context.availableHotels.includes(hotel),
    );
    if (invalid.length > 0) {
      return {
        output: {
          accepted: false,
          error: `These hotels are not available: ${invalid.join(", ")}.`,
        },
      };
    }

    const documents = PricingEngine.fetchHotels(selected);
    if (documents.length !== selected.length) {
      return {
        output: {
          accepted: false,
          error: "One or more selected hotels could not be loaded.",
        },
      };
    }
    const availableResults = state.nodes.PresentNode?.hotelFound ?? [];
    const criteria = state.nodes.ExploreNode?.criteria;
    const rows = documents.map((hotel): ComparisonRow => {
      if (feature === "amenities") {
        return {
          hotelName: hotel.hotelName,
          ...hotel.amenities,
        };
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
      return this.priceRow(hotel.hotelName, availableResults, criteria);
    });
    const comparison =
      feature === "amenities" || feature === "roomType"
        ? GenChart.comparisonRows(rows)
        : rows;
    context.selectedHotels = selected;
    context.comparison = comparison;
    context.response = `${GenChart.getChart(comparison)}\nAnother comparison or ready to book?`;
    return {
      output: { accepted: true, hotels: selected, feature },
      stopAfterBatch: true,
    };
  }

  @Tool("resume_booking")
  async resumeBooking(
    { isResumed }: ResumeBookingInput,
    context: CompareContext,
  ): Promise<ConversationToolResult> {
    if (!isResumed) return { output: { accepted: false } };
    context.resume = true;
    return { output: { accepted: true }, stopAfterBatch: true };
  }

  protected createContext(state: HotelGraphStateType): CompareContext {
    const local = this.state(state);
    return {
      availableHotels: local.availableHotels ?? [],
      selectedHotels: local.selectedHotels ?? [],
      resume: false,
    };
  }

  protected nextStep(
    _state: HotelGraphStateType,
    context: CompareContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<HotelGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.comparison && context.response) {
      return this.stay(conversation, context.response).withState({
        availableHotels: context.availableHotels,
        selectedHotels: context.selectedHotels,
        lastComparison: context.comparison,
      });
    }
    if (context.resume) {
      return this.advance(PresentNode, conversation)
        .withState({
          availableHotels: context.availableHotels,
          selectedHotels: context.selectedHotels,
        })
        .withHistory(
          "hotel-present",
          new HumanMessage(
            "Present the current hotel choices so the user can book.",
          ),
        );
    }
    return this.stay(conversation).withState({
      availableHotels: context.availableHotels,
      selectedHotels: context.selectedHotels,
    });
  }

  private priceRow(
    hotelName: string,
    results: Array<{ hotelName: string; prices: number[]; total: number }>,
    criteria?: HotelSearchCriteria,
  ): ComparisonRow {
    const result = results.find((hotel) => hotel.hotelName === hotelName);
    const dates = criteria?.cDateArray ?? [];
    return {
      hotelName,
      ...Object.fromEntries(
        dates.map((date, index) => [
          date,
          GenChart.formatCurrency(result?.prices[index] ?? 0),
        ]),
      ),
      total: GenChart.formatCurrency(result?.total ?? 0),
    };
  }
}

function formatMiles(distance: number | undefined): string {
  return distance === undefined ? "N/A" : `${distance} mi`;
}
