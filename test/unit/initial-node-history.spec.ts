import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { scriptedGateway, scriptedDecisions } from "@picoflow/ezgraph/testing";
import { QuoteGraph } from "../../src/graphs/quote-graph/quote-graph.js";
import { DecisionHotelGraph } from "../../src/graphs/decision-hotel-graph/decision-hotel-graph.js";
import { ExpenseGraph } from "../../src/graphs/expense-graph/expense-graph.js";

const cases = [
  {
    name: "QuoteGraph",
    create: () => new QuoteGraph(scriptedGateway()),
    node: "DriverNode",
    space: "quote-intake",
  },
  {
    name: "DecisionHotelGraph",
    create: () => {
      const graph = new DecisionHotelGraph(scriptedGateway());
      graph.attachDecisionProviderResolver(() => scriptedDecisions());
      return graph;
    },
    node: "RouterDecisionNode",
    space: "hotel-intake",
  },
  {
    name: "ExpenseGraph",
    create: () => new ExpenseGraph(scriptedGateway()),
    node: "ExtractExpenseNode",
    space: "expense",
  },
];

describe("first user message uses the initial node's history", () => {
  for (const { name, create, node, space } of cases) {
    it(name, () => {
      const graph = create();
      const message = new HumanMessage("Keep this exact first request.");
      const prepared = graph.prepareInput(undefined, message);
      assert.equal(prepared.currentNode, node);
      assert.deepEqual(Object.keys(prepared.histories ?? {}), [space]);
      assert.deepEqual(prepared.histories?.[space], [message]);
    });
  }
});
