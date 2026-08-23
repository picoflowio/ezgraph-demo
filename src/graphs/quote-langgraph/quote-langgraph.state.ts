import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type {
  CoverageSelection,
  DriverProfile,
  InsuranceHistory,
  QuoteTier,
  QuoteTierName,
  VehicleUse,
} from "./quote-types.js";

export type QuoteLanggraphPhase =
  | "driver"
  | "vehicle"
  | "history"
  | "coverage"
  | "quote"
  | "terminal";

export type QuoteLanggraphRoute =
  | "driverAgent"
  | "vehicleAgent"
  | "historyAgent"
  | "coverageAgent"
  | "quoteAgent"
  | "end";

const replace = <T>(_: T, next: T): T => next;
const appendMessages = (
  current: BaseMessage[],
  update: BaseMessage | BaseMessage[],
): BaseMessage[] => current.concat(Array.isArray(update) ? update : [update]);

/**
 * Three independent message channels mirror the three history spaces the
 * EZGraph QuoteGraph declares: intake (driver, vehicle, coverage), incidents
 * (history), and present (quote).
 */
export const QuoteLanggraphState = Annotation.Root({
  phase: Annotation<QuoteLanggraphPhase>({
    reducer: replace,
    default: () => "driver",
  }),
  route: Annotation<QuoteLanggraphRoute>({
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
  driver: Annotation<DriverProfile | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  resolvedVehicleId: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  vehicle: Annotation<VehicleUse | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  history: Annotation<InsuranceHistory | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  coverage: Annotation<CoverageSelection | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  tiers: Annotation<QuoteTier[]>({ reducer: replace, default: () => [] }),
  acceptedTier: Annotation<QuoteTierName | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  referenceNumber: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
  intakeMessages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
  incidentsMessages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
  presentMessages: Annotation<BaseMessage[], BaseMessage | BaseMessage[]>({
    reducer: appendMessages,
    default: () => [],
  }),
});

export type QuoteLanggraphStateType = typeof QuoteLanggraphState.State;
export type QuoteLanggraphStateUpdate = typeof QuoteLanggraphState.Update;
