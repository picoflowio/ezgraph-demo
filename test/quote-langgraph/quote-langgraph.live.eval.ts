import "dotenv/config";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "../../src/app.module.js";
import { QuoteLanggraph } from "../../src/graphs/quote-langgraph/quote-langgraph.js";

type Scenario = {
  judgeModel?: string;
  judgeMinScore?: number;
  turns: ScenarioTurn[];
};

type ScenarioTurn = {
  label: string;
  input: string;
  expectedResponse: string;
  completed: boolean;
  minScore?: number;
};

type RunResponse = {
  success: boolean;
  completed: boolean;
  message: string;
  session: string;
};

type JudgeResult = {
  pass: boolean;
  score: number;
  reason: string;
  missing?: string[];
  contradictions?: string[];
};

const scenario = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "test",
      "quote-langgraph",
      "quote-langgraph.scenario.json",
    ),
    "utf8",
  ),
) as Scenario;

process.env.QUOTE_GRAPH_CURRENT_DATE ??= "2027-06-01T00:00:00.000Z";

const useEnvironmentSessionStore = process.env.USE_ENV === "1";

if (!useEnvironmentSessionStore) {
  process.env.SESSION_STORE = "memory";
}

test(
  "QuoteLanggraph completes the live 15-turn car-insurance quote scenario",
  { timeout: Number(process.env.QUOTE_GRAPH_TEST_TIMEOUT_MS ?? 900_000) },
  async () => {
    assert(
      process.env.OPENAI_API_KEY?.trim(),
      "test:quote-langgraph requires OPENAI_API_KEY; the live test does not silently skip.",
    );
    assert.equal(scenario.turns.length, 15);

    const app = await createApp();
    const server = app.getHttpAdapter().getInstance();
    const graph = app.get(QuoteLanggraph);
    const keepSession = process.env.KEEP_SESSION === "1";
    let sessionId: string | undefined;

    console.log(`[QuoteLanggraph Live] session store: ${graph.sessionStoreKind}`);

    try {
      for (const [index, turn] of scenario.turns.entries()) {
        console.log(
          `[QuoteLanggraph Live] turn ${index + 1}/${scenario.turns.length}: ${turn.label}`,
        );
        console.log(`[QuoteLanggraph Live] input: ${turn.input}`);

        const response = await server.inject({
          method: "POST",
          url: "/ai-langgraph/run",
          headers: {
            "content-type": "application/json",
            ...(sessionId ? { SESSION_ID: sessionId } : {}),
          },
          payload: JSON.stringify({
            graphName: "QuoteLanggraph",
            message: turn.input,
          }),
        });
        assert.equal(
          response.statusCode,
          200,
          `${turn.label}: ${response.payload}`,
        );
        const body = JSON.parse(response.payload) as RunResponse;
        assert.equal(body.success, true, turn.label);
        assert.ok(body.message.trim(), `${turn.label}: empty response`);
        assert.equal(
          body.completed,
          turn.completed,
          `${turn.label}: completed flag mismatch`,
        );

        const responseSession = readSessionHeader(response.headers);
        if (sessionId) {
          assert.equal(body.session, sessionId, "session body changed");
          assert.equal(responseSession, sessionId, "session header changed");
        } else {
          sessionId = responseSession ?? body.session;
          assert.ok(sessionId, "first response did not return a session");
        }

        console.log(`[QuoteLanggraph Live] response: ${preview(body.message)}`);
        const judged = await judge(turn, body.message);
        const minScore = turn.minScore ?? scenario.judgeMinScore ?? 0.75;
        console.log(
          `[QuoteLanggraph Live] judge: pass=${judged.pass} score=${judged.score} reason=${preview(judged.reason)}`,
        );
        assert.equal(
          judged.pass && judged.score >= minScore,
          true,
          [
            `${turn.label}: semantic judge failed`,
            `score=${judged.score}, minScore=${minScore}`,
            `reason=${judged.reason}`,
            `missing=${JSON.stringify(judged.missing ?? [])}`,
            `contradictions=${JSON.stringify(judged.contradictions ?? [])}`,
            `actual=${body.message}`,
          ].join("\n"),
        );
      }

      assert(sessionId);
      const state = await graph.getSessionState(sessionId);
      assert(state, "final QuoteLanggraph session state was not stored");
      assert.equal(state.phase, "terminal");
      assert.equal(state.completed, true);
      assert.equal(state.driver?.licenseState, "OR");
      assert.equal(state.driver?.licenseStatus, "valid");
      assert.equal(state.vehicle?.vehicleId, "2019-toyota-camry-se");
      assert.equal(state.vehicle?.ownership, "finance");
      assert.equal(state.history?.currentlyInsured, true);
      assert.deepEqual(state.history?.incidents, [
        { type: "violation", date: "2026-03" },
      ]);
      assert.equal(state.coverage?.collisionDeductible, 1000);
      assert.equal(state.coverage?.comprehensiveDeductible, 1000);
      assert.equal(state.coverage?.startDate, "2027-06-15");
      assert.equal(state.acceptedTier, "selected");
      assert.match(String(state.referenceNumber), /^QT-\d{6}$/);
      console.log("[QuoteLanggraph Live] final session state: ok");
    } finally {
      if (sessionId && keepSession) {
        console.log(`[QuoteLanggraph Live] retained session: ${sessionId}`);
      } else if (sessionId) {
        await graph.deleteSession(sessionId);
      }
      await app.close();
    }
  },
);

async function createApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function judge(
  turn: ScenarioTurn,
  actualAssistantResponse: string,
): Promise<JudgeResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model:
        process.env.QUOTE_GRAPH_JUDGE_MODEL ?? scenario.judgeModel ?? "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are a strict but fair evaluator for a car-insurance quoting chatbot.",
            "Compare the response with the expected semantic behavior.",
            "Ignore wording and harmless formatting differences.",
            "The scenario date is June 1, 2027 and coverage starts June 15, 2027.",
            "Accept responses that ask for the correct next quoting field even when they include acknowledgement or harmless extra explanation.",
            "Asking for several related details of the same stage in one message is acceptable.",
            "Accept quote tiers presented as a numbered list or a table when the premiums and coverage details are present.",
            "Return only JSON with pass boolean, score number 0 to 1, reason string, missing string array, and contradictions string array.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            turnLabel: turn.label,
            userInput: turn.input,
            expectedSemanticBehavior: turn.expectedResponse,
            actualAssistantResponse,
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    assert.fail(`${turn.label}: judge failed: ${await response.text()}`);
  }
  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = result.choices?.[0]?.message?.content;
  assert.ok(content, `${turn.label}: judge returned no content`);
  return JSON.parse(content) as JudgeResult;
}

function readSessionHeader(
  headers: Record<string, number | string | string[] | undefined>,
): string | undefined {
  const header = headers.session_id ?? headers.SESSION_ID;
  return Array.isArray(header) ? header[0] : header?.toString();
}

function preview(message: string, maxLength = 200): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength)}...`;
}
