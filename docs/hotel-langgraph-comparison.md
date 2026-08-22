# HotelGraph and HotelLanggraph comparison

This repository exposes two implementations of the same Portland Hilton
reservation chatbot:

| API graph name | Implementation |
| --- | --- |
| `HotelGraph` | EZGraph classes built on LangGraph |
| `HotelLanggraph` | Direct LangGraph and LangChain APIs, with no EZGraph import |

`HotelLanggraph` is the public graph name for the direct LangGraph comparison.
It does **not** extend `BaseGraph`; doing so would make it an EZGraph graph.

Each implementation carries its own copy of the role and stage prompts,
`hotels.json` catalog, pricing rules, comparison chart generator, and domain
types. They both support multi-turn criteria collection, search changes, hotel
presentation, repeated comparisons, returning to booking, explicit termination,
and booking confirmation.

## Dedicated controller

`AiController` remains the EZGraph-only `/ai` controller. The direct graph has
its own `AiLanggraphController` and route namespace:

```text
POST /ai-langgraph/run
    |
    v
AiLanggraphController
    `-- HotelLanggraph --> pure StateGraph wrapper
```

The direct controller mirrors the response envelope, `SESSION_ID` header,
graph listing, completed-session behavior, and `POST /ai-langgraph/end`
cleanup without changing the EZGraph controller or registry.

| Endpoint | Direct-LangGraph purpose |
| --- | --- |
| `GET /ai-langgraph/graphs` | List the dedicated `HotelLanggraph` graph. |
| `POST /ai-langgraph/run` | Start or resume a `HotelLanggraph` session. |
| `POST /ai-langgraph/end` | Delete a `HotelLanggraph` session using `SESSION_ID`. |

## What the direct implementation has to own

The pure graph defines these concerns explicitly:

- every state channel and reducer;
- three independent message histories;
- stage-specific OpenAI model creation and tool binding;
- user-input consumption and forwarding between stages;
- agent-to-tool and tool-to-agent loops;
- conditional edges for every stage and outcome;
- Zod parsing and `ToolMessage` creation;
- resume routing from `START` using the persisted phase;
- session-document serialization, hydration, expiry, and deletion;
- memory, SQLite, and MongoDB document-store adapters;
- HTTP result translation in the dedicated controller.

For the orchestration comparison, the matching 236-line catalog and pricing
backend is excluded from both graphs. This leaves 845 TypeScript lines for
HotelGraph and 1,481 for HotelLanggraph. Controller code is excluded from both
sides: `AiController` is shared by several EZGraph graphs, while
`AiLanggraphController` is dedicated to the comparison graph.
The matching copied prompt and catalog assets add 1,127 lines to each graph but
are not used in the normalized percentage. The complete implementation
inventories, excluding both controllers, are 2,208 lines in 15 files for
HotelGraph and 2,844 lines in 14 files for HotelLanggraph.

The line count is only a snapshot, but the responsibility difference is more
important: the direct implementation mixes domain behavior with recurring
conversation infrastructure, while the EZGraph version expresses those
infrastructure decisions through `ConversationNode`, typed outcomes,
`historySpaces`, `resume`, `autoRouteOutcomes`, and `addEdge`.

EZGraph therefore uses **42.9% less normalized executable graph code** in this
experiment. That is a code-size measurement, not a stopwatch measurement, but
it is a practical indicator of time to market: less application-owned
orchestration has to be designed, written, reviewed, tested, and taught to the
next developer.

## Team consistency, modularity, and delivery speed

Direct LangGraph deliberately provides low-level primitives rather than one
required chatbot idiom. A disciplined team can establish excellent conventions
on top of them. Without that additional team layer, however, different authors
can reasonably choose different state channels, reducers, tool loops, routing
names, resume rules, and persistence shapes. Each choice is valid locally, but
the team must first learn the author-specific model before it can modify or
debug the graph.

EZGraph supplies a common conceptual picture:

```text
GraphDefinition -> named conversation phase -> prompt and tools
                -> typed semantic outcome -> history space -> session document
```

In HotelGraph, `ExploreNode`, `PresentNode`, and `CompareNode` are those
named, focused phases. This modular organization lets a developer find a
business behavior by phase rather than trace it through agent loops, route
strings, and persistence plumbing. It also gives code reviews, onboarding, and
cross-team knowledge sharing a consistent vocabulary. The result is a shorter
path from a chatbot idea to a maintainable implementation, while retaining
LangGraph underneath for graph execution.

## State and routing equivalence

| Behavior | EZGraph | Direct LangGraph |
| --- | --- | --- |
| Resume active stage | `graph.registerTurns(...)` | `START` conditional edge using `phase` |
| Standard outcome routing | `graph.autoRouteOutcomes()` | Conditional routes after each agent node |
| Unconditional internal topology | `graph.addEdge(...)` | Direct and conditional edges |
| Isolated stage history | `historySpaces` | Three message channels and reducers |
| Wait for next request | `stay(...)` | Conditional edge to `END` with phase retained |
| Move to another stage | `advance(...)` | State patch plus conditional route string |
| Forward current input | `forwardInput(...)` | Reset `inputConsumed` and route in the same invocation |
| Complete booking | `finish(...)` | Set `completed`, terminal phase, response, and `END` route |
| Tool lifecycle | `ConversationNode` and `@Tool` | Bound LangChain tools, explicit parsing, tool nodes, and `ToolMessage`s |
| Multi-turn storage | Built-in `SessionManager` document | Explicit session document, message serialization, and store adapters |
| API registration | `GraphEngine` graph registry at `/ai` | Dedicated `AiLanggraphController` at `/ai-langgraph` |

The pure wrapper does not use a LangGraph checkpointer. It loads one complete
session document at the start of a request, hydrates its stored LangChain
messages into graph state, invokes a fresh compiled graph, then serializes and
saves the resulting state. This is sufficient for the chatbot because it does
not use interrupts, time travel, or super-step recovery.

The direct implementation supports memory, SQLite, and MongoDB session
documents. EZGraph additionally supplies normalized logs, token totals, model
metadata, error documents, and its other configured persistence integrations.
The application code required to reproduce even the smaller direct contract is
deliberately visible in this demo.

The document shapes also affect team comprehension. The direct document is
clear for this one graph, but its `phase`, `route`, control flags, and message
channels are local conventions. EZGraph organizes the same concerns under a
stable top-level vocabulary—status, current node, histories, node state,
tokens, warnings, errors, model, and parameters. A developer or diagnostic tool
can therefore inspect a session without first reverse-engineering a particular
author's state-machine idiom.

## Run and test

Start the application normally, then select the pure graph by name:

```bash
curl -i http://localhost:8000/ai-langgraph/run \
  -H 'content-type: application/json' \
  --data '{"graphName":"HotelLanggraph","message":"Hi"}'
```

Reuse the returned `SESSION_ID` header for later turns. Run the visible,
provider-backed 14-turn reservation scenario with the session store selected by
`.env`:

```bash
yarn test:hotel-langgraph
```

Every user turn, assistant response, and semantic-judge result is printed while
the test runs. Missing provider credentials cause a clear failure instead of a
silent skip.

Run the same live scenario with MongoDB forced as the session store and retain
its session document for inspection with:

```bash
yarn test2:hotel-langgraph
```

`test2:hotel-langgraph` overrides `SESSION_STORE` to `mongodb`; it does not
depend on that `.env` setting. It uses `MONGODB_URL`, with `MONGODB_NAME` and
`MONGODB_COLLECTION` defaulting to `ezgraph` and `sessions`, respectively. The
live session document is retained for inspection and its ID is printed. With
the defaults, it is written to the exact `ezgraph.sessions` namespace.

The EZGraph baseline has the equivalent MongoDB-only live command:

```bash
yarn test2:hotel-graph
```

It forces `SESSION_STORE=mongodb`, runs only the HotelGraph 14-turn live
scenario, and retains the resulting `HotelGraph` session document in the same
configured MongoDB database and collection.

The fast deterministic tests remain available separately and do not make a
provider request:

```bash
yarn test:hotel-langgraph:unit
```

They cover the criteria, search, changed-search, repeated comparison, resume,
booking, termination, session inspection, controller mapping, and session
deletion paths.
