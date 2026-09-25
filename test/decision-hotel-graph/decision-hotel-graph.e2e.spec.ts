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
import type { DecisionHotelGraphStateType } from "../../src/graphs/decision-hotel-graph/decision-hotel-graph.state.js";

type RunResponse = {
  success?: boolean;
  completed?: boolean;
  message?: string;
  session?: string;
};

type DecisionHotelGraphScenario = {
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
  "decision-hotel-graph",
  "decision-hotel-graph.scenario.json",
);
const artifactDirectory = join(process.cwd(), "test", ".tmp", "decision-hotel-graph");
const failureArtifactPath = join(artifactDirectory, "semantic-failure.json");
const successArtifactPath = join(artifactDirectory, "live.json");

process.env.HOTEL_GRAPH_CURRENT_DATE ??= "2027-07-15T00:00:00.000Z";

const scenario = loadScenario();
const apiKeyJudgeModel =
  process.env.DECISION_HOTEL_GRAPH_JUDGE_MODEL ??
  scenario.judgeModel ??
  "gpt-4o";
const openAIAuthJudgeModel = "openai-auth:gpt-5.4";
const testTimeoutMs = Number(
  process.env.DECISION_HOTEL_GRAPH_TEST_TIMEOUT_MS ?? 900_000,
);
const useEnvironmentSessionStore = process.env.USE_ENV === "1";
const missingLiveConfig = ["TYPESAFE_API_KEY", "OPENAI_API_KEY"].filter(
  (key) => !process.env[key]?.trim(),
);
const shouldRunLiveTest =
  useEnvironmentSessionStore && missingLiveConfig.length === 0;
const skipReason = !useEnvironmentSessionStore
  ? "Set USE_ENV=1 to run the live-provider evaluation"
  : missingLiveConfig.length > 0
    ? `Missing live DecisionHotelGraph config: ${missingLiveConfig.join(", ")}`
    : undefined;
const keepSession = process.env.KEEP_SESSION === "1";

if (!useEnvironmentSessionStore) {
  process.env.SESSION_STORE = "memory";
}

test(
  "DecisionHotelGraph completes a live routed, judged, revised hotel booking",
  { timeout: testTimeoutMs, skip: shouldRunLiveTest ? false : skipReason },
  async () => {
    const app = await createApp();
    const server = app.getHttpAdapter().getInstance();
    const transcript: TranscriptTurn[] = [];
    let sessionId: string | undefined;

    async function send(message: string): Promise<RunResponse> {
      const response = await server.inject({
        method: "POST",
        url: "/ai/run",
        headers: {
          "content-type": "application/json",
          ...(sessionId ? { SESSION_ID: sessionId } : {}),
        },
        payload: JSON.stringify({ message, graphName: scenario.graphName }),
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
      const session = await expectSessionState(app, sessionId);
      logProgress("final session state ok");

      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(
        successArtifactPath,
        JSON.stringify(
          {
            transcript,
            decisionUsage: session.decisionUsage,
            llmUsage: session.tokens,
          },
          null,
          2,
        ),
        "utf8",
      );
      logProgress(`saved successful transcript: ${successArtifactPath}`);
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

function loadScenario(): DecisionHotelGraphScenario {
  const parsed = JSON.parse(
    readFileSync(scenarioPath, "utf8"),
  ) as DecisionHotelGraphScenario;

  assert.equal(parsed.graphName, "DecisionHotelGraph");
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
  "You are a strict but fair evaluator for a live AI hotel booking graph test.",
  "Compare the actual assistant response with the expected semantic behavior.",
  "Ignore harmless wording, formatting, ordering, and politeness differences.",
  "The graph searches Hilton hotels in the Portland, Oregon metropolitan area.",
  "The test conversation date is July 15, 2027.",
  "August 1 through August 8, 2027 and August 3 through August 9, 2027 are valid future stay ranges.",
  "Accept concise responses that ask for the correct next criterion without acknowledging or repeating the prior answer; persisted state is checked separately, so omission of an acknowledgement is never a failure by itself.",
  "When one supplied date is impossible, accept either asking only for that date to be corrected or asking the user to provide the valid date pair again, as long as date collection remains active.",
  "On the date-correction turn, the visible response only needs to continue by asking for amenities; the test separately verifies that the corrected dates were saved.",
  "A criteria summary may use normalized tool values such as freeWiFi and freeParking.",
  "Hotel result responses must use actual search results, include hotel names, addresses, nightly price ranges, and total prices, and explain booking or revision.",
  "Fail responses that ask for the wrong criterion, contradict a saved correction, invent a result or booking, omit a required correction, or claim completion before booking.",
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
          { role: "system", content: judgeSystemPrompt },
          { role: "user", content: judgeInput(turn, message) },
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
) {
  const session = await app
    .get(GraphEngine)
    .getSession<DecisionHotelGraphStateType>(sessionId);
  assert.ok(session, "Expected DecisionHotelGraph session document");
  assert.equal(session.graph.id, "DecisionHotelGraph");
  assert.equal(session.status, "completed");
  assert.equal(session.graph.currentNode, "end");

  const nodes = session.graph.nodes;
  assert.deepEqual(nodes.DateRangeNode, {
    answered: true,
    start: "2027-08-03",
    end: "2027-08-09",
  });
  assert.deepEqual(nodes.BudgetNode, {
    answered: true,
    min: null,
    max: 750,
  });
  assert.deepEqual(nodes.RoomTypeNode, {
    answered: true,
    roomType: "suite",
  });
  assert.deepEqual(nodes.AmenityNode, {
    answered: true,
    amenities: ["freeWiFi", "freeParking"],
  });
  assert.deepEqual(nodes.DistanceNode, {
    answered: true,
    airport: null,
    cityCenter: null,
  });

  assert.equal(nodes.CriteriaReadinessDecisionNode?.accepted, true);
  assert.ok(nodes.PresentationDecisionNode?.review);
  assert.equal(
    typeof nodes.PresentationDecisionNode?.accepted,
    "boolean",
    "Expected an accepted draft or a deterministic grounded fallback",
  );

  const present = nodes.PresentNode;
  const hotels = present?.hotelFound;
  assert.ok(Array.isArray(hotels) && hotels.length > 0);
  assert.equal(typeof present?.selectedHotel, "string");
  assert.ok(
    hotels.some((hotel) => hotel.hotelName === present?.selectedHotel),
    "Booked hotel must come from the current search result set",
  );
  assert.match(String(present?.confirmationNumber), /^\d{6}$/);
  assert.ok((session.decisionUsage?.calls ?? 0) >= 10);
  assert.ok(session.tokens.total_tokens > 0);

  return session;
}

function readSessionHeader(
  headers: Record<string, number | string | string[] | undefined>,
): string | undefined {
  const header = headers.session_id ?? headers.SESSION_ID;
  return Array.isArray(header) ? header[0] : header?.toString();
}

function logProgress(message: string): void {
  if (process.env.DECISION_HOTEL_GRAPH_TEST_LOG === "0") return;
  console.log(`[DecisionHotelGraph E2E] ${message}`);
}

function preview(message?: string, maxLength = 180): string {
  const compact = message?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength)}...`;
}
