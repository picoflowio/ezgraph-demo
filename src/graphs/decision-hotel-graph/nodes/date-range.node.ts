import { z } from 'zod';
import { ConversationNode, Tool, go, stay, type ToolDefinition, type ToolResponse } from '@picoflow/ezgraph';
import { CriteriaHelper } from '../criteria-helper.js';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { fillHotelPrompt, hotelPrompts } from '../prompt/hotel-prompts.js';
import { RouterDecisionNode } from './router-decision.node.js';

export class DateRangeNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(): string {
    return fillHotelPrompt(hotelPrompts.dates, {
      CURRENT_DATE: CriteriaHelper.currentBusinessDate().toISOString().slice(0, 10),
    });
  }

  defineTool(): readonly ToolDefinition[] {
    return [
      {
        name: 'capture_date_range',
        description: 'Save complete check-in and checkout dates.',
        schema: z.object({ start: z.string(), end: z.string() }),
      },
      {
        name: 'reroute_request',
        description: 'Return a request for another hotel criterion to the router.',
        schema: z.object({}),
      },
    ];
  }

  @Tool('capture_date_range')
  async captureDateRange(input: { start: string; end: string }): Promise<ToolResponse> {
    const start = CriteriaHelper.parseDate(input.start);
    const end = CriteriaHelper.parseDate(input.end);
    if (!start || !end) {
      return stay('Use valid calendar dates for both check-in and checkout.');
    }
    if (start <= CriteriaHelper.currentBusinessDate()) {
      return stay('Check-in must be after the current date.');
    }
    if (end <= start) return stay('Checkout must be after check-in.');
    this.saveState({ answered: true, start: input.start, end: input.end });
    return go(RouterDecisionNode);
  }

  @Tool('reroute_request')
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}
