import type { HotelSearchResult } from "../hotel-types.js";
import { HotelCatalog } from "./hotel-catalog.js";

type HotelPriceEntry = {
  basePrice: number;
  hotelName: string;
};

const US_PUBLIC_HOLIDAYS = [
  new Date(2025, 0, 1),
  nthWeekdayOfMonth(2025, 0, 1, 3),
  nthWeekdayOfMonth(2025, 1, 1, 3),
  lastWeekdayOfMonth(2025, 4, 1),
  new Date(2025, 6, 4),
  nthWeekdayOfMonth(2025, 8, 1, 1),
  nthWeekdayOfMonth(2025, 9, 1, 2),
  new Date(2025, 10, 11),
  nthWeekdayOfMonth(2025, 10, 4, 4),
  new Date(2025, 11, 25),
];

/** Pricing rules and catalog queries ported from the reference HotelFlow. */
export class PricingEngine {
  static searchHotel(
    startDate: Date,
    endDate: Date,
    amenities: string[],
    roomTypes: string[],
    maxBudget?: number,
    minBudget?: number,
    airport?: number,
    cityCenter?: number,
  ): HotelSearchResult[] {
    const hotels = HotelCatalog.search(
      amenities,
      roomTypes,
      airport,
      cityCenter,
    ).map((hotel) => ({
      hotelName: hotel.name,
      basePrice: hotel.level,
    }));

    return this.findHotelByBudget(
      startDate,
      endDate,
      roomTypes[0],
      hotels,
      maxBudget,
      minBudget,
    );
  }

  static fetchHotels(names: string[]) {
    return HotelCatalog.fetch(names).map((hotel) => ({
      hotelName: hotel.name,
      amenities: hotel.amenities,
      roomType: hotel.roomType,
      airport: hotel.nearby.airport,
      cityCenter: hotel.nearby.cityCenter,
    }));
  }

  static findHotelByBudget(
    startDate: Date,
    endDate: Date,
    roomType: string | undefined,
    hotels: HotelPriceEntry[],
    maxBudget?: number,
    minBudget?: number,
  ): HotelSearchResult[] {
    return hotels.flatMap((hotel) => {
      const prices = this.findPrices(
        startDate,
        endDate,
        hotel.basePrice,
        roomType,
      );
      if (prices.length === 0) return [];

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      if (maxBudget !== undefined && max > maxBudget) return [];
      if (minBudget !== undefined && min < minBudget) return [];
      return [
        {
          hotelName: hotel.hotelName,
          prices,
          total: prices.reduce((sum, price) => sum + price, 0),
        },
      ];
    });
  }

  static findPrices(
    startDate: Date,
    endDate: Date,
    basePrice: number,
    roomType?: string,
  ): number[] {
    return enumerateDates(startDate, endDate).flatMap((date) => {
      const price = this.findPriceOneDay(date, basePrice, roomType);
      return price === null ? [] : [price];
    });
  }

  static enumerateDateStrings(startDate: Date, endDate: Date): string[] {
    return enumerateDates(startDate, endDate).map((date) =>
      date.toISOString().slice(0, 10),
    );
  }

  private static findPriceOneDay(
    date: Date,
    basePrice: number,
    roomType?: string,
  ): number | null {
    const month = date.getUTCMonth();
    let priceMultiplier = 1.2;
    if (month === 9) priceMultiplier = 1.5;
    else if (month >= 3 && month <= 5) priceMultiplier = 1.4;
    else if (month >= 6 && month <= 8) priceMultiplier = 1.8;

    const isPublicHoliday = US_PUBLIC_HOLIDAYS.some(
      (holiday) =>
        holiday.getMonth() === month &&
        holiday.getDate() === date.getUTCDate(),
    );
    const holidayMultiplier = isPublicHoliday ? 1.2 : 1;
    const roomMultiplier =
      roomType === "two beds" ? 1.6 : roomType === "suite" ? 2.5 : 1;
    const weekday = date.getUTCDay();
    const weekendMultiplier = weekday === 0 || weekday === 6 ? 1.15 : 1;
    const price =
      basePrice *
      priceMultiplier *
      holidayMultiplier *
      roomMultiplier *
      weekendMultiplier;
    return price > 0 ? price : null;
  }
}

function enumerateDates(startDate: Date, endDate: Date): Date[] {
  let start = new Date(startDate);
  let end = new Date(endDate);
  if (!isValidDate(start) || !isValidDate(end)) return [];
  if (start > end) [start, end] = [end, start];

  const dates: Date[] = [];
  const current = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const last = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
  );
  while (current <= last) {
    dates.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  nth: number,
): Date {
  const first = new Date(year, month, 1);
  const offset = (7 + weekday - first.getDay()) % 7;
  return new Date(year, month, 1 + offset + (nth - 1) * 7);
}

function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
): Date {
  const last = new Date(year, month + 1, 0);
  last.setDate(last.getDate() - ((7 + last.getDay() - weekday) % 7));
  return last;
}
