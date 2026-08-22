import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphLlmConfigOverride,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import type {
  HotelGraphStateType,
  HotelSearchResult,
} from "../hotel-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  hotelPrompt,
} from "../prompt/hotel-prompt.js";
import { CompareNode } from "./compare.node.js";
import { ExploreNode } from "./explore.node.js";

type PresentAction =
  | { type: "book"; hotelName: string }
  | { type: "search" }
  | { type: "compare"; hotelNames: string[] };
type PresentContext = {
  available: HotelSearchResult[];
  action?: PresentAction;
};
type ChosenHotelInput = { hotelName: string };
type SearchAgainInput = { isSearch: boolean };
type GoCompareInput = { hotelsToCompare: string[] };

export class PresentNode extends ConversationNode<
  HotelGraphStateType,
  {
    hotelFound?: HotelSearchResult[];
    hotel?: string;
    confirmationNumber?: number;
  },
  PresentContext
> {
  getPrompt(state: HotelGraphStateType): string {
    const hotelFound = this.state(state).hotelFound ?? [];
    return `${hotelPrompt.role}\n\n${fillPrompt(hotelPrompt.present, {
      HOTEL_FOUND_INFO: JSON.stringify(hotelFound),
    })}\n\nResolve a hotel number to the corresponding hotelName before calling a tool. ${
      state.inputConsumed
        ? "This stage has just been entered. Present the current hotel list even if earlier history contains another request."
        : "Handle the user's current booking, comparison, or search-change request."
    }\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<ChosenHotelInput>
    | ToolDefinition<SearchAgainInput>
    | ToolDefinition<GoCompareInput>
  )[] {
    return [
      {
        name: "chosen_hotel",
        description: "Book one hotel from the presented search results.",
        schema: z.object({ hotelName: z.string().min(1) }),
      },
      {
        name: "search_again",
        description:
          "Return to the search criteria and apply the user's changes.",
        schema: z.object({ isSearch: z.boolean() }),
      },
      {
        name: "go_compare",
        description: "Compare selected hotels from the presented results.",
        schema: z.object({ hotelsToCompare: z.array(z.string()) }),
      },
    ];
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return { params: { temperature: 0.5 } };
  }

  @Tool("chosen_hotel")
  async chosenHotel(
    { hotelName }: ChosenHotelInput,
    context: PresentContext,
  ): Promise<ConversationToolResult> {
    const exact = context.available.find(
      (hotel) => hotel.hotelName === hotelName.trim(),
    );
    if (!exact) {
      return {
        output: {
          accepted: false,
          error: "Choose one hotel from the current search results.",
        },
      };
    }
    context.action = { type: "book", hotelName: exact.hotelName };
    return {
      output: { accepted: true, hotelName: exact.hotelName },
      stopAfterBatch: true,
    };
  }

  @Tool("search_again")
  async searchAgain(
    { isSearch }: SearchAgainInput,
    context: PresentContext,
  ): Promise<ConversationToolResult> {
    if (!isSearch) return { output: { accepted: false } };
    context.action = { type: "search" };
    return { output: { accepted: true }, stopAfterBatch: true };
  }

  @Tool("go_compare")
  async goCompare(
    { hotelsToCompare }: GoCompareInput,
    context: PresentContext,
  ): Promise<ConversationToolResult> {
    const availableNames = context.available.map((hotel) => hotel.hotelName);
    const selected = [...new Set(hotelsToCompare.map((name) => name.trim()))];
    const invalid = selected.filter((name) => !availableNames.includes(name));
    if (invalid.length > 0) {
      return {
        output: {
          accepted: false,
          error: `These hotels are not in the current results: ${invalid.join(", ")}.`,
        },
      };
    }
    context.action = { type: "compare", hotelNames: selected };
    return {
      output: { accepted: true, hotels: selected },
      stopAfterBatch: true,
    };
  }

  protected createContext(
    state: HotelGraphStateType,
  ): PresentContext {
    return { available: this.state(state).hotelFound ?? [] };
  }

  protected nextStep(
    state: HotelGraphStateType,
    context: PresentContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<HotelGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.action?.type === "book") {
      const confirmationNumber = this.generateConfirmationNumber();
      const response = `${context.action.hotelName} is booked. Your confirmation number is ${confirmationNumber}. Thank you for choosing Hilton.`;
      return this.finish(response, conversation).withState({
        hotelFound: context.available,
        hotel: context.action.hotelName,
        confirmationNumber,
      });
    }
    if (context.action?.type === "search") {
      return this.advance(ExploreNode, conversation).forwardInput(
        state,
        "Review and update the hotel search criteria.",
      );
    }
    if (context.action?.type === "compare") {
      return this.advance(CompareNode, conversation)
        .withStateFor(CompareNode, {
          availableHotels: context.available.map((hotel) => hotel.hotelName),
          selectedHotels: context.action.hotelNames,
        })
        .forwardInput(state, "Choose hotels and one feature to compare.");
    }
    return this.stay(conversation);
  }

  private generateConfirmationNumber(): number {
    return Math.floor(100000 + Math.random() * 900000);
  }
}
