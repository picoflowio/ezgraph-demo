import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  Tool,
  go,
  stay,
  type ToolResponse,
  type ToolDefinition,
} from "@picoflow/ezgraph";
import {
  monthsBetween,
  parseUtcMonth,
  quoteNow,
} from "../backend/quote-clock.js";
import type {
  InsuranceHistory,
  QuoteGraphStateType,
} from "../quote-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  quotePrompt,
} from "../prompt/quote-prompt.js";
import { CoverageNode } from "./coverage.node.js";

type CaptureHistoryInput = {
  currentlyInsured: boolean;
  coverageLapse: boolean;
  incidents: {
    type:
    | "at-fault-accident"
    | "not-at-fault-accident"
    | "violation"
    | "comprehensive-claim";
    date: string;
  }[];
};

/** Third stage: captures incidents and prior-insurance facts in its own history space. */
export class HistoryNode extends ConversationNode<QuoteGraphStateType> {
  getPrompt(): string {
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.history, {
      CURRENT_DATE: quoteNow().toISOString().slice(0, 10),
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly ToolDefinition<CaptureHistoryInput>[] {
    return [
      {
        name: "capture_history",
        description:
          "Capture prior insurance status and all incidents from the last five years.",
        schema: z.object({
          currentlyInsured: z.boolean(),
          coverageLapse: z.boolean(),
          incidents: z
            .array(
              z.object({
                type: z.enum([
                  "at-fault-accident",
                  "not-at-fault-accident",
                  "violation",
                  "comprehensive-claim",
                ]),
                date: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM"),
              }),
            )
            .max(10),
        }),
      },
    ];
  }

  @Tool("capture_history")
  async captureHistory(
    input: CaptureHistoryInput,
  ): Promise<ToolResponse> {
    const now = quoteNow();
    for (const [index, incident] of input.incidents.entries()) {
      const month = parseUtcMonth(incident.date);
      if (!month) {
        return reject(`Incident ${index + 1}: '${incident.date}' is not a real month.`);
      }
      if (month > now) {
        return reject(`Incident ${index + 1} is dated in the future.`);
      }
      if (monthsBetween(month, now) > 60) {
        return reject(
          `Incident ${index + 1} is more than five years old; only the last five years affect this quote — drop it.`,
        );
      }
    }
    const history = {
      currentlyInsured: input.currentlyInsured,
      coverageLapse: input.coverageLapse,
      incidents: input.incidents,
    };
    this.saveState({ history });
    return go(CoverageNode).withMessage(
      new HumanMessage(
        "The history stage is complete. Collect the coverage preferences.",
      ),
    );
  }
}

function reject(error: string): ToolResponse {
  return stay(JSON.stringify({ accepted: false, error }));
}
