import { createGraphStateAnnotation, type NodeStateValue } from '@picoflow/ezgraph';
import { RouterDecisionNode } from './nodes/router-decision.node.js';
import type { HotelCriteriaSnapshot } from './criteria-helper.js';
import type { SearchHotelEntry } from './hotel-search.js';

export type DecisionHotelGraphNodes = {
  RouterDecisionNode?: NodeStateValue<{
    notice?: string | null;
    lastRoute?: string;
    lastDecision?: object;
  }>;
  DateRangeNode?: NodeStateValue<{ answered?: boolean; start?: string | null; end?: string | null }>;
  BudgetNode?: NodeStateValue<{ answered?: boolean; min?: number | null; max?: number | null }>;
  RoomTypeNode?: NodeStateValue<{ answered?: boolean; roomType?: 'one bed' | 'two beds' | 'suite' | null }>;
  AmenityNode?: NodeStateValue<{ answered?: boolean; amenities?: string[] }>;
  DistanceNode?: NodeStateValue<{ answered?: boolean; airport?: number | null; cityCenter?: number | null }>;
  CriteriaReadinessDecisionNode?: NodeStateValue<{ review?: object; accepted?: boolean }>;
  PresentNode?: NodeStateValue<{
    hotelFound?: SearchHotelEntry[];
    criteria?: HotelCriteriaSnapshot;
    criteriaReviewAccepted?: boolean;
    draft?: string;
    selectedHotel?: string;
    confirmationNumber?: number;
  }>;
  PresentationDecisionNode?: NodeStateValue<{ review?: object; accepted?: boolean }>;
};

export const DecisionHotelGraphState = createGraphStateAnnotation(
  RouterDecisionNode.name,
  () => ({} as DecisionHotelGraphNodes),
);

export type DecisionHotelGraphStateType = typeof DecisionHotelGraphState.State;
