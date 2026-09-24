import { readFileSync } from 'node:fs';

const load = (name: string) =>
  readFileSync(new URL(`${name}.md`, import.meta.url), 'utf8').trim();

export const hotelPrompts = {
  amenities: load('amenities'),
  budget: load('budget'),
  criteriaJudge: load('criteria-judge'),
  dates: load('date-range'),
  distance: load('distance'),
  present: load('present'),
  presentationJudge: load('presentation-judge'),
  roomType: load('room-type'),
  router: load('router'),
} as const;

export function fillHotelPrompt(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
}
