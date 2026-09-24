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
      description: 'Save required amenities; empty means no preference.',
      schema: z.object({ amenities: z.array(z.enum(AMENITIES)) }),
    }];
  }

  @Tool('capture_amenities')
  async captureAmenities(input: { amenities: (typeof AMENITIES)[number][] }): Promise<ToolResponse> {
    this.saveState({ answered: true, amenities: [...new Set(input.amenities)] });
    return go(RouterDecisionNode);
  }

  @Tool('reroute_request')
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}
