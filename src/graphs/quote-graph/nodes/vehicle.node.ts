import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  Tool,
  go,
  stay,
  type ToolResponse,
  type ToolDefinition,
} from "@picoflow/ezgraph";
import { VehicleCatalog } from "../backend/vehicle-catalog.js";
import type {
  QuoteGraphNodeState,
  QuoteGraphStateType,
  VehicleUse,
} from "../quote-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  quotePrompt,
} from "../prompt/quote-prompt.js";
import { HistoryNode } from "./history.node.js";

type ResolveVehicleInput = {
  year: number;
  make: string;
  model: string;
  trim?: string | undefined;
};

type CaptureVehicleUseInput = {
  vehicleId: string;
  ownership: "own" | "finance" | "lease";
  annualMileage: number;
  parking: "garage" | "driveway" | "street";
};

/** Second stage: resolves the vehicle against the catalog and captures its use. */
export class VehicleNode extends ConversationNode<QuoteGraphStateType> {
  getPrompt(state: QuoteGraphStateType): string {
    const local = this.state(state) as QuoteGraphNodeState<"VehicleNode">;
    const resolvedId = local.resolvedVehicleId;
    const resolved = resolvedId ? VehicleCatalog.fetch(resolvedId) : undefined;
    const driver = state.nodes.DriverNode?.driver;
    const transitionAcknowledgement = state.inputConsumed && driver
      ? `This stage has just started after recording the driver's details. Your user-facing reply must begin by briefly confirming this saved record before asking any question: ${driver.fullName}, born ${driver.dateOfBirth}, has a ${driver.licenseStatus} ${driver.licenseState} license and ${driver.yearsLicensed} years licensed. Then ask for the vehicle's year, make, and model. Do not treat earlier messages as vehicle answers.`
      : "";
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.vehicle, {
      RESOLVED_VEHICLE: JSON.stringify(resolved ?? null),
    })}\n\n${transitionAcknowledgement}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly (
    | ToolDefinition<ResolveVehicleInput>
    | ToolDefinition<CaptureVehicleUseInput>
  )[] {
    return [
      {
        name: "resolve_vehicle",
        description:
          "Look the vehicle up in the ratable-vehicle catalog by year, make, and model.",
        schema: z.object({
          year: z.number().int().min(1990).max(2035),
          make: z.string().min(1),
          model: z.string().min(1),
          trim: z.string().min(1).optional(),
        }),
      },
      {
        name: "capture_vehicle_use",
        description:
          "Capture ownership, mileage, and parking for the resolved vehicle.",
        schema: z.object({
          vehicleId: z.string().min(1),
          ownership: z.enum(["own", "finance", "lease"]),
          annualMileage: z.number().int().min(1000).max(60000),
          parking: z.enum(["garage", "driveway", "street"]),
        }),
      },
    ];
  }

  @Tool("resolve_vehicle")
  async resolveVehicle(
    input: ResolveVehicleInput,
  ): Promise<ToolResponse> {
    const matches = VehicleCatalog.search(input);
    if (matches.length === 0) {
      const years = VehicleCatalog.yearsFor(input.make, input.model);
      if (years.length > 0) {
        return reject(
          `No ${input.year} ${input.make} ${input.model} is in the catalog; supported years for that model: ${years.join(", ")}.`,
        );
      }
      return reject(
        `That vehicle cannot be rated. Supported vehicles: ${VehicleCatalog.summarize()}.`,
      );
    }
    if (matches.length > 1) {
      return stay(JSON.stringify({
        accepted: false,
        needsTrim: true,
        candidates: matches.map((candidate) => ({
          vehicleId: candidate.id,
          trim: candidate.trim,
        })),
        error: "Several trims match; ask the customer which one.",
      }));
    }
    const vehicle = matches[0]!;
    this.saveState({ resolvedVehicleId: vehicle.id });
    return stay(JSON.stringify({ accepted: true, vehicle }));
  }

  @Tool("capture_vehicle_use")
  async captureVehicleUse(
    input: CaptureVehicleUseInput,
  ): Promise<ToolResponse> {
    const local = this.getState() as QuoteGraphNodeState<"VehicleNode">;
    if (input.vehicleId !== local.resolvedVehicleId) {
      return reject(
        "Resolve the vehicle with resolve_vehicle before capturing its use.",
      );
    }
    const vehicle = {
      vehicleId: input.vehicleId,
      ownership: input.ownership,
      annualMileage: input.annualMileage,
      parking: input.parking,
    };
    this.saveState({ resolvedVehicleId: vehicle.vehicleId, vehicle });
    return go(HistoryNode).withMessage(
      new HumanMessage("Collect the driving and insurance history."),
    );
  }
}

function reject(error: string): ToolResponse {
  return stay(JSON.stringify({ accepted: false, error }));
}
