import {
  DecisionNode,
  directTo,
  go,
  type DecisionAnswers,
  type DecisionContext,
  type DecisionErrorContext,
  type DecisionQuestionMap,
  type GraphNodeResponse,
} from "@picoflow/ezgraph";
import { CriteriaHelper } from "../criteria-helper.js";
import type { DecisionHotelGraphStateType } from "../decision-hotel-graph.state.js";
import { fillHotelPrompt, hotelPrompts } from "../prompt/hotel-prompts.js";
import { RouterDecisionNode } from "./router-decision.node.js";
import { SearchHotelsNode } from "./search-hotels.node.js";

export const CRITERIA_REVIEW_QUESTIONS = {
  outcome: {
    type: "choice",
    criteria: {
      ready: "Ready to search",
      dates: "Dates conflict",
      budget: "Budget conflicts",
      room_type: "Room type conflicts",
      amenities: "Amenities conflict",
      distance: "Distance conflicts",
      unclear: "Ambiguous",
    },
  },
  faithful: {
    type: "noul",
    criteria: {
      true: "Saved criteria reflect requests",
      false: "Saved criteria contradict requests",
    },
  },
} as const satisfies DecisionQuestionMap;

export class CriteriaReadinessDecisionNode extends DecisionNode<
  DecisionHotelGraphStateType,
  typeof CRITERIA_REVIEW_QUESTIONS
> {
  /** Declares the typed readiness and faithfulness judgments to request. */
  override defineQuestions() {
    return CRITERIA_REVIEW_QUESTIONS;
  }

  /** Supplies shared judging guidance that is prepended to every question. */
  override getPrompt(state: DecisionHotelGraphStateType): string {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    return fillHotelPrompt(hotelPrompts.criteriaJudge, {
      NORMALIZED_CRITERIA: JSON.stringify(criteria, null, 2),
      DETERMINISTIC_ISSUES: issues.length
        ? issues.map((issue) => `${issue.field}: ${issue.message}`).join("\n")
        : "None.",
    });
  }

  /**
   * Adds normalized criteria and deterministic validation results as evidence.
   * Conversation input is added separately by the DecisionNode framework.
   */
  protected override getDecisionFacts(state: DecisionHotelGraphStateType) {
    const criteria = CriteriaHelper.readCriteria(state);
    return {
      criteria,
      deterministicIssues: CriteriaHelper.validateCriteria(criteria),
    };
  }

  /** Keeps acceptance thresholds and resulting graph routes in application code. */
  override onDecision(
    answers: DecisionAnswers<typeof CRITERIA_REVIEW_QUESTIONS>,
    _context: DecisionContext,
    state: DecisionHotelGraphStateType,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    const outcome = answers.outcome.choice;
    const accepted =
      issues.length === 0 &&
      outcome === "ready" &&
      answers.faithful.noul >= 0.75;
    this.saveState({ review: answers, accepted });
    if (issues.length) return go(CriteriaHelper.nextNode(issues[0]!));
    if (accepted) return go(SearchHotelsNode);
    if (outcome !== "ready" && outcome !== "unclear") {
      return directTo(
        CriteriaHelper.nextNode(outcome),
        CriteriaHelper.criteriaPrompt(outcome),
      );
    }
    return directTo(
      RouterDecisionNode,
      `${CriteriaHelper.renderCriteriaSummary(criteria)}\nI could not verify one clear correction. Tell me which single criterion to update.`,
    );
  }

  /** Falls back to deterministic validation when this decision call fails. */
  protected override onDecisionError(
    context: DecisionErrorContext<DecisionHotelGraphStateType>,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const issues = CriteriaHelper.validateCriteria(
      CriteriaHelper.readCriteria(context.state),
    );
    return issues.length
      ? directTo(
          CriteriaHelper.nextNode(issues[0]!),
          CriteriaHelper.criteriaPrompt(issues[0]!.field),
        )
      : go(SearchHotelsNode);
  }
}
