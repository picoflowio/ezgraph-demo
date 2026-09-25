import { z } from 'zod';
import { ConversationNode, Tool, go, type ToolDefinition, type ToolResponse } from '@picoflow/ezgraph';
import { AMENITIES } from '../criteria.js';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { hotelPrompts } from '../prompt/hotel-prompts.js';
import { RouterDecisionNode } from './router-decision.node.js';

export class AmenityNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(): string { return hotelPrompts.amenities; }

  defineTool(): readonly ToolDefinition[] {
    return [{
      name: 'capture_amenities',
      description: 'Save required amenities. An empty array is valid only when the user explicitly states no amenity preference.',
      schema: z.object({ amenities: z.array(z.enum(AMENITIES)) }),
    }];
  }

  @Tool('capture_amenities')
  async captureAmenities(
    input: { amenities: (typeof AMENITIES)[number][] },
    _context: unknown,
    state: DecisionHotelGraphStateType,
  ): Promise<ToolResponse> {
    if (
      input.amenities.length === 0 &&
      !isExplicitNoPreference(this.graph.input(state))
    ) {
      return go(RouterDecisionNode);
    }
    this.saveState({ answered: true, amenities: [...new Set(input.amenities)] });
    return go(RouterDecisionNode);
  }

  @Tool('reroute_request')
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}

function isExplicitNoPreference(input: string): boolean {
  return /\b(?:no amenit(?:y|ies)(?: preference)?|amenit(?:y|ies) (?:do not|don't|does not|doesn't) matter|any amenit(?:y|ies)(?: (?:is|are) fine)?|do not care about amenit(?:y|ies)|don't care about amenit(?:y|ies))\b/i.test(
    input,
  );
}
