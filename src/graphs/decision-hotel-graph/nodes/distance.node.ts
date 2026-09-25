import { z } from "zod";
import {
  ConversationNode,
  Tool,
  go,
  stay,
  type ToolDefinition,
  type ToolResponse,
} from "@picoflow/ezgraph";
import type { DecisionHotelGraphStateType } from "../decision-hotel-graph.state.js";
import { hotelPrompts } from "../prompt/hotel-prompts.js";
import { RouterDecisionNode } from "./router-decision.node.js";

export class DistanceNode extends ConversationNode<DecisionHotelGraphStateType> {
  getPrompt(): string {
    return hotelPrompts.distance;
  }

  defineTool(): readonly ToolDefinition[] {
    return [
      {
        name: "capture_distance",
        description:
          "Save maximum airport and city-center miles; null means no limit.",
        schema: z.object({
          airport: z.number().finite().nullable(),
          cityCenter: z.number().finite().nullable(),
        }),
      },
    ];
  }

  @Tool("capture_distance")
  async captureDistance(input: {
    airport: number | null;
    cityCenter: number | null;
  }): Promise<ToolResponse> {
    if (
      (input.airport !== null && input.airport < 0) ||
      (input.cityCenter !== null && input.cityCenter < 0)
    ) {
      return stay("Distance limits cannot be negative.");
    }
    this.saveState({
      answered: true,
      airport: input.airport,
      cityCenter: input.cityCenter,
    });
    return go(RouterDecisionNode);
  }

  @Tool("reroute_request")
  async rerouteRequest(): Promise<ToolResponse> {
    return go(RouterDecisionNode);
  }
}
