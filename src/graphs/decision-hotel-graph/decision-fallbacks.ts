import { directTo, go } from '@picoflow/ezgraph';
import { readCriteria, renderHotelResults, validateCriteria } from './criteria.js';
import type { DecisionHotelGraphStateType } from './decision-hotel-graph.state.js';
import { criteriaNode, criteriaPrompt } from './routing.js';
import { PresentNode } from './nodes/present.node.js';
import { RouterDecisionNode } from './nodes/router-decision.node.js';
import { SearchHotelsNode } from './nodes/search-hotels.node.js';

export function presentationFallback(state: DecisionHotelGraphStateType) {
  return directTo(
    PresentNode,
    renderHotelResults(state.nodes.PresentNode?.hotelFound ?? []),
  );
}

export function criteriaFallback(state: DecisionHotelGraphStateType) {
  const issues = validateCriteria(readCriteria(state));
  return issues.length
    ? directTo(criteriaNode(issues[0]!.field), criteriaPrompt(issues[0]!.field))
    : go(SearchHotelsNode);
}

export function routerFallback(state: DecisionHotelGraphStateType) {
  const notice = state.nodes.RouterDecisionNode?.notice;
  if (notice) {
    return directTo(RouterDecisionNode, notice).withState({ notice: null });
  }
  const issues = validateCriteria(readCriteria(state));
  return issues.length
    ? directTo(criteriaNode(issues[0]!.field), criteriaPrompt(issues[0]!.field))
    : directTo(
        RouterDecisionNode,
        'Your saved criteria are ready. Say “search” to find hotels, or tell me what to revise.',
      );
}
