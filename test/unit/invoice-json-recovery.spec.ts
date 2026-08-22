import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GraphNodeRuntime,
  ModelCatalog,
  emptyTokenUsage,
  type GraphNodeUpdate,
  type LlmGateway,
} from "ezgraph";
import { ExtractInvoiceNode } from "../../src/graphs/invoice-graph/nodes/extract-invoice.node.js";
import type { InvoiceGraphStateType } from "../../src/graphs/invoice-graph/invoice-graph.state.js";

class InvalidJsonResponseNode extends ExtractInvoiceNode {
  override async run(): Promise<GraphNodeUpdate<InvoiceGraphStateType>> {
    return this.complete('{"vendor_name":"ACME Inc"');
  }
}

describe("ExtractInvoiceNode invalid JSON handling", () => {
  it("terminates the graph flow when the final response is invalid JSON", async () => {
    const node = new InvalidJsonResponseNode(
      {} as LlmGateway,
      createJsonRuntime(),
    );

    await assert.rejects(
      node.invoke(createState()),
      /A JSON-response graph completed without an object result/,
    );
  });
});

function createJsonRuntime(): GraphNodeRuntime<InvoiceGraphStateType> {
  return new GraphNodeRuntime(
    "end",
    ModelCatalog.model("scripted:scripted-model", { retries: 0 }),
    {},
    "invoice",
    "json",
  );
}

function createState(): InvoiceGraphStateType {
  return {
    histories: {},
    currentNode: "ExtractInvoiceNode",
    config: { fileName: "ACME.pdf" },
    nodes: {},
    tokens: emptyTokenUsage(),
    inputConsumed: false,
    response: "",
    completed: false,
  };
}
