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
import {
  GraphEngine,
  LangChainLlmGateway,
  ModelCatalog,
} from "@picoflow/ezgraph";
import { AppModule } from "../../src/app.module.js";
import { QuoteGraph } from "../../src/graphs/quote-graph/quote-graph.js";
import type { QuoteGraphStateType } from "../../src/graphs/quote-graph/quote-graph.state.js";

type RunResponse = {
  success?: boolean;
  completed?: boolean;
  message?: string;
  session?: string;
};

type QuoteGraphScenario = {
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
  "quote-graph",
  "quote-graph.scenario.json",
);
const failureArtifactPath = join(
  process.cwd(),
  "test",
  ".tmp",
  "quote-graph-semantic-failure.json",
);

process.env.QUOTE_GRAPH_CURRENT_DATE ??= "2027-06-01T00:00:00.000Z";

const scenario = loadScenario();
const apiKeyJudgeModel =
  process.env.QUOTE_GRAPH_JUDGE_MODEL ?? scenario.judgeModel ?? "gpt-4o";
const openAIAuthJudgeModel = "openai:gpt-5.4";
const testTimeoutMs = Number(
  process.env.QUOTE_GRAPH_TEST_TIMEOUT_MS ?? 900_000,
);
const useEnvironmentSessionStore = process.env.USE_ENV === "1";
const shouldRunLiveTest = useEnvironmentSessionStore;
const skipReason = !shouldRunLiveTest
  ? "Set USE_ENV=1 to run the live-provider evaluation"
  : undefined;
const keepSession = process.env.KEEP_SESSION === "1";

// AppModule also creates QuoteLanggraph, so force its store to memory along with
// QuoteGraph unless this test is explicitly exercising the configured store.
if (!useEnvironmentSessionStore) {
  process.env.SESSION_STORE = "memory";
}

test(
  "QuoteGraph completes a realistic guided car-insurance quote conversation",
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
        logProgress(
          `turn ${index + 1}/${scenario.turns.length}: ${turn.label}`,
        );
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
      .useValue(new GraphEngine({ graphs: [QuoteGraph] }));
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
  if (process.env.QUOTE_GRAPH_TEST_LOG === "0") return;
  console.log(`[QuoteGraph E2E] ${message}`);
}

function preview(message?: string, maxLength = 180): string {
  const compact = message?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength)}...`;
}

function loadScenario(): QuoteGraphScenario {
  const parsed = JSON.parse(
    readFileSync(scenarioPath, "utf8"),
  ) as QuoteGraphScenario;

  assert.equal(parsed.graphName, "QuoteGraph");
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

  if (process.env.OPENAI_API_KEY?.trim()) {
    return judgeWithOpenAIApiKey(turn, message);
  }

  return judgeWithOpenAIAuth(turn, message);
}

const judgeSystemPrompt = [
  "You are a strict but fair evaluator for an AI car-insurance quoting graph test.",
  "Compare the actual assistant response to the expected semantic behavior.",
  "Ignore wording differences, formatting differences, currency formatting differences, and harmless extra politeness.",
  "This assistant quotes personal car insurance for Sequoia Auto Insurance through staged intake: driver, vehicle, history, coverage, then quote tiers.",
  "The test conversation date is June 1, 2027, so a start date of June 15 means June 15, 2027; do not mark 2027 dates as incorrect.",
  "The assistant may batch its questions differently than expected: accept responses that ask for only part of the expected next details, and accept responses that ask for several related details of the current stage in a single message, as long as they ask for a correct next missing item and nothing wrong.",
  "Accept responses that restate or confirm collected details before asking the next question.",
  "Accept quote presentations when they include tier options with monthly premiums in dollars, even if tier naming or ordering differs slightly.",
  "Fail if the response asks for information belonging to a wrong stage, skips a required behavior, proceeds with something the expected behavior says must be refused, contradicts the expected behavior, or is too vague to be useful.",
  "Return only JSON with: pass boolean, score number from 0 to 1, reason string, missing string array, contradictions string array.",
].join(" ");

function judgeInput(
  turn: ScenarioTurn,
  actualAssistantResponse: string,
): string {
  return JSON.stringify({
    turnLabel: turn.label,
    userInput: turn.input,
    expectedSemanticBehavior: turn.expectedResponse,
    actualAssistantResponse,
  });
}

async function judgeWithOpenAIApiKey(
  turn: ScenarioTurn,
  message: string,
): Promise<JudgeResult> {
  const openAiResponse = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: apiKeyJudgeModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: judgeSystemPrompt,
          },
          {
            role: "user",
            content: judgeInput(turn, message),
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
  return parseJudgeResult(turn, content);
}

async function judgeWithOpenAIAuth(
  turn: ScenarioTurn,
  message: string,
): Promise<JudgeResult> {
  const config = ModelCatalog.model(openAIAuthJudgeModel, {
    retries: 3,
    reasoningEffort: "low",
  });
  const result = await new LangChainLlmGateway(config).generate(
    judgeSystemPrompt,
    judgeInput(turn, message),
  );
  return parseJudgeResult(turn, result.value);
}

function parseJudgeResult(turn: ScenarioTurn, content: string): JudgeResult {
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
        {
          failedTurn: turn.label,
          judgeModel: process.env.OPENAI_API_KEY?.trim()
            ? apiKeyJudgeModel
            : openAIAuthJudgeModel,
          minScore,
          transcript,
        },
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
    .getSession<QuoteGraphStateType>(sessionId);
  assert.ok(session, "Expected QuoteGraph session document");
  assert.equal(session.graph.id, "QuoteGraph");
  assert.equal(session.status, "completed");
  assert.equal(session.graph.currentNode, "end");
  assert.ok(session.graph.nodes, "Expected QuoteGraph node state");

  const driver = session.graph.nodes.DriverNode?.driver;
  assert.ok(driver, "Expected captured driver profile");
  assert.equal(driver.fullName, "Jamie Rivera");
  assert.equal(driver.dateOfBirth, "1993-04-12");
  assert.equal(driver.licenseState, "OR");
  assert.equal(driver.licenseStatus, "valid");
  assert.equal(driver.yearsLicensed, 10);

  const vehicle = session.graph.nodes.VehicleNode?.vehicle;
  assert.ok(vehicle, "Expected captured vehicle use");
  assert.equal(vehicle.vehicleId, "2019-toyota-camry-se");
  assert.equal(vehicle.ownership, "finance");
  assert.equal(vehicle.parking, "driveway");

  const history = session.graph.nodes.HistoryNode?.history;
  assert.ok(history, "Expected captured insurance history");
  assert.equal(history.currentlyInsured, true);
  assert.equal(history.coverageLapse, false);
  assert.equal(history.incidents.length, 1);
  assert.equal(history.incidents[0]?.type, "violation");

  const coverage = session.graph.nodes.CoverageNode?.coverage;
  assert.ok(coverage, "Expected coverage selection");
  assert.equal(coverage.liability, "standard");
  assert.equal(coverage.collisionDeductible, 1000);
  assert.equal(coverage.comprehensiveDeductible, 1000);
  assert.deepEqual(coverage.extras, ["rental"]);

  assert.equal(session.graph.nodes.QuoteNode?.acceptedTier, "selected");
  assert.match(
    String(session.graph.nodes.QuoteNode?.referenceNumber),
    /^QT-\d{6}$/,
  );
}
