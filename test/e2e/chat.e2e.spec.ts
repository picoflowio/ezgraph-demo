import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "../../src/app.module.js";
import { DemoGraph } from "../../src/graphs/demo-graph/demo-graph.js";
import { InvoiceGraph } from "../../src/graphs/invoice-graph/invoice-graph.js";
import { GraphEngine } from "ezgraph";
import type { DemoGraphStateType } from "../../src/graphs/demo-graph/demo-graph.state.js";
import { ScriptedLlmGateway } from "../support/scripted-llm-gateway.js";

describe("AiController / DemoGraph", () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  const llmGateway = new ScriptedLlmGateway();

  before(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GraphEngine)
      .useValue(
        new GraphEngine({
          llmGatewayFactory: () => llmGateway,
          graphs: [DemoGraph, InvoiceGraph],
        }),
      )
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => app.close());

  it("exposes health and registered graphs", async () => {
    const health = await fetch(`${baseUrl}/healthcheck`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");

    const graphs = await fetch(`${baseUrl}/ai/graphs`);
    assert.deepEqual(await graphs.json(), [
      "DemoGraph",
      "InvoiceGraph",
    ]);
  });

  it("runs the complete multi-turn graph with header-based continuity", async () => {
    const first = await run("Hi");
    assert.equal(first.response.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.completed, false);
    assert.match(first.body.message, /LA and NYC/i);
    assert.equal(first.body.bot, first.body.message);
    const session = first.response.headers.get("session_id");
    assert(session);

    const favorites = await run("LA and NYC", session);
    assert.match(favorites.body.message, /favorite color/i);

    const color = await run("blue", session);
    assert.match(color.body.message, /provide all three favorites/i);
    const afterColor = await app
      .get(GraphEngine)
      .getSession<DemoGraphStateType>(session);
    assert(afterColor?.graph.nodes);
    assert.deepEqual(afterColor.graph.nodes.FavoritesNode?.favorites, {
      favoriteColor: "blue",
    });
    const favoritesHistory = afterColor.graph.histories.favorites;
    assert(favoritesHistory);
    const defaultHistory = afterColor.graph.histories.default;
    assert(defaultHistory);
    assert(
      favoritesHistory.some(
        (message) => message.data.content === "blue",
      ),
      "favorites are persisted in their own history space",
    );
    assert(
      defaultHistory.some(
        (message) => message.data.content === "LA and NYC",
      ),
      "weather remains in the shared default history space",
    );
    const favoriteHistory = [...llmGateway.agentHistories]
      .reverse()
      .find((history) => history.some((message) => message.content === "blue"));
    assert(favoriteHistory);
    assert.equal(
      favoriteHistory.some((message) => message.content === "LA and NYC"),
      false,
      "the favorites agent does not receive the weather history",
    );

    const movie = await run("The Matrix", session);
    assert.match(movie.body.message, /provide all three favorites/i);
    const afterMovie = await app
      .get(GraphEngine)
      .getSession<DemoGraphStateType>(session);
    assert(afterMovie?.graph.nodes);
    assert.deepEqual(afterMovie.graph.nodes.FavoritesNode?.favorites, {
      favoriteColor: "blue",
      favoriteMovie: "The Matrix",
    });

    const name = await run("winter", session);
    assert.match(name.body.message, /full name/i);

    const rejectedName = await run("John Doe", session);
    assert.match(rejectedName.body.message, /cannot accept John Doe/i);

    const afterRejectedName = await app
      .get(GraphEngine)
      .getSession<DemoGraphStateType>(session);
    assert(afterRejectedName);
    assert(afterRejectedName.graph.nodes);
    const nameHistory = afterRejectedName.graph.histories.name;
    assert(nameHistory);
    assert.deepEqual(
      nameHistory.slice(-4).map((message) => ({
        type: message.type,
        content: message.data.content,
      })),
      [
        { type: "human", content: "John Doe" },
        { type: "ai", content: "" },
        {
          type: "tool",
          content:
            '{"accepted":false,"name":"John Doe","reason":"That name is not accepted."}',
        },
        {
          type: "ai",
          content:
            "I cannot accept John Doe. Please choose a different full name.",
        },
      ],
    );
    const storedRejectedName = nameHistory.at(-4);
    assert(storedRejectedName?.type === "human");
    assert.equal("additional_kwargs" in storedRejectedName.data, false);
    assert.equal("response_metadata" in storedRejectedName.data, false);
    const storedToolCall = nameHistory.at(-3);
    assert(storedToolCall?.type === "ai");
    assert.equal("tool_calls" in storedToolCall.data, true);
    const storedRejection = nameHistory.at(-1);
    assert(storedRejection?.type === "ai");
    assert.equal("additional_kwargs" in storedRejection.data, false);
    assert.equal("tool_calls" in storedRejection.data, false);
    assert.equal("invalid_tool_calls" in storedRejection.data, false);
    assert.equal("response_metadata" in storedRejection.data, false);

    const dob = await run("Jane Doe", session);
    assert.match(dob.body.message, /date of birth/i);
    assert.equal(llmGateway.maxActiveGenerations, 2);

    const address = await run("1990-01-02", session);
    assert.match(address.body.message, /US address/i);

    const invalid = await run("not an address", session);
    assert.equal(invalid.body.completed, false);
    assert.match(invalid.body.message, /valid US address/i);

    const completed = await run("123 Main St., New York, NY 10001", session);
    assert.equal(completed.body.success, true);
    assert.equal(completed.body.completed, true);
    assert.equal(completed.body.message, "Address collected successfully.");

    const stored = await app
      .get(GraphEngine)
      .getSession<DemoGraphStateType>(session);
    assert(stored);
    assert.equal(stored.version, 16);
    assert.equal(stored.graph.id, "DemoGraph");
    assert.deepEqual(stored.graph.model, {
      name: "google:gemini-3.1-flash-lite",
      family: "chat",
      params: { retries: 3, temperature: 0.2 },
    });
    assert(stored.graph.nodes);
    assert.deepEqual(stored.graph.nodes.WeatherNode?.model, {
      name: "google:gemini-3.5-flash",
      family: "chat",
      params: { retries: 3, temperature: 0.2 },
    });
    assert.equal(stored.graph.nodes.FavoritesNode?.model, undefined);
    assert.deepEqual(stored.graph.nodes.WeatherNode?.weather, {
      LA: 72,
      NYC: 83,
    });
    assert.deepEqual(stored.graph.nodes.FavoritesNode?.favorites, {
      favoriteColor: "blue",
      favoriteMovie: "The Matrix",
      favoriteSeason: "winter",
    });
    assert.equal(stored.graph.nodes.NameNode?.name, "Jane Doe");
    assert.equal("toolTrace" in (stored.graph.nodes.WeatherNode ?? {}), false);
    assert.equal("toolTrace" in (stored.graph.nodes.FavoritesNode ?? {}), false);
    assert.equal("toolTrace" in (stored.graph.nodes.NameNode ?? {}), false);
    assert.equal("toolTrace" in (stored.graph.nodes.InContextNode ?? {}), false);
    assert.equal("toolTrace" in (stored.graph.nodes.DobNode ?? {}), false);
    assert.equal("toolTrace" in (stored.graph.nodes.AddressNode ?? {}), false);
    assert.deepEqual(stored.tokens, {
      input_tokens: 250,
      output_tokens: 100,
      thinking_tokens: 25,
      tool_input_tokens: 50,
      cached_input_tokens: 75,
      total_tokens: 350,
    });
    assert.equal(
      Object.values(stored.graph.histories)
        .flat()
        .filter(({ type }) => type === "tool").length,
      10,
      "Agent tool results are persisted as LangChain ToolMessages.",
    );
    const finalReplyHistory = llmGateway.agentHistories.at(-1);
    assert(finalReplyHistory);
    assert(
      finalReplyHistory.some(
        (message) => message.content === "123 Main St., New York, NY 10001",
      ),
      "the agent receives its current history segment",
    );
    assert.equal(
      finalReplyHistory.some((message) => message.content === "Hi"),
      false,
      "the address agent does not receive unrelated earlier-stage history",
    );
    assert.equal("context" in stored, false);
    assert.equal("state" in stored, false);

    const repeated = await run("anything else", session);
    assert.equal(repeated.body.completed, true);
    assert.equal(repeated.body.message, "This conversation is already complete.");
  });

  it("deletes a session and rejects unknown graphs", async () => {
    const started = await run("Hi");
    const session = started.response.headers.get("session_id");
    assert(session);

    const ended = await fetch(`${baseUrl}/ai/end`, {
      method: "POST",
      headers: { SESSION_ID: session },
    });
    assert.equal(ended.status, 200);
    assert.equal(((await ended.json()) as { success: boolean }).success, true);

    const restarted = await run("Hi", session);
    assert.match(restarted.body.message, /LA and NYC/i);

    const unknown = await run("Hi", undefined, "NoSuchGraph");
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.success, false);
    assert.match(unknown.body.message, /not registered/i);
  });

  it("captures a graph exception in the session document and can recover", async () => {
    llmGateway.failNextCall(new Error("Simulated provider failure"));
    const failed = await run("Hi");
    assert.equal(failed.response.status, 400);
    assert.equal(failed.body.success, false);
    assert.equal(failed.body.message, "Simulated provider failure");

    const session = failed.response.headers.get("session_id");
    assert(session);
    const failedDocument = await app
      .get(GraphEngine)
      .getSession(session);
    assert(failedDocument);
    assert.equal(failedDocument.graph.nodes, undefined);
    assert.equal(failedDocument.errors.length, 1);
    const firstError = failedDocument.errors[0];
    assert(firstError);
    assert.equal(
      firstError.chat_service,
      "Simulated provider failure",
    );
    assert.match(firstError.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(failedDocument.warnings, []);

    const recovered = await run("Hi", session);
    assert.equal(recovered.response.status, 200);
    const recoveredDocument = await app
      .get(GraphEngine)
      .getSession(session);
    assert(recoveredDocument?.graph.nodes);
    assert.equal(recoveredDocument?.errors.length, 1);
  });

  async function run(
    userMessage: string,
    session?: string,
    graphName = "DemoGraph",
    config: Record<string, unknown> = {},
  ) {
    const response = await fetch(`${baseUrl}/ai/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { SESSION_ID: session } : {}),
      },
      body: JSON.stringify({ message: userMessage, graphName, config }),
    });
    const body = (await response.json()) as {
      success: boolean;
      completed: boolean;
      message: string;
      bot?: string;
      session?: string;
    };
    return { response, body };
  }
});
