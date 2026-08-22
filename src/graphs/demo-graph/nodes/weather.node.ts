import { z } from "zod";
import {
  ConversationNode,
  ModelCatalog,
  Tool,
  type ConversationNodeRunResult,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import type { GraphLlmConfigOverride } from "ezgraph";
import type { ConversationToolResult } from "ezgraph";
import type { DemoGraphStateType } from "../demo-graph.state.js";
import { FavoritesNode } from "./favorites.node.js";
import { FooLogicNode } from "./foo-logic.node.js";

type WeatherNodeState = { weather?: Record<string, number> };
type WeatherToolContext = { weather: Record<string, number> };

export class WeatherNode extends ConversationNode<
  DemoGraphStateType,
  WeatherNodeState,
  WeatherToolContext
> {
  getPrompt(_state: DemoGraphStateType): string {
    return "You are a personal travel assistant helping the user compare the current-day temperatures of LA and NYC. This demo supports LA and NYC only. In your initial question, explicitly state that LA and NYC are the only supported cities. Ask naturally for the cities needed for the comparison. When the user names an unsupported city, explicitly say that named city is unsupported, explain that only LA and NYC are supported, and directly ask the user to provide supported city names, specifically LA or NYC; do not phrase this as only a yes/no question. When the user supplies LA or NYC, call getCityTemperature once for each supplied supported city before replying. After a tool result, use it to continue the conversation. If the user asks to stop, call terminate_session. Never mention internal tools, phases, schemas, or implementation details.";
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("google:gemini-3.5-flash", {
      retries: 3,
      temperature: 0.2,
    });
  }

  defineTool(): readonly ToolDefinition<{ city: string }>[] {
    return [
      {
        name: "getCityTemperature",
        description: "Return the demo temperature for LA or NYC.",
        schema: z.object({ city: z.string() }),
      },
    ];
  }

  @Tool("getCityTemperature")
  async getCityTemperature(
    { city }: { city: string },
    context: WeatherToolContext,
  ): Promise<ConversationToolResult> {
    const normalized = city.trim().toUpperCase();
    const temperature =
      ({ nyc: 83, la: 72 } as Record<string, number>)[
        city.trim().toLowerCase()
      ] ?? null;
    const weather = { ...context.weather };
    if (temperature !== null && (normalized === "LA" || normalized === "NYC")) {
      weather[normalized] = temperature;
    }
    return this.toolResult({ temperature })
      .withContext({ weather })
      .stopAfterBatchWhen(this.hasBothCities(weather));
  }

  protected createContext(state: DemoGraphStateType): WeatherToolContext {
    const weather: Record<string, number> = {
      ...(this.state(state).weather ?? {}),
    };
    return { weather };
  }

  protected nextStep(
    _state: DemoGraphStateType,
    context: WeatherToolContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<DemoGraphStateType> {
    const { weather } = context;
    if (conversation.quitRequested) {
      return this.quit(conversation).withState({ weather });
    }
    if (this.hasBothCities(weather)) {
      return this.advance(FavoritesNode, conversation)
        .via(FooLogicNode)
        .withState({ weather });
    }
    return this.stay(conversation).withState({ weather });
  }

  private hasBothCities(weather: Record<string, number>): boolean {
    return weather.LA !== undefined && weather.NYC !== undefined;
  }
}
