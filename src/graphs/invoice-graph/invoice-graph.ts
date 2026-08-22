import { END, START } from "@langchain/langgraph";
import {
  BaseGraph,
  GRAPH_END_NODE,
  ModelCatalog,
  type GraphDefinition,
  type LlmGateway,
} from "ezgraph";
import {
  InvoiceGraphState,
  type InvoiceGraphStateType,
} from "./invoice-graph.state.js";
import { ExtractInvoiceNode } from "./nodes/extract-invoice.node.js";

/**
 * A single-request vision extraction graph. One configured invoice image is
 * fetched by the node, converted into a multimodal message, and captured as
 * structured JSON before the graph completes.
 */
export class InvoiceGraph extends BaseGraph<InvoiceGraphStateType> {
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
      historySpaces: [[ExtractInvoiceNode, "invoice"]],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, InvoiceGraph.getGraphDefinition());
  }

  protected buildGraph() {
    return this.createStateGraph(InvoiceGraphState)
      .nodes(ExtractInvoiceNode)
      .addEdge(START, ExtractInvoiceNode)
      .addEdge(ExtractInvoiceNode, END)
      .compile();
  }
}
