import assert from "node:assert/strict";
import { it } from "node:test";
import {
  SessionManager, emptyTokenUsage, emptyDecisionUsage,
} from "@picoflow/ezgraph";
import { createTurnHarness, scriptedGateway } from "@picoflow/ezgraph/testing";
import { QuoteGraph } from "../../src/graphs/quote-graph/quote-graph.js";
import type { QuoteGraphStateType } from "../../src/graphs/quote-graph/quote-graph.state.js";

it("QuoteGraph persists global rating context across calculation, adjustment, and acceptance", async () => {
  const previousDate = process.env.QUOTE_GRAPH_CURRENT_DATE;
  process.env.QUOTE_GRAPH_CURRENT_DATE = "2027-06-01T10:00:00.000Z";
  const sessions = new SessionManager();
  const gateway = scriptedGateway()
    .callsTool("select_coverage", {
      liability: "standard", collisionDeductible: 500, comprehensiveDeductible: 500,
      extras: ["rental"], startDate: "2027-06-15",
    })
    .text("Here are your quote tiers.")
    .callsTool("adjust_quote", { collisionDeductible: 1000, comprehensiveDeductible: 1000 })
    .callsTool("accept_quote", { tier: "selected" });
  const harness = createTurnHarness<QuoteGraphStateType>({
    graph: QuoteGraph, gateway, sessionManager: sessions, sessionId: "quote-context-example",
  });
  try {
    await sessions.saveState<QuoteGraphStateType>(harness.session, {
      currentNode: "CoverageNode", config: {}, context: { request: { correlationId: "quote-123" } },
      histories: {}, tokens: emptyTokenUsage(), decisionUsage: emptyDecisionUsage(),
      inputConsumed: true, response: "", completed: false,
      nodes: {
        DriverNode: { driver: {
          fullName: "Jamie Rivera", dateOfBirth: "1993-04-12", licenseState: "OR",
          licenseStatus: "valid", yearsLicensed: 10,
        } },
        VehicleNode: { vehicle: {
          vehicleId: "2019-toyota-camry-se", ownership: "finance", annualMileage: 12000, parking: "driveway",
        } },
        HistoryNode: { history: {
          currentlyInsured: true, coverageLapse: false, incidents: [],
        } },
      },
    }, { graphId: QuoteGraph.id(), graphSchemaVersion: 1, llmConfig: QuoteGraph.getGraphDefinition().llmConfig });
    const calculated = await harness.send("Quote the selected coverage.");
    assert.equal(calculated.status, 200, calculated.response);
    assert.deepEqual(calculated.document?.graph.context?.rating, {
      calculatedAt: "2027-06-01T10:00:00.000Z", businessDate: "2027-06-01",
    });
    process.env.QUOTE_GRAPH_CURRENT_DATE = "2027-06-01T11:00:00.000Z";
    const adjusted = await harness.send("Raise both deductibles to 1000.");
    assert.equal(adjusted.status, 200, adjusted.response);
    assert.deepEqual(adjusted.document?.graph.context?.rating, {
      calculatedAt: "2027-06-01T11:00:00.000Z", businessDate: "2027-06-01",
    });
    const accepted = await harness.send("Accept the selected tier.");
    assert.equal(accepted.status, 200, accepted.response);
    assert.equal(accepted.document?.status, "completed");
    assert.deepEqual(accepted.document?.graph.context, {
      request: { correlationId: "quote-123" },
      rating: adjusted.document?.graph.context?.rating,
      acceptance: { acceptedAt: "2027-06-01T11:00:00.000Z", rating: adjusted.document?.graph.context?.rating },
    });
    assert.equal(accepted.state?.nodes.QuoteNode?.acceptedTier, "selected");
    assert.equal(gateway.drained, true);
  } finally {
    await harness.close();
    if (previousDate === undefined) delete process.env.QUOTE_GRAPH_CURRENT_DATE;
    else process.env.QUOTE_GRAPH_CURRENT_DATE = previousDate;
  }
});
