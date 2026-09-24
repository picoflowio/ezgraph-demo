# EZGraph demo

This is a public NestJS + Fastify consumer application for
[`@picoflow/ezgraph`](https://www.npmjs.com/package/@picoflow/ezgraph). It
contains the same Sequoia Auto Insurance conversation built twice:

- `src/graphs/quote-graph/` — EZGraph: five conversational node classes with
  node-owned durable state and explicit tool responses.
- `src/graphs/quote-langgraph/` — direct LangGraph control implementation:
  the same product, prompts, rating engine, and scenarios without EZGraph.

It also includes:

- `DecisionHotelGraph`, a mixed `DecisionNode` + `ConversationNode` hotel
  workflow with deterministic policy, semantic routing/review, durable decision
  audits, and graph-owned fallbacks.
- `ExpenseGraph`, a one-shot receipt/folio extraction graph.

## What the comparison measures

The quote implementations have the same customer-facing scope: driver,
vehicle, history, coverage, quote adjustment, acceptance, deterministic rating,
idle expiry, and termination.

Current normalized application-code counts are:

| Scope | EZGraph | Direct LangGraph | Difference |
| --- | ---: | ---: | ---: |
| Framework-facing quote graph code | 617 | 1,283 | 51.9% less |
| Matching domain backend | 287 | 287 | identical |
| Quote graph code + controller | 664 | 1,357 | 51.1% less |

The count excludes framework source and the matching domain backend from the
headline. It is one reproducible application comparison, not a universal
performance or productivity claim. See the
[method and breakdown](https://www.picoflow.io/ezgraph/docs/langgraph-pain-points/).

## Run locally

This checkout links the local EZGraph development artifact. Clone the sibling
repositories, build that artifact first, then install the demo:

```bash
git clone https://github.com/picoflowio/ezgraph.git
git clone https://github.com/picoflowio/ezgraph-demo.git

cd ezgraph
npm run build:locallib

cd ../ezgraph-demo
npm install
cp .env.example .env
```

The default `.env.example` uses SQLite. Set one of `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, or `ANTHROPIC_API_KEY` before running a provider-backed
conversation. The deterministic tests do not require a provider credential.

```bash
# Deterministic QuoteGraph tests: validation, state, transitions, rating, and acceptance.
npm run test:quote-graph

# 23-turn DecisionHotelGraph contract through the real GraphEngine harness.
npm run test:decision-hotel-graph

# Opt-in live DecisionHotelGraph replay with turn-by-turn output and semantic evaluation.
USE_ENV=1 npm run test2:decision-hotel-graph

# Opt-in live QuoteGraph replay and semantic evaluation.
USE_ENV=1 npm run test2:quote-graph

# Compile the NestJS application.
npm run build

# Start the server after building.
npm run start:prod
```

`USE_ENV=1` is the live/provider-test switch. `test2:*` also sets
`KEEP_SESSION=1` so a replay session can be inspected after the test. Live
tests depend on current provider credentials and send the scenario transcript
to the selected model and judge; they are intentionally not part of the default
deterministic test path.

## Read QuoteGraph first

The EZGraph implementation shows the current authoring contract:

```ts
export class DriverNode extends ConversationNode<QuoteGraphStateType> {
  @Tool("capture_driver")
  async captureDriver(input: DriverInput): Promise<ToolResponse> {
    const driver = validateDriver(input);
    if (!driver.ok) return stay(JSON.stringify(driver.error));

    this.saveState({ driver: driver.value });
    return go(VehicleNode);
  }
}
```

Each node saves its validated state directly. A handler then returns one of:

| Return | Meaning |
| --- | --- |
| `stay(feedback)` | Keep collecting in the current node. |
| `go(TargetNode)` | Enter the target conversational node now. |
| `direct(content)` | Return exact code-owned content while keeping the graph active. |
| `directTo(TargetNode, content)` | Return exact content and make the target the next user-turn node. |
| `finish(content)` | Return exact final content and complete the graph. |

`QuoteGraph` registers its conversational topology explicitly:

```ts
graph.registerTurnNodes(
  DriverNode,
  VehicleNode,
  HistoryNode,
  CoverageNode,
  QuoteNode,
  TerminateSessionNode,
);
graph.addEdge(TerminateSessionNode, END);
```

There is no per-turn context object, post-tool transition hook, synthetic tool
result, or automatic outcome router. For a transition that seeds target state,
use `go(TargetNode).withState({ ... })`; for cross-node policy reads and writes,
use `graph.graphState()` and `graph.saveNodeState()`.

## HTTP surface

The NestJS host is deliberately thin. It forwards requests to `GraphEngine`
without embedding graph-specific routing in the controller:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthcheck` | Health response. |
| `GET /ai/graphs` | Registered EZGraph graph names. |
| `POST /ai/run` | Run `DecisionHotelGraph`, `QuoteGraph`, or `ExpenseGraph`; pass a `SESSION_ID` header to resume. |
| `POST /ai/end` | End an EZGraph session. |
| `GET /ai-langgraph/graphs` | Direct-LangGraph comparison graph names. |
| `POST /ai-langgraph/run` | Run the direct `QuoteLanggraph` control implementation. |
| `POST /ai-langgraph/end` | End a direct-LangGraph session. |

## Repository layout

```text
src/
  controllers/              HTTP adapters for EZGraph and the direct control graph
  graphs/
    decision-hotel-graph/   Mixed decision/conversation DecisionHotelGraph
    quote-graph/            EZGraph QuoteGraph
    quote-langgraph/        Direct LangGraph comparison
    expense-graph/          Receipt and folio extraction
test/
  decision-hotel-graph/     23-turn deterministic GraphEngine acceptance test
  quote-graph/              Deterministic and opt-in live QuoteGraph tests
  quote-langgraph/          Control-implementation tests and live replay
```

## Learn more

- [EZGraph tutorial](https://www.picoflow.io/ezgraph/tutorial/)
- [EZGraph developer guide](https://www.picoflow.io/ezgraph/docs/developer-guide/)
- [QuoteGraph walkthrough](https://www.picoflow.io/ezgraph/quote-graph/)
- [Direct LangGraph comparison](https://www.picoflow.io/ezgraph/compare/langgraph/)

This repository is an example host. EZGraph itself is framework-neutral; NestJS
and Fastify are not runtime requirements of the library.
