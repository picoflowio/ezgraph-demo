import { readFileSync } from "node:fs";

export type CatalogVehicle = {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  bodyStyle: string;
  /** 1 (lowest premium impact) to 5 (highest). */
  riskGroup: number;
  msrp: number;
};

const vehicles = JSON.parse(
  readFileSync(new URL("../data/vehicles.json", import.meta.url), "utf8"),
) as CatalogVehicle[];

/** Local vehicle catalog used by this self-contained demo graph. */
export class VehicleCatalog {
  static search(criteria: {
    year: number;
    make: string;
    model: string;
    trim?: string | undefined;
  }): CatalogVehicle[] {
    const make = normalize(criteria.make);
    const model = normalize(criteria.model);
    const trim = criteria.trim === undefined ? null : normalize(criteria.trim);
    return vehicles.filter(
      (vehicle) =>
        vehicle.year === criteria.year &&
        normalize(vehicle.make) === make &&
        normalize(vehicle.model) === model &&
        (trim === null || normalize(vehicle.trim) === trim),
    );
  }

  static fetch(id: string): CatalogVehicle | undefined {
    return vehicles.find((vehicle) => vehicle.id === id);
  }

  /** Model years available for a make and model, for "wrong year" errors. */
  static yearsFor(make: string, model: string): number[] {
    const wantedMake = normalize(make);
    const wantedModel = normalize(model);
    return [
      ...new Set(
        vehicles
          .filter(
            (vehicle) =>
              normalize(vehicle.make) === wantedMake &&
              normalize(vehicle.model) === wantedModel,
          )
          .map((vehicle) => vehicle.year),
      ),
    ].sort();
  }

  /** Distinct supported vehicles, for "not in catalog" errors. */
  static summarize(): string {
    return [
      ...new Set(
        vehicles.map(
          (vehicle) => `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        ),
      ),
    ].join("; ");
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
