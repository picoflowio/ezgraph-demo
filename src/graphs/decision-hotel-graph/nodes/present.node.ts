import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  ConversationNode,
  Tool,
  finish,
  go,
  stay,
  type GraphLlmConfigOverride,
  type ToolDefinition,
  type ToolResponse,
} from '@picoflow/ezgraph';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { fillHotelPrompt, hotelPrompts } from '../prompt/hotel-prompts.js';
import { PresentationDecisionNode } from './presentation-decision.node.js';
import { RouterDecisionNode } from './router-decision.node.js';

export class PresentNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(state: DecisionHotelGraphStateType): string {
    return fillHotelPrompt(hotelPrompts.present, {
      HOTEL_FOUND_INFO: JSON.stringify(state.nodes.PresentNode?.hotelFound ?? []),
    });
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return { params: { forceToolCalls: true } };
  }

  defineTool(): readonly ToolDefinition[] {
    return [
      {
        name: 'publish_hotel_draft',
        description: 'Submit the grounded result draft for semantic review.',
        schema: z.object({ draft: z.string().min(1) }),
      },
      {
        name: 'chosen_hotel',
        description: 'Book one hotel from the current results.',
        schema: z.object({ hotelName: z.string().min(1) }),
      },
      {
        name: 'revise_search',
        description: 'Return a criteria revision to the decision router.',
        schema: z.object({}),
      },
    ];
  }

  @Tool('publish_hotel_draft')
  async publishDraft(input: { draft: string }): Promise<ToolResponse> {
    this.saveState({ draft: input.draft });
    return go(PresentationDecisionNode);
  }

  @Tool('chosen_hotel')
  async chosenHotel(input: { hotelName: string }): Promise<ToolResponse> {
    const hotels = this.graph.graphState().nodes.PresentNode?.hotelFound ?? [];
    const normalized = input.hotelName.trim().toLowerCase();
    const numeric = /^\d+$/.test(normalized) ? Number(normalized) : NaN;
    const selected =
      Number.isInteger(numeric) && numeric >= 1 && numeric <= hotels.length
        ? hotels[numeric - 1]
        : hotels.find((hotel) => hotel.hotelName.toLowerCase() === normalized);
    if (!selected) {
      return stay('Choose a hotel name or number from the current result list.');
    }

    const confirmationNumber = Math.floor(100000 + Math.random() * 900000);
    this.saveState({ selectedHotel: selected.hotelName, confirmationNumber });
    return finish(
      `${selected.hotelName} is booked with confirmation #${confirmationNumber}. Thank you for choosing Hilton.`,
    );
  }

  @Tool('revise_search')
  async reviseSearch(
    _input: Record<string, never>,
    _context: Record<string, never>,
    state: DecisionHotelGraphStateType,
  ): Promise<ToolResponse> {
    return go(RouterDecisionNode).withMessage(
      new HumanMessage(this.graph.input(state)),
    );
  }
}
