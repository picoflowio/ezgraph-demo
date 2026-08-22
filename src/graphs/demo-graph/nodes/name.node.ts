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
import { InContextNode } from "./in-context.node.js";

type NameToolContext = { name?: string };
type NameNodeState = { name?: string };

export class NameNode extends ConversationNode<
  DemoGraphStateType,
  NameNodeState,
  NameToolContext
> {
  getPrompt(state: DemoGraphStateType): string {
    return `You are collecting the user's full name. When the user provides a usable full name, call recordName. If its result says it was rejected, explicitly say that the submitted name shown in the result cannot be accepted, then politely ask for another full name. If the user asks to stop, call terminate_session. ${state.inputConsumed ? "This stage has just started after the user's favorites were recorded. Briefly acknowledge that their favorites were recorded, then ask for the full name. Do not mention or repeat weather, temperatures, or earlier-stage answers; do not treat earlier conversation as a new name answer." : ""} Never mention internal tools, phases, schemas, or implementation details.`;
  }

  defineTool(): readonly ToolDefinition<{ name: string }>[] {
    return [
      {
        name: "recordName",
        description: "Record the full name supplied by the user.",
        schema: z.object({ name: z.string() }),
      },
    ];
  }

  @Tool("recordName")
  async recordName(
    { name }: { name: string },
    context: NameToolContext,
  ): Promise<ConversationToolResult> {
    const submitted = name.trim();
    const accepted = !!submitted && submitted.toLowerCase() !== "john doe";
    if (accepted) context.name = submitted;
    return {
      output: {
        accepted,
        name: submitted,
        reason: accepted ? undefined : "That name is not accepted.",
      },
      stopAfterBatch: accepted,
    };
  }

  protected createContext(
    _state: DemoGraphStateType,
  ): NameToolContext {
    return {};
  }

  protected nextStep(
    _state: DemoGraphStateType,
    context: NameToolContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<DemoGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.name) {
      return this.advance(InContextNode, conversation).withState({
        name: context.name,
      });
    }
    return this.stay(conversation);
  }
}
