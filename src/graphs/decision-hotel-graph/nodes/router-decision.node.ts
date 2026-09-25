import { HumanMessage } from "@langchain/core/messages";
import {
  DecisionNode,
  directTo,
  finish,
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
import { CriteriaReadinessDecisionNode } from "./criteria-readiness-decision.node.js";

export const ROUTING_QUESTIONS = {
  destination: {
    type: "choice",
    criteria: {
      dates: "Set or revise dates",
      budget: "Set or revise nightly budget",
      room_type: "Set or revise room type",
      amenities: "Set or revise amenities",
      distance: "Set or revise distances",
      review: "Show saved criteria",
      search: "Execute a hotel search",
      exit: "End the conversation",
      unclear: "Ambiguous or outside this flow",
    },
  },
  request_delivery: {
    type: "choice",
    criteria: {
      apply_request:
        "The latest request contains a new value or revision that the selected collector must apply",
      prompt_next: "The selected criterion is merely the next unresolved field",
      none: "The destination is not a criterion collector",
    },
  },
} as const satisfies DecisionQuestionMap;

export class RouterDecisionNode extends DecisionNode<
  DecisionHotelGraphStateType,
  typeof ROUTING_QUESTIONS
> {
  /** Declares the typed classifications the decision provider must answer. */
  override defineQuestions() {
    return ROUTING_QUESTIONS;
  }

  /** Supplies shared guidance that the framework prepends to every question. */
  override getPrompt(state: DecisionHotelGraphStateType): string {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    return fillHotelPrompt(hotelPrompts.router, {
      COLLECTED_CRITERIA: JSON.stringify(criteria, null, 2),
      UNRESOLVED_CRITERIA: issues.length
        ? issues
            .map(
              (issue, index) =>
                `${index + 1}. ${issue.field}: ${issue.message}`,
            )
            .join("\n")
        : "None.",
    });
  }

  /**
   * Adds JSON-compatible application evidence to the provider input.
   * The framework adds the current `request` and `priorRequests`; this hook
   * must not replace either framework-owned field.
   */
  protected override getDecisionFacts(state: DecisionHotelGraphStateType) {
    const criteria = CriteriaHelper.readCriteria(state);
    return {
      criteria,
      unresolved: CriteriaHelper.validateCriteria(criteria).map(
        (issue) => issue.field,
      ),
      notice: state.nodes.RouterDecisionNode?.notice ?? null,
    };
  }

  /** Applies application-owned routing policy to the provider's typed answers. */
  override onDecision(
    answers: DecisionAnswers<typeof ROUTING_QUESTIONS>,
    context: DecisionContext,
    state: DecisionHotelGraphStateType,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const criteria = CriteriaHelper.readCriteria(state);
    const issues = CriteriaHelper.validateCriteria(criteria);
    const notice = state.nodes.RouterDecisionNode?.notice;
    if (notice) {
      this.saveState({ notice: null });
      return directTo(RouterDecisionNode, notice);
    }

    const route = answers.destination.choice;
    this.saveState({ lastRoute: route, lastDecision: answers });
    if (route === "unclear") {
      return directTo(
        RouterDecisionNode,
        "I can update dates, nightly budget, room type, amenities, or distance. You can also ask to review or search.",
      );
    }
    if (route === "exit") {
      return finish("Thanks for considering Hilton hotels in Portland.");
    }
    if (route === "review") {
      return directTo(
        RouterDecisionNode,
        `${CriteriaHelper.renderCriteriaSummary(criteria)}\n\nTell me what to revise, or say “search” when ready.`,
      );
    }
    if (route === "search") {
      if (context.request.trim().toLowerCase() !== "search") {
        return issues.length
          ? directTo(
              CriteriaHelper.nextNode(issues[0]!),
              CriteriaHelper.criteriaPrompt(issues[0]!.field),
            )
          : directTo(
              RouterDecisionNode,
              `${CriteriaHelper.renderCriteriaSummary(criteria)}\n\nTell me what to revise, or say “search” when ready.`,
            );
      }
      return issues.length
        ? go(CriteriaHelper.nextNode(issues[0]!))
        : go(CriteriaReadinessDecisionNode);
    }
    return answers.request_delivery.choice === "apply_request" ||
      CriteriaHelper.criterionAnswered(criteria, route)
      ? go(CriteriaHelper.nextNode(route)).withMessage(
          new HumanMessage(context.request),
        )
      : directTo(
          CriteriaHelper.nextNode(route),
          CriteriaHelper.criteriaPrompt(route),
        );
  }

  /** Returns a deterministic route when this node's decision call fails. */
  protected override onDecisionError(
    context: DecisionErrorContext<DecisionHotelGraphStateType>,
  ): GraphNodeResponse<DecisionHotelGraphStateType> {
    const notice = context.state.nodes.RouterDecisionNode?.notice;
    if (notice) {
      return directTo(RouterDecisionNode, notice).withState({ notice: null });
    }
    const issues = CriteriaHelper.validateCriteria(
      CriteriaHelper.readCriteria(context.state),
    );
    return issues.length
      ? directTo(
          CriteriaHelper.nextNode(issues[0]!),
          CriteriaHelper.criteriaPrompt(issues[0]!.field),
        )
      : directTo(
          RouterDecisionNode,
          "Your saved criteria are ready. Say “search” to find hotels, or tell me what to revise.",
        );
  }
}
