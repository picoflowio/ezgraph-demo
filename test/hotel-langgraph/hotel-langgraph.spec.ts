import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HotelLanggraph } from "../../src/graphs/hotel-langgraph/hotel-langgraph.js";
import {
  hotelTestModelFactory,
  threeHotels,
} from "./hotel-langgraph-test-model.js";

describe("HotelLanggraph pure LangGraph", () => {
  it("matches the multi-turn search, comparison, and booking behavior", async () => {
    const graph = new HotelLanggraph(hotelTestModelFactory);
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

    assert.match((await send("Hi")).message, /Portland/i);
    assert.match((await send("yes")).message, /date range/i);
    assert.match(
      (await send("8/1/2027 to 8/8/2027")).message,
      /price|budget/i,
    );
    assert.match((await send("max 700")).message, /room type/i);
    assert.match((await send("suite")).message, /amenities/i);
    assert.match(
      (await send("free wifi, parking")).message,
      /distance/i,
    );
    assert.match((await send("none")).message, /search/i);
    assert.match((await send("search")).message, /hotel choices/i);
    assert.match(
      (await send("change to a 2 bed rooms, search")).message,
      /hotel choices/i,
    );

    const price = await send("compare hotel 2,5,8 on price");
    assert.match(price.message, /Hampton Inn Portland-Airport/);
    assert.match(price.message, /2027-08-01/);

    const amenities = await send("compare on amenities");
    assert.match(amenities.message, /freeWiFi/);

    const twoHotelPrice = await send("compare hotels 2,5 on price");
    assert.match(twoHotelPrice.message, /Hampton Inn Portland\/Clackamas/);

    assert.match(
      (await send("resume booking")).message,
      /hotel choices/i,
    );
    const booked = await send("8");
    assert.equal(booked.completed, true);
    assert.match(booked.message, /confirmation number is \d{6}/i);

    assert(session);
    const state = await graph.getSessionState(session);
    assert(state);
    assert.equal(state.phase, "terminal");
    assert.equal(state.completed, true);
    assert.equal(state.criteria?.cRoomType[0], "two beds");
    assert.equal(state.hotelFound.length, 9);
    assert.deepEqual(state.selectedHotels, threeHotels.slice(0, 2));
    assert.equal(state.bookedHotel, "Hampton Inn Sherwood Portland");
    assert.equal(state.confirmationNumber?.toString().length, 6);

    const repeated = await send("anything else");
    assert.equal(repeated.completed, true);
    assert.equal(repeated.message, "This conversation is already complete.");
  });

  it("terminates and deletes a stored session", async () => {
    const graph = new HotelLanggraph(hotelTestModelFactory);
    const ended = await graph.run({
      userMessage: "quit",
    });
    assert.equal(ended.status, 200);
    assert(ended.session);
    assert.equal(
      (ended.body as { completed: boolean }).completed,
      true,
    );
    assert.equal(await graph.hasSession(ended.session), true);
    assert.equal((await graph.deleteSession(ended.session)).status, 200);
    assert.equal(await graph.hasSession(ended.session), false);
  });
});
