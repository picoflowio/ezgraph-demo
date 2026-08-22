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
import { ManualConcurrentNode } from "./manual-concurrent.node.js";

type Address = { street: string; city: string; state: string; zip: string };
type AddressToolContext = { address?: Address };
type AddressNodeState = { address?: Address };

export class AddressNode extends ConversationNode<
  DemoGraphStateType,
  AddressNodeState,
  AddressToolContext
> {
  getPrompt(state: DemoGraphStateType): string {
    return `You are collecting a US mailing address. When the user supplies one, call recordAddress with separate street, city, two-letter state, and ZIP fields. After a rejected result, ask naturally for the missing or invalid parts. After an accepted result, explicitly say that the address was accepted or successfully recorded, then confirm that the profile collection and conversation are complete; do not ask a follow-up question or offer further help. If the user asks to stop, call terminate_session. ${state.inputConsumed ? "This stage has just started after a valid date of birth. Acknowledge that the date of birth was accepted, then ask for a complete US mailing address. Do not treat earlier conversation as a new address answer." : ""} Never mention internal tools, phases, schemas, or implementation details.`;
  }

  defineTool(): readonly ToolDefinition<Address>[] {
    return [
      {
        name: "recordAddress",
        description:
          "Record a US mailing address with separate street, city, state, and ZIP fields.",
        schema: z.object({
          street: z.string(),
          city: z.string(),
          state: z.string(),
          zip: z.string(),
        }),
      },
    ];
  }

  @Tool("recordAddress")
  async recordAddress(
    submitted: Address,
    context: AddressToolContext,
  ): Promise<ConversationToolResult> {
    const accepted = this.isValidAddress(submitted);
    if (accepted) context.address = submitted;
    return {
      output: {
        accepted,
        address: submitted,
        reason: accepted
          ? undefined
          : "A street, city, two-letter state, and ZIP code are required.",
      },
    };
  }

  protected createContext(
    _state: DemoGraphStateType,
  ): AddressToolContext {
    return {};
  }

  protected nextStep(
    _state: DemoGraphStateType,
    context: AddressToolContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<DemoGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.address) {
      return this.finish(conversation.response ?? "", conversation)
        .via(ManualConcurrentNode)
        .withState({ address: context.address });
    }
    return this.stay(conversation);
  }

  private isValidAddress(address: Address): boolean {
    return (
      !!address.street.trim() &&
      !!address.city.trim() &&
      /^[A-Za-z]{2}$/.test(address.state.trim()) &&
      /^\d{5}(?:-\d{4})?$/.test(address.zip.trim())
    );
  }
}
