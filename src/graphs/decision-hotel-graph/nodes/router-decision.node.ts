import { HumanMessage } from '@langchain/core/messages';
import {
  DecisionNode,
  directTo,
  finish,
  go,
  type DecisionAnswers,
  type DecisionContext,
  type DecisionQuestionMap,
  type GraphNodeResponse,
} from '@picoflow/ezgraph';
import { readCriteria, renderCriteriaSummary, validateCriteria } from '../criteria.js';
import type { DecisionHotelGraphStateType } from '../decision-hotel-graph.state.js';
import { fillHotelPrompt, hotelPrompts } from '../prompt/hotel-prompts.js';
import { criteriaNode, criteriaPrompt } from '../routing.js';
import { CriteriaReadinessDecisionNode } from './criteria-readiness-decision.node.js';

export const ROUTING_QUESTIONS = {
  destination: {
    type: 'choice',
    criteria: {
      dates: 'Set or revise dates',
      budget: 'Set or revise nightly budget',
      room_type: 'Set or revise room type',
      amenities: 'Set or revise amenities',
      distance: 'Set or revise distances',
      review: 'Show saved criteria',
      search: 'Execute a hotel search',
      exit: 'End the conversation',
      unclear: 'Ambiguous or outside this flow',
    },
  },
  request_delivery: {
    type: 'choice',
    criteria: {
      apply_request: 'The latest request contains a new value or revision that the selected collector must apply',
      prompt_next: 'The selected criterion is merely the next unresolved field',
      none: 'The destination is not a criterion collector',
    },
  },
} as const satisfies DecisionQuestionMap;

export class RouterDecisionNode extends DecisionNode<DecisionHotelGraphStateType, typeof ROUTING_QUESTIONS> {
  defineQuestions() { return ROUTING_QUESTIONS; }

  getPrompt(state: DecisionHotelGraphStateType): string {
    const criteria = readCriteria(state);
    const issues = validateCriteria(criteria);
    return fillHotelPrompt(hotelPrompts.router, {
      COLLECTED_CRITERIA: JSON.stringify(criteria, null, 2),
      UNRESOLVED_CRITERIA: issues.length
        ? issues.map((issue, index) => `${index + 1}. ${issue.field}: ${issue.message}`).join('\n')
        : 'None.',
    });
  }

  protected getDecisionData(state: DecisionHotelGraphStateType) {
    const criteria = readCriteria(state);
    return {
      criteria,
      unresolved: validateCriteria(criteria).map((issue) => issue.field),
      notice: state.nodes.RouterDecisionNode?.notice ?? null,
    };
  }

  onDecision(
    answers: DecisionAnswers<typeof ROUTING_QUESTIONS>,
    context: DecisionContext,
    state: DecisionHotelGraphStateType,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const criteria = readCriteria(state);
    const issues = validateCriteria(criteria);
    const notice = state.nodes.RouterDecisionNode?.notice;
    if (notice) {
      this.saveState({ notice: null });
      return directTo(RouterDecisionNode, notice);
    }

    const route = answers.destination.choice;
    this.saveState({ lastRoute: route, lastDecision: answers });
    if (route === 'unclear') {
      return directTo(RouterDecisionNode, 'I can update dates, nightly budget, room type, amenities, or distance. You can also ask to review or search.');
    }
    if (route === 'exit') {
      return finish('Thanks for considering Hilton hotels in Portland.');
    }
    if (route === 'review') {
      return directTo(RouterDecisionNode, `${renderCriteriaSummary(criteria)}\n\nTell me what to revise, or say “search” when ready.`);
    }
    if (route === 'search') {
      if (context.request.trim().toLowerCase() !== 'search') {
        return issues.length
          ? directTo(criteriaNode(issues[0]!.field), criteriaPrompt(issues[0]!.field))
          : directTo(
              RouterDecisionNode,
              `${renderCriteriaSummary(criteria)}\n\nTell me what to revise, or say “search” when ready.`,
            );
      }
      return issues.length
        ? go(criteriaNode(issues[0]!.field))
        : go(CriteriaReadinessDecisionNode);
    }
    return answers.request_delivery.choice === 'apply_request' || criterionAnswered(criteria, route)
      ? go(criteriaNode(route)).withMessage(new HumanMessage(context.request))
      : directTo(criteriaNode(route), criteriaPrompt(route));
  }
}

function criterionAnswered(
  criteria: ReturnType<typeof readCriteria>,
  field: 'dates' | 'budget' | 'room_type' | 'amenities' | 'distance',
): boolean {
  switch (field) {
    case 'dates': return criteria.dates.answered;
    case 'budget': return criteria.budget.answered;
    case 'room_type': return criteria.roomType.answered;
    case 'amenities': return criteria.amenities.answered;
    case 'distance': return criteria.distance.answered;
  }
}
