import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  CriteriaHelper,
  type Amenity,
  type HotelCriteriaSnapshot,
  type RoomType,
} from "../criteria-helper.js";

export type SearchHotelEntry = {
  hotelName: string;
  address: string;
  amenities: Amenity[];
  roomType: RoomType;
  distance: { airport: number; cityCenter: number };
  prices: number[];
  total: number;
};

type Hotel = {
  name: string;
  address: string;
  amenities: Amenity[];
  level: number;
  roomTypes: RoomType[];
  airport: number;
  cityCenter: number;
};

const rawHotelSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  amenities: z
    .record(z.string(), z.boolean())
    .refine(
      (amenities) =>
        Object.keys(amenities).every((amenity) =>
          CriteriaHelper.AMENITIES.includes(amenity as Amenity),
        ),
      "Hotel catalog contains an unsupported amenity",
    ),
  level: z.number().positive(),
  roomType: z.array(z.enum(CriteriaHelper.ROOM_TYPES)).min(1),
  nearby: z.object({
    airport: z.number().nonnegative(),
    cityCenter: z.number().nonnegative(),
  }),
});

const HOTELS: Hotel[] = z
  .array(rawHotelSchema)
  .parse(
    JSON.parse(
      readFileSync(new URL("./hotels.json", import.meta.url), "utf8"),
    ),
  )
  .map((hotel) => ({
    name: hotel.name,
    address: hotel.address,
    amenities: Object.entries(hotel.amenities).flatMap(([amenity, enabled]) =>
      enabled && CriteriaHelper.AMENITIES.includes(amenity as Amenity)
        ? [amenity as Amenity]
        : [],
    ),
    level: hotel.level,
    roomTypes: hotel.roomType,
    airport: hotel.nearby.airport,
    cityCenter: hotel.nearby.cityCenter,
  }));

export function searchHotels(
  criteria: HotelCriteriaSnapshot,
): SearchHotelEntry[] {
  const start = new Date(`${criteria.dates.start}T00:00:00.000Z`);
  const end = new Date(`${criteria.dates.end}T00:00:00.000Z`);
  const roomType = criteria.roomType.roomType!;
  return HOTELS.filter((hotel) =>
    criteria.amenities.amenities.every((amenity) =>
      hotel.amenities.includes(amenity),
    ),
  )
    .filter((hotel) => hotel.roomTypes.includes(roomType))
    .filter(
      (hotel) =>
        criteria.distance.airport === null ||
        hotel.airport < criteria.distance.airport,
    )
    .filter(
      (hotel) =>
        criteria.distance.cityCenter === null ||
        hotel.cityCenter < criteria.distance.cityCenter,
    )
    .flatMap((hotel) => {
      const prices = enumerateDates(start, end).map((date) =>
        nightlyPrice(date, hotel.level, roomType),
      );
      const low = Math.min(...prices);
      const high = Math.max(...prices);
      if (criteria.budget.min !== null && low < criteria.budget.min) return [];
      if (criteria.budget.max !== null && high > criteria.budget.max) return [];
      return [
        {
          hotelName: hotel.name,
          address: hotel.address,
          amenities: hotel.amenities,
          roomType,
          distance: { airport: hotel.airport, cityCenter: hotel.cityCenter },
          prices,
          total: prices.reduce((sum, price) => sum + price, 0),
        },
      ];
    });
}

function nightlyPrice(date: Date, base: number, roomType: RoomType): number {
  const month = date.getUTCMonth();
  const seasonal =
    month >= 5 && month <= 8
      ? 1.8
      : month >= 3 && month <= 5
        ? 1.4
        : month === 9
          ? 1.5
          : 1.2;
  const room = roomType === "suite" ? 2.5 : roomType === "two beds" ? 1.6 : 1;
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? 1.15 : 1;
  return base * seasonal * room * weekend;
}
function enumerateDates(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  for (
    const date = new Date(start);
    date <= end;
    date.setUTCDate(date.getUTCDate() + 1)
  )
    dates.push(new Date(date));
  return dates;
}
