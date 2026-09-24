import type { DecisionHotelGraphStateType } from './decision-hotel-graph.state.js';
import type { SearchHotelEntry } from './hotel-search.js';

export const ROOM_TYPES = ['one bed', 'two beds', 'suite'] as const;
export const AMENITIES = [
  'freeWiFi', 'nonSmoking', 'freeBreakfast', 'freeParking', 'airportShuttle',
  'roomService', 'fitnessCenter', 'petFriendly', 'digitalKey', 'boutique',
  'onSiteRestaurant', 'indoorPool', 'businessCenter', 'meetingRoom',
  'evCharging', 'connectingRooms', 'eveningReception', 'concierge',
  'streaming', 'kitchen', 'tennis', 'outdoorPool', 'newHotel',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export type Amenity = (typeof AMENITIES)[number];
export type CriteriaField = 'dates' | 'budget' | 'room_type' | 'amenities' | 'distance';
export type CriteriaIssue = { field: CriteriaField; message: string };
export type HotelCriteriaSnapshot = {
  dates: { answered: boolean; start: string | null; end: string | null };
  budget: { answered: boolean; min: number | null; max: number | null };
  roomType: { answered: boolean; roomType: RoomType | null };
  amenities: { answered: boolean; amenities: Amenity[] };
  distance: { answered: boolean; airport: number | null; cityCenter: number | null };
};

export function readCriteria(state: DecisionHotelGraphStateType): HotelCriteriaSnapshot {
  const dates = state.nodes.DateRangeNode ?? {};
  const budget = state.nodes.BudgetNode ?? {};
  const room = state.nodes.RoomTypeNode ?? {};
  const amenities = state.nodes.AmenityNode ?? {};
  const distance = state.nodes.DistanceNode ?? {};
  return {
    dates: { answered: dates.answered === true, start: stringOrNull(dates.start), end: stringOrNull(dates.end) },
    budget: { answered: budget.answered === true, min: finiteOrNull(budget.min), max: finiteOrNull(budget.max) },
    roomType: { answered: room.answered === true, roomType: ROOM_TYPES.includes(room.roomType as RoomType) ? room.roomType as RoomType : null },
    amenities: { answered: amenities.answered === true, amenities: Array.isArray(amenities.amenities) ? amenities.amenities.filter((value): value is Amenity => AMENITIES.includes(value as Amenity)) : [] },
    distance: { answered: distance.answered === true, airport: finiteOrNull(distance.airport), cityCenter: finiteOrNull(distance.cityCenter) },
  };
}

export function validateCriteria(criteria: HotelCriteriaSnapshot): CriteriaIssue[] {
  const issues: CriteriaIssue[] = [];
  if (!criteria.dates.answered) issues.push({ field: 'dates', message: 'Stay dates have not been answered.' });
  else {
    const start = parseDate(criteria.dates.start);
    const end = parseDate(criteria.dates.end);
    if (!start || !end || end <= start) issues.push({ field: 'dates', message: 'Checkout must be after a valid check-in date.' });
    else if (start <= currentBusinessDate()) issues.push({ field: 'dates', message: 'Check-in must be after the current date.' });
  }
  if (!criteria.budget.answered) issues.push({ field: 'budget', message: 'Nightly budget has not been answered.' });
  else if ((criteria.budget.min !== null && criteria.budget.min < 0) || (criteria.budget.max !== null && criteria.budget.max < 0) || (criteria.budget.min !== null && criteria.budget.max !== null && criteria.budget.min > criteria.budget.max)) issues.push({ field: 'budget', message: 'Budget values must be nonnegative and minimum cannot exceed maximum.' });
  if (!criteria.roomType.answered || !criteria.roomType.roomType) issues.push({ field: 'room_type', message: 'Room type has not been answered.' });
  if (!criteria.amenities.answered) issues.push({ field: 'amenities', message: 'Amenity preferences have not been answered.' });
  if (!criteria.distance.answered) issues.push({ field: 'distance', message: 'Distance preferences have not been answered.' });
  else if ((criteria.distance.airport !== null && criteria.distance.airport < 0) || (criteria.distance.cityCenter !== null && criteria.distance.cityCenter < 0)) issues.push({ field: 'distance', message: 'Distance limits must be nonnegative.' });
  return issues;
}

export function renderCriteriaSummary(criteria: HotelCriteriaSnapshot): string {
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

export function renderHotelResults(hotels: readonly SearchHotelEntry[]): string {
  if (hotels.length === 0) return 'No hotels matched the current criteria. Tell me which criterion to revise.';
  return ['Here are the matching Portland hotels:', ...hotels.map((hotel, index) => `${index + 1}. ${hotel.hotelName} — total ${usd(hotel.total)}`), '', 'Reply with a hotel name or number to book, or tell me which search criterion to revise.'].join('\n');
}

export function currentBusinessDate(): Date {
  const date = new Date(process.env.HOTEL_GRAPH_CURRENT_DATE ?? new Date().toISOString());
  date.setUTCHours(0, 0, 0, 0);
  return date;
}
export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function finiteOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function usd(value: number): string { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value); }
