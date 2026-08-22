# EZGraph

**EZGraph is a framework-independent TypeScript library that makes it practical
to build durable, multi-turn LangGraph applications without re-creating the
same state, tool-loop, routing, session, and provider plumbing for every
graph.**

This repository is a NestJS and Fastify consumer application. NestJS owns the
HTTP and dependency-injection setup; EZGraph does not depend on either
framework.

For a concrete side-by-side comparison, the API exposes the same Hilton hotel
chatbot as `HotelGraph` (EZGraph) and `HotelLanggraph` (direct LangGraph). See
[HotelGraph and HotelLanggraph comparison](./docs/hotel-langgraph-comparison.md)
for the self-contained implementations and the orchestration each version owns.
`HotelGraph` is available through `/ai/*`; `HotelLanggraph` is available
through `/ai-langgraph/*`.

LangGraph is a strong, intentionally low-level runtime for stateful agent
workflows. Its graph model—state, nodes, edges, conditional routing, and
persistence—is exactly what production agent applications need. But a real
application can quickly spread those concerns across route handlers, graph
builders, model adapters, tool dispatchers, and database code. The result is
often correct only after a great deal of repeated, hard-to-test glue code.

EZGraph keeps LangGraph as the execution engine and adds an opinionated
application layer around it. You write focused, typed node classes and a
readable topology. EZGraph owns the recurring mechanics: conversation
continuity, tool-call sequencing, state reduction, session persistence, model
configuration, token accounting, and graph registration behind `GraphEngine`.

> EZGraph is designed to make LangGraph applications faster to develop and
> harder to wire incorrectly. It cannot make an LLM application error-free:
> prompts, tools, provider behavior, data validation, and tests still matter.
> Its value is removing repeatable infrastructure work and adding guard rails
> at the boundaries where orchestration bugs commonly appear.

## Why use EZGraph with LangGraph?

LangGraph's flexibility is valuable, but the basic API deliberately asks an
application to define its own state, nodes, edges, routing, and persistence
strategy. The official graph API starts with a `StateGraph`, then explicit
node and edge registration; durable, multi-turn state adds a checkpointer and
a thread identifier. That is the right level of control for an orchestration
runtime, but it can be a lot of scaffolding for every conversational product.

This is not merely a theoretical complaint. The LangGraph maintainers have
asked users specifically for feedback on parts of the low-level `StateGraph`
API that feel confusing, complex, or boilerplate-heavy. EZGraph is our
application-focused answer to those recurring concerns: keep LangGraph's
control flow, while standardizing the code that every graph application ends
up writing.

- [LangGraph Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
  explains the underlying state, node, edge, and conditional-routing model.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
  describes thread-scoped state and the work required for multi-turn memory.
- [LangGraph's v1 feedback issue](https://github.com/langchain-ai/langgraph/issues/4973)
  records the community discussion about clarity and boilerplate in the
  low-level API.

EZGraph is a good fit when you want LangGraph's graph semantics but also need
a repeatable way to ship a backend chatbot, guided workflow, document flow,
or multi-step agent in a TypeScript service. This demo shows one way to host it
with NestJS and Fastify.

The self-contained HotelGraph authoring experiment in this repository uses
**42.7% less normalized executable graph code** than its direct-LangGraph
counterpart after excluding matching domain backend code and both controllers.
It also illustrates the value of a shared phase model and consistently organized
session documents for team comprehension. See the
[technical evaluation](./docs/hotel-graph-critical-evaluation.md) for method
and scope.

## The enterprise differentiator: self-contained operation

EZGraph does not require a LangSmith account, an EZGraph cloud, or any other
vendor observability control plane. When deployed with an in-network Ollama
endpoint and SQLite or self-managed MongoDB, the application, model traffic,
session document, histories, node state, warnings, errors, and token records
can all remain inside the enterprise firewall. The session document supplies a
durable, per-conversation operational record without exporting it to a
framework observability service.

This is an explicit deployment choice: selecting a hosted model or persistence
provider sends data to that selected provider. See the self-contained
deployment feature below for the boundary and configuration implications.

## What EZGraph gives you

### 1. Graphs authored as typed classes, not scattered orchestration code

`BaseGraph` and `StateGraphExt` turn a graph into one discoverable TypeScript
class. A graph declares its model policy and topology in one place; nodes are
registered before they can be connected; conditional routes resolve to
declared endpoints; and the compiled LangGraph is built once.

That means the graph remains visible as a business workflow instead of being
split between controller code, anonymous callbacks, and a raw graph builder.

```ts
export class DemoGraph extends BaseGraph<DemoGraphStateType> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("google:gemini-3.1-flash-lite", {
        retries: 3,
        temperature: 0.2,
      }),
      endNode: GRAPH_END_NODE,
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, DemoGraph.getGraphDefinition());
  }

  protected buildGraph() {
    const graph = this.createStateGraph(DemoGraphState);
    graph.nodes(WeatherNode, FavoritesNode, NameNode, TerminateSessionNode);
    graph.registerTurns(WeatherNode, FavoritesNode, NameNode, TerminateSessionNode);
    graph.branchBy(WeatherNode, {
      cases: [
        { when: FavoritesNode, routeTo: FavoritesNode },
        { when: TerminateSessionNode, routeTo: TerminateSessionNode },
      ],
      otherwise: END,
    });
    graph.branchBy(FavoritesNode, {
      cases: [
        { when: NameNode, routeTo: NameNode },
        { when: TerminateSessionNode, routeTo: TerminateSessionNode },
      ],
      otherwise: END,
    });
    graph.addEdge(TerminateSessionNode, END);
    return graph.compile();
  }
}
```

`StateGraphExt` does not remove LangGraph. It creates the underlying
`StateGraph` and compiles it. Its purpose is to make common authoring mistakes
obvious early: a graph cannot connect a node that was never registered, and a
node class cannot be replaced accidentally by an arbitrary callback.

### 2. Nodes own their prompt, local state, tools, and transitions

Extend `ConversationNode` for interactive stages and `GraphNode` for lower-level
or non-chat stages. A conversational node owns its prompt, optional model
override, typed local state, model-callable tools, and one turn-level outcome.
It does not manually coordinate histories, token usage, response flags, or
session storage.

```ts
protected nextStep(_state, context, conversation) {
  if (conversation.quitRequested) return this.quit(conversation);
  if (this.hasBothCities(context.weather)) {
    return this.advance(FavoritesNode, conversation)
      .withState({ weather: context.weather });
  }
  return this.stay(conversation)
    .withState({ weather: context.weather });
}
```

`stay`, `advance`, `quit`, and `finish` enforce the graph's response,
consumption, history, token, resume-node, and completion invariants. Their
builders also support typed `withState`, `withStateFor`, `withHistory`, and
one-time input forwarding.

The `@Tool` decorator connects a Zod-validated domain tool to its node method.
EZGraph exposes only those decorated tools to the model, validates tool input
before the handler runs, and lets the handler return an explicit result to the
model. `toolResult(output).withContext(...)` records typed context effects
without mutating shared context directly. `stopAfterBatchWhen(...)` can end
the current agent loop after every tool call in that assistant batch has been
executed and recorded.

This is the key separation:

| Concern | Lives in |
| --- | --- |
| Prompt and allowed action | `ConversationNode` / `GraphNode` |
| Typed tool input and business validation | Zod tool + decorated node method |
| Node-local durable values | Outcome `.withState(...)` / `this.state(...)` |
| Turn outcome | `stay`, `advance`, `quit`, or `finish` |
| Graph transition | `branchBy(...)` topology |
| Session read/write and request handling | `GraphEngine` |

### 3. A reusable conversation and tool-call loop

Most tool-using chat nodes need the same delicate sequence: invoke a model,
append its AI message, execute every requested tool, append tool results,
continue until the model answers, record token use, and cap runaway loops.
Copying that loop into every node is a common source of missing messages,
lost tool results, or infinite cycles.

`ConversationNode` and `ConversationRunner` supply that loop. The node base
passes the prompt, active history, declared tools, model settings, and typed
tool executor to the runner, then asks the subclass for one semantic outcome.
The runner:

- preserves AI and tool messages in their correct order;
- executes and records every tool call in an assistant turn before honoring a
  `stopAfterBatch` request;
- bounds a conversation run to eight model/tool turns by default;
- accumulates token usage from every model call;
- releases temporary provider attachments after they are no longer needed;
- handles the neutral initial message required for a fresh Gemini history;
- retries a limited number of empty Gemini candidate responses rather than
  silently treating them as a final answer.

Nodes can still use direct `generate(...)`, `structured(...)`, `respond(...)`,
or `agent(...)` calls when that is the clearer abstraction. EZGraph does not
force every node to be a chat agent.

### 4. Multi-turn conversation state that resumes at the right step

Conversation continuity is more than storing a list of messages. On a later
request, the application has to restore the active workflow step, its local
business values, its configuration, histories, completion state, and token
totals—then route the request back to the correct LangGraph node.

EZGraph gives every graph a state annotation with reducers for:

- `currentNode` — where the next user message resumes;
- `histories` — persisted LangChain messages, grouped by named history space;
- `nodes` — independently merged local state for each node;
- `config` — request or session configuration;
- `tokens` — cumulative input, output, thinking, cache, and total usage;
- `response`, `inputConsumed`, and `completed` — a consistent chat response
  contract.

`graph.registerTurns(...)` supplies the special LangGraph `START` branch. It maps
the persisted `currentNode` to the node that should handle the next turn and
maps the framework's terminal state to LangGraph `END`. No controller needs
to duplicate a `switch` statement for every phase of a conversation.

### 5. Independent histories prevent prompt and context bleed

One giant chat history is often the wrong context for a staged workflow. A
profile-collection node should not accidentally interpret an answer from a
weather phase as an address, and a focused enrichment step should not inherit
all prior chat noise.

Graph definitions can map nodes to named `historySpaces`. Each node reads and
appends only its assigned history. A graph can therefore keep a natural
conversation where continuity is desirable while creating an isolated context
where it is safer or cheaper. The transition is explicit and durable across
requests.

### 6. Session persistence without forcing application code to manage raw checkpoints

EZGraph persists one versioned document per session. On each successful turn,
the session manager behind `GraphEngine` saves the graph name, current node,
histories, node-local values, config, model metadata, token totals, logs,
lifecycle status, and expiry. The next request restores that state before
invoking the graph. `BaseGraph.onRestoreSessionDoc()` applies the default
expiry check; a graph may override it to migrate a document or use a different
retention policy before state is restored.

```ts
protected override async onRestoreSessionDoc(session: SessionDocument<MyState>) {
  if (this.canMigrate(session)) return this.migrate(session);
  return await super.onRestoreSessionDoc(session);
}
```

Return `null` from the hook to start a fresh graph run for the supplied session
ID. The session store itself only loads persisted documents; it does not decide
whether a graph may resume one.

Choose the store through `SESSION_STORE`:

| Store | Best for |
| --- | --- |
| `memory` | Tests and short-lived local experiments |
| `sqlite` | Local development and simple durable deployments |
| `mongodb` / `mongo` | MongoDB-backed services |
| `cosmos` / `cosmosdb` | Azure Cosmos DB deployments |

This library deliberately persists the application-level conversation
document instead of exposing LangGraph's checkpoint mechanics in every
controller. You keep a small, inspectable session record with an expiration
policy, while LangGraph still executes the graph itself.

For a no-egress deployment, select `sqlite` or a self-managed MongoDB
deployment inside the enterprise boundary. Do not select the Cosmos DB store
or a hosted model provider when the application must remain entirely within
the firewall.

### 7. Provider-neutral models with typed, validated configuration

Nodes depend on the `LlmGateway` contract rather than provider SDK classes.
The default `LangChainLlmGateway` uses LangChain's universal chat-model entry
point and caches initialized models by configuration. A graph can select a
default model; a node can override it for a specialized task.

`ModelCatalog.model(model, params)` correlates built-in model IDs with their legal
parameters at compile time and validates the same catalog entry at runtime.
Applications can add models and parameter profiles without an EZGraph release
by loading JSON with `ModelCatalog.create(...)`; those extensions are validated
at startup and each `catalog.model(...)` call. The complete format is published
as `ezgraph/model-catalog.schema.json`, with a local example in
[`config/model-catalog.example.json`](config/model-catalog.example.json).
This demo also loads the real application catalog at
[`src/config/model-catalog.json`](src/config/model-catalog.json):
[`app-model-providers.ts`](src/config/app-model-providers.ts) registers the new
`glm` provider through Z.AI's OpenAI-compatible API, the catalog defines its
runtime parameter profile, and `FavoritesNode` selects `glm:glm-5.1`.
Credentials remain in application configuration rather than graph definitions.

The session records the provider-prefixed model identifier and safe model
parameters used for the conversation. That makes an operational question—
“which model produced this session?”—answerable without scraping logs.

### 8. Self-contained, in-firewall deployment — no mandatory observability cloud

**EZGraph has no required EZGraph cloud, LangSmith account, telemetry client,
or observability control plane.** The graph service runs in the enterprise
runtime, and its session document is written only to the persistence store
chosen by the application. EZGraph does not configure or depend on LangSmith
to execute, resume, or observe a graph.

This is a material architectural difference for enterprises with data-residency
or network-egress requirements. Configure an Ollama model endpoint and a local
SQLite or self-managed MongoDB session store, deploy them inside the enterprise
network, and the graph runtime, conversation histories, node state, session
logs, and token records can remain inside that boundary. No customer prompt or
session document needs to be sent to an EZGraph or LangSmith service.

The boundary is a deployment choice, not a magic property of a library. If you
configure OpenAI, Anthropic, Google, Azure, Bedrock, Cosmos DB, or any other
hosted provider, the data sent to that provider is governed by its own network
path and terms. EZGraph makes this choice explicit; it does not silently
export session data for framework observability.

### 9. Session-document observability that follows a conversation

EZGraph accumulates normalized token usage across all model calls in a graph
turn. It also provides request-isolated warning and error collection through
`withSessionLogs`, `SessionLogWarning`, and `SessionLogError`. The session
service persists those logs alongside the session, including errors raised
before a full state update could be saved.

The result is a durable, per-conversation operational record: graph name and
status, active node, histories, node state, model metadata, token totals,
warnings, errors, timestamps, and expiry. Unlike a trace-only dependency, it
is the same document used to resume the conversation and can live in the
enterprise-selected store. It does not replace distributed tracing or a
visual execution debugger, but it eliminates the need for a vendor
observability service to understand and support a session.

### 10. Provider file uploads with cleanup ownership

`ProviderFileManager` uploads a local image or PDF to OpenAI, Google, or
Anthropic and returns the provider-native message part plus an async cleanup
function. The conversation runner performs the cleanup after the attachment
is no longer needed. This keeps provider file IDs and deletion responsibility
out of node business logic.

### 11. A framework-independent facade with application-owned NestJS wiring

`GraphEngine` is the application facade. It creates the default LangChain
model gateway, selects the session store from `.env` and `process.env`, and
registers the graph classes. The NestJS application only provides
`GraphEngine`; controllers and tests inject that same facade.

```ts
import { GraphEngine } from "ezgraph";

@Module({
  providers: [
    {
      provide: GraphEngine,
      useFactory: () => GraphEngine.create({ graphs: [DemoGraph] }),
    },
  ],
})
export class AppModule {}
```

## DemoGraph: a feature-by-feature tour

`DemoGraph` is an intentionally non-trivial reference design. It exercises
the features an application needs once a chatbot becomes a workflow, rather
than stopping at a single model response.

### The flow

```text
Weather ──► FooLogic ──► GooLogic ──► Favorites ──► Name
  │                                                   │
  └──────────────────────► Quit ◄────────────────────┘
                                                      │
                                                      ▼
                                                InContext
                                                      │
                                                      ▼
                                  Parallel ──► Child1 ─┐
                                      │                 ├──► Date of birth ──► Address
                                      └────► Child2 ────┘                         │
                                                                                   ▼
                                                                       Manual concurrent work ──► End
```

The diagram simplifies the per-turn `stay` and `quit` exits, but it shows
the important authoring patterns in one graph:

| DemoGraph feature | What it demonstrates | Why it matters in an application |
| --- | --- | --- |
| Guided collection | Weather, favorites, name, date of birth, and address are separate nodes | Each stage has one prompt and one business responsibility rather than one large prompt with fragile instructions. |
| Typed tools | Nodes expose tools such as `recordFavorites`, `recordName`, `recordDateOfBirth`, and `recordAddress` | The model returns structured input that Zod validates before application logic accepts it. |
| Domain validation | Nodes accept only valid values and ask again when needed | The graph does not treat an arbitrary model extraction as a committed business value. |
| Named histories | The graph uses `default`, `favorites`, `name`, `isolated`, `dob`, `address`, and `terminal` history spaces | A new stage starts with the context it needs, not accidental answers from every prior stage. |
| Multi-turn resume | The persisted node is the entry point for the next request | A browser or API client only needs to retain its session ID; it does not need to understand the workflow phase. |
| Internal enrichment | `InContextNode` records a structured movie idea without first sending a user-facing reply | Background graph work can enrich state between conversational steps. |
| Fan-out and join | `ParallelNode` fans out to two joke-writing children and both join at the date-of-birth step | The same typed state reducers support concurrent branches without manual shared-object mutation. |
| Explicit concurrency | `ManualConcurrentNode` runs four independent model calls with `Promise.all` | A node can still own deliberate concurrent work when graph-level fan-out is not the clearest choice. |
| Clean ending | `TerminateSessionNode` and the terminal state handle cancellation and completion | The API can distinguish an in-progress conversation from a completed one. |

### What a multi-turn request looks like

The demo application's service follows one small repeatable protocol:

1. Receive a graph name, a user message, and an optional session ID.
2. Create a session ID if this is the first turn; otherwise restore the
   matching graph state.
3. Reject a session that belongs to a different graph; the graph's restore
   hook then accepts, migrates, or resets an otherwise valid document.
4. Append the new `HumanMessage` to the history space for the active node.
5. Invoke the compiled LangGraph from the persisted `currentNode`.
6. Save the resulting state and return the response, completion flag, and
   session ID.

On a second or tenth user message, the client uses the same API shape. The
application, not the client, knows whether the next reply should collect a
favorite movie, a name, a birth date, or an address. That is the practical
reason EZGraph makes multi-turn chatbot development substantially simpler:
it centralizes continuity rather than asking every endpoint and node to
reinvent it.

## Quick start

### Requirements

- Node.js **22.5 or later**
- A Node.js TypeScript application (this demo uses NestJS and Fastify)
- Credentials for the LLM provider selected by your graph
- A session store configuration for durable conversations (`sqlite`, MongoDB,
  or Cosmos DB); use `memory` only for ephemeral local runs and tests

### Install

```bash
npm install ezgraph
```

### Next steps

Define your graph state with `createGraphStateAnnotation`, create focused
`GraphNode` classes for each meaningful workflow stage, and register the
resulting `BaseGraph` class through `GraphEngine.create(...)` or
`registerGraph(...)`. Application endpoints call the `GraphEngine` facade to
run, inspect, or delete sessions; they do not manage persistence directly.

## When EZGraph is the right abstraction

Use EZGraph when you are building a TypeScript application that has one
or more of these needs:

- a chatbot whose next action depends on prior turns;
- a guided intake, onboarding, support, or approval workflow;
- tools that must be schema-validated and handled by domain code;
- multiple agent phases that should not share the same conversation context;
- graph fan-out, joins, conditional paths, or explicit cancellation;
- durable sessions that can survive process restarts;
- provider flexibility without leaking provider SDK setup into each node; or
- consistent token, warning, error, and model metadata per session.

Use raw LangGraph directly when you need a very small one-off graph or full
control over every checkpointer and graph-builder detail. EZGraph intentionally
trades some of that low-level freedom for a consistent application
architecture.

## License

**Licensing intent — not a substitute for the final EULA:** The npm package
will be offered under a commercial/proprietary license or EULA that grants free
use in applications while prohibiting redistribution or resale of the library
(including modified versions) and use in competing hosted offerings without a
separate written commercial agreement.
