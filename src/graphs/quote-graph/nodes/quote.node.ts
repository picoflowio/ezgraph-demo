import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  ModelCatalog,
  Tool,
  direct,
  finish,
  go,
  stay,
  type ToolResponse,
  type GraphLlmConfigOverride,
  type ToolDefinition,
} from "@picoflow/ezgraph";
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
  QuoteGraphNodeState,
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
export class QuoteNode extends ConversationNode<QuoteGraphStateType> {
  getPrompt(state: QuoteGraphStateType): string {
    const local = this.state(state) as QuoteGraphNodeState<"QuoteNode">;
    return `${quotePrompt.role}\n\n${fillPrompt(quotePrompt.quote, {
      TIERS_JSON: JSON.stringify(local.tiers ?? []),
    })}\n\n${endChatInstruction}`;
  }

  getLlmConfig(): GraphLlmConfigOverride {
    return ModelCatalog.model("openai:gpt-5.4", {
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
          liability: z
            .enum(["state-minimum", "standard", "premium"])
            .optional(),
          collisionDeductible: deductibleSchema.optional(),
          comprehensiveDeductible: deductibleSchema.optional(),
          extras: z
            .array(z.enum(["rental", "roadside"]))
            .max(2)
            .optional(),
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
  async adjustQuote(input: AdjustQuoteInput): Promise<ToolResponse> {
    const state = this.graph.graphState();
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
    const response = `Here is the updated quote:\n${formatTiers(tiers)}\nAdjust anything else, accept a tier, or rework the coverage.`;
    this.saveState({ tiers });
    this.graph.saveNodeState(CoverageNode, { coverage: next });
    return direct(response);
  }

  @Tool("accept_quote")
  async acceptQuote(input: AcceptQuoteInput): Promise<ToolResponse> {
    const local = this.getState() as QuoteGraphNodeState<"QuoteNode">;
    const tier = local.tiers?.find(
      (candidate) => candidate.tier === input.tier,
    );
    if (!tier) {
      return reject("That tier is not part of the current quote.");
    }
    const referenceNumber = `QT-${Math.floor(100000 + Math.random() * 900000)}`;
    const response = `You're all set — ${ACCEPTED_TIER_PHRASES[tier.tier]} (${TIER_LABELS[tier.tier]}) is locked in at ${usd(tier.monthlyPremium)}/month starting ${tier.coverage.startDate}. Your quote reference is ${referenceNumber}.`;
    this.saveState({ acceptedTier: tier.tier, referenceNumber });
    return finish(response);
  }

  @Tool("revise_coverage")
  async reviseCoverage(
    { isRevise }: ReviseCoverageInput,
    _context: Record<string, never>,
    state: QuoteGraphStateType,
  ): Promise<ToolResponse> {
    if (!isRevise) return stay("Continue with the current quote tiers.");
    return go(CoverageNode).withMessage(
      new HumanMessage(this.graph.input(state)),
    );
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

function reject(error: string): ToolResponse {
  return stay(JSON.stringify({ accepted: false, error }));
}
