import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { InvoiceGraph } from "../../src/graphs/invoice-graph/invoice-graph.js";
import type { InvoiceGraphStateType } from "../../src/graphs/invoice-graph/invoice-graph.state.js";
import { DemoGraph } from "../../src/graphs/demo-graph/demo-graph.js";
import { GraphEngine } from "ezgraph";

type InvoiceResponse = Record<string, unknown>;

// Captured from the InvoiceGraph response for data/ACME.pdf.
const CAPTURED_RESPONSE = JSON.parse(
  readFileSync(new URL("./captured-response.json", import.meta.url), "utf8"),
) as InvoiceResponse;

describe("InvoiceGraph captured response", () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  before(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GraphEngine)
      .useValue(new GraphEngine({ graphs: [DemoGraph, InvoiceGraph] }))
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

  it(
    "runs the ACME invoice extraction request and matches the captured JSON",
    { timeout: 180_000 },
    async () => {
      const response = await fetch(`${baseUrl}/ai/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphName: "InvoiceGraph",
          config: {
            fileName: "data/ACME.pdf",
          },
        }),
      });
      const body = (await response.json()) as InvoiceResponse;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(
        response.headers.get("content-type")?.split(";")[0],
        "application/json",
      );
      const sessionId = response.headers.get("session_id");
      assert(sessionId, "Expected an InvoiceGraph session id");
      assert.deepEqual(body, CAPTURED_RESPONSE);

      const stored = await app
        .get(GraphEngine)
        .getSession<InvoiceGraphStateType>(sessionId);
      assert(stored, "Expected persisted InvoiceGraph session state");
      assert.equal(stored.status, "completed");
      assert.equal(stored.graph.id, "InvoiceGraph");
      assert.equal(stored.graph.currentNode, "end");
      assert.deepEqual(stored.graph.nodes.ExtractInvoiceNode?.invoice, body);
    },
  );
});
