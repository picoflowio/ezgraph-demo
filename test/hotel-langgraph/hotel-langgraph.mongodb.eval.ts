import "dotenv/config";

import assert from "node:assert/strict";
import { test } from "node:test";
import { HotelLanggraph } from "../../src/graphs/hotel-langgraph/hotel-langgraph.js";
import { createMongoHotelSessionStore } from "../../src/graphs/hotel-langgraph/hotel-session-store.js";
import { hotelTestModelFactory } from "./hotel-langgraph-test-model.js";

test("HotelLanggraph hydrates and retains a MongoDB session document", async () => {
  const mongo = mongoConfig();
  const firstGraph = new HotelLanggraph(
    hotelTestModelFactory,
    await createMongoHotelSessionStore(mongo),
  );
  let session: string | undefined;

  try {
    assert.equal(firstGraph.sessionStoreKind, "mongodb");
    const first = await firstGraph.run({
      userMessage: "Hi",
    });
    assert.equal(first.status, 200);
    assert(first.session);
    session = first.session;
    assert.match(
      (first.body as { message: string }).message,
      /Portland/i,
    );
    assert.equal(await firstGraph.hasSession(session), true);
  } finally {
    await firstGraph.close();
  }

  const restoredGraph = new HotelLanggraph(
    hotelTestModelFactory,
    await createMongoHotelSessionStore(mongo),
  );
  try {
    assert(session);
    const restored = await restoredGraph.getSessionState(session);
    assert(restored);
    assert.equal(restored.phase, "explore");
    assert.equal(restored.exploreMessages.length, 2);

    const second = await restoredGraph.run({
      sessionId: session,
      userMessage: "yes",
    });
    assert.equal(second.status, 200);
    assert.equal(second.session, session);
    assert.match(
      (second.body as { message: string }).message,
      /date range/i,
    );
    assert.equal(await restoredGraph.hasSession(session), true);
    console.log(
      `[HotelLanggraph Mongo] retained ${mongo.databaseName}.${mongo.collectionName} session: ${session}`,
    );
  } finally {
    await restoredGraph.close();
  }
});

function mongoConfig(): {
  url: string;
  databaseName: string;
  collectionName: string;
} {
  const url = process.env.MONGODB_URL?.trim();
  if (!url) {
    throw new Error(
      "test2:hotel-langgraph requires MONGODB_URL.",
    );
  }
  return {
    url,
    databaseName: process.env.MONGODB_NAME?.trim() || "ezgraph",
    collectionName: process.env.MONGODB_COLLECTION?.trim() || "sessions",
  };
}
