import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphNodeUpdate,
  type ToolDefinition,
} from "ezgraph";
import { quoteNow } from "../backend/quote-clock.js";
import {
  RatingEngine,
  buildRatingSubject,
  validateCoverageSelection,
} from "../backend/rating-engine.js";
import type {
  CoverageExtra,
  CoverageSelection,
  Deductible,
  LiabilityLevel,
  QuoteGraphStateType,
  QuoteTier,
} from "../quote-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  quotePrompt,
} from "../prompt/quote-prompt.js";
import { QuoteNode } from "./quote.node.js";

type SelectCoverageInput = {
  liability: LiabilityLevel;
  collisionDeductible: Deductible | null;
  comprehensiveDeductible: Deductible | null;
  extras: CoverageExtra[];
  startDate: string;
};

type CoverageContext = {
  coverage?: CoverageSelection;
  tiers?: QuoteTier[];
};

const deductibleSchema = z.union([
  z.literal(250),
  z.literal(500),
  z.literal(1000),
  z.null(),
]);

/** Fourth stage: coverage selections, validated against ownership rules. */
export class CoverageNode extends ConversationNode<
  QuoteGraphStateType,
  { coverage?: CoverageSelection },
  CoverageContext
> {
  getPrompt(state: QuoteGraphStateType): string {
    const ownership = state.nodes.VehicleNode?.vehicle?.ownership ?? "own";
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.coverage, {
      CURRENT_DATE: quoteNow().toISOString().slice(0, 10),
      OWNERSHIP: ownership,
    })}\n\n${endChatInstruction}`;
  }

  defineTool(): readonly ToolDefinition<SelectCoverageInput>[] {
    return [
      {
        name: "select_coverage",
        description:
          "Capture the complete coverage selection and produce quote tiers.",
        schema: z.object({
          liability: z.enum(["state-minimum", "standard", "premium"]),
          collisionDeductible: deductibleSchema,
          comprehensiveDeductible: deductibleSchema,
          extras: z.array(z.enum(["rental", "roadside"])).max(2),
          startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
        }),
      },
    ];
  }

  @Tool("select_coverage")
  async selectCoverage(
    input: SelectCoverageInput,
    context: CoverageContext,
    state: QuoteGraphStateType,
  ): Promise<ConversationToolResult> {
    const use = state.nodes.VehicleNode?.vehicle;
    if (!use) {
      return reject("Vehicle details are missing; complete the vehicle stage first.");
    }
    const coverage: CoverageSelection = {
      liability: input.liability,
      collisionDeductible: input.collisionDeductible,
      comprehensiveDeductible: input.comprehensiveDeductible,
      extras: [...new Set(input.extras)],
      startDate: input.startDate,
    };
    const now = quoteNow();
    const error = validateCoverageSelection(coverage, use.ownership, now);
    if (error) return reject(error);
    const rating = buildRatingSubject(state.nodes);
    if ("error" in rating) return reject(rating.error);
    context.coverage = coverage;
    context.tiers = RatingEngine.quoteTiers(rating.subject, coverage, now);
    return { output: { accepted: true }, stopAfterBatch: true };
  }

  protected createContext(): CoverageContext {
    return {};
  }

  protected nextStep(
    _state: QuoteGraphStateType,
    context: CoverageContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<QuoteGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.coverage && context.tiers) {
      return this.advance(QuoteNode, conversation)
        .withState({ coverage: context.coverage })
        .withStateFor(QuoteNode, { tiers: context.tiers })
        .withHistory(
          "quote-present",
          new HumanMessage("Present the quote tiers."),
        );
    }
    return this.stay(conversation);
  }
}

function reject(error: string): ConversationToolResult {
  return { output: { accepted: false, error } };
}
