import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type GraphLlmConfigOverride,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import { AppModelCatalog } from "../../../config/app-model-catalog.js";
import type { DemoGraphStateType } from "../demo-graph.state.js";
import type { ConversationToolResult } from "ezgraph";
import { NameNode } from "./name.node.js";

type Favorites = Partial<{
  favoriteColor: string | undefined;
  favoriteMovie: string | undefined;
  favoriteSeason: string | undefined;
}>;

type FavoritesNodeState = { favorites?: Favorites };
type FavoritesToolContext = { favorites: Favorites };

export class FavoritesNode extends ConversationNode<
  DemoGraphStateType,
  FavoritesNodeState,
  FavoritesToolContext
> {
  // getLlmConfig(): GraphLlmConfigOverride {
  //   return AppModelCatalog.model("glm:glm-5.1", {
  //     retries: 3,
  //     temperature: 0.2,
  //   });
  // }

  getPrompt(state: DemoGraphStateType): string {
    return `You are collecting a favorite color, favorite movie, and favorite season. The only valid colors are red, blue, and white. The only valid seasons are spring, summer, autumn, and winter. Existing recorded values are ${JSON.stringify(this.state(state).favorites ?? {})}. ${state.inputConsumed ? "This stage has just started after the weather comparison. Begin the user-facing reply by explicitly saying that LA and NYC are supported, then ask for favorites. Do not repeat or report the temperatures, even though they appear in the conversation history. Do not treat earlier messages as favorite answers." : ""} When the user supplies one or more values, call recordFavorites with just those values. Keep valid existing values unless the user explicitly replaces them. After a recordFavorites result, ask naturally only for values still missing or invalid. If the user asks to stop, call terminate_session. Never mention internal tools, phases, schemas, or implementation details.`;
  }

  defineTool(): readonly ToolDefinition<Favorites>[] {
    return [
      {
        name: "recordFavorites",
        description:
          "Record any favorite color, movie, or season the user supplied.",
        schema: z.object({
          favoriteColor: z.string().optional(),
          favoriteMovie: z.string().optional(),
          favoriteSeason: z.string().optional(),
        }),
      },
    ];
  }

  @Tool("recordFavorites")
  async recordFavorites(
    submitted: Favorites,
    context: FavoritesToolContext,
  ): Promise<ConversationToolResult> {
    context.favorites = {
      ...context.favorites,
      ...(submitted.favoriteColor
        ? { favoriteColor: submitted.favoriteColor.toLowerCase() }
        : {}),
      ...(submitted.favoriteMovie
        ? { favoriteMovie: submitted.favoriteMovie }
        : {}),
      ...(submitted.favoriteSeason
        ? { favoriteSeason: submitted.favoriteSeason.toLowerCase() }
        : {}),
    };
    const valid = this.isComplete(context.favorites);
    return {
      output: {
        accepted: valid,
        favorites: context.favorites,
        missing: this.missingFavorites(context.favorites),
      },
      stopAfterBatch: valid,
    };
  }

  protected createContext(state: DemoGraphStateType): FavoritesToolContext {
    return {
      favorites: {
        ...(this.state(state).favorites ?? {}),
      },
    };
  }

  protected nextStep(
    _state: DemoGraphStateType,
    context: FavoritesToolContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<DemoGraphStateType> {
    const { favorites } = context;
    if (conversation.quitRequested) {
      return this.quit(conversation).withState({ favorites });
    }
    if (this.isComplete(favorites)) {
      return this.advance(NameNode, conversation).withState({ favorites });
    }
    return this.stay(conversation).withState({ favorites });
  }

  private isComplete(favorites: Favorites): boolean {
    return (
      ["red", "blue", "white"].includes(favorites.favoriteColor ?? "") &&
      ["spring", "summer", "autumn", "winter"].includes(
        favorites.favoriteSeason ?? "",
      ) &&
      !!favorites.favoriteMovie
    );
  }

  private missingFavorites(favorites: Favorites): string[] {
    return [
      !["red", "blue", "white"].includes(favorites.favoriteColor ?? "")
        ? "favorite color (red, blue, or white)"
        : undefined,
      !favorites.favoriteMovie ? "favorite movie" : undefined,
      !["spring", "summer", "autumn", "winter"].includes(
        favorites.favoriteSeason ?? "",
      )
        ? "favorite season (spring, summer, autumn, or winter)"
        : undefined,
    ].filter((value): value is string => !!value);
  }
}
