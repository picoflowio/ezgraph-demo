import "dotenv/config";

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { GraphEngine } from "ezgraph";
import { AppModule } from "../../src/app.module.js";
import { SupportGraph } from "../../src/graphs/support-graph/support-graph.js";
import type { SupportGraphStateType } from "../../src/graphs/support-graph/support-graph.state.js";

type RunResponse = {
  success?: boolean;
  completed?: boolean;
  message?: string;
  session?: string;
};

type SupportGraphScenario = {
  graphName: string;
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

type TranscriptTurn = ScenarioTurn & {
  actualResponse?: string;
  judge?: JudgeResult;
};

type JudgeResult = {
  pass: boolean;
  score: number;
  reason: string;
  missing?: string[];
  contradictions?: string[];
};

const scenarioPath = join(
  process.cwd(),
  "test",
  "support-graph",
  "support-graph.scenario.json",
);
const failureArtifactPath = join(
  process.cwd(),
  "test",
  ".tmp",
  "support-graph-semantic-failure.json",
);

process.env.SUPPORT_GRAPH_CURRENT_DATE ??= "2027-07-15T00:00:00.000Z";

const scenario = loadScenario();
const judgeModel =
  process.env.SUPPORT_GRAPH_JUDGE_MODEL ?? scenario.judgeModel ?? "gpt-4o";
const testTimeoutMs = Number(
  process.env.SUPPORT_GRAPH_TEST_TIMEOUT_MS ?? 900_000,
);
const missingLiveConfig = ["OPENAI_API_KEY"].filter(
  (key) => !process.env[key]?.trim(),
);
const shouldRunLiveTest =
  process.env.RUN_LIVE_SUPPORT_GRAPH_TEST !== "0" &&
  missingLiveConfig.length === 0;
const skipReason =
  process.env.RUN_LIVE_SUPPORT_GRAPH_TEST === "0"
    ? "RUN_LIVE_SUPPORT_GRAPH_TEST=0"
    : `Missing live SupportGraph config: ${missingLiveConfig.join(", ")}`;
const useEnvironmentSessionStore =
  process.env.SUPPORT_GRAPH_TEST_USE_ENV === "1";
const keepSession = process.env.SUPPORT_GRAPH_KEEP_SESSIONS === "1";

test(
  "SupportGraph gates a large refund, auto-approves a small one, and escalates a charge",
  { timeout: testTimeoutMs, skip: shouldRunLiveTest ? false : skipReason },
  async () => {
    const app = await createApp();
    const server = app.getHttpAdapter().getInstance();
    let sessionId: string | undefined;

    async function send(message: string): Promise<RunResponse> {
      const response = await server.inject({
        method: "POST",
        url: "/ai/run",
        headers: {
          "content-type": "application/json",
          ...(sessionId ? { SESSION_ID: sessionId } : {}),
        },
        payload: JSON.stringify({
          message,
          graphName: scenario.graphName,
        }),
      });

      assert.equal(
        response.statusCode,
        200,
        `POST /ai/run failed for "${message}": ${response.payload}`,
      );

      const body = JSON.parse(response.payload) as RunResponse;
      assert.equal(body.success, true, `Expected success for "${message}"`);
      assert.ok(body.session, `Expected session id for "${message}"`);

      const responseSessionId = readSessionHeader(response.headers);
      if (sessionId) {
        assert.equal(body.session, sessionId, "Session id changed in body");
        assert.equal(
          responseSessionId,
          sessionId,
          "Session id changed in response header",
        );
      } else {
        sessionId = responseSessionId ?? body.session;
      }

      return body;
    }

    const transcript: TranscriptTurn[] = [];

    try {
      for (const [index, turn] of scenario.turns.entries()) {
        logProgress(`turn ${index + 1}/${scenario.turns.length}: ${turn.label}`);
        logProgress(`input: ${turn.input}`);

        const response = await send(turn.input);
        logProgress(`response: ${preview(response.message)}`);

        const transcriptTurn: TranscriptTurn = {
          ...turn,
          actualResponse: response.message ?? "",
        };
        transcript.push(transcriptTurn);

        assert.equal(
          response.completed,
          turn.completed,
          `${turn.label} completed flag mismatch`,
        );

        transcriptTurn.judge = await judgeResponse(turn, response);
        expectSemanticMatch(transcriptTurn, transcript);
        logProgress(
          `judge: pass score=${transcriptTurn.judge.score} reason=${preview(
            transcriptTurn.judge.reason,
          )}`,
        );
      }

      assert.ok(sessionId, "Expected a session id after conversation");
      logProgress("checking final session state");
      await expectSessionState(app, sessionId);
      logProgress("final session state ok");
    } finally {
      if (sessionId && keepSession) {
        logProgress(`retained session: ${sessionId}`);
      } else if (sessionId) {
        await app.get(GraphEngine).deleteSession(sessionId);
      }
      await app.close();
    }
  },
);

async function createApp(): Promise<NestFastifyApplication> {
  const moduleBuilder = Test.createTestingModule({ imports: [AppModule] });
  if (!useEnvironmentSessionStore) {
    moduleBuilder
      .overrideProvider(GraphEngine)
      .useValue(new GraphEngine({ graphs: [SupportGraph] }));
  }
  const moduleRef = await moduleBuilder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function readSessionHeader(
  headers: Record<string, number | string | string[] | undefined>,
): string | undefined {
  const header = headers.session_id ?? headers.SESSION_ID;
  return Array.isArray(header) ? header[0] : header?.toString();
}

function logProgress(message: string): void {
  if (process.env.SUPPORT_GRAPH_TEST_LOG === "0") return;
  console.log(`[SupportGraph E2E] ${message}`);
}

function preview(message?: string, maxLength = 180): string {
  const compact = message?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength)}...`;
}

function loadScenario(): SupportGraphScenario {
  const parsed = JSON.parse(
    readFileSync(scenarioPath, "utf8"),
  ) as SupportGraphScenario;

  assert.equal(parsed.graphName, "SupportGraph");
  assert.ok(parsed.turns.length > 0, "Scenario must include turns");
  for (const turn of parsed.turns) {
    assert.ok(turn.label, "Scenario turn must include a label");
    assert.ok(turn.input, `${turn.label}: scenario turn must include input`);
    assert.ok(
      turn.expectedResponse,
      `${turn.label}: scenario turn must include expectedResponse`,
    );
    assert.equal(
      typeof turn.completed,
      "boolean",
      `${turn.label}: scenario turn must include completed`,
    );
  }
  return parsed;
}

async function judgeResponse(
  turn: ScenarioTurn,
  response: RunResponse,
): Promise<JudgeResult> {
  const message = response.message?.replace(/\s+/g, " ").trim();
  assert.ok(message, `${turn.label}: expected non-empty bot message`);

  const openAiResponse = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: judgeModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a strict but fair evaluator for an AI post-purchase support graph test.",
              "Compare the actual assistant response to the expected semantic behavior.",
              "Ignore wording differences, formatting differences, markdown table layout differences, and harmless extra politeness.",
              "This assistant handles order status, returns and refunds, and billing disputes for Northwind Outfitters. The conversation date is July 15, 2027.",
              "Accept responses that ask for the correct next piece of information even if they omit acknowledgement of the prior answer.",
              "Accept refund breakdowns in a table, a list, or prose, as long as the stated net refund amount and destination payment method match the expected values exactly.",
              "Money is decided by the system, not the assistant. Fail any turn where the assistant invents, estimates, negotiates, or changes an amount, a fee, or an eligibility outcome that the expected behavior did not state.",
              "The approval gate turn is the most important one. Fail it if the assistant claims the refund was already issued, gives an RMA number, or fails to ask for an explicit confirmation.",
              "The decline turn must leave nothing committed. Fail it if the assistant reports an RMA number or a completed refund.",
              "For billing, fail any response that promises a reversal, a credit, or a specific timeline.",
              "Identifier formats matter: an RMA is RMA followed by six digits, and a ticket is ESC followed by five digits. The specific digits are generated at runtime, so judge the format and not the value.",
              "Fail if the response asks for the wrong information, skips a required behavior, contradicts the expected behavior, or is too vague to be useful.",
              "Return only JSON with: pass boolean, score number from 0 to 1, reason string, missing string array, contradictions string array.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              turnLabel: turn.label,
              userInput: turn.input,
              expectedSemanticBehavior: turn.expectedResponse,
              actualAssistantResponse: message,
            }),
          },
        ],
      }),
    },
  );

  if (!openAiResponse.ok) {
    assert.fail(
      `${turn.label}: judge request failed: ${await openAiResponse.text()}`,
    );
  }

  const result = (await openAiResponse.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = result.choices?.[0]?.message?.content;
  assert.ok(content, `${turn.label}: judge returned empty response`);
  try {
    return JSON.parse(content) as JudgeResult;
  } catch {
    assert.fail(`${turn.label}: judge returned invalid JSON: ${content}`);
  }
}

function expectSemanticMatch(
  turn: TranscriptTurn,
  transcript: TranscriptTurn[],
): void {
  const judge = turn.judge;
  assert.ok(judge, `${turn.label}: missing judge result`);
  const minScore = turn.minScore ?? scenario.judgeMinScore ?? 0.75;
  const passed = judge.pass === true && judge.score >= minScore;

  if (!passed) {
    mkdirSync(dirname(failureArtifactPath), { recursive: true });
    writeFileSync(
      failureArtifactPath,
      JSON.stringify(
        { failedTurn: turn.label, judgeModel, minScore, transcript },
        null,
        2,
      ),
      "utf8",
    );
  }

  assert.equal(
    passed,
    true,
    [
      `${turn.label}: semantic judge failed`,
      `score=${judge.score}, minScore=${minScore}`,
      `reason=${judge.reason}`,
      `actual=${turn.actualResponse}`,
      `artifact=${failureArtifactPath}`,
    ].join("\n"),
  );
}

async function expectSessionState(
  app: NestFastifyApplication,
  sessionId: string,
): Promise<void> {
  const session = await app
    .get(GraphEngine)
    .getSession<SupportGraphStateType>(sessionId);
  assert.ok(session, "Expected SupportGraph session document");
  assert.equal(session.graph.id, "SupportGraph");
  assert.equal(session.status, "completed");
  assert.equal(session.graph.currentNode, "end");
  assert.ok(session.graph.nodes, "Expected SupportGraph node state");

  assert.equal(session.graph.nodes.TriageNode?.order?.orderId, "NW-100412");

  // The declined $289 refund must never have been committed.
  const refunds = session.graph.nodes.TriageNode?.refunds ?? [];
  assert.equal(refunds.length, 1, "Expected exactly one committed refund");
  assert.equal(refunds[0]?.netRefund, 136);
  assert.equal(refunds[0]?.authority, "agent");
  assert.match(refunds[0]?.rma ?? "", /^RMA-\d{6}$/);
  assert.deepEqual(session.graph.nodes.ReturnsNode?.returnedLineIds, ["L2"]);
  assert.equal(
    session.graph.nodes.ApprovalNode?.pending,
    undefined,
    "Expected the approval gate to be released",
  );

  const tickets = session.graph.nodes.TriageNode?.tickets ?? [];
  assert.equal(tickets.length, 1, "Expected exactly one escalation ticket");
  assert.match(tickets[0]?.ticketId ?? "", /^ESC-\d{5}$/);
  assert.equal(tickets[0]?.amountInDispute, 439.95);
}
