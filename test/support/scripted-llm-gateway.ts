import type { LlmGateway } from "ezgraph";
import type { ZodType } from "zod";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { GraphLlmConfig } from "ezgraph";
import type { LlmGatewayTool, LlmGatewayToolCall } from "ezgraph";
import type { ModelResult, TokenUsage } from "ezgraph";
import { ModelCatalog, modelExecution } from "ezgraph";

type WeatherDecision = { cities: string[]; message: string };
type FavoritesDecision = {
  favoriteColor: string | null;
  favoriteMovie: string | null;
  favoriteSeason: string | null;
  message: string;
};
type NameDecision = { name: string | null; message: string };
type DobDecision = {
  year: number | null;
  month: number | null;
  day: number | null;
  message: string;
};
type ScriptedAddress = {
  street: string;
  city: string;
  state: string;
  zip: string;
};
type AddressDecision = { address: ScriptedAddress | null; message: string };
type MovieIdea = {
  title: string;
  genre: string;
  releaseYear: number;
  rating: number;
  summary: string;
};

export class ScriptedLlmGateway implements LlmGateway {
  activeGenerations = 0;
  maxActiveGenerations = 0;
  responseHistories: BaseMessage[][] = [];
  agentHistories: BaseMessage[][] = [];
  private nextFailure: Error | undefined;

  failNextCall(error: Error): void {
    this.nextFailure = error;
  }

  async structured<T extends Record<string, unknown>>(
    _schema: ZodType<T>,
    systemPrompt: string,
    input: string,
    name: string,
    llmConfig: GraphLlmConfig = SCRIPTED_LLM_CONFIG,
    _history?: readonly BaseMessage[],
  ): Promise<ModelResult<T>> {
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      throw error;
    }
    let result: ModelResult<unknown>;
    switch (name) {
      case "weather_decision":
        result = await this.weather(input);
        break;
      case "favorites_decision":
        result = await this.favorites(input);
        break;
      case "name_decision":
        result = await this.name(input);
        break;
      case "dob_decision":
        result = await this.dob(input);
        break;
      case "address_decision":
        result = await this.address(input);
        break;
      case "movie_idea":
        result = await this.movieIdea();
        break;
      default:
        throw new Error(`No scripted structured result for '${name}'.`);
    }
    return {
      ...result,
      execution: modelExecution(llmConfig),
    } as ModelResult<T>;
  }

  async weather(input: string): Promise<ModelResult<WeatherDecision>> {
    return withUsage({
      cities: ["LA", "NYC"].filter((city) =>
        input.toUpperCase().includes(city),
      ),
      message: "Please enter LA and NYC.",
    });
  }

  async favorites(input: string): Promise<ModelResult<FavoritesDecision>> {
    const lower = input.toLowerCase();
    return withUsage({
      favoriteColor:
        ["red", "blue", "white"].find((value) => lower.includes(value)) ?? null,
      favoriteMovie: lower.includes("matrix") ? "The Matrix" : null,
      favoriteSeason:
        ["spring", "summer", "autumn", "winter"].find((value) =>
          lower.includes(value),
        ) ?? null,
      message: "Please provide all three favorites.",
    });
  }

  async name(input: string): Promise<ModelResult<NameDecision>> {
    return withUsage({
      name: input.trim() || null,
      message: "What is your full name?",
    });
  }

  async dob(input: string): Promise<ModelResult<DobDecision>> {
    const match = input.match(/(\d{4})-(\d{2})-(\d{2})/);
    return withUsage({
      year: match ? Number(match[1]) : null,
      month: match ? Number(match[2]) : null,
      day: match ? Number(match[3]) : null,
      message: "Please provide a valid complete date of birth.",
    });
  }

  async address(input: string): Promise<ModelResult<AddressDecision>> {
    return withUsage({
      address: parseScriptedAddress(input),
      message: "Please provide a valid US address.",
    });
  }

  async movieIdea(): Promise<ModelResult<MovieIdea>> {
    return withUsage({
      title: "Orbit High",
      genre: "Science fiction",
      releaseYear: 2027,
      rating: 8,
      summary: "Students save their orbital school.",
    });
  }

  async generate(
    systemPrompt: string,
    _userPrompt?: string,
    llmConfig: GraphLlmConfig = SCRIPTED_LLM_CONFIG,
  ): Promise<ModelResult<string>> {
    this.activeGenerations += 1;
    this.maxActiveGenerations = Math.max(
      this.maxActiveGenerations,
      this.activeGenerations,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.activeGenerations -= 1;
    return withUsage(
      `${systemPrompt.match(/ConcurStep\d/)?.[0] ?? "Task"} complete.`,
      llmConfig,
    );
  }

  async respond(
    systemPrompt: string,
    history: readonly BaseMessage[],
    llmConfig: GraphLlmConfig = SCRIPTED_LLM_CONFIG,
  ): Promise<ModelResult<string>> {
    this.responseHistories.push([...history]);
    return withUsage(scriptedResponse(systemPrompt), llmConfig);
  }

  async agent(
    systemPrompt: string,
    history: readonly BaseMessage[],
    tools: readonly LlmGatewayTool[],
    llmConfig: GraphLlmConfig = SCRIPTED_LLM_CONFIG,
  ): Promise<ModelResult<AIMessage>> {
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      throw error;
    }
    this.agentHistories.push([...history]);
    const latestInput = [...history]
      .reverse()
      .find((message) => HumanMessage.isInstance(message));
    const input =
      latestInput && typeof latestInput.content === "string"
        ? latestInput.content
        : "";
    const hasEndResult = hasToolResultAfterLatestInput(
      history,
      "terminate_session",
    );
    if (hasEndResult) {
      return withUsage(
        new AIMessage("Of course. This conversation is now complete."),
        llmConfig,
      );
    }

    if (
      wantsToExit(input) &&
      tools.some(({ name }) => name === "terminate_session")
    ) {
      return withUsage(
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "end-chat",
              name: "terminate_session",
              args: {},
              type: "tool_call",
            },
          ],
        }),
        llmConfig,
      );
    }

    if (systemPrompt.includes("This stage has just started")) {
      if (tools.some(({ name }) => name === "recordName"))
        return withUsage(new AIMessage("What is your full name?"), llmConfig);
      if (tools.some(({ name }) => name === "recordDateOfBirth"))
        return withUsage(
          new AIMessage("What is your date of birth?"),
          llmConfig,
        );
      if (tools.some(({ name }) => name === "recordAddress"))
        return withUsage(new AIMessage("What is your US address?"), llmConfig);
    }

    const cities = ["LA", "NYC"].filter((city) =>
      input.toUpperCase().includes(city),
    );
    const hasWeatherResult = hasToolResultAfterLatestInput(
      history,
      "getCityTemperature",
    );
    if (
      cities.length > 0 &&
      !hasWeatherResult &&
      tools.some(({ name }) => name === "getCityTemperature")
    ) {
      return withUsage(
        new AIMessage({
          content: "",
          tool_calls: cities.map((city) => ({
            id: `weather-${city}`,
            name: "getCityTemperature",
            args: { city },
            type: "tool_call" as const,
          })),
        }),
        llmConfig,
      );
    }

    if (tools.some(({ name }) => name === "recordFavorites")) {
      if (hasToolResultAfterLatestInput(history, "recordFavorites")) {
        return withUsage(
          new AIMessage("Please provide all three favorites."),
          llmConfig,
        );
      }
      const favoriteColor = ["red", "blue", "white"].find((value) =>
        input.toLowerCase().includes(value),
      );
      const favoriteSeason = ["spring", "summer", "autumn", "winter"].find(
        (value) => input.toLowerCase().includes(value),
      );
      const favoriteMovie = input.toLowerCase().includes("matrix")
        ? "The Matrix"
        : undefined;
      if (favoriteColor || favoriteSeason || favoriteMovie)
        return toolMessage(
          "record-favorites",
          "recordFavorites",
          {
            ...(favoriteColor ? { favoriteColor } : {}),
            ...(favoriteMovie ? { favoriteMovie } : {}),
            ...(favoriteSeason ? { favoriteSeason } : {}),
          },
          llmConfig,
        );
      return withUsage(
        new AIMessage(
          "What are your favorite color, favorite movie, and favorite season?",
        ),
        llmConfig,
      );
    }

    if (tools.some(({ name }) => name === "recordName")) {
      if (hasToolResultAfterLatestInput(history, "recordName")) {
        return withUsage(
          new AIMessage(
            "I cannot accept John Doe. Please choose a different full name.",
          ),
          llmConfig,
        );
      }
      if (input.trim())
        return toolMessage(
          "record-name",
          "recordName",
          { name: input.trim() },
          llmConfig,
        );
      return withUsage(new AIMessage("What is your full name?"), llmConfig);
    }

    if (tools.some(({ name }) => name === "recordMovieIdea")) {
      return toolMessage(
        "record-movie-idea",
        "recordMovieIdea",
        {
          title: "Orbit High",
          genre: "Science fiction",
          releaseYear: 2027,
          rating: 8,
          summary: "Students save their orbital school.",
        },
        llmConfig,
      );
    }

    if (tools.some(({ name }) => name === "recordDateOfBirth")) {
      if (hasToolResultAfterLatestInput(history, "recordDateOfBirth"))
        return withUsage(
          new AIMessage("Please provide a valid complete date of birth."),
          llmConfig,
        );
      const match = input.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (match)
        return toolMessage(
          "record-dob",
          "recordDateOfBirth",
          {
            year: Number(match[1]),
            month: Number(match[2]),
            day: Number(match[3]),
          },
          llmConfig,
        );
      return withUsage(new AIMessage("What is your date of birth?"), llmConfig);
    }

    if (tools.some(({ name }) => name === "recordAddress")) {
      if (hasToolResultAfterLatestInput(history, "recordAddress")) {
        const accepted = toolResultAccepted(history, "recordAddress");
        return withUsage(
          new AIMessage(
            accepted
              ? "Address collected successfully."
              : "Please provide a valid US address.",
          ),
          llmConfig,
        );
      }
      const address = parseScriptedAddress(input);
      if (address)
        return toolMessage(
          "record-address",
          "recordAddress",
          address,
          llmConfig,
        );
      return withUsage(
        new AIMessage("Please provide a valid US address."),
        llmConfig,
      );
    }

    return withUsage(
      new AIMessage(
        cities.length === 1 || hasWeatherResult
          ? "Please also provide the other supported city so I can compare temperatures."
          : "Please enter LA and NYC so I can compare their current-day temperatures.",
      ),
      llmConfig,
    );
  }

  async toolCall(
    _systemPrompt: string,
    input: string,
    tools: readonly LlmGatewayTool[],
    llmConfig: GraphLlmConfig = SCRIPTED_LLM_CONFIG,
    _history?: readonly BaseMessage[],
  ): Promise<ModelResult<LlmGatewayToolCall | undefined>> {
    const canEndChat = tools.some(({ name }) => name === "terminate_session");
    return withUsage(
      canEndChat && wantsToExit(input)
        ? { name: "terminate_session", args: {} }
        : undefined,
      llmConfig,
    );
  }
}

function toolMessage(
  id: string,
  name: string,
  args: Record<string, unknown>,
  llmConfig: GraphLlmConfig,
): ModelResult<AIMessage> {
  return withUsage(
    new AIMessage({
      content: "",
      tool_calls: [{ id, name, args, type: "tool_call" }],
    }),
    llmConfig,
  );
}

function hasToolResultAfterLatestInput(
  history: readonly BaseMessage[],
  name: string,
): boolean {
  const latestHuman =
    history
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => HumanMessage.isInstance(message))
      .at(-1)?.index ?? -1;
  return history
    .slice(latestHuman + 1)
    .some(
      (message) => ToolMessage.isInstance(message) && message.name === name,
    );
}

function toolResultAccepted(
  history: readonly BaseMessage[],
  name: string,
): boolean {
  const result = [...history]
    .reverse()
    .find(
      (message) => ToolMessage.isInstance(message) && message.name === name,
    );
  if (!result || typeof result.content !== "string") return false;
  try {
    return JSON.parse(result.content).accepted === true;
  } catch {
    return false;
  }
}

function scriptedResponse(systemPrompt: string): string {
  const outcome = systemPrompt.slice(
    systemPrompt.indexOf("Current turn outcome:") +
      "Current turn outcome:".length,
  );
  if (outcome.includes("not accepted")) {
    return "I cannot accept John Doe. Please choose a different full name.";
  }
  if (outcome.includes("asked to end the conversation")) {
    return "Of course. This conversation is now complete.";
  }
  if (outcome.includes("conversation is complete")) {
    return "Address collected successfully.";
  }
  if (outcome.includes("address is invalid or incomplete")) {
    return "Please provide a valid US address.";
  }
  if (outcome.includes("complete US mailing address")) {
    return "What is your US address?";
  }
  if (outcome.includes("date of birth is incomplete")) {
    return "Please provide a valid complete date of birth.";
  }
  if (outcome.includes("complete date of birth")) {
    return "What is your date of birth?";
  }
  if (outcome.includes("full name")) {
    return "What is your full name?";
  }
  if (outcome.includes("favorites are incomplete")) {
    return "Please provide all three favorites.";
  }
  if (outcome.includes("favorite color, movie, and season")) {
    return "What are your favorite color, favorite movie, and favorite season?";
  }
  if (outcome.includes("required city information")) {
    return "Please enter LA and NYC.";
  }
  if (outcome.includes("supported city or cities needed")) {
    return "Please enter LA and NYC so I can compare their current-day temperatures.";
  }
  throw new Error(`No scripted conversational response for '${systemPrompt}'.`);
}

export const SCRIPTED_TOKEN_USAGE: TokenUsage = {
  input_tokens: 10,
  output_tokens: 4,
  thinking_tokens: 1,
  tool_input_tokens: 2,
  cached_input_tokens: 3,
  total_tokens: 14,
};

const SCRIPTED_LLM_CONFIG: GraphLlmConfig = ModelCatalog.model(
  "scripted:scripted-model",
  { retries: 0, temperature: 0 },
);

function withUsage<T>(
  value: T,
  llmConfig: GraphLlmConfig = SCRIPTED_LLM_CONFIG,
): ModelResult<T> {
  return {
    value,
    usage: { ...SCRIPTED_TOKEN_USAGE },
    execution: modelExecution(llmConfig),
  };
}

function wantsToExit(input: string): boolean {
  return /\b(exit|quit|stop)\b/i.test(input);
}

function parseScriptedAddress(input: string): ScriptedAddress | null {
  const match = input.match(
    /^(.+?),\s*(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/,
  );
  if (!match) return null;
  const [, street, city, state, zip] = match;
  if (!street || !city || !state || !zip) return null;
  return {
    street: street.trim(),
    city: city.trim(),
    state: state.toUpperCase(),
    zip,
  };
}
