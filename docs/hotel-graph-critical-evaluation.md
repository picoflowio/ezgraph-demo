# Critical evaluation: HotelGraph versus HotelLanggraph

## Executive conclusion

Both implementations can deliver the tested 14-turn Hilton reservation
conversation. Each carries matching, self-contained copies of the prompts,
hotel catalog, pricing engine, chart renderer, and semantic scenario. The
experiment therefore does show that EZGraph is not technically required: direct
LangGraph can produce the same user-visible workflow.

The experiment also shows a real developer-productivity benefit from EZGraph.
For this chatbot, the self-contained EZGraph implementation contains 1,081
lines of executable TypeScript. The direct implementation contains 1,717 lines.
Controller code is excluded from both sides: `AiController` is shared by several
EZGraph graphs, while `AiLanggraphController` is dedicated to the direct graph.
The matching 236-line catalog and pricing backend is also excluded from the
normalized comparison, leaving 845 EZGraph lines versus 1,481 direct lines.
EZGraph removes 636 lines, or 42.9% of the direct graph implementation.

That reduction is not cosmetic. EZGraph supplies the repetitive agent loop,
tool dispatch, history management, phase resumption, token accounting, error
capture, model metadata, session serialization, and storage selection. The
direct implementation has to reproduce those concerns manually.

From the application developer's perspective, EZGraph's internal implementation
is library code, just as LangGraph's implementation is library code. It should
not be added to the chatbot's implementation cost. Its development and
maintenance are amortized across the library's user base; a consumer incurs
only the cost of learning, configuring, upgrading, and using its public API.
Under the assumption that EZGraph is a supported library shared by thousands of
users, its internal line count is not a reason to reject it.

If EZGraph is also free for developers, the consumer pays neither the library's
development cost nor a license or subscription fee. That strengthens the value
case: the application receives the shared runtime and its code reduction at no
framework acquisition cost. “Free” does not make the complete chatbot free—the
developer still pays the normal learning, integration, testing, model-token,
database, hosting, and operational costs—but those costs exist with direct
LangGraph as well.

For this repository, which already has hotel, demo, and invoice graphs, the
recommendation is to keep EZGraph as the primary application framework and keep
HotelLanggraph as a conformance example and regression baseline—not as a second
production implementation. This recommendation is conditional on treating
EZGraph as a supported dependency with a stable public contract. Framework
release engineering remains the library project's responsibility rather than a
cost charged to each chatbot developer.

## What was compared

The review examined the current working-tree implementations:

- [HotelGraph](../src/graphs/hotel-graph/hotel-graph.ts), its
  [state](../src/graphs/hotel-graph/hotel-graph.state.ts), and its three
  phase-oriented nodes:
  [ExploreNode](../src/graphs/hotel-graph/nodes/explore.node.ts),
  [PresentNode](../src/graphs/hotel-graph/nodes/present.node.ts), and
  [CompareNode](../src/graphs/hotel-graph/nodes/compare.node.ts).
- [HotelLanggraph](../src/graphs/hotel-langgraph/hotel-langgraph.ts), its
  [state](../src/graphs/hotel-langgraph/hotel-langgraph.state.ts), and its
  [session stores](../src/graphs/hotel-langgraph/hotel-session-store.ts).
- The dedicated direct-graph boundary in
  [AiLanggraphController](../src/controllers/ai-langgraph-controller.ts),
  exposed at `/ai-langgraph/*` rather than the EZGraph `/ai/*` namespace.
- The EZGraph implementation linked into `node_modules/ezgraph`, including
  `BaseGraph`, `ConversationNode`, `ConversationRunner`, `GraphEngine`,
  `StateGraphExt`, and `SessionManager`.
- The independent
  [HotelGraph scenario](../test/hotel-graph/hotel-graph.scenario.json) and
  [HotelLanggraph scenario](../test/hotel-langgraph/hotel-langgraph.scenario.json).

The line counts use `wc -l`, so they include comments, imports, and blank lines.
Tests are not included. No graph source, prompt, catalog, pricing, chart, or
scenario file is shared between the implementations. The matching catalog and
pricing backend is excluded from the normalized percentage; executable
TypeScript and copied prompt/catalog assets are reported separately so the
comparison does not mistake duplicated domain/static content for orchestration
code.

## Functional chatbot comparison

Both chatbots implement the same high-level state machine:

```text
explore criteria -> present results -> compare hotels
       ^                  ^                 |
       |                  +-----------------+
       +-- change search       resume booking

present results -> book -> terminal
any phase -> terminate -> terminal
```

Both implementations:

- collect dates, budget, room type, amenities, and distance preferences;
- validate the submitted criteria before searching;
- search the same JSON catalog with the same pricing engine;
- present and re-present current results;
- compare price, room types, amenities, or distance;
- retain selected hotels across comparison turns;
- return to booking and generate a six-digit confirmation number;
- keep separate conversation histories for explore, present, and compare;
- hydrate one session document at the beginning of each HTTP turn rather than
  using a LangGraph checkpointer.

The matching prompt and business-backend copies account for much of the
behavioral parity. EZGraph does not make the language model intrinsically more
capable, and direct LangGraph does not make the responses intrinsically better.
The framework choice mainly affects how safely and economically the surrounding
conversation mechanics are implemented.

The two implementations are not guaranteed to be identical outside the tested
path. EZGraph's `ConversationRunner` supports a bounded multi-step agent/tool
loop, processes a batch of tool calls, retries limited empty responses, tracks
token usage, and normalizes provider behavior. HotelLanggraph binds tools
directly to `ChatOpenAI`, selects the termination call or first tool call from
an assistant message, then manually routes through a corresponding tool node.
Unusual multi-tool responses, empty provider responses, and provider-specific
payloads can therefore behave differently.

## Code-size evidence

| Concern | HotelGraph with EZGraph | HotelLanggraph direct | Difference |
| --- | ---: | ---: | ---: |
| Executable TypeScript before normalization | 1,081 | 1,717 | +636 direct |
| Matching catalog and pricing backend, excluded | -236 | -236 | equal |
| Normalized graph code, controllers excluded | **845** | **1,481** | **+636 direct** |
| Prompt and catalog asset lines | 1,127 | 1,127 | equal |
| Complete graph footprint, controllers excluded | **2,208** | **2,844** | **+636 direct** |
| Graph file count, controllers excluded | 15 | 14 | -1 direct |

The identical-size asset copies make the measurement fairer: they are now part
of both implementations, but they do not explain the 636-line total gap.

The single normalized comparison to carry forward is that **HotelGraph uses
42.9% less executable graph code** than the direct implementation. The asset
and full-footprint rows are retained as inventory context, not competing
percentage claims.

These figures demonstrate the relevant consumer-side reduction. EZGraph's
internal implementation is deliberately excluded, for the same reason that
LangGraph's and LangChain's internal lines are excluded. A library consumer does
not rewrite or maintain that implementation per chatbot. With maintenance
shared across thousands of users, the executable application-level comparison
is 845 normalized lines versus 1,481, not a comparison that adds the library's internal
source lines to either side.

## Modularity

### HotelGraph

HotelGraph is more modular in the current source tree.

The 68-line graph class owns topology and graph-wide model defaults. Each
conversation phase is a separate class that owns its prompt, allowed tools,
tool effects, working context, and semantic outcome. Search normalization is in
ExploreNode, booking selection is in PresentNode, and comparisons are in
CompareNode. Domain services remain outside the graph nodes.

This organization has practical advantages:

- a developer can change comparison behavior without navigating booking and
  persistence code;
- node-local state is grouped under the node that owns it;
- transitions read as domain outcomes—`stay`, `advance`, `finish`, or `quit`;
- graph topology follows three clear contracts: `registerTurns(...)` for later user
  turns, `autoRouteOutcomes()` for semantic outcomes, and `addEdge()` for
  unconditional internal work;
- persistence and controller concerns cannot leak into a node accidentally;
- model overrides are declared by the phase that requires them.

The modularity is not free of coupling. Class names are runtime identifiers for
nodes and the graph itself. Renaming `CompareNode` or `HotelGraph` changes
persisted names. Decorators connect `@Tool("name")` methods to definitions by
string, which is less obvious than a direct function reference. Understanding a
node fully requires knowing the inherited `ConversationNode` contract.

### HotelLanggraph

HotelLanggraph has two good external seams:

- `HotelModelFactory` makes model calls replaceable in tests.
- `HotelSessionStore` cleanly separates memory, SQLite, and MongoDB storage.

Inside those seams, the implementation is much less modular. One 1,063-line
class/file contains model construction, all tool schemas, tool declarations,
graph topology, three agent nodes, three tool nodes, all transition logic,
criteria normalization, comparisons, session lifecycle, response envelopes,
and validation helpers. The store is separate, but the conversational domain
is effectively a monolith.

That is a property of this implementation, not an inherent limitation of pure
LangGraph. It could be split into phase modules and reusable agent-loop and
persistence utilities. Doing that well, however, begins to recreate the exact
abstraction layer EZGraph already supplies. The fair conclusion is therefore:
pure LangGraph permits good modularity, but EZGraph makes the desired modular
shape the default and reduces the design work required from each chatbot team.

**Modularity winner: HotelGraph/EZGraph for this implementation.**

## Team consistency and time to market

This result is not because direct LangGraph prevents modular code. It provides
low-level primitives, so a capable team can build its own shared architecture.
The tradeoff is that the primitives do not prescribe one common chatbot idiom.
Different authors can make individually reasonable but incompatible choices for
state channels, reducers, agent/tool loops, route names, resume semantics, and
session schemas. The team must create, document, enforce, and teach those
conventions itself.

EZGraph supplies that common conceptual picture in the public authoring model:

```text
GraphDefinition -> conversation node -> prompt and tools
                -> typed outcome -> history space -> session document
```

HotelGraph maps directly onto it with Explore, Present, and Compare phase
nodes. This makes the codebase more comprehensible to someone joining the team:
they look for the business phase, its tools, and its semantic outcomes instead
of first reconstructing a local state-machine style. It gives reviews and
cross-team knowledge sharing a stable vocabulary as well.

The 42.9% figure is a code-size measurement, not a measured calendar-time
benchmark. It nevertheless indicates a credible time-to-market benefit: fewer
lines of application-owned conversation infrastructure need to be designed,
implemented, reviewed, tested, debugged, and explained before the chatbot is
ready to demonstrate. A future experiment could validate that inference by
recording implementation time and review effort across several teams.

## Contract clarity

The answer depends on which boundary is being examined.

| Boundary | HotelGraph/EZGraph | HotelLanggraph direct |
| --- | --- | --- |
| Controller contract | `GraphEngine.run()` and registry at `/ai/*` | Dedicated `AiLanggraphController` at `/ai-langgraph/*` calls the direct graph directly |
| Graph identity | Derived and validated from the graph class name | Explicit `name`, validated by the dedicated controller |
| Graph-wide config | One `GraphDefinition` for provider, model, retries, end node, and histories | Distributed between model construction, state defaults, graph builder, and environment helpers |
| Node contract | Typed `ConversationNode` hooks and semantic outcome builders | Plain LangGraph async node functions with explicit state updates |
| Tool contract | Definition plus decorated handler; framework validates registrations | LangChain tool declaration plus a separate manual string-dispatch branch and repeated Zod parsing |
| Resume contract | `currentNode`, history spaces, and `graph.registerTurns(...)` | `phase`, `route`, `inputConsumed`, three message arrays, and repeated route functions |
| Persistence contract | One versioned cross-graph `SessionDocument` | A clear but graph-specific `HotelSessionDocument` |
| Provider contract | Provider-neutral `LlmGateway` and normalized model metadata | Direct `ChatOpenAI`; injectable factory helps testing but production is OpenAI-specific |

EZGraph has the stronger application-platform contract. Its graph, node,
conversation, and session abstractions establish conventions that multiple
graphs can share. It also validates duplicate or missing tool registration and
graph/node names at construction.

HotelLanggraph is more locally explicit. A developer familiar with LangGraph
can follow the raw `StateGraph` without first learning EZGraph. Its
`HotelSessionStore` interface is particularly easy to understand. But its
internal contract is spread across string names and duplicated control fields.
For example, `phase` identifies the durable conversation stage while `route`
selects an edge inside the current invocation; `inputConsumed` determines
whether the same user message is forwarded into a new stage. Those invariants
are real but are not represented by one enforceable abstraction.

**Contract winner: EZGraph across an application portfolio; direct LangGraph
for local transparency at a single call site.**

## Where the boilerplate went

HotelLanggraph has to implement all of the following explicitly:

- seven Zod tool schemas and seven LangChain tool objects;
- stage-to-tool arrays and per-stage bound models;
- three agent functions and three tool-execution functions;
- three post-agent routing functions plus common post-tool routing;
- repeated parsing, invalid-tool responses, and tool-result construction;
- user-input consumption and cross-stage history forwarding;
- success and error HTTP-style result envelopes;
- UUID and session-ID validation;
- session load, expiration, hydration, serialization, save, and deletion;
- memory, SQLite, and MongoDB adapters;
- message serialization and restoration;
- controller dispatch between two independently managed graph engines.

HotelGraph still contains necessary domain code: prompts, schemas, validation,
searching, comparison construction, booking, and semantic transitions. EZGraph
removes mostly infrastructure repetition rather than hiding the hotel rules.
That is the right kind of code reduction.

EZGraph does retain some ceremony. A tool name appears in both `defineTool()`
and `@Tool()`. Nodes use generic base classes and framework-specific outcome
builders. Topology must register nodes and separately describe branches. These
costs are visible, but they are much smaller than the duplicated runtime in the
direct implementation.

**Boilerplate winner: HotelGraph/EZGraph, decisively.**

## Session-document organization

Neither implementation uses a LangGraph checkpointer. Both save one application
session document after a turn and hydrate that document at the next turn. This
is a reasonable design for request/response chat, provided that concurrent
updates are addressed separately.

### EZGraph session shape

The EZGraph document is a framework-wide operational record. Its effective
shape is:

```jsonc
{
  "version": 11,
  "id": "...",
  "graphName": "HotelGraph",
  "status": "in_progress | completed | error",
  "currentNode": "ExploreNode | PresentNode | CompareNode | end",
  "config": {},
  "histories": {
    "hotel-explore": ["stored LangChain messages"],
    "hotel-present": ["stored LangChain messages"],
    "hotel-compare": ["stored LangChain messages"]
  },
  "nodes": {
    "ExploreNode": { "criteria": "..." },
    "PresentNode": {
      "hotelFound": [],
      "hotel": "...",
      "confirmationNumber": 123456
    },
    "CompareNode": {
      "availableHotels": [],
      "selectedHotels": [],
      "lastComparison": []
    }
  },
  "tokens": {
    "input_tokens": 0,
    "output_tokens": 0,
    "thinking_tokens": 0,
    "tool_input_tokens": 0,
    "cached_input_tokens": 0,
    "total_tokens": 0
  },
  "errors": [],
  "warnings": [],
  "model": "openai:gpt-4o",
  "parameters": { "retries": 3 },
  "expireAfter": 50000,
  "createdAt": "...",
  "modifiedAt": "..."
}
```

The real document can also contain per-node model override metadata. EZGraph
compacts stored messages by removing response and usage metadata that are not
needed to reconstruct future chat context, while retaining standardized tool
calls and required provider signatures.

### Direct session shape

HotelLanggraph uses a smaller outer envelope around a graph-specific state:

```jsonc
{
  "version": 1,
  "id": "...",
  "graphName": "HotelLanggraph",
  "state": {
    "phase": "explore | present | compare | terminal",
    "route": "exploreAgent | presentAgent | compareAgent | end",
    "completed": false,
    "response": "...",
    "userInput": "...",
    "inputConsumed": true,
    "config": {},
    "criteria": {},
    "hotelFound": [],
    "availableHotels": [],
    "selectedHotels": [],
    "lastComparison": [],
    "bookedHotel": "...",
    "confirmationNumber": 123456,
    "exploreMessages": [],
    "presentMessages": [],
    "compareMessages": []
  },
  "expireAfter": 50000,
  "createdAt": "...",
  "modifiedAt": "..."
}
```

The direct shape is easy to understand in isolation because it mirrors the
LangGraph annotation. It also persists transient control values such as the
last `response`, `userInput`, `inputConsumed`, and internal `route`. It has no
status independent of state, no token totals, no warning or error history, and
no model/parameter record. A failed model turn returns an error to the caller
but does not persist the failure for later diagnosis.

### Which document is better?

| Question | Better choice | Reason |
| --- | --- | --- |
| Understand one hotel state without framework knowledge | HotelLanggraph | One graph-specific `state` object mirrors its annotation |
| Diagnose a failed production turn | HotelGraph | Status, errors, warnings, model, parameters, timestamps, and tokens are first-class |
| Query sessions across many graph types | HotelGraph | Every graph shares the same top-level operational schema |
| Identify the next resumable phase | HotelGraph | `currentNode` is direct; the pure document requires interpreting `phase` versus `route` |
| Minimize provider payload bloat | HotelGraph | Framework compacts stored messages |
| Add a custom storage backend locally | HotelLanggraph | The small `HotelSessionStore` interface is straightforward |
| Support storage backends without per-app code | HotelGraph | Memory, SQLite, MongoDB, and Cosmos are framework concerns |

EZGraph's organization is better for session debugging and machine processing
across a graph fleet. More importantly, it is a shared knowledge artifact: a
reader can find operational facts in predictable top-level locations instead
of learning whether a particular author called the active stage `phase`,
`route`, `step`, or something else. HotelLanggraph's document is simpler only
as a single-graph snapshot; its control values are local implementation detail.

There is one current operational complication: both implementations can write
different schemas into the same `ezgraph.sessions` MongoDB collection. Their
`graphName` and `version` distinguish them, but analytics and administrative
tools must handle both shapes. Running two production session systems in one
collection should be treated as a comparison setup, not a desirable final
architecture.

## Debugging and machine comprehension

### Source-level debugging

HotelLanggraph is explicit enough to single-step without entering a custom
framework. The drawback is the amount of code and the number of manually
maintained invariants. A bug involving an input forwarded from present to
explore may require tracing `phase`, `route`, `inputConsumed`, message-array
reducers, and conditional edges through one large file.

HotelGraph source is shorter and organized around domain stages. A developer
can usually identify the responsible node quickly. A framework-level bug,
however, requires stepping into EZGraph's runner, outcome builders, history
spaces, or persistence manager. The framework therefore improves ordinary
chatbot debugging while making rare infrastructure failures more specialized.

The direct session store statically imports `node:sqlite`, which is why a Mongo
test still prints Node's experimental SQLite warning. EZGraph dynamically loads
the configured persistence adapter. This small example illustrates the polish
a shared runtime can provide once, instead of asking every graph author to
handle it.

### Machine comprehension

For an AI coding agent reading only one function, raw LangGraph is more
explicit: tool calls and state updates are ordinary local code. For an agent
reasoning about the complete chatbot, the 1,063-line multipurpose file is less
tractable than three semantically named nodes with a standard base contract.

For machines consuming persisted data, EZGraph is clearly stronger. A stable
top-level schema exposes graph, status, current node, histories, domain nodes,
tokens, failures, and model configuration using the same fields for every
graph. HotelLanggraph's custom state is understandable, but a machine must learn
a new schema and new control semantics for each independently authored graph.

The EZGraph advantage depends on its contracts being documented and available
to the machine. If it is distributed as an opaque package with weak docs, the
decorators and inherited behavior become hidden context. Good type declarations,
examples, schema documentation, and source maps are therefore part of the
product—not optional extras.

**Debugging winner: HotelGraph for session diagnosis and routine domain work;
HotelLanggraph for low-level step-through control. Machine-comprehension winner:
HotelGraph when EZGraph's contracts are documented.**

## Risks and shortcomings shared by both approaches

The framework comparison must not obscure deficiencies in the hotel chatbot
itself.

1. **It is not a real reservation system.** Booking generates a random number
   and a sentence. There is no inventory lock, reservation API, payment,
   cancellation, idempotency key, or durable booking record separate from the
   conversation.
2. **Checkout pricing appears inclusive.** The matching copied pricing engines
   enumerate both start and end dates. A stay from August 1 to August 8 is
   normally seven nights, but either backend can price eight dates. Prompt
   wording and semantic judging cannot correct a wrong total.
3. **Concurrent turns can overwrite each other.** Both systems upsert a whole
   session document without a revision, compare-and-swap condition, lock, or
   idempotency policy. Two requests for the same session can race.
4. **The default 50-second expiration is unsuitable for normal users.** Both
   implementations default `SESSION_EXPIRATION` to 50,000 milliseconds. A user
   pausing for a minute may lose the resumable conversation unless deployment
   configuration changes it.
5. **Sensitive chat data needs governance.** Both documents retain conversation
   histories and search preferences. Neither application demonstrates field
   redaction, encryption policy, access controls, retention jobs, or audit
   policy.
6. **The language model still controls workflow interpretation.** Tool handlers
   validate selected hotel names and criteria, which is good, but correctness
   still depends on the model translating user intent into the expected tool
   and arguments.
7. **Neither approach demonstrates streaming, interruption, or human approval.**
   Those requirements could materially change the framework decision.

These are higher-priority production issues than choosing between the two graph
authoring styles.

## Library-selection risks specific to EZGraph

These are dependency-selection considerations, not an instruction for each
application developer to maintain EZGraph's source.

- The linked development package currently identifies itself as version
  `0.0.1`, is private in the staging manifest, and is consumed through a local
  link. A production distribution should state its free-use license and support
  terms clearly so developers can rely on the no-fee assumption.
- The framework has a broad provider and persistence dependency surface. This
  centralizes integrations, while consumers still experience installation
  size, security advisories, and upgrade compatibility. The library project—not
  each chatbot team—should keep optional adapters/providers from imposing
  unnecessary runtime weight.
- Graph and node class names are persisted identifiers. Ordinary TypeScript
  renames can become data-schema changes. Stable explicit identifiers and a
  migration registry would be safer.
- `StateGraphExt` intentionally exposes a narrower API than raw LangGraph. This
  keeps authors inside the contract but can delay access to advanced LangGraph
  features until EZGraph adds and supports them.
- A library defect in history forwarding, tool execution, serialization, or
  provider normalization can affect every consuming graph. Consumers should
  evaluate release quality and support, while fixes remain the library
  maintainers' responsibility.
- Developers must learn EZGraph concepts in addition to LangGraph concepts.
  This learning cost is incurred by consumers even though library maintenance
  is not.

## Risks specific to direct LangGraph

- Every application can invent a different state, persistence, error, and
  response convention.
- Boilerplate is likely to drift. The same tool name, phase, route, history key,
  and graph name appear in multiple locations without one registry enforcing
  them all.
- Operational metadata is absent unless every team remembers to add it.
- Provider behavior and message serialization become application concerns.
- The direct graph is intentionally reachable only through its dedicated
  controller namespace, so it does not participate in the EZGraph registry.
- Maintaining memory, SQLite, and MongoDB adapters inside this one chatbot adds
  code that has no hotel-domain value.
- Once several direct graphs exist, teams will naturally extract common
  runners, stores, state conventions, and tool loops—in effect creating another
  framework, often less deliberately.

## Is EZGraph actually easier for a developer?

**Yes, for a developer implementing the second and subsequent multi-turn
chatbots under the supported patterns.** The measured reduction is substantial,
the phase modules are more cohesive, and important operational behavior comes
from one tested runtime.

**There is still a learning and abstraction cost.** A developer must learn an
additional API, and some behavior is inherited rather than local. That is a
consumer cost; maintaining EZGraph's implementation is not.

The right value proposition is not “EZGraph makes LangGraph possible” or even
“EZGraph always makes graphs simpler.” It is:

> EZGraph standardizes the repetitive application engineering around
> multi-turn LangGraph chatbots so individual graph authors can focus on domain
> prompts, tools, validation, and transitions.

The HotelGraph source supports that claim. The claim would be weakened only if
the library's abstractions block required LangGraph capabilities or its public
contract proves unreliable—not because the consumer is charged for maintaining
the library source.

## Decision framework

Use EZGraph when most of the following are true:

- the application will contain several conversational graphs;
- graphs need the same API, session schema, storage backends, model gateway,
  token accounting, and error policy;
- developers should work in domain-oriented phase modules;
- provider portability matters;
- a supported EZGraph release satisfies the application's compatibility and
  reliability requirements;
- advanced LangGraph capabilities can be exposed deliberately through a stable
  EZGraph contract.

Prefer direct LangGraph when most of the following are true:

- there is one small graph or a short-lived prototype;
- the workflow needs new LangGraph features before EZGraph supports them;
- full control and ecosystem documentation are more valuable than uniformity;
- adding another public abstraction is not worthwhile for the particular task;
- persistence and observability already come from another platform;
- the graph is unusual enough that EZGraph abstractions fight its design.

## Recommendation for this codebase

Keep EZGraph, with conditions.

The current HotelGraph is more modular, has the stronger cross-application
contract, writes materially less application boilerplate, and produces the
better organized session document. The benefit is not hypothetical; it is
visible in the measured 42.9% reduction in normalized executable graph code
and in the responsibilities that disappear from the hotel implementation.

Do not keep both hotel implementations as production paths. Use HotelLanggraph
as an executable comparison fixture that proves the behavior is not dependent
on proprietary magic and catches regressions in EZGraph's abstraction. Two
active implementations would double maintenance while sharing the same domain
defects.

The following should be prioritized by the appropriate owner. Shared hotel
domain fixes belong to the application; generic framework fixes belong to the
EZGraph library project:

1. fix checkout-exclusive pricing and replace mock booking with an idempotent
   reservation boundary;
2. add optimistic concurrency or another single-session turn policy;
3. choose realistic expiration and retention policies;
4. stabilize explicit graph/node identifiers and session migrations;
5. publish a versioned package with contract tests, source maps, and clear
   dependency/optional-adapter rules;
6. document the node, tool, history, error, and persistence contracts;
7. add a session inspection view that renders current node, domain state,
   histories, errors, model, and token totals;
8. benchmark the next two real graphs by implementation time, defects, and
   review effort—not only line count.

Under the stated model—a free library used by thousands of developers—the
decision is clearer: keep EZGraph. Its maintenance cost is amortized outside
this application, there is no developer license or subscription charge, and
the developer receives the 42.9% normalized-code reduction, stronger
modularity, standardized persistence, and better observability. Rejecting it
should require a concrete functional limitation, unacceptable dependency or
release risk, or a need for raw LangGraph capabilities; the size, maintenance
cost, or acquisition price of the library's own implementation is not a valid
charge against this chatbot.
