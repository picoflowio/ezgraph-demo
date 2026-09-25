import {
  DecisionNode,
  directTo,
  type DecisionAnswers,
  type DecisionContext,
  type DecisionErrorContext,
  type DecisionQuestionMap,
  type GraphNodeResponse,
} from "@picoflow/ezgraph";
import { CriteriaHelper } from "../criteria-helper.js";
import type { DecisionHotelGraphStateType } from "../decision-hotel-graph.state.js";
import { hotelPrompts } from "../prompt/hotel-prompts.js";
import { PresentNode } from "./present.node.js";

export const PRESENTATION_QUESTIONS = {
  grounded: {
    type: "noul",
    instructions:
      "Are all names, addresses, and prices supported by hotelFound?",
  },
  completeness: {
    type: "score",
    criteria: [
      "Missing names, addresses, or prices",
      "Hotel details without a next action",
      "Complete hotel details plus booking or revision action",
    ],
  },
  clarity: {
    type: "score",
    criteria: ["Confusing", "Understandable", "Clear numbered choices"],
  },
} as const satisfies DecisionQuestionMap;

export class PresentationDecisionNode extends DecisionNode<
  DecisionHotelGraphStateType,
  typeof PRESENTATION_QUESTIONS
> {
  /** Declares the typed quality judgments used to review a presentation. */
  override defineQuestions() {
    return PRESENTATION_QUESTIONS;
  }

  /** Supplies shared review guidance that is prepended to every question. */
  override getPrompt(): string {
    return hotelPrompts.presentationJudge;
  }

  /**
   * Exposes only the draft and its grounding data as provider evidence.
   * The framework supplies conversation input without copying it into state.
   */
  protected override getDecisionFacts(state: DecisionHotelGraphStateType) {
    return {
      draft: state.nodes.PresentNode?.draft ?? "",
      hotelFound: state.nodes.PresentNode?.hotelFound ?? [],
      criteria: state.nodes.PresentNode?.criteria ?? {},
    };
  }

  /** Applies application-owned quality thresholds and selects the safe response. */
  override onDecision(
    answers: DecisionAnswers<typeof PRESENTATION_QUESTIONS>,
    _context: DecisionContext,
    state: DecisionHotelGraphStateType,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const hotels = state.nodes.PresentNode?.hotelFound ?? [];
    const draft = state.nodes.PresentNode?.draft ?? "";
    const accepted =
      answers.grounded.noul >= 0.85 &&
      answers.completeness.score >= 1.5 &&
      answers.completeness.confidence >= 0.75 &&
      answers.clarity.score >= 1.5 &&
      answers.clarity.confidence >= 0.75;
    this.saveState({ review: answers, accepted });
    return directTo(
      PresentNode,
      accepted ? draft : CriteriaHelper.renderHotelResults(hotels),
    );
  }

  /** Returns grounded, code-rendered results when presentation review fails. */
  protected override onDecisionError(
    context: DecisionErrorContext<DecisionHotelGraphStateType>,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    return directTo(
      PresentNode,
      CriteriaHelper.renderHotelResults(
        context.state.nodes.PresentNode?.hotelFound ?? [],
      ),
    );
  }
}
