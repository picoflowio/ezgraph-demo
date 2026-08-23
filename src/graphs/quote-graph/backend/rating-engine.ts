import type {
  CoverageSelection,
  Deductible,
  DriverProfile,
  InsuranceHistory,
  LiabilityLevel,
  QuoteGraphNodes,
  QuoteTier,
  VehicleUse,
} from "../quote-graph.state.js";
import {
  addDays,
  parseUtcDate,
  utcDay,
  yearsBetween,
} from "./quote-clock.js";
import { VehicleCatalog, type CatalogVehicle } from "./vehicle-catalog.js";

export type RatingSubject = {
  driver: DriverProfile;
  vehicle: CatalogVehicle;
  use: VehicleUse;
  history: InsuranceHistory;
};

const LIABILITY_BASE: Record<LiabilityLevel, number> = {
  "state-minimum": 52,
  standard: 68,
  premium: 89,
};

const DEDUCTIBLE_FACTOR: Record<Deductible, number> = {
  250: 1.25,
  500: 1.0,
  1000: 0.8,
};

const EXTRA_COST: Record<CoverageSelection["extras"][number], number> = {
  rental: 12,
  roadside: 5,
};

/**
 * Deterministic monthly-premium rules. The conversation collects the inputs;
 * every dollar figure comes from here so quotes are reproducible in tests.
 */
export class RatingEngine {
  static riskFactor(subject: RatingSubject, at: Date): number {
    const age = yearsBetween(
      parseUtcDate(subject.driver.dateOfBirth) ?? at,
      at,
    );
    const ageFactor =
      age < 20 ? 1.9 : age < 25 ? 1.5 : age < 30 ? 1.2 : age < 65 ? 1.0 : 1.1;
    const experienceFactor = subject.driver.yearsLicensed < 3 ? 1.15 : 1;
    const statusFactor = subject.driver.licenseStatus === "permit" ? 1.25 : 1;
    const vehicleFactor = 0.9 + 0.08 * subject.vehicle.riskGroup;
    const mileage = subject.use.annualMileage;
    const mileageFactor =
      mileage <= 7500 ? 0.92 : mileage <= 12000 ? 1.0 : mileage <= 20000 ? 1.12 : 1.28;
    const parkingFactor =
      subject.use.parking === "garage"
        ? 0.95
        : subject.use.parking === "street"
          ? 1.07
          : 1.0;
    const counts = incidentCounts(subject.history);
    const incidentFactor =
      1 +
      0.35 * counts["at-fault-accident"] +
      0.15 * counts.violation +
      0.1 * counts["not-at-fault-accident"] +
      0.08 * counts["comprehensive-claim"];
    const lapseFactor = subject.history.coverageLapse ? 1.18 : 1;
    const insuredFactor = subject.history.currentlyInsured ? 0.95 : 1;
    const factor =
      ageFactor *
      experienceFactor *
      statusFactor *
      vehicleFactor *
      mileageFactor *
      parkingFactor *
      incidentFactor *
      lapseFactor *
      insuredFactor;
    return Math.min(4, Math.max(0.5, factor));
  }

  static monthlyPremium(
    subject: RatingSubject,
    coverage: CoverageSelection,
    at: Date,
  ): number {
    const valuePerThousand = subject.vehicle.msrp / 1000;
    let base = LIABILITY_BASE[coverage.liability];
    if (coverage.collisionDeductible !== null) {
      base += valuePerThousand * 1.1 * DEDUCTIBLE_FACTOR[coverage.collisionDeductible];
    }
    if (coverage.comprehensiveDeductible !== null) {
      base +=
        valuePerThousand * 0.55 * DEDUCTIBLE_FACTOR[coverage.comprehensiveDeductible];
    }
    const extras = coverage.extras.reduce(
      (sum, extra) => sum + EXTRA_COST[extra],
      0,
    );
    return roundCents(base * this.riskFactor(subject, at) + extras);
  }

  /**
   * Three tiers around the customer's selection: a cheaper variant, the exact
   * selection, and a fuller-protection variant.
   */
  static quoteTiers(
    subject: RatingSubject,
    selected: CoverageSelection,
    at: Date,
  ): QuoteTier[] {
    const saver: CoverageSelection = {
      ...selected,
      liability: stepDown(selected.liability),
      collisionDeductible: selected.collisionDeductible === null ? null : 1000,
      comprehensiveDeductible:
        selected.comprehensiveDeductible === null ? null : 1000,
      extras: [],
    };
    // Shield lowers existing deductibles to $250, or adds full coverage at
    // $500 when the customer chose liability-only.
    const shield: CoverageSelection = {
      ...selected,
      liability: "premium",
      collisionDeductible: selected.collisionDeductible === null ? 500 : 250,
      comprehensiveDeductible:
        selected.comprehensiveDeductible === null ? 500 : 250,
      extras: ["rental", "roadside"],
    };
    return [
      { tier: "saver", coverage: saver, monthlyPremium: this.monthlyPremium(subject, saver, at) },
      { tier: "selected", coverage: selected, monthlyPremium: this.monthlyPremium(subject, selected, at) },
      { tier: "shield", coverage: shield, monthlyPremium: this.monthlyPremium(subject, shield, at) },
    ];
  }
}

/** Returns an error for an invalid coverage combination, or null when legal. */
export function validateCoverageSelection(
  coverage: CoverageSelection,
  ownership: VehicleUse["ownership"],
  at: Date,
): string | null {
  const start = parseUtcDate(coverage.startDate);
  if (!start) {
    return "startDate must be a real calendar date in YYYY-MM-DD form.";
  }
  const today = utcDay(at);
  if (start < today) return "The coverage start date cannot be in the past.";
  if (start > addDays(today, 60)) {
    return "The coverage start date must be within the next 60 days.";
  }
  const fullCoverage =
    coverage.collisionDeductible !== null &&
    coverage.comprehensiveDeductible !== null;
  if ((ownership === "finance" || ownership === "lease") && !fullCoverage) {
    return "A financed or leased vehicle requires both collision and comprehensive coverage; the lender mandates full coverage.";
  }
  if (coverage.collisionDeductible !== null && coverage.comprehensiveDeductible === null) {
    return "Collision coverage requires comprehensive coverage as well.";
  }
  return null;
}

/** Assembles the rating input from earlier stages' persisted node state. */
export function buildRatingSubject(
  nodes: QuoteGraphNodes,
): { subject: RatingSubject } | { error: string } {
  const driver = nodes.DriverNode?.driver;
  const use = nodes.VehicleNode?.vehicle;
  const history = nodes.HistoryNode?.history;
  const vehicle = use ? VehicleCatalog.fetch(use.vehicleId) : undefined;
  if (!driver || !use || !vehicle || !history) {
    return {
      error:
        "Driver, vehicle, and history details must all be captured before rating.",
    };
  }
  return { subject: { driver, vehicle, use, history } };
}

function incidentCounts(
  history: InsuranceHistory,
): Record<IncidentTypeKey, number> {
  const counts: Record<IncidentTypeKey, number> = {
    "at-fault-accident": 0,
    "not-at-fault-accident": 0,
    violation: 0,
    "comprehensive-claim": 0,
  };
  for (const incident of history.incidents) counts[incident.type] += 1;
  return counts;
}

type IncidentTypeKey = InsuranceHistory["incidents"][number]["type"];

function stepDown(liability: LiabilityLevel): LiabilityLevel {
  if (liability === "premium") return "standard";
  return "state-minimum";
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
