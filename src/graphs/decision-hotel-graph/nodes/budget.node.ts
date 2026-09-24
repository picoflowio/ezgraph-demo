import { z } from 'zod';
import { ConversationNode, Tool, go, stay, type ToolDefinition, type ToolResponse } from '@picoflow/ezgraph';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { hotelPrompts } from '../prompt/hotel-prompts.js';
import { RouterDecisionNode } from './router-decision.node.js';

export class BudgetNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(): string { return hotelPrompts.budget; }

  defineTool(): readonly ToolDefinition[] {
    return [{
      name: 'capture_budget',
      description: 'Save nightly minimum and maximum; null means no limit.',
      schema: z.object({ min: z.number().finite().nullable(), max: z.number().finite().nullable() }),
    }];
  }

  @Tool('capture_budget')
  async captureBudget(input: { min: number | null; max: number | null }): Promise<ToolResponse> {
    if ((input.min !== null && input.min < 0) || (input.max !== null && input.max < 0)) {
      return stay('Budget values cannot be negative.');
    }
    if (input.min !== null && input.max !== null && input.min > input.max) {
      return stay('The minimum nightly budget cannot exceed the maximum.');
    }
    this.saveState({ answered: true, min: input.min, max: input.max });
    return go(RouterDecisionNode);
  }

  @Tool('reroute_request')
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}
