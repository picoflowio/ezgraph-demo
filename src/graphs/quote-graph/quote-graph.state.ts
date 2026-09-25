import { createGraphStateAnnotation } from "@picoflow/ezgraph";
import type { NodeStateValue } from "@picoflow/ezgraph";
import { DriverNode } from "./nodes/driver.node.js";

export type DriverProfile = {
  fullName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** Two-letter U.S. state code, uppercase. */
  licenseState: string;
  licenseStatus: "valid" | "permit";
  yearsLicensed: number;
};

export type VehicleUse = {
  /** Catalog vehicle id resolved during the vehicle stage. */
  vehicleId: string;
  ownership: "own" | "finance" | "lease";
  annualMileage: number;
  parking: "garage" | "driveway" | "street";
};

export type IncidentType =
  | "at-fault-accident"
  | "not-at-fault-accident"
  | "violation"
  | "comprehensive-claim";

export type IncidentRecord = {
  type: IncidentType;
  /** YYYY-MM, within the last five years. */
  date: string;
};

export type InsuranceHistory = {
  currentlyInsured: boolean;
  coverageLapse: boolean;
  incidents: IncidentRecord[];
};

export type LiabilityLevel = "state-minimum" | "standard" | "premium";
export type Deductible = 250 | 500 | 1000;
export type CoverageExtra = "rental" | "roadside";

export type CoverageSelection = {
  liability: LiabilityLevel;
  /** null means no collision coverage (liability-only). */
  collisionDeductible: Deductible | null;
  comprehensiveDeductible: Deductible | null;
  extras: CoverageExtra[];
  /** YYYY-MM-DD, today through +60 days. */
  startDate: string;
};

export type QuoteTierName = "saver" | "selected" | "shield";

export type QuoteTier = {
  tier: QuoteTierName;
  coverage: CoverageSelection;
  monthlyPremium: number;
};

export type QuoteGraphNodes = {
  DriverNode?: NodeStateValue<{ driver?: DriverProfile }>;
  VehicleNode?: NodeStateValue<{
    resolvedVehicleId?: string;
    vehicle?: VehicleUse;
  }>;
  HistoryNode?: NodeStateValue<{ history?: InsuranceHistory }>;
  CoverageNode?: NodeStateValue<{ coverage?: CoverageSelection }>;
  QuoteNode?: NodeStateValue<{
    tiers?: QuoteTier[];
    acceptedTier?: QuoteTierName;
    referenceNumber?: string;
  }>;
};

/** Domain state owned by one quote node, excluding framework metadata. */
export type QuoteGraphNodeState<NodeName extends keyof QuoteGraphNodes> = Omit<
  NonNullable<QuoteGraphNodes[NodeName]>,
  "model"
>;

export const QuoteGraphState = createGraphStateAnnotation(
  DriverNode.name,
  () => ({}) as QuoteGraphNodes,
);

export type QuoteGraphStateType = typeof QuoteGraphState.State;
