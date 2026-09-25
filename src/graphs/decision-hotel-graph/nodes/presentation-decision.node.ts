import {
  DecisionNode,
  directTo,
  type DecisionAnswers,
  type DecisionContext,
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
  defineQuestions() {
    return PRESENTATION_QUESTIONS;
  }
  getPrompt(): string {
    return hotelPrompts.presentationJudge;
  }

  protected getDecisionData(state: DecisionHotelGraphStateType) {
    return {
      draft: state.nodes.PresentNode?.draft ?? "",
      hotelFound: state.nodes.PresentNode?.hotelFound ?? [],
      criteria: state.nodes.PresentNode?.criteria ?? {},
    };
  }

  onDecision(
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
}
