import type { Amenity, HotelCriteriaSnapshot, RoomType } from './criteria.js';

export type SearchHotelEntry = { hotelName: string; prices: number[]; total: number };
type Hotel = { name: string; amenities: Amenity[]; level: number; roomTypes: RoomType[]; airport: number; cityCenter: number };

const HOTELS: Hotel[] = [
  { name: 'Hampton Inn & Suites Portland Tigard', amenities: ['freeWiFi', 'freeParking', 'freeBreakfast', 'indoorPool', 'fitnessCenter'], level: 116, roomTypes: ['one bed', 'two beds', 'suite'], airport: 19, cityCenter: 8.5 },
  { name: 'Hilton Garden Inn Portland Airport', amenities: ['freeWiFi', 'freeParking', 'airportShuttle', 'onSiteRestaurant', 'fitnessCenter'], level: 128, roomTypes: ['one bed', 'two beds', 'suite'], airport: 3, cityCenter: 10.7 },
  { name: 'Hilton Garden Inn Beaverton', amenities: ['freeWiFi', 'freeParking', 'onSiteRestaurant', 'fitnessCenter'], level: 102, roomTypes: ['one bed', 'two beds', 'suite'], airport: 22, cityCenter: 10 },
  { name: 'The Porter Portland, Curio Collection by Hilton', amenities: ['freeWiFi', 'indoorPool', 'fitnessCenter', 'onSiteRestaurant'], level: 120, roomTypes: ['one bed', 'two beds', 'suite'], airport: 12.4, cityCenter: 0.5 },
];

export function searchHotels(criteria: HotelCriteriaSnapshot): SearchHotelEntry[] {
  const start = new Date(`${criteria.dates.start}T00:00:00.000Z`);
  const end = new Date(`${criteria.dates.end}T00:00:00.000Z`);
  const roomType = criteria.roomType.roomType!;
  return HOTELS
    .filter((hotel) => criteria.amenities.amenities.every((amenity) => hotel.amenities.includes(amenity)))
    .filter((hotel) => hotel.roomTypes.includes(roomType))
    .filter((hotel) => criteria.distance.airport === null || hotel.airport < criteria.distance.airport)
    .filter((hotel) => criteria.distance.cityCenter === null || hotel.cityCenter < criteria.distance.cityCenter)
    .flatMap((hotel) => {
      const prices = enumerateDates(start, end).map((date) => nightlyPrice(date, hotel.level, roomType));
      const low = Math.min(...prices);
      const high = Math.max(...prices);
      if (criteria.budget.min !== null && low < criteria.budget.min) return [];
      if (criteria.budget.max !== null && high > criteria.budget.max) return [];
      return [{ hotelName: hotel.name, prices, total: prices.reduce((sum, price) => sum + price, 0) }];
    });
}

function nightlyPrice(date: Date, base: number, roomType: RoomType): number {
  const month = date.getUTCMonth();
  const seasonal = month >= 5 && month <= 8 ? 1.8 : month >= 3 && month <= 5 ? 1.4 : month === 9 ? 1.5 : 1.2;
  const room = roomType === 'suite' ? 2.5 : roomType === 'two beds' ? 1.6 : 1;
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1.15 : 1;
  return base * seasonal * room * weekend;
}
function enumerateDates(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) dates.push(new Date(date));
  return dates;
}
