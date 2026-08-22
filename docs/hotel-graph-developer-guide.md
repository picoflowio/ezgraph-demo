# HotelGraph developer guide

HotelGraph is the most complete transactional conversation in this repository.
It collects search criteria over several turns, queries a local hotel catalog,
presents results, supports repeated comparisons, returns to earlier stages, and
finally records a booking decision. It is a useful reference when a workflow
must preserve business state while allowing the user to move backward and
forward through conversational stages.

Use the other tutorials for complementary patterns:

- [DemoGraph developer guide](./demo-graph-developer-guide.md) covers a broad
  selection of graph patterns, including logic nodes, isolated histories, and
  concurrent work.
- [InvoiceGraph developer guide](./invoice-graph-developer-guide.md) covers a
  document-oriented workflow and provider-file lifecycle.
- [SupportGraph developer guide](./support-graph-developer-guide.md) covers a
  hub-and-spoke agent with in-turn worker nodes, an explicit typed `branch()`,
  and a human-in-the-loop approval gate.

This guide follows the current implementation under
[`src/graphs/hotel-graph`](../src/graphs/hotel-graph/). It assumes basic
TypeScript knowledge, but no prior EZGraph experience.

## Start here: authoring a custom workflow

When creating a graph from scratch, make three decisions before writing a
prompt: which values survive a request, which stages may wait for another user
message, and which steps are internal work in the current invocation.
`HotelGraph` is a useful template because its topology and its node behavior
stay separate: the graph says where control can go; each node says what its
stage means.

### Build the graph shell first

Create state with the initial resumable stage, extend `BaseGraph`, return shared
policy from `getGraphDefinition()`, pass it to `super(...)`, then build a graph
in this order:

```ts
const graph = this.createStateGraph(HotelGraphState);
graph.nodes(ExploreNode, PresentNode, CompareNode, TerminateSessionNode);
graph.registerTurns(ExploreNode, PresentNode, CompareNode, TerminateSessionNode);
graph.autoRouteOutcomes();
return graph.compile();
```

`nodes(...)` registers classes and their tool contracts. `registerTurns(...)` is only
for stages that can receive the next HTTP request: it dispatches `START` using
persisted `currentNode`. Register internal worker nodes with `nodes(...)` and
connect them with edges, but do not list them as resume targets. This prevents
a later user message from entering a half-finished implementation detail.

The conversation graph has three topology contracts. `registerTurns(...)` identifies
stages that can receive a later user request. `autoRouteOutcomes()` handles
standard `stay()`, `advance()`, `quit()`, and `finish()` outcomes. `addEdge()`
connects unconditional internal work. Keep `branchBy()` for lower-level cases
where explicit conditional topology is required.

### Pick the lifecycle that matches the stage

| Base class | Best for | Implement | Why |
| --- | --- | --- | --- |
| `ConversationNode` | A stage that talks to a user over one or more turns. | `getPrompt`, `createContext`, optional `defineTool` and `@Tool` handlers, then `nextStep`. | EZGraph runs the model/tool loop, tracks `terminate_session`, records history and tokens, and gives the node one domain decision point. |
| `GraphNode` | An internal worker, deterministic transformation, direct model call, or a stage with a custom loop. | `getPrompt` and `run`; create any working context inside `run`, then return an update. | The developer, rather than the conversational wrapper, controls exactly how the step executes. |

An internal node is not a subclass nested inside another node. It is a normal
`GraphNode` placed after another node by graph topology. It can be model-backed
or entirely deterministic; “internal” describes its workflow role, not its
ability to call an LLM.

### The `ConversationNode` lifecycle

Most HotelGraph stages use the same lifecycle:

```text
persisted state
  -> createContext(state)     // fresh working data for this one turn
  -> model and tool loop
  -> typed tool effects enrich context
  -> nextStep(...)            // stay, advance, quit, or finish
  -> graph branch and durable state update
```

Implement the hooks with separate responsibilities:

```ts
class ExploreNode extends ConversationNode<State, ExploreState, ExploreContext> {
  getPrompt(state: State) { /* describe this stage and its constraints */ }

  protected createContext(state: State): ExploreContext {
    return { criteria: { ...(this.state(state).criteria ?? {}) } };
  }

  defineTool() { /* return Zod-validated model tool definitions */ }

  @Tool("record_criteria")
  recordCriteria(input: CriteriaInput, context: ExploreContext) {
    return this.toolResult({ accepted: true }).withContext({ /* patch */ });
  }

  protected nextStep(state: State, context: ExploreContext, conversation: ConversationNodeRunResult) {
    if (conversation.quitRequested) return this.quit(conversation);
    return context.criteria.destination
      ? this.advance(PresentNode, conversation).withState(context)
      : this.stay(conversation).withState(context);
  }
}
```

`createContext()` returns a new object for each invocation. Use it for tool
coordination and partial values; make values durable only in `nextStep()`
with `withState(...)` or `withStateFor(...)`. `nextStep()` is not a
LangGraph-routing callback—it is the business decision after the turn’s
evidence has been gathered. It answers “what should this workflow do next?”

Usually do not override `ConversationNode.run()`: doing so bypasses the shared
model/tool/history lifecycle. Use `GraphNode.run()` instead when the lifecycle
itself is intentionally custom. For example, a worker may call
`runConversation(state, context)` directly, make a direct gateway call, or
perform local computation, then return `save(...)`, `stay(...)`,
`advance(...)`, or `finish(...)`.

### Authoring checklist before adding a stage

1. Give the stage a small, owned durable-state type and decide which history
   space it reads.
2. Choose `ConversationNode` for a resumable user stage or `GraphNode` for
   internal/custom work.
3. Define the prompt, tools, validation, and the fresh context separately.
4. Make `nextStep()` cover incomplete input, success, and `terminate_session` (check
   quitting before accepting a domain success).
5. Register the node, add it to `registerTurns(...)` only if it accepts later user
   input, enable `autoRouteOutcomes()`, and add explicit internal edges.
6. Test the node’s observable decisions, not only its preferred model wording.

## What HotelGraph demonstrates

HotelGraph brings several EZGraph features together:

- a persisted, resumable workflow with four conversational stages;
- typed local state owned by individual nodes;
- deliberate cross-node state handoffs;
- a separate named history for each stage;
- Zod-validated model tools and deterministic backend validation;
- semantic `stay`, `advance`, `quit`, and `finish` outcomes;
- same-turn input forwarding when the user changes modes;
- three-part topology: `registerTurns(...)`, `autoRouteOutcomes()`, and `addEdge()`;
- deterministic orchestration tests and an optional live-model evaluation.

The implementation is split by responsibility:

| Area | Source | Responsibility |
| --- | --- | --- |
| Graph definition | [`hotel-graph.ts`](../src/graphs/hotel-graph/hotel-graph.ts) | Model policy, history spaces, node registration, resume points, and topology |
| State contract | [`hotel-graph.state.ts`](../src/graphs/hotel-graph/hotel-graph.state.ts) | Search types and per-node durable state |
| Conversation stages | [`nodes/`](../src/graphs/hotel-graph/nodes/) | Prompts, tools, validation, and semantic outcomes |
| Prompt assets | [`prompt/`](../src/graphs/hotel-graph/prompt/) | Role, stage instructions, and the criteria template |
| Domain backend | [`backend/`](../src/graphs/hotel-graph/backend/) | Catalog filtering and pricing rules |
| Presentation | [`gen-chart.ts`](../src/graphs/hotel-graph/gen-chart.ts) | Markdown comparison tables and currency formatting |
| Tests | [`test/hotel-graph/`](../test/hotel-graph/) | Scripted deterministic coverage and live semantic evaluation |

## The workflow at a glance

The graph starts at `ExploreNode`.

```text
                             explicit end request
                         ┌──────────────────────────► TerminateSessionNode ──► END
                         │
START/resume ──► ExploreNode ── search succeeds ──► PresentNode
                    ▲                                  │   │
                    │                                  │   └─ book ──► end
                    │                                  │
                    └──────── change search ───────────┤
                                                       │
                                                       └─ compare ──► CompareNode
                                                                        │   ▲
                                                   resume booking ──────┘   │
                                                   another comparison ─────┘

```

Each interactive node can also `stay`. Staying ends the current LangGraph
invocation and persists that node as the resume point for the next API call.
It does **not** complete the session.

This distinction is fundamental:

- LangGraph `END` means “stop executing nodes for this invocation.” It is the
  normal yield point between user turns.
- `GRAPH_END_NODE` (the string `"end"` by default) is EZGraph's persisted
  terminal state.
- `finish(...)` sets the terminal node and `completed: true`, then the graph
  maps that terminal value to LangGraph `END`.

Consequently, the automatic `stay()` route to `END` is expected and does not
represent a failed or prematurely completed conversation.

## 1. Define graph policy and topology

[`HotelGraph.getGraphDefinition()`](../src/graphs/hotel-graph/hotel-graph.ts)
declares settings shared by the graph:

```ts
return {
  llmConfig: ModelCatalog.model("openai:gpt-4o", { retries: 3 }),
  endNode: GRAPH_END_NODE,
  initialHistorySpace: "hotel-explore",
  historySpaces: [
    [ExploreNode, "hotel-explore"],
    [PresentNode, "hotel-present"],
    [CompareNode, "hotel-compare"],
    [TerminateSessionNode, "hotel-terminal"],
  ],
};
```

The graph-level model is OpenAI `gpt-4o`. A node may override this policy:
`ExploreNode` and `CompareNode` select `gpt-5.1` with low reasoning effort,
while `PresentNode` changes temperature to `0.5`. Overrides are resolved with
the graph defaults and recorded in node execution metadata.

Every conversational stage gets its own named history. A node reads and
appends only its assigned history, which prevents an old search answer from
being interpreted as a comparison answer. Stage transitions therefore need
an explicit handoff when the next node needs context; later sections explain
`withHistory(...)` and `forwardInput(...)`.

### Register before connecting

`buildGraph()` performs graph construction in a predictable order:

```ts
const graph = this.createStateGraph(HotelGraphState);
graph.nodes(ExploreNode, PresentNode, CompareNode, TerminateSessionNode);
graph.registerTurns(ExploreNode, PresentNode, CompareNode, TerminateSessionNode);
graph.autoRouteOutcomes();
graph.addEdge(TerminateSessionNode, END);
return graph.compile();
```

`nodes(...)` creates the node instances. `registerTurns(...)` adds the special
`START` branch that reads persisted `state.currentNode`, allowing a later API
request to re-enter the correct stage. `autoRouteOutcomes()` installs the
standard conversational outcome routes, while the plain
`TerminateSessionNode` keeps its explicit edge to `END`. The terminal node is
handled by the framework and must not be passed to `registerTurns(...)`.

### Route semantic outcomes automatically

Nodes choose an outcome such as `advance(PresentNode, conversation)`. The
outcome persists `"PresentNode"` in `state.currentNode`; the graph owns the
actual edge:

```ts
graph.autoRouteOutcomes();
```

This removes repetitive graph cases for direct outcomes. `advance(PresentNode)`
routes directly to `PresentNode`; `stay()` ends the current invocation;
`quit()` routes to `TerminateSessionNode`; and `finish()` marks the durable
terminal state. Internal steps still use `addEdge()`.

The durable target and immediate destination may differ when a node uses
`.via(WorkerNode)`. `branchBy()` remains available for explicit cases that need
graph-owned conditional routing.

HotelGraph's semantic outcomes produce these automatic transitions:

| Source | Persisted `currentNode` | Immediate destination |
| --- | --- | --- |
| `ExploreNode` | `PresentNode` | `PresentNode` |
| `PresentNode` | `ExploreNode` | `ExploreNode` |
| `PresentNode` | `CompareNode` | `CompareNode` |
| `PresentNode` | `GRAPH_END_NODE` | LangGraph `END` |
| `CompareNode` | `PresentNode` | `PresentNode` |
| Any conversational node | `TerminateSessionNode` | `TerminateSessionNode` |

`stay()` automatically routes to `END`, normally because the node remains
active and should wait for another user turn.

## 2. Model durable state by owner

[`hotel-graph.state.ts`](../src/graphs/hotel-graph/hotel-graph.state.ts)
defines the domain data and maps each node name to the state it owns:

| Owner | Durable values | Main consumers |
| --- | --- | --- |
| `ExploreNode` | Accumulated `HotelSearchCriteria` | Explore prompt, search backend, price comparison |
| `PresentNode` | Search results, booked hotel, confirmation number | Presentation, booking, comparison |
| `CompareNode` | Available names, selected names, last comparison rows | Repeated comparisons and return-to-booking flow |

This structure avoids one flat state object in which every node can
accidentally overwrite every field. At runtime, EZGraph also records a node's
resolved `modelName` and `modelParam` when it overrides the graph model. The
current `HotelGraphNodes` types describe only domain fields, so code that needs
that runtime metadata should declare it explicitly rather than assuming
`NodeStateValue<T>` adds fields.

### Local state versus conversation context

There are two lifetimes to understand:

- `state.nodes.<NodeName>` is durable. It is reduced into graph state and can
  be persisted with the session.
- The context returned by `createContext(...)` exists only for
  the current invocation of that node. Tools use it to accumulate decisions
  during an agent/tool loop.

For example, `PresentContext.action` is transient. A tool sets it to `book`,
`search`, or `compare`; `nextStep(...)` converts that action into
one graph outcome. It should not be persisted because it is only a turn-level
control signal. By contrast, selected hotels and the final booking belong in
durable node state.

Context changes are lost unless the outcome persists the relevant fields.
That is why `ExploreNode` uses `.withState({ criteria: context.criteria })`
for all paths, including no-results and quit paths.

### Read and update the current node's state

Inside a typed node, `this.state(state)` returns that node's local state:

```ts
const local = this.state(state);
const selectedHotels = local.selectedHotels ?? [];
```

Persist an immutable patch through the outcome:

```ts
return this.stay(conversation).withState({
  availableHotels: context.availableHotels,
  selectedHotels: context.selectedHotels,
  lastComparison: context.comparison,
});
```

`withState(...)` is typed to the node's declared `LocalState`; it cannot
silently write a field owned by another node.

### Hand state to another node with `withStateFor`

When search results are ready, Explore owns the criteria but Present owns the
result list:

```ts
return this.advance(PresentNode, conversation)
  .withState({ criteria: context.criteria })
  .withStateFor(PresentNode, { hotelFound: context.results });
```

`withStateFor(PresentNode, ...)` infers `PresentNode`'s local-state type from
the class, so misspelled or inappropriate fields fail type checking. Present
uses the same pattern to initialize Compare:

```ts
.withStateFor(CompareNode, {
  availableHotels: context.available.map(({ hotelName }) => hotelName),
  selectedHotels: context.action.hotelNames,
})
```

Direct cross-node reads remain possible when a computation needs established
state from multiple owners. `CompareNode.generateComparison(...)` reads
`state.nodes.PresentNode?.hotelFound` for calculated prices and
`state.nodes.ExploreNode?.criteria` for date headings. Treat such reads as
explicit dependencies and cover them in tests.

## 3. Use semantic outcomes instead of raw state envelopes

Every `ConversationNode` runs the shared model/tool loop, then asks
`nextStep(...)` for one turn-level decision. Four outcome helpers
encode the framework invariants:

| Outcome | Meaning | Framework behavior |
| --- | --- | --- |
| `stay(conversation, response?)` | Wait in this stage | Keeps the current node active, requires a response, consumes input, records history and tokens |
| `advance(Target, conversation)` | Move to another stage | Sets the target resume node, clears the response, consumes input, records history and tokens |
| `quit(conversation)` | Honor explicit conversation termination | Advances to the shared `TerminateSessionNode`; input forwarding is unavailable |
| `finish(response, conversation)` | Complete the business workflow | Sets the terminal node, `completed`, final response, history, and tokens |

All four return immutable builders with:

```ts
.withState({ ... })
.withStateFor(TargetNode, { ... })
.withHistory("history-space", messageOrMessages)
```

Only `advance(...)` exposes `.forwardInput(...)`. The helper methods are
non-enumerable; the final value presented to LangGraph is an ordinary state
update.

### `stay`: continue a multi-turn stage

If the model asks the next question, preserve its response:

```ts
return this.stay(conversation).withState({ criteria: context.criteria });
```

`stay` requires a non-empty assistant response. For a deterministic backend
response, pass an explicit value. Compare uses this to return its generated
Markdown table rather than asking the model for another turn:

```ts
return this.stay(conversation, context.response).withState({
  lastComparison: context.comparison,
});
```

When the explicit response differs from `conversation.response`, EZGraph adds
it as an assistant message so the displayed response and stored history stay
consistent.

### `advance`: change the active stage

Advancing normally consumes the input. Seed the next node's separate history
with a synthetic instruction when the next stage should begin fresh:

```ts
return this.advance(PresentNode, conversation)
  .withStateFor(PresentNode, { hotelFound: context.results })
  .withHistory(
    "hotel-present",
    new HumanMessage("Present the current hotel choices and booking options."),
  );
```

This pattern is used after search and resume-booking transitions.
The synthetic `HumanMessage` tells the newly entered stage what to do without
copying unrelated dialogue into its isolated history.

### `forwardInput`: let the target reinterpret the same user request

Some messages both select a transition and contain work for the target:

- “change to two beds and search” moves from Present back to Explore, and
  Explore must read the requested criteria change;
- “compare hotels 2 and 5 on price” moves from Present to Compare, and Compare
  must read the selected feature.

Present handles these paths with:

```ts
return this.advance(CompareNode, conversation)
  .withStateFor(CompareNode, { ... })
  .forwardInput(state, "Choose hotels and one feature to compare.");
```

`forwardInput` marks the input unconsumed. If the source and target have
different histories, it copies the latest `HumanMessage` to the target
history. The fallback is used only when no source human message is available.
It can be called once and only on an `advance` outcome.

Use `withHistory` when the target should receive a new stage instruction. Use
`forwardInput` when the target should reinterpret the user's actual utterance.
Forwarding every transition can cause a target prompt to act twice on a
message that the source already fully handled.

### `quit` and `finish` are different outcomes

All HotelGraph conversation nodes inherit the `terminate_session` tool from
`ConversationNode`. When called, `conversation.quitRequested` becomes true.
Each outcome method checks it before domain success:

```ts
if (conversation.quitRequested) return this.quit(conversation);
```

This ordering makes an explicit end request win even if the model called more
than one tool in the same batch.

`quit` routes through the shared `TerminateSessionNode`, which owns the terminal farewell
flow. `finish` represents successful business completion. Present uses
`finish` only after validating a hotel and creating a confirmation number.

## 4. Follow one request through each stage

### ExploreNode: collect, normalize, and search

[`explore.node.ts`](../src/graphs/hotel-graph/nodes/explore.node.ts) owns the
longest guided stage.

1. `criteria(state)` clones `explore.json`, merges saved criteria, and supplies
   a current date.
2. `getPrompt(...)` injects the complete criteria JSON into the stage prompt.
3. The model asks for dates, nightly budget, room type, amenities, and distance
   preferences over multiple turns.
4. When the user requests a search, the model calls `capture_choices` with the
   complete JSON serialized as a string.
5. The handler parses and normalizes untrusted model output before calling the
   deterministic pricing backend.

Normalization requires an object payload, parseable nonempty check-in and
check-out strings with checkout after check-in, allowlisted room types and
amenities, and finite numeric filters. Unknown room types and amenities are
filtered out. This is deliberately limited demo validation: it does not require
check-in after `currentDate`, validate strict ISO calendar strings, reject
negative ranges or `min > max`, or verify that a model-supplied `cDateArray`
matches the requested range. Strengthen those invariants before treating the
criteria as a production contract.

No results is not a graph error. The tool returns `{ accepted: true, found: 0
}` and leaves the node active so the model can ask the user to adjust criteria.
When results exist, the tool stores them in transient context and halts after
the current tool-call batch. The outcome then advances to Present, persists
criteria locally, gives results to Present with `withStateFor`, and seeds the
new history.

### PresentNode: select the next business action

[`present.node.ts`](../src/graphs/hotel-graph/nodes/present.node.ts) injects
the current result list into its prompt and exposes three tools:

| Tool | Validated action |
| --- | --- |
| `chosen_hotel` | Book one exact hotel from the current result set |
| `search_again` | Return to search criteria |
| `go_compare` | Compare a de-duplicated set of current hotel names |

The tools do not return graph routes. They validate input and set one
discriminated `PresentAction` in transient context. The outcome method is the
single place that translates the action into graph behavior:

- `book` generates a six-digit confirmation, persists the chosen hotel and
  confirmation, and calls `finish`;
- `search` advances to Explore and forwards the same user input;
- `compare` initializes Compare state, advances, and forwards the input;
- no action stays in Present with the model response.

The prompt tells the model to resolve a displayed number to its corresponding
hotel name before calling a tool. The handler still treats the backend result
set as authoritative and rejects names outside it.

### CompareNode: deterministic comparison with conversational reuse

[`compare.node.ts`](../src/graphs/hotel-graph/nodes/compare.node.ts) supports
`price`, `roomType`, `amenities`, and `distance` comparisons. It remembers the
available and selected hotels in local state so a follow-up such as “compare
on amenities” can reuse the previous selection.

`generate_comparison` validates every requested name against
`availableHotels`, loads full catalog documents, and produces rows:

- amenities become boolean feature columns;
- room types become boolean room-type columns;
- distance values are formatted in miles;
- price rows combine Present's calculated nightly prices with Explore's date
  array and total.

`GenChart` formats the rows as a Markdown table. The handler saves the table
as a deterministic response and halts the tool batch. The outcome stays in
Compare, persists the new selection and rows, and returns that table directly.

`resume_booking` sets a transient resume flag. Its outcome advances to Present
and adds a fresh `hotel-present` instruction asking it to display the current
choices. It does not forward “resume booking” because Present should present
the list, not reinterpret that phrase as a booking choice.

## 5. Understand the shared conversation and tool loop

Every stage extends `ConversationNode`, so it does not implement a custom
`run()` method. The base class:

1. creates the typed context;
2. loads the node's named history;
3. invokes the model with that node's prompt and decorated tools;
4. validates tool arguments with Zod;
5. executes every tool call in the assistant's current batch;
6. appends the AI and tool messages in order;
7. accumulates token usage;
8. exposes `quitRequested`; and
9. asks the node for one semantic outcome.

`stopAfterBatch: true` does not complete the graph. It tells the runner not to
make another model call after all tool calls from the current assistant
message have executed and been recorded. The node still selects `stay`,
`advance`, `quit`, or `finish`.

For new tools, prefer typed context effects when several calls may compose:

```ts
return this.toolResult({ accepted: true })
  .withContext({ action: { type: "search" } })
  .haltAfterBatch();
```

`withContext(...)` applies effects in order after each handler returns.
`stopAfterBatchWhen(...)` can inspect the updated context. This avoids tools
mutating shared graph state directly and keeps model-visible output separate
from application effects.

Tools should validate domain facts but should not choose edges themselves.
One assistant message can contain multiple tool calls; a single turn-level
`nextStep(...)` gives the node one authoritative routing decision.

## 6. Prompts, catalog, pricing, and output

### Prompt loading and composition

[`hotel-prompt.ts`](../src/graphs/hotel-graph/prompt/hotel-prompt.ts) loads
Markdown and JSON assets relative to the module using `import.meta.url`. This
works independently of the process working directory as long as the build
copies or preserves the assets where the compiled module expects them.

Every stage combines:

1. [`role.md`](../src/graphs/hotel-graph/prompt/role.md), which limits the
   assistant to Portland-area Hilton booking;
2. its stage-specific Markdown instructions;
3. dynamic values inserted by `fillPrompt(...)`; and
4. `endChatInstruction`, which standardizes explicit termination behavior.

Dynamic prompt values are guidance, not trust boundaries. Tools and backend
code perform a second validation layer, but the current criteria normalizer is
not exhaustive; the gaps called out in the Explore section remain.

[`explore.json`](../src/graphs/hotel-graph/prompt/explore.json) serves two
purposes: it is the initial criteria shape and the allowlist for room types and
amenities. Clone it before merging state; otherwise one session could mutate a
module-level object shared by other sessions.

### Local catalog behavior

[`hotels.json`](../src/graphs/hotel-graph/data/hotels.json) contains 32 demo
properties. `HotelCatalog.search(...)` applies deterministic filters:

- every selected amenity must be `true`;
- at least one selected room type must match, unless none was selected;
- airport and city-center limits are optional;
- distance comparison is strict (`actual < requested`), not inclusive.

`HotelCatalog.fetch(...)` preserves the requested-name order and drops names
that do not exist. Compare checks the returned count so missing data becomes a
tool error rather than a misleading partial table.

### Pricing behavior

`PricingEngine` derives nightly prices from catalog `level` using seasonal,
holiday, room-type, and weekend multipliers. It then filters by nightly budget
and returns daily prices plus a total.

Be aware of the current demo semantics:

- date enumeration includes both start and end dates;
- budget min/max apply to the minimum and maximum nightly prices, not total;
- when multiple room types are selected, pricing uses the first one;
- public-holiday dates are derived from 2025, but matching ignores the year,
  so those month/day values—including 2025's movable holidays—are applied to
  every year;
- the engine calculates examples—it is not inventory or a live rate service.

These rules are acceptable for a self-contained demo but should be explicit
business decisions before production use.

### Comparison output

`GenChart.getChart(...)` transposes comparison rows into a Markdown table with
one column per hotel. `comparisonRows(...)` creates a union of feature keys and
renders missing or false boolean features as `❌`, true as `✅`.
`formatCurrency(...)` uses `Intl.NumberFormat` with U.S. dollars by default.

Because tables are generated in application code, their factual contents do
not depend on the model faithfully reproducing a backend result.

## 7. Run HotelGraph through the demo API

`HotelGraph` is registered with `DemoGraph` and `InvoiceGraph` in
[`AppModule`](../src/app.module.ts):

```ts
GraphEngine.create({ graphs: [DemoGraph, HotelGraph, InvoiceGraph] });
```

Expose the OpenAI credential required by the selected models to the server
process, then start the NestJS application. A `.env` file configures EZGraph's
session manager, but the provider SDK reads `OPENAI_API_KEY` from the process
environment:

```bash
export OPENAI_API_KEY='<key>'
npm run start
```

The default port is `8000`. Start a conversation with:

```bash
curl -i http://localhost:8000/ai/run \
  -H 'content-type: application/json' \
  --data '{"graphName":"HotelGraph","message":"Hi"}'
```

The response body and `SESSION_ID` response header contain the new session
identifier. Send that header with every later turn:

```bash
curl -i http://localhost:8000/ai/run \
  -H 'content-type: application/json' \
  -H 'SESSION_ID: <session-id>' \
  --data '{"graphName":"HotelGraph","message":"August 1 to August 8"}'
```

The client does not choose a node. `GraphEngine` restores the session and
`graph.registerTurns(...)` routes the request from persisted `currentNode`.

Set `HOTEL_GRAPH_CURRENT_DATE` to make relative-date behavior repeatable in
development or tests. Otherwise Explore uses the current ISO timestamp.

## 8. Test deterministic orchestration before live model behavior

HotelGraph has two complementary test layers.

### Deterministic graph test

[`hotel-graph.spec.ts`](../test/hotel-graph/hotel-graph.spec.ts) uses a
`HotelScriptedGateway`. Instead of calling a provider, it examines the tools
available in the active node and returns predetermined AI tool calls. The test
covers this complete path:

```text
Explore search → Present → Compare price → Present → book → completed
```

It asserts current nodes, search-result values, selected hotel persistence,
the generated comparison, final local state, and a six-digit confirmation.
Run it directly with:

```bash
node --import tsx --test test/hotel-graph/hotel-graph.spec.ts
```

This is the primary regression test for topology, reducers, handoffs, and
backend behavior. It is fast, repeatable, and does not need network access.

### Live conversational evaluation

[`hotel-graph.e2e.spec.ts`](../test/hotel-graph/hotel-graph.e2e.spec.ts) drives
the real `/ai/run` API over a 14-turn scenario from
[`hotel-graph.scenario.json`](../test/hotel-graph/hotel-graph.scenario.json).
It exercises gradual criteria collection, a changed room request, search,
several comparisons, reuse of selected hotels, resume booking, and completion.

Each response is evaluated semantically by an OpenAI judge rather than by
exact string equality. After the transcript, the test reads the session and
asserts persisted criteria, results, selections, booking, terminal node, and
completed status. By default it uses an in-memory `GraphEngine` and deletes
the session after the test.

Run both HotelGraph specs with live evaluation disabled:

```bash
RUN_LIVE_HOTEL_GRAPH_TEST=0 npm run test:hotel-graph
```

Run the live evaluation with an API key:

```bash
OPENAI_API_KEY=<key> RUN_LIVE_HOTEL_GRAPH_TEST=1 npm run test:hotel-graph
```

To force MongoDB for only the live fourteen-turn scenario and retain the
session document for inspection, run:

```bash
yarn test2:hotel-graph
```

This command uses `MONGODB_URL`, `MONGODB_NAME`, and `MONGODB_COLLECTION`; it
does not use the configured `SESSION_STORE` value.

Useful live-test settings include:

| Variable | Purpose |
| --- | --- |
| `HOTEL_GRAPH_CURRENT_DATE` | Fix the date injected into the search prompt |
| `HOTEL_GRAPH_JUDGE_MODEL` | Override the semantic judge model |
| `HOTEL_GRAPH_TEST_TIMEOUT_MS` | Change the full scenario timeout |
| `HOTEL_GRAPH_TEST_LOG=0` | Suppress per-turn progress logging |
| `HOTEL_GRAPH_TEST_USE_ENV=1` | Use the application's environment-selected session store instead of the test's in-memory engine |

Do not use a passing live test as a substitute for the deterministic test.
Provider behavior can vary; deterministic coverage should prove state and
routing invariants, while live evaluation proves that prompts elicit the
desired behavior from the configured model.

## 9. Extend HotelGraph safely

Suppose a new `GuestPreferencesNode` should run after search and before hotel
presentation. Use this sequence.

### Step 1: give the new node an owned state shape

Add it to `HotelGraphNodes`:

```ts
GuestPreferencesNode?: NodeStateValue<{
  lateArrival?: boolean;
}>;
```

Avoid placing the field in another node merely because that node currently
precedes it. State ownership should follow the business stage that validates
and maintains the value.

### Step 2: implement one focused ConversationNode

Define:

- the stage prompt;
- Zod tool definitions;
- decorated handlers that validate domain input;
- a transient context;
- `nextStep(...)` with quit checked first.

A typical accepted tool can return:

```ts
return this.toolResult({ accepted: true })
  .withContext({ lateArrival: input.lateArrival })
  .haltAfterBatch();
```

Then persist and advance exactly once:

```ts
return this.advance(PresentNode, conversation)
  .withState({ lateArrival: context.lateArrival })
  .withHistory(
    "hotel-present",
    new HumanMessage("Present the current hotel choices and booking options."),
  );
```

### Step 3: hand off existing results

Change Explore's success path to target the new stage while still writing the
results to their long-term owner:

```ts
return this.advance(GuestPreferencesNode, conversation)
  .withState({ criteria: context.criteria })
  .withStateFor(PresentNode, { hotelFound: context.results })
  .withHistory("hotel-preferences", new HumanMessage("Collect guest preferences."));
```

### Step 4: register all runtime relationships

Update `HotelGraph` in four places:

1. add a named history mapping;
2. add the node to `graph.nodes(...)`;
3. add it to `graph.registerTurns(...)`;
4. add the new node to the automatic outcome routing contract.

```ts
graph.autoRouteOutcomes();
```

Registration errors should fail during graph construction rather than during
a customer session.

### Step 5: extend both test layers deliberately

First teach the scripted gateway how to respond when the new tool is present,
then assert the new node state and transitions. After deterministic coverage
passes, add natural-language turns to the live scenario and update its session
assertions. Keep semantic expectations about behavior, not exact prose.

If the new requirement is non-conversational computation, fan-out, or a join,
use the [DemoGraph developer guide](./demo-graph-developer-guide.md) to choose
between `GraphNode`, graph edges, and explicit concurrency. If it introduces a
file upload or extraction stage, use the
[InvoiceGraph developer guide](./invoice-graph-developer-guide.md) for file
ownership and cleanup patterns.

## Common pitfalls

### Treating graph `END` as completed

Most turns intentionally reach LangGraph `END` with `completed: false`. Check
the persisted terminal node or completed flag, not whether one invocation
stopped executing.

### Assuming isolated histories share dialogue

They do not. Use `withHistory` for a synthetic stage-entry message or
`forwardInput` for the actual user utterance. Pick the semantic behavior
intentionally for every transition.

### Forgetting that context is transient

Setting `context.action` or `context.criteria` does not persist it. Every path
that must retain a value needs `withState` or `withStateFor` on its outcome.

### Returning raw routes from tools

Tools can be called more than once in a batch. Let them validate and record
typed effects; choose one route in `nextStep`.

### Trusting prompt-injected JSON

Prompt data helps the model but is not authoritative. Continue to parse,
normalize, allowlist, and validate tool input in application code.

### Forgetting same-turn input forwarding

Without `forwardInput`, “compare hotels 2 and 5 on price” may enter Compare
without the comparison request in its isolated history. Conversely, forwarding
“resume booking” would make Present reinterpret a message that Compare already
handled. Test both kinds of transition.

### Treating the demo booking as a real reservation

`generateConfirmationNumber()` creates an in-memory random six-digit number.
There is no inventory hold, idempotency key, payment, or reservation backend.
A production booking tool should perform an idempotent external transaction
and persist its authoritative reservation ID before calling `finish`.

### Letting time make tests nondeterministic

Explore falls back to `new Date().toISOString()`. Pin
`HOTEL_GRAPH_CURRENT_DATE` whenever prompts or assertions depend on relative
dates.

### Overlooking pricing assumptions

Checkout is currently included in priced dates, holidays cover 2025 only,
distance thresholds are strict, and multiple room types use the first type for
pricing. Change these rules and their deterministic assertions together.

## Developer checklist

Before merging a HotelGraph change, confirm that:

- the node that validates a value owns its durable state;
- tools have Zod schemas and backend validation;
- transient context effects are converted into one semantic outcome;
- explicit quit is checked before domain success;
- `stay` always has a non-empty response;
- cross-node writes use `withStateFor`;
- every stage transition deliberately chooses `withHistory` or
  `forwardInput`;
- every new node is in history mappings, `nodes`, `resume`, and topology;
- every conversational outcome is covered by automatic routing or an explicit
  lower-level `branchBy()` override;
- deterministic tests prove state and routing before live tests assess prompt
  quality;
- date, price, catalog, and external side-effect assumptions are documented.

HotelGraph's central design rule is simple: tools validate facts, local state
preserves business data, semantic outcomes express one turn-level decision,
and the graph file owns topology. Keeping those boundaries intact makes a
long, revisitable booking conversation understandable and testable.
