import {
  DecisionNode,
  directTo,
  go,
  type DecisionAnswers,
  type DecisionContext,
  type DecisionQuestionMap,
  type GraphNodeResponse,
} from '@picoflow/ezgraph';
import { CriteriaHelper } from '../criteria-helper.js';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { fillHotelPrompt, hotelPrompts } from '../prompt/hotel-prompts.js';
import { RouterDecisionNode } from './router-decision.node.js';
import { SearchHotelsNode } from './search-hotels.node.js';

export const CRITERIA_REVIEW_QUESTIONS = {
  outcome: {
    type: 'choice',
    criteria: {
      ready: 'Ready to search', dates: 'Dates conflict', budget: 'Budget conflicts',
      room_type: 'Room type conflicts', amenities: 'Amenities conflict',
      distance: 'Distance conflicts', unclear: 'Ambiguous',
    },
  },
  faithful: {
    type: 'noul',
    criteria: {
      true: 'Saved criteria reflect requests',
      false: 'Saved criteria contradict requests',
    },
  },
} as const satisfies DecisionQuestionMap;

export class CriteriaReadinessDecisionNode extends DecisionNode<DecisionHotelGraphStateType, typeof CRITERIA_REVIEW_QUESTIONS> {
  defineQuestions() { return CRITERIA_REVIEW_QUESTIONS; }

  getPrompt(state: DecisionHotelGraphStateType): string {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    return fillHotelPrompt(hotelPrompts.criteriaJudge, {
      NORMALIZED_CRITERIA: JSON.stringify(criteria, null, 2),
      DETERMINISTIC_ISSUES: issues.length
        ? issues.map((issue) => `${issue.field}: ${issue.message}`).join('\n')
        : 'None.',
    });
  }

  protected getDecisionData(state: DecisionHotelGraphStateType) {
    const criteria = CriteriaHelper.readCriteria(state);
    return { criteria, deterministicIssues: CriteriaHelper.validateCriteria(criteria) };
  }

  onDecision(
    answers: DecisionAnswers<typeof CRITERIA_REVIEW_QUESTIONS>,
    _context: DecisionContext,
    state: DecisionHotelGraphStateType,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    const outcome = answers.outcome.choice;
    const accepted =
      issues.length === 0 &&
      outcome === 'ready' &&
      answers.faithful.noul >= 0.75;
    this.saveState({ review: answers, accepted });
    if (issues.length) return go(CriteriaHelper.nextNode(issues[0]!));
    if (accepted) return go(SearchHotelsNode);
    if (outcome !== 'ready' && outcome !== 'unclear') {
      return directTo(CriteriaHelper.nextNode(outcome), CriteriaHelper.criteriaPrompt(outcome));
    }
    return directTo(
      RouterDecisionNode,
      `${CriteriaHelper.renderCriteriaSummary(criteria)}\nI could not verify one clear correction. Tell me which single criterion to update.`,
    );
  }
}
