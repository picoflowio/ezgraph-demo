import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import type { ExpenseGraphStateType } from "../../src/graphs/expense-graph/expense-graph.state.js";
import { GraphEngine } from "@picoflow/ezgraph";

type ExpenseLineItem = {
  date: string;
  description: string;
  category: string;
  amount: number;
};

type ExpenseResponse = {
  hotel_name: string;
  folio_number: string;
  guest_name: string;
  room_number: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  currency: string;
  line_items: ExpenseLineItem[];
  room_subtotal: number;
  tax_total: number;
  incidentals_subtotal: number;
  total: number;
  payments: { method: string; amount: number }[];
  balance_due: number;
};

// Ground truth printed on data/GrandSequoia.pdf by
// scripts/generate-hotel-receipt.mjs.
const RECEIPT = {
  folio: "GS-88214",
  checkIn: "2027-05-10",
  checkOut: "2027-05-13",
  nights: 3,
  lineItemCount: 11,
  roomSubtotal: 567.0,
  taxTotal: 79.38,
  incidentalsSubtotal: 215.5,
  total: 861.88,
} as const;

describe("ExpenseGraph hotel receipt extraction", () => {
  let app: NestFastifyApplication;
  let baseUrl: string;

  before(async () => {
    // Use AppModule's GraphEngine.create() so SESSION_STORE (mongodb in
    // test:expense-graph) is honored. `new GraphEngine()` would silently
    // fall back to the in-memory SessionManager.
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    "extracts the Grand Sequoia folio into itemized expense JSON",
    { timeout: 180_000 },
    async () => {
      const response = await fetch(`${baseUrl}/ai/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graphName: "ExpenseGraph",
          config: {
            fileName: "data/GrandSequoia.pdf",
          },
        }),
      });
      const body = (await response.json()) as ExpenseResponse;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(
        response.headers.get("content-type")?.split(";")[0],
        "application/json",
      );
      const sessionId = response.headers.get("session_id");
      assert(sessionId, "Expected an ExpenseGraph session id");

      assert.match(body.hotel_name, /grand sequoia/i);
      assert.equal(body.folio_number, RECEIPT.folio);
      assert.match(body.guest_name, /jamie rivera/i);
      assert.equal(body.room_number, "412");
      assert.equal(body.check_in_date, RECEIPT.checkIn);
      assert.equal(body.check_out_date, RECEIPT.checkOut);
      assert.equal(body.nights, RECEIPT.nights);
      assert.equal(body.currency, "USD");

      assert.equal(body.line_items.length, RECEIPT.lineItemCount);
      const roomNights = body.line_items.filter(
        (item) => item.category === "room",
      );
      assert.equal(roomNights.length, 3);
      for (const night of roomNights) {
        assert.equal(night.amount, 189.0);
      }
      const itemizedSum = body.line_items.reduce(
        (sum, item) => sum + item.amount,
        0,
      );
      assert.equal(Math.round(itemizedSum * 100) / 100, RECEIPT.total);

      assert.equal(body.room_subtotal, RECEIPT.roomSubtotal);
      assert.equal(body.tax_total, RECEIPT.taxTotal);
      assert.equal(body.incidentals_subtotal, RECEIPT.incidentalsSubtotal);
      assert.equal(body.total, RECEIPT.total);
      assert.equal(body.payments.length, 1);
      assert.match(body.payments[0]!.method, /visa/i);
      assert.equal(body.payments[0]!.amount, RECEIPT.total);
      assert.equal(body.balance_due, 0);

      const stored = await app
        .get(GraphEngine)
        .getSession<ExpenseGraphStateType>(sessionId);
      assert(stored, "Expected persisted ExpenseGraph session state");
      assert.equal(stored.status, "completed");
      assert.equal(stored.graph.id, "ExpenseGraph");
      assert.equal(stored.graph.currentNode, "end");
      assert.deepEqual(stored.graph.nodes.ExtractExpenseNode?.expense, body);
    },
  );
});
