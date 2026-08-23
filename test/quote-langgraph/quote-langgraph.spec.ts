import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuoteLanggraph } from "../../src/graphs/quote-langgraph/quote-langgraph.js";
import { RatingEngine } from "../../src/graphs/quote-langgraph/backend/rating-engine.js";
import { VehicleCatalog } from "../../src/graphs/quote-langgraph/backend/vehicle-catalog.js";
import type { CoverageSelection } from "../../src/graphs/quote-langgraph/quote-types.js";
import {
  camrySeUse,
  jamie,
  jamieHistory,
  quoteTestModelFactory,
} from "./quote-langgraph-test-model.js";

process.env.QUOTE_GRAPH_CURRENT_DATE = "2027-06-01T00:00:00.000Z";
const QUOTE_DATE = new Date("2027-06-01T00:00:00.000Z");

const subject = {
  driver: jamie,
  vehicle: VehicleCatalog.fetch("2019-toyota-camry-se")!,
  use: camrySeUse,
  history: jamieHistory,
};

const selectedCoverage: CoverageSelection = {
  liability: "standard",
  collisionDeductible: 500,
  comprehensiveDeductible: 500,
  extras: ["rental"],
  startDate: "2027-06-15",
};

describe("QuoteLanggraph pure LangGraph", () => {
  it("matches the multi-stage collection, quoting, adjustment, and acceptance behavior", async () => {
    const graph = new QuoteLanggraph(quoteTestModelFactory);
    let session: string | undefined;

    async function send(message: string) {
      const result = await graph.run({
        userMessage: message,
        ...(session ? { sessionId: session } : {}),
      });
      assert.equal(result.status, 200);
      assert(result.session);
      session ??= result.session;
      assert.equal(result.session, session);
      return result.body as {
        success: boolean;
        completed: boolean;
        message: string;
      };
    }

    assert.match((await send("Hi, I'd like a car insurance quote.")).message, /name/i);

    // Capturing the driver advances to the vehicle stage within the same turn.
    assert.match(
      (await send("Jamie Rivera, born 1993-04-12, licensed in Oregon 10 years, valid."))
        .message,
      /vehicle/i,
    );
    assert.match((await send("It's a 2019 Toyota Camry.")).message, /LE, SE, and XSE/);

    // Resolving the trim loops back through the same agent to capture use,
    // which then advances into the isolated history stage.
    assert.match(
      (await send("The SE trim; I finance it, 12000 miles a year, parked in the driveway."))
        .message,
      /insured|accidents/i,
    );

    assert.match(
      (await send("Insured today, no lapse, just one speeding ticket in March 2026."))
        .message,
      /coverage/i,
    );

    const lenderRule = await send(
      "Standard liability, but liability only — no deductibles. Start June 15.",
    );
    assert.match(lenderRule.message, /lender/i);

    const quoted = await send("Fine — $500 deductibles on both, plus rental.");
    assert.match(quoted.message, /quote options/i);

    const adjusted = await send("What if I raise both deductibles to $1000?");
    const adjustedCoverage: CoverageSelection = {
      ...selectedCoverage,
      collisionDeductible: 1000,
      comprehensiveDeductible: 1000,
    };
    const adjustedTiers = RatingEngine.quoteTiers(
      subject,
      adjustedCoverage,
      QUOTE_DATE,
    );
    assert.match(adjusted.message, /Here is the updated quote/);
    assert.match(
      adjusted.message,
      new RegExp(
        `\\$${adjustedTiers[1]!.monthlyPremium.toFixed(2).replace(".", "\\.")}/mo`,
      ),
    );

    const accepted = await send("Accept my selected option, please.");
    assert.equal(accepted.completed, true);
    assert.match(accepted.message, /QT-\d{6}/);
    assert.match(
      accepted.message,
      new RegExp(
        `\\$${adjustedTiers[1]!.monthlyPremium.toFixed(2).replace(".", "\\.")}/month`,
      ),
    );

    assert(session);
    const state = await graph.getSessionState(session);
    assert(state);
    assert.equal(state.phase, "terminal");
    assert.equal(state.completed, true);
    assert.deepEqual(state.driver, jamie);
    assert.deepEqual(state.vehicle, camrySeUse);
    assert.deepEqual(state.history, jamieHistory);
    assert.deepEqual(state.coverage, adjustedCoverage);
    assert.deepEqual(state.tiers, adjustedTiers);
    assert.equal(state.acceptedTier, "selected");
    assert.match(String(state.referenceNumber), /^QT-\d{6}$/);
    // The three history spaces stay isolated.
    assert.equal(
      state.incidentsMessages.some((message) =>
        String(message.content).includes("Camry"),
      ),
      false,
    );
    assert.ok(state.presentMessages.length > 0);

    const repeated = await send("anything else");
    assert.equal(repeated.completed, true);
    assert.equal(repeated.message, "This conversation is already complete.");
  });

  it("rejects a suspended license and stays in the driver stage", async () => {
    const graph = new QuoteLanggraph(quoteTestModelFactory);
    const result = await graph.run({
      userMessage:
        "My license is currently suspended but I'd like a quote. Casey Morgan, born 1990-01-15, Oregon, 8 years licensed.",
    });

    assert.equal(result.status, 200);
    assert(result.session);
    const body = result.body as { completed: boolean; message: string };
    assert.equal(body.completed, false);
    assert.match(body.message, /suspended/i);

    const state = await graph.getSessionState(result.session);
    assert(state);
    assert.equal(state.phase, "driver");
    assert.equal(state.driver, undefined);
  });

  it("returns to the coverage stage when the customer reworks the quote", async () => {
    const graph = new QuoteLanggraph(quoteTestModelFactory);
    let session: string | undefined;

    async function send(message: string) {
      const result = await graph.run({
        userMessage: message,
        ...(session ? { sessionId: session } : {}),
      });
      session ??= result.session;
      return result.body as { completed: boolean; message: string };
    }

    await send("Hi");
    await send("Jamie Rivera, born 1993-04-12, licensed in Oregon 10 years, valid.");
    await send("It's a 2019 Toyota Camry.");
    await send("The SE trim; I finance it, 12000 miles a year, driveway.");
    await send("Insured today, no lapse, one speeding ticket in March 2026.");
    await send("Fine — $500 deductibles on both, plus rental.");

    // revise_coverage forwards the same user turn into the coverage stage,
    // which immediately re-selects and re-quotes.
    const reworked = await send("Let's rework the coverage with $500 deductibles.");
    assert.match(reworked.message, /quote options/i);

    assert(session);
    const state = await graph.getSessionState(session);
    assert(state);
    assert.equal(state.phase, "quote");
    assert.deepEqual(state.coverage, selectedCoverage);
  });

  it("terminates and deletes a stored session", async () => {
    const graph = new QuoteLanggraph(quoteTestModelFactory);
    const ended = await graph.run({ userMessage: "quit" });
    assert.equal(ended.status, 200);
    assert(ended.session);
    assert.equal((ended.body as { completed: boolean }).completed, true);
    assert.match((ended.body as { message: string }).message, /Sequoia/i);
    assert.equal(await graph.hasSession(ended.session), true);
    assert.equal((await graph.deleteSession(ended.session)).status, 200);
    assert.equal(await graph.hasSession(ended.session), false);
  });

  it("starts over once a quote session has been idle past its window", async () => {
    const graph = new QuoteLanggraph(quoteTestModelFactory, undefined, 1);
    const first = await graph.run({ userMessage: "Hi" });
    assert(first.session);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await graph.hasSession(first.session), false);
  });
});
