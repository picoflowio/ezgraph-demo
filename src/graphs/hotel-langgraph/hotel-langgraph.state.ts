import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type {
  HotelComparisonRow,
  HotelSearchCriteria,
  HotelSearchResult,
} from "./hotel-types.js";

export type HotelLanggraphPhase =
  | "explore"
  | "present"
  | "compare"
  | "terminal";

export type HotelLanggraphRoute =
  | "exploreAgent"
  | "presentAgent"
  | "compareAgent"
  | "end";

const replace = <T>(_: T, next: T): T => next;
const appendMessages = (
  current: BaseMessage[],
  update: BaseMessage | BaseMessage[],
): BaseMessage[] => current.concat(Array.isArray(update) ? update : [update]);

export const HotelLanggraphState = Annotation.Root({
  phase: Annotation<HotelLanggraphPhase>({
    reducer: replace,
    default: () => "explore",
  }),
  route: Annotation<HotelLanggraphRoute>({
    reducer: replace,
    default: () => "end",
  }),
  completed: Annotation<boolean>({ reducer: replace, default: () => false }),
  response: Annotation<string>({ reducer: replace, default: () => "" }),
  userInput: Annotation<string>({ reducer: replace, default: () => "" }),
  inputConsumed: Annotation<boolean>({
    reducer: replace,
    default: () => false,
  }),
  config: Annotation<Record<string, unknown>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  criteria: Annotation<HotelSearchCriteria | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  hotelFound: Annotation<HotelSearchResult[]>({
    reducer: replace,
    default: () => [],
  }),
  availableHotels: Annotation<string[]>({
    reducer: replace,
    default: () => [],
  }),
  selectedHotels: Annotation<string[]>({
    reducer: replace,
    default: () => [],
  }),
  lastComparison: Annotation<HotelComparisonRow[]>({
    reducer: replace,
    default: () => [],
  }),
  bookedHotel: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  confirmationNumber: Annotation<number | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  exploreMessages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
  presentMessages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
  compareMessages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
});

export type HotelLanggraphStateType = typeof HotelLanggraphState.State;
export type HotelLanggraphStateUpdate = typeof HotelLanggraphState.Update;
