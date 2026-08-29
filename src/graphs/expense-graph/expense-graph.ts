import { END, START } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  TerminateSessionNode,
  type GraphDefinition,
  type LlmGateway,
} from "@picoflow/ezgraph";
import {
  ExpenseGraphState,
  type ExpenseGraphStateType,
} from "./expense-graph.state.js";
import { ExtractExpenseNode } from "./nodes/extract-expense.node.js";

const EMPTY_RESPONSE_NUDGE =
  "Return the extracted expense report by calling capture_json. Do not reply with empty content.";

/**
 * A single-request vision extraction graph. One configured hotel receipt PDF
 * is fetched by the node, attached as a multimodal message, and captured as
 * itemized expense JSON before the graph completes.
 */
export class ExpenseGraph extends BaseGraph<ExpenseGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("openai:gpt-5.4", {
        retries: 3,
        reasoningEffort: "medium",
        forceToolCalls: true,
      }),
      endNode: GRAPH_END_NODE,
      requiresUserMessage: false,
      responseMode: "json",
      // Vision extraction sends a whole receipt file, so one request gets a
      // long budget, and an empty candidate after the upload is retried.
      llmTimeoutMs: 120_000,
      emptyResponseRecovery: { retries: 2, nudge: EMPTY_RESPONSE_NUDGE },
      historySpaces: [[ExtractExpenseNode, "expense"]],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, ExpenseGraph.getGraphDefinition());
  }

  protected buildGraph() {
    return this.createStateGraph(ExpenseGraphState)
      .nodes(ExtractExpenseNode, TerminateSessionNode)
      .addEdge(START, ExtractExpenseNode)
      .addEdge(ExtractExpenseNode, END)
      .addEdge(TerminateSessionNode, END)
      .compile();
  }
}
