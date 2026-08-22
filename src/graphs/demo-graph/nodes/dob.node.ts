import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import type { DemoGraphStateType } from "../demo-graph.state.js";
import type { ConversationToolResult } from "ezgraph";
import { AddressNode } from "./address.node.js";

type Dob = { year: number; month: number; day: number };
type DobToolContext = { dob?: Dob };
type DobNodeState = { jokes?: string[]; dob?: Dob };

export class DobNode extends ConversationNode<
  DemoGraphStateType,
  DobNodeState,
  DobToolContext
> {
  getPrompt(state: DemoGraphStateType): string {
    return `You are collecting a complete date of birth. When the user supplies an unambiguous date, call recordDateOfBirth with numeric year, month, and day. After a rejected date result, ask naturally for a complete valid date. If the user asks to stop, call terminate_session. ${state.inputConsumed ? "This stage has just started; do not treat earlier conversation as a new answer. Ask for the date of birth now, without mentioning the internal movie-idea enrichment." : ""} Never mention internal tools, phases, schemas, or implementation details.`;
  }

  defineTool(): readonly ToolDefinition<Dob>[] {
    return [
      {
        name: "recordDateOfBirth",
        description: "Record a complete numeric date of birth.",
        schema: z.object({
          year: z.number().int(),
          month: z.number().int(),
          day: z.number().int(),
        }),
      },
    ];
  }

  @Tool("recordDateOfBirth")
  async recordDateOfBirth(
    submitted: Dob,
    context: DobToolContext,
  ): Promise<ConversationToolResult> {
    const accepted = this.isValidDate(
      submitted.year,
      submitted.month,
      submitted.day,
    );
    if (accepted) context.dob = submitted;
    return {
      output: {
        accepted,
        dob: submitted,
        reason: accepted ? undefined : "The date is not valid.",
      },
      stopAfterBatch: accepted,
    };
  }

  protected createContext(
    _state: DemoGraphStateType,
  ): DobToolContext {
    return {};
  }

  protected nextStep(
    state: DemoGraphStateType,
    context: DobToolContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<DemoGraphStateType> {
    const jokes = this.childJokes(state);
    if (conversation.quitRequested) {
      return this.quit(conversation).withState({ jokes });
    }
    if (context.dob) {
      return this.advance(AddressNode, conversation).withState({
        jokes,
        dob: context.dob,
      });
    }
    return this.stay(conversation).withState({ jokes });
  }

  private isValidDate(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  private childJokes(state: DemoGraphStateType): string[] {
    return [
      (state.nodes.Child1Node as { joke?: string } | undefined)?.joke,
      (state.nodes.Child2Node as { joke?: string } | undefined)?.joke,
    ].filter((joke): joke is string => Boolean(joke));
  }
}
