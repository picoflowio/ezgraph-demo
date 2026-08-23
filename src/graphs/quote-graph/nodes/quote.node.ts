import { z } from "zod";
import {
  ConversationNode,
  ModelCatalog,
  Tool,
  type ConversationNodeRunResult,
  type ConversationToolResult,
  type GraphLlmConfigOverride,
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
  QuoteTierName,
} from "../quote-graph.state.js";
import {
  endChatInstruction,
  fillPrompt,
  quotePrompt,
} from "../prompt/quote-prompt.js";
import { CoverageNode } from "./coverage.node.js";

type AdjustQuoteInput = {
  liability?: LiabilityLevel | undefined;
  collisionDeductible?: Deductible | null | undefined;
  comprehensiveDeductible?: Deductible | null | undefined;
  extras?: CoverageExtra[] | undefined;
};

type AcceptQuoteInput = { tier: QuoteTierName };
type ReviseCoverageInput = { isRevise: boolean };

type QuoteContext = {
  tiers: QuoteTier[];
  adjustedCoverage?: CoverageSelection;
  adjustedTiers?: QuoteTier[];
  response?: string;
  accepted?: QuoteTier;
  revise: boolean;
};

const deductibleSchema = z.union([
  z.literal(250),
  z.literal(500),
  z.literal(1000),
  z.null(),
]);

const TIER_LABELS: Record<QuoteTierName, string> = {
  saver: "Saver",
  selected: "Your selection",
  shield: "Shield",
};

/** Reads naturally inside the acceptance sentence, unlike the list labels. */
const ACCEPTED_TIER_PHRASES: Record<QuoteTierName, string> = {
  saver: "the Saver tier",
  selected: "your selected coverage",
  shield: "the Shield tier",
};

/**
 * Final stage: presents tiers, answers "what if" adjustments deterministically,
 * and locks in an accepted quote. Explaining tier trade-offs is the one place
 * this graph pays for a stronger model.
 */
export class QuoteNode extends ConversationNode<
  QuoteGraphStateType,
  {
    tiers?: QuoteTier[];
    acceptedTier?: QuoteTierName;
    referenceNumber?: string;
  },
  QuoteContext
> {
  getPrompt(state: QuoteGraphStateType): string {
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.quote, {
      TIERS_JSON: JSON.stringify(this.state(state).tiers ?? []),
    })}\n\n${endChatInstruction}`;
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-5.1", {
      retries: 3,
      reasoningEffort: "low",
    });
  }

  defineTool(): readonly (
    | ToolDefinition<AdjustQuoteInput>
    | ToolDefinition<AcceptQuoteInput>
    | ToolDefinition<ReviseCoverageInput>
  )[] {
    return [
      {
        name: "adjust_quote",
        description:
          "Recompute the quote tiers after changing deductibles, liability, or extras.",
        schema: z.object({
          liability: z.enum(["state-minimum", "standard", "premium"]).optional(),
          collisionDeductible: deductibleSchema.optional(),
          comprehensiveDeductible: deductibleSchema.optional(),
          extras: z.array(z.enum(["rental", "roadside"])).max(2).optional(),
        }),
      },
      {
        name: "accept_quote",
        description: "Accept one presented quote tier and finish the quote.",
        schema: z.object({
          tier: z.enum(["saver", "selected", "shield"]),
        }),
      },
      {
        name: "revise_coverage",
        description: "Return to the coverage stage to rework the selections.",
        schema: z.object({ isRevise: z.boolean() }),
      },
    ];
  }

  @Tool("adjust_quote")
  async adjustQuote(
    input: AdjustQuoteInput,
    context: QuoteContext,
    state: QuoteGraphStateType,
  ): Promise<ConversationToolResult> {
    if (
      input.liability === undefined &&
      input.collisionDeductible === undefined &&
      input.comprehensiveDeductible === undefined &&
      input.extras === undefined
    ) {
      return reject("Provide at least one coverage change to adjust.");
    }
    const current = state.nodes.CoverageNode?.coverage;
    const use = state.nodes.VehicleNode?.vehicle;
    if (!current || !use) {
      return reject("There is no coverage selection to adjust yet.");
    }
    const next: CoverageSelection = {
      ...current,
      ...(input.liability === undefined ? {} : { liability: input.liability }),
      ...(input.collisionDeductible === undefined
        ? {}
        : { collisionDeductible: input.collisionDeductible }),
      ...(input.comprehensiveDeductible === undefined
        ? {}
        : { comprehensiveDeductible: input.comprehensiveDeductible }),
      ...(input.extras === undefined
        ? {}
        : { extras: [...new Set(input.extras)] }),
    };
    const now = quoteNow();
    const error = validateCoverageSelection(next, use.ownership, now);
    if (error) return reject(error);
    const rating = buildRatingSubject(state.nodes);
    if ("error" in rating) return reject(rating.error);
    const tiers = RatingEngine.quoteTiers(rating.subject, next, now);
    context.adjustedCoverage = next;
    context.adjustedTiers = tiers;
    context.response = `Here is the updated quote:\n${formatTiers(tiers)}\nAdjust anything else, accept a tier, or rework the coverage.`;
    return { output: { accepted: true }, stopAfterBatch: true };
  }

  @Tool("accept_quote")
  async acceptQuote(
    input: AcceptQuoteInput,
    context: QuoteContext,
  ): Promise<ConversationToolResult> {
    const tier = context.tiers.find((candidate) => candidate.tier === input.tier);
    if (!tier) {
      return reject("That tier is not part of the current quote.");
    }
    context.accepted = tier;
    return { output: { accepted: true }, stopAfterBatch: true };
  }

  @Tool("revise_coverage")
  async reviseCoverage(
    { isRevise }: ReviseCoverageInput,
    context: QuoteContext,
  ): Promise<ConversationToolResult> {
    if (!isRevise) return { output: { accepted: false } };
    context.revise = true;
    return { output: { accepted: true }, stopAfterBatch: true };
  }

  protected createContext(state: QuoteGraphStateType): QuoteContext {
    return { tiers: this.state(state).tiers ?? [], revise: false };
  }

  protected nextStep(
    state: QuoteGraphStateType,
    context: QuoteContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<QuoteGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.accepted) {
      const referenceNumber = `QT-${Math.floor(100000 + Math.random() * 900000)}`;
      const tier = context.accepted;
      const response = `You're all set — ${ACCEPTED_TIER_PHRASES[tier.tier]} (${TIER_LABELS[tier.tier]}) is locked in at ${usd(tier.monthlyPremium)}/month starting ${tier.coverage.startDate}. Your quote reference is ${referenceNumber}.`;
      return this.finish(response, conversation).withState({
        acceptedTier: tier.tier,
        referenceNumber,
      });
    }
    if (context.adjustedTiers && context.adjustedCoverage && context.response) {
      return this.stay(conversation, context.response)
        .withState({ tiers: context.adjustedTiers })
        .withStateFor(CoverageNode, { coverage: context.adjustedCoverage });
    }
    if (context.revise) {
      return this.advance(CoverageNode, conversation).forwardInput(
        state,
        "Review and update the coverage selections.",
      );
    }
    return this.stay(conversation);
  }
}

function formatTiers(tiers: QuoteTier[]): string {
  return tiers
    .map(
      (tier, index) =>
        `${index + 1}. ${TIER_LABELS[tier.tier]} — ${describeCoverage(tier.coverage)}: ${usd(tier.monthlyPremium)}/mo`,
    )
    .join("\n");
}

function describeCoverage(coverage: CoverageSelection): string {
  const deductibles =
    coverage.collisionDeductible === null
      ? "liability only"
      : `$${coverage.collisionDeductible}/$${coverage.comprehensiveDeductible} deductibles`;
  const extras =
    coverage.extras.length === 0 ? "no extras" : coverage.extras.join(" + ");
  return `${coverage.liability} liability, ${deductibles}, ${extras}`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function reject(error: string): ConversationToolResult {
  return { output: { accepted: false, error } };
}
