import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { GraphEngine } from "ezgraph";
import { AppModule } from "../../src/app.module.js";
import { HotelLanggraph } from "../../src/graphs/hotel-langgraph/hotel-langgraph.js";
import { QuoteLanggraph } from "../../src/graphs/quote-langgraph/quote-langgraph.js";
import { hotelTestModelFactory } from "../hotel-langgraph/hotel-langgraph-test-model.js";
import { quoteTestModelFactory } from "./quote-langgraph-test-model.js";

describe("AiLanggraphController / QuoteLanggraph", () => {
  let app: NestFastifyApplication;

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GraphEngine)
      .useValue(new GraphEngine())
      .overrideProvider(HotelLanggraph)
      .useValue(new HotelLanggraph(hotelTestModelFactory))
      .overrideProvider(QuoteLanggraph)
      .useValue(new QuoteLanggraph(quoteTestModelFactory))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  after(async () => app.close());

  it("maps QuoteLanggraph through the shared pure-LangGraph API", async () => {
    const server = app.getHttpAdapter().getInstance();
    const graphs = await server.inject({
      method: "GET",
      url: "/ai-langgraph/graphs",
    });
    assert.deepEqual(JSON.parse(graphs.payload), [
      "HotelLanggraph",
      "QuoteLanggraph",
    ]);

    const first = await server.inject({
      method: "POST",
      url: "/ai-langgraph/run",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        graphName: "QuoteLanggraph",
        message: "Hi, I'd like a car insurance quote.",
      }),
    });
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.payload) as {
      success: boolean;
      completed: boolean;
      message: string;
      session: string;
    };
    assert.equal(firstBody.success, true);
    assert.equal(firstBody.completed, false);
    assert.match(firstBody.message, /Sequoia/i);
    assert.equal(first.headers.session_id, firstBody.session);

    const second = await server.inject({
      method: "POST",
      url: "/ai-langgraph/run",
      headers: {
        "content-type": "application/json",
        SESSION_ID: firstBody.session,
      },
      payload: JSON.stringify({
        graphName: "QuoteLanggraph",
        message: "Jamie Rivera, born 1993-04-12, licensed in Oregon 10 years, valid.",
      }),
    });
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.payload) as {
      session: string;
      message: string;
    };
    assert.equal(secondBody.session, firstBody.session);
    assert.match(secondBody.message, /vehicle/i);

    const ended = await server.inject({
      method: "POST",
      url: "/ai-langgraph/end",
      headers: { SESSION_ID: firstBody.session },
    });
    assert.equal(ended.statusCode, 200);
    assert.equal(
      (JSON.parse(ended.payload) as { success: boolean }).success,
      true,
    );
    assert.equal(
      await app.get(QuoteLanggraph).hasSession(firstBody.session),
      false,
    );
  });

  it("rejects an unregistered graph name", async () => {
    const server = app.getHttpAdapter().getInstance();
    const response = await server.inject({
      method: "POST",
      url: "/ai-langgraph/run",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ graphName: "QuoteGraph", message: "Hi" }),
    });
    assert.equal(response.statusCode, 400);
    assert.match(
      (JSON.parse(response.payload) as { message: string }).message,
      /not registered/i,
    );
  });
});
