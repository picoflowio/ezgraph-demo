import { z } from "zod";
import {
  GraphNode,
  Tool,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import type { DemoGraphStateType } from "../demo-graph.state.js";
import type { ConversationToolResult } from "ezgraph";
import { DobNode } from "./dob.node.js";

const MovieIdeaSchema = z.object({
  title: z.string(),
  genre: z.string(),
  releaseYear: z.number().int(),
  rating: z.number().min(0).max(10),
  summary: z.string(),
});
type MovieIdea = z.infer<typeof MovieIdeaSchema>;
type MovieToolContext = { movieIdea?: MovieIdea };
type InContextNodeState = { movieIdea?: MovieIdea };

export class InContextNode extends GraphNode<
  DemoGraphStateType,
  InContextNodeState,
  MovieToolContext
> {
  getPrompt(_state: DemoGraphStateType): string {
    return "Generate one original sci-fi movie idea suitable for teens, then call recordMovieIdea with its title, genre, release year, rating from 0 to 10, and summary. Do not send a user-facing message before recording it. Never mention internal tools, phases, schemas, or implementation details.";
  }

  defineTool(): readonly ToolDefinition<MovieIdea>[] {
    return [
      {
        name: "recordMovieIdea",
        description: "Record the original movie idea generated for the user.",
        schema: MovieIdeaSchema,
      },
    ];
  }

  @Tool("recordMovieIdea")
  async recordMovieIdea(
    submitted: MovieIdea,
    context: MovieToolContext,
  ): Promise<ConversationToolResult> {
    context.movieIdea = submitted;
    return {
      output: { accepted: true, movieIdea: context.movieIdea },
      stopAfterBatch: true,
    };
  }

  async run(
    state: DemoGraphStateType,
  ): Promise<GraphNodeUpdate<DemoGraphStateType>> {
    const context: MovieToolContext = {};
    const conversation = await this.runConversation(state, context);
    if (!context.movieIdea)
      throw new Error("Movie idea agent did not record an idea.");
    // Persist the next conversational resume point; fixed edges still run
    // ParallelNode and its child fan-out in this invocation.
    return this.resumeAt(DobNode, conversation).withState({
      movieIdea: context.movieIdea,
    });
  }
}
