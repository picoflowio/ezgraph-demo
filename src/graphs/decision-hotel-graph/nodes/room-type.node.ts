import { z } from 'zod';
import { ConversationNode, Tool, go, type ToolDefinition, type ToolResponse } from '@picoflow/ezgraph';
import { ROOM_TYPES } from '../criteria.js';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { hotelPrompts } from '../prompt/hotel-prompts.js';
import { RouterDecisionNode } from './router-decision.node.js';

export class RoomTypeNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(): string { return hotelPrompts.roomType; }

  defineTool(): readonly ToolDefinition[] {
    return [{
      name: 'capture_room_type',
      description: 'Save one supported room type.',
      schema: z.object({ roomType: z.enum(ROOM_TYPES) }),
    }];
  }

  @Tool('capture_room_type')
  async captureRoomType(input: { roomType: (typeof ROOM_TYPES)[number] }): Promise<ToolResponse> {
    this.saveState({ answered: true, roomType: input.roomType });
    return go(RouterDecisionNode);
  }

  @Tool('reroute_request')
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}
