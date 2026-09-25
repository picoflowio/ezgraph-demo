import { HumanMessage } from '@langchain/core/messages';
import {
  GraphNode,
  go,
  type GraphNodeResult,
} from '@picoflow/ezgraph';
import { CriteriaHelper } from '../criteria-helper.js';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { searchHotels } from '../hotel-search.js';
import { PresentNode } from './present.node.js';
import { RouterDecisionNode } from './router-decision.node.js';

export class SearchHotelsNode extends GraphNode<DecisionHotelGraphStateType> {
  getPrompt(): string { return ''; }

  async run(
    state: DecisionHotelGraphStateType,
  ): Promise<GraphNodeResult<DecisionHotelGraphStateType>> {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    if (issues.length) {
      return this.resolveNodeResponse(go(CriteriaHelper.criteriaNode(issues[0]!.field)));
    }

    const hotels = searchHotels(criteria);
    if (!hotels.length) {
      return this.resolveNodeResponse(
        go(RouterDecisionNode).withState({
          notice: 'No hotels matched all current criteria. Tell me whether to revise budget, room type, amenities, or distance.',
        }),
      );
    }

    return this.resolveNodeResponse(
      go(PresentNode)
        .withState({
          hotelFound: hotels,
          criteria,
          criteriaReviewAccepted:
            state.nodes.CriteriaReadinessDecisionNode?.accepted === true,
        })
        .withMessage(
          new HumanMessage({
            content: 'Present the current matching hotels.',
            additional_kwargs: { ezgraphInternal: true },
          }),
        ),
    );
  }

  protected usesChatModel(): boolean { return false; }
}
