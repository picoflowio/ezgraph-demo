import type { CriteriaField } from './criteria.js';
import { AmenityNode } from './nodes/amenity.node.js';
import { BudgetNode } from './nodes/budget.node.js';
import { DateRangeNode } from './nodes/date-range.node.js';
import { DistanceNode } from './nodes/distance.node.js';
import { RoomTypeNode } from './nodes/room-type.node.js';

export function criteriaNode(field: CriteriaField) {
  switch (field) {
    case 'dates': return DateRangeNode;
    case 'budget': return BudgetNode;
    case 'room_type': return RoomTypeNode;
    case 'amenities': return AmenityNode;
    case 'distance': return DistanceNode;
  }
}

export function criteriaPrompt(field: CriteriaField): string {
  switch (field) {
    case 'dates': return 'What are your Portland check-in and checkout dates?';
    case 'budget': return 'What nightly budget range should I use?';
    case 'room_type': return 'Would you like one bed, two beds, or a suite?';
    case 'amenities': return 'Which hotel amenities do you require?';
    case 'distance': return 'Do you have an airport or city-center distance limit?';
  }
}
