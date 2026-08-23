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
