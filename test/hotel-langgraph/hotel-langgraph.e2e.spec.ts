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
import { hotelTestModelFactory } from "./hotel-langgraph-test-model.js";

describe("AiLanggraphController / HotelLanggraph", () => {
  let app: NestFastifyApplication;

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GraphEngine)
      .useValue(new GraphEngine())
      .overrideProvider(HotelLanggraph)
      .useValue(new HotelLanggraph(hotelTestModelFactory))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  after(async () => app.close());

  it("maps HotelLanggraph through its dedicated API and cleans up its session", async () => {
    const server = app.getHttpAdapter().getInstance();
    const graphs = await server.inject({
      method: "GET",
      url: "/ai-langgraph/graphs",
    });
    assert.deepEqual(JSON.parse(graphs.payload), ["HotelLanggraph"]);

    const first = await server.inject({
      method: "POST",
      url: "/ai-langgraph/run",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ graphName: "HotelLanggraph", message: "Hi" }),
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
    assert.match(firstBody.message, /Portland/i);
    assert.equal(first.headers.session_id, firstBody.session);

    const second = await server.inject({
      method: "POST",
      url: "/ai-langgraph/run",
      headers: {
        "content-type": "application/json",
        SESSION_ID: firstBody.session,
      },
      payload: JSON.stringify({ graphName: "HotelLanggraph", message: "yes" }),
    });
    assert.equal(second.statusCode, 200);
    assert.equal(
      (JSON.parse(second.payload) as { session: string }).session,
      firstBody.session,
    );

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
  });
});
