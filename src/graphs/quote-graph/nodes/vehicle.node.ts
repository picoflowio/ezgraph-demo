import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "@picoflow/ezgraph";
import { VehicleCatalog } from "../backend/vehicle-catalog.js";
import type {
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

type VehicleContext = {
  resolvedVehicleId?: string;
  use?: VehicleUse;
};

/** Second stage: resolves the vehicle against the catalog and captures its use. */
export class VehicleNode extends ConversationNode<
  QuoteGraphStateType,
  { resolvedVehicleId?: string; vehicle?: VehicleUse },
  VehicleContext
> {
  getPrompt(state: QuoteGraphStateType): string {
    const resolvedId = this.state(state).resolvedVehicleId;
    const resolved = resolvedId ? VehicleCatalog.fetch(resolvedId) : undefined;
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.vehicle, {
      RESOLVED_VEHICLE: JSON.stringify(resolved ?? null),
    })}\n\n${endChatInstruction}`;
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
    context: VehicleContext,
  ): Promise<ConversationToolResult> {
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
      return {
        output: {
          accepted: false,
          needsTrim: true,
          candidates: matches.map((candidate) => ({
            vehicleId: candidate.id,
            trim: candidate.trim,
          })),
          error: "Several trims match; ask the customer which one.",
        },
      };
    }
    const vehicle = matches[0]!;
    context.resolvedVehicleId = vehicle.id;
    return { output: { accepted: true, vehicle } };
  }

  @Tool("capture_vehicle_use")
  async captureVehicleUse(
    input: CaptureVehicleUseInput,
    context: VehicleContext,
  ): Promise<ConversationToolResult> {
    if (input.vehicleId !== context.resolvedVehicleId) {
      return reject(
        "Resolve the vehicle with resolve_vehicle before capturing its use.",
      );
    }
    context.use = {
      vehicleId: input.vehicleId,
      ownership: input.ownership,
      annualMileage: input.annualMileage,
      parking: input.parking,
    };
    return { output: { accepted: true, use: context.use }, stopAfterBatch: true };
  }

  protected createContext(state: QuoteGraphStateType): VehicleContext {
    const resolvedVehicleId = this.state(state).resolvedVehicleId;
    return resolvedVehicleId ? { resolvedVehicleId } : {};
  }

  protected nextStep(
    _state: QuoteGraphStateType,
    context: VehicleContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<QuoteGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.use) {
      return this.advance(HistoryNode, conversation)
        .withState({
          resolvedVehicleId: context.use.vehicleId,
          vehicle: context.use,
        })
        .withHistory(
          "quote-incidents",
          new HumanMessage("Collect the driving and insurance history."),
        );
    }
    if (context.resolvedVehicleId) {
      return this.stay(conversation).withState({
        resolvedVehicleId: context.resolvedVehicleId,
      });
    }
    return this.stay(conversation);
  }
}

function reject(error: string): ConversationToolResult {
  return { output: { accepted: false, error } };
}
