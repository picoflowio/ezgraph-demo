/**
 * Date arithmetic for the quote graph. `QUOTE_GRAPH_CURRENT_DATE` pins "today"
 * so prompts, validation, and tests stay reproducible.
 */
export function quoteNow(): Date {
  const configured = process.env.QUOTE_GRAPH_CURRENT_DATE;
  if (configured) {
    const pinned = new Date(configured);
    if (!Number.isNaN(pinned.getTime())) return pinned;
  }
  return new Date();
}

/** Strictly parses YYYY-MM-DD into a UTC date; rejects overflow like 2027-02-30. */
export function parseUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return roundTrips ? date : null;
}

/** Strictly parses YYYY-MM into the first day of that UTC month. */
export function parseUtcMonth(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Whole years between two dates, month- and day-aware (an age calculation). */
export function yearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const anniversaryNotReached =
    to.getUTCMonth() < from.getUTCMonth() ||
    (to.getUTCMonth() === from.getUTCMonth() &&
      to.getUTCDate() < from.getUTCDate());
  if (anniversaryNotReached) years -= 1;
  return years;
}

/** Whole months between two dates at month precision (days ignored). */
export function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}

/** Truncates a date to its UTC calendar day. */
export function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
