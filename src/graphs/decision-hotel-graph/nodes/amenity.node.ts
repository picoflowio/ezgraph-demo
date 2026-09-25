import { z } from "zod";
import {
  ConversationNode,
  Tool,
  go,
  type ToolDefinition,
  type ToolResponse,
} from "@picoflow/ezgraph";
import { CriteriaHelper, type Amenity } from "../criteria-helper.js";
import type { DecisionHotelGraphStateType } from "../decision-hotel-graph.state.js";
import { hotelPrompts } from "../prompt/hotel-prompts.js";
import { RouterDecisionNode } from "./router-decision.node.js";

export class AmenityNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(): string {
    return hotelPrompts.amenities;
  }

  defineTool(): readonly ToolDefinition[] {
    return [
      {
        name: "capture_amenities",
        description: "Save one or more required hotel amenities.",
        schema: z.object({
          amenities: z.array(z.enum(CriteriaHelper.AMENITIES)).min(1),
        }),
      },
      {
        name: "capture_no_amenity_preference",
        description:
          "Record that the user explicitly has no amenity preference.",
        schema: z.object({}),
      },
    ];
  }

  @Tool("capture_amenities")
  async captureAmenities(input: {
    amenities: Amenity[];
  }): Promise<ToolResponse> {
    this.saveState({
      answered: true,
      amenities: [...new Set(input.amenities)],
    });
    return go(RouterDecisionNode);
  }

  @Tool("capture_no_amenity_preference")
  async captureNoAmenityPreference(): Promise<ToolResponse> {
    this.saveState({ answered: true, amenities: [] });
    return go(RouterDecisionNode);
  }

  @Tool("reroute_request")
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}
