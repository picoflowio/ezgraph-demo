import type { GraphNodeTarget } from '@picoflow/ezgraph';
import type { DecisionHotelGraphStateType } from './decision-hotel-graph.state.js';
import type { SearchHotelEntry } from './hotel-search.js';

export class CriteriaHelper {
  private static criteriaNodes: Readonly<Record<CriteriaField, GraphNodeTarget>> | null = null;

  static readonly ROOM_TYPES = ['one bed', 'two beds', 'suite'] as const;

  static readonly AMENITIES = [
    'freeWiFi', 'nonSmoking', 'freeBreakfast', 'freeParking', 'airportShuttle',
    'roomService', 'fitnessCenter', 'petFriendly', 'digitalKey', 'boutique',
    'onSiteRestaurant', 'indoorPool', 'businessCenter', 'meetingRoom',
    'evCharging', 'connectingRooms', 'eveningReception', 'concierge',
    'streaming', 'kitchen', 'tennis', 'outdoorPool', 'newHotel',
  ] as const;

  static readCriteria(state: DecisionHotelGraphStateType): HotelCriteriaSnapshot {
    const dates = state.nodes.DateRangeNode ?? {};
    const budget = state.nodes.BudgetNode ?? {};
    const room = state.nodes.RoomTypeNode ?? {};
    const amenities = state.nodes.AmenityNode ?? {};
    const distance = state.nodes.DistanceNode ?? {};
    return {
      dates: { answered: dates.answered === true, start: this.stringOrNull(dates.start), end: this.stringOrNull(dates.end) },
      budget: { answered: budget.answered === true, min: this.finiteOrNull(budget.min), max: this.finiteOrNull(budget.max) },
      roomType: { answered: room.answered === true, roomType: this.ROOM_TYPES.includes(room.roomType as RoomType) ? room.roomType as RoomType : null },
      amenities: { answered: amenities.answered === true, amenities: Array.isArray(amenities.amenities) ? amenities.amenities.filter((value): value is Amenity => this.AMENITIES.includes(value as Amenity)) : [] },
      distance: { answered: distance.answered === true, airport: this.finiteOrNull(distance.airport), cityCenter: this.finiteOrNull(distance.cityCenter) },
    };
  }

  static validateCriteria(criteria: HotelCriteriaSnapshot): CriteriaIssue[] {
    const issues: CriteriaIssue[] = [];
    if (!criteria.dates.answered) issues.push({ field: 'dates', message: 'Stay dates have not been answered.' });
    else {
      const start = this.parseDate(criteria.dates.start);
      const end = this.parseDate(criteria.dates.end);
      if (!start || !end || end <= start) issues.push({ field: 'dates', message: 'Checkout must be after a valid check-in date.' });
      else if (start <= this.currentBusinessDate()) issues.push({ field: 'dates', message: 'Check-in must be after the current date.' });
    }
    if (!criteria.budget.answered) issues.push({ field: 'budget', message: 'Nightly budget has not been answered.' });
    else if ((criteria.budget.min !== null && criteria.budget.min < 0) || (criteria.budget.max !== null && criteria.budget.max < 0) || (criteria.budget.min !== null && criteria.budget.max !== null && criteria.budget.min > criteria.budget.max)) issues.push({ field: 'budget', message: 'Budget values must be nonnegative and minimum cannot exceed maximum.' });
    if (!criteria.roomType.answered || !criteria.roomType.roomType) issues.push({ field: 'room_type', message: 'Room type has not been answered.' });
    if (!criteria.amenities.answered) issues.push({ field: 'amenities', message: 'Amenity preferences have not been answered.' });
    if (!criteria.distance.answered) issues.push({ field: 'distance', message: 'Distance preferences have not been answered.' });
    else if ((criteria.distance.airport !== null && criteria.distance.airport < 0) || (criteria.distance.cityCenter !== null && criteria.distance.cityCenter < 0)) issues.push({ field: 'distance', message: 'Distance limits must be nonnegative.' });
    return issues;
  }

  static renderCriteriaSummary(criteria: HotelCriteriaSnapshot): string {
    const budget = criteria.budget.answered
      ? criteria.budget.min === null && criteria.budget.max === null ? 'no preference' : `${criteria.budget.min === null ? 'no minimum' : `$${criteria.budget.min}`} to ${criteria.budget.max === null ? 'no maximum' : `$${criteria.budget.max}`}`
      : 'not set';
    const distances = [criteria.distance.airport === null ? null : `airport within ${criteria.distance.airport} miles`, criteria.distance.cityCenter === null ? null : `city center within ${criteria.distance.cityCenter} miles`].filter(Boolean);
    return [
      'Current Portland hotel criteria:',
      `- Dates: ${criteria.dates.answered ? `${criteria.dates.start} to ${criteria.dates.end}` : 'not set'}`,
      `- Nightly budget: ${budget}`,
      `- Room type: ${criteria.roomType.answered ? criteria.roomType.roomType : 'not set'}`,
      `- Amenities: ${criteria.amenities.answered ? (criteria.amenities.amenities.join(', ') || 'no preference') : 'not set'}`,
      `- Distance: ${criteria.distance.answered ? (distances.join('; ') || 'no preference') : 'not set'}`,
    ].join('\n');
  }

  static renderHotelResults(hotels: readonly SearchHotelEntry[]): string {
    if (hotels.length === 0) return 'No hotels matched the current criteria. Tell me which criterion to revise.';
    return [
      'Here are the matching Portland hotels:',
      ...hotels.map((hotel, index) => {
        const low = Math.min(...hotel.prices);
        const high = Math.max(...hotel.prices);
        return `${index + 1}. ${hotel.hotelName} — ${hotel.address} — nightly ${this.usd(low)}–${this.usd(high)} — total ${this.usd(hotel.total)}`;
      }),
      '',
      'Reply with a hotel name or number to book, or tell me which search criterion to revise.',
    ].join('\n');
  }

  static currentBusinessDate(): Date {
    const date = new Date(process.env.HOTEL_GRAPH_CURRENT_DATE ?? new Date().toISOString());
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }

  static parseDate(value: unknown): Date | null {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
  }

  static registerCriteriaNodes(nodes: Readonly<Record<CriteriaField, GraphNodeTarget>>): void {
    this.criteriaNodes = nodes;
  }

  static nextNode(field: CriteriaField): GraphNodeTarget;
  static nextNode(issue: CriteriaIssue): GraphNodeTarget;
  static nextNode(fieldOrIssue: CriteriaField | CriteriaIssue): GraphNodeTarget {
    const field = typeof fieldOrIssue === 'string' ? fieldOrIssue : fieldOrIssue.field;
    const node = this.criteriaNodes?.[field];
    if (!node) throw new Error(`Criteria node is not registered for field: ${field}`);
    return node;
  }

  static criteriaPrompt(field: CriteriaField): string {
    switch (field) {
      case 'dates': return 'What are your Portland check-in and checkout dates?';
      case 'budget': return 'What nightly budget range should I use?';
      case 'room_type': return 'Would you like one bed, two beds, or a suite?';
      case 'amenities': return 'Which hotel amenities do you require?';
      case 'distance': return 'Do you have an airport or city-center distance limit?';
    }
  }

  static criterionAnswered(criteria: HotelCriteriaSnapshot, field: CriteriaField): boolean {
    switch (field) {
      case 'dates': return criteria.dates.answered;
      case 'budget': return criteria.budget.answered;
      case 'room_type': return criteria.roomType.answered;
      case 'amenities': return criteria.amenities.answered;
      case 'distance': return criteria.distance.answered;
    }
  }

  private static stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private static finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private static usd(value: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  }
}

export type RoomType = (typeof CriteriaHelper.ROOM_TYPES)[number];
export type Amenity = (typeof CriteriaHelper.AMENITIES)[number];
export type CriteriaField = 'dates' | 'budget' | 'room_type' | 'amenities' | 'distance';
export type CriteriaIssue = { field: CriteriaField; message: string };
export type HotelCriteriaSnapshot = {
  dates: { answered: boolean; start: string | null; end: string | null };
  budget: { answered: boolean; min: number | null; max: number | null };
  roomType: { answered: boolean; roomType: RoomType | null };
  amenities: { answered: boolean; amenities: Amenity[] };
  distance: { answered: boolean; airport: number | null; cityCenter: number | null };
};
