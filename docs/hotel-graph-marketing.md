# Build a multi-turn hotel chatbot with less orchestration code

The hotel chatbot experiment answers a practical question for teams adopting
LangGraph: how much application code must a developer write to create a
stateful, tool-using, multi-turn conversation?

This repository implements the same Hilton hotel-search experience twice:

- `HotelGraph` uses EZGraph on top of LangGraph.
- `HotelLanggraph` uses direct LangGraph and LangChain APIs only.

Both guide a customer through Portland-area hotel search, collect preferences,
search a local hotel catalog, compare options, resume booking, and confirm a
selection across fourteen conversation turns.

HotelGraph uses the EZGraph route family at `/ai/*`. HotelLanggraph has a
dedicated route family at `/ai-langgraph/*`, so the direct experiment does not
change the existing EZGraph API.

```bash
curl -i http://localhost:8000/ai-langgraph/run \
  -H 'content-type: application/json' \
  --data '{"graphName":"HotelLanggraph","message":"Hi"}'
```

## One experiment, two authoring styles

The customer experience is intentionally comparable:

```text
Greeting
  -> collect stay dates, budget, room, amenities, distance
  -> search hotels
  -> compare selected hotels
  -> resume booking
  -> confirmation
```

The difference is where the orchestration lives.

With direct LangGraph, the application author writes the agent/tool loop,
routing, phase resumption, history movement, session hydration, persistence
adapters, response envelopes, and controller dispatch.

With EZGraph, the application author focuses on the business conversation:

- the graph topology;
- one node per conversation phase;
- prompts and model choices;
- validated business tools;
- domain transitions such as search, compare, resume, book, and end.

## The result in this experiment

| Measure | HotelGraph / EZGraph | HotelLanggraph / direct LangGraph |
| --- | ---: | ---: |
| Self-contained graph files, controllers excluded | 15 | 14 |
| Matching catalog and pricing backend excluded | -236 | -236 |
| Normalized executable TypeScript | 845 | 1,481 |
| Copied prompt and catalog assets | 1,127 | 1,127 |
| Complete graph footprint, controllers excluded | **2,208** | **2,844** |
| Conversation architecture | Graph plus three focused phase nodes | One large graph class plus state and session-store modules |
| Session diagnostics | Standard graph status, histories, node state, tokens, warnings, errors, model metadata | Graph-specific state and message histories |

For this experiment, EZGraph reduces normalized executable graph code by 42.9%.
Both controllers are excluded from that percentage: `AiController` is shared by
the EZGraph API, while `AiLanggraphController` is dedicated to the direct graph.
The matching domain backend is also excluded. The copied assets remain in the
complete graph inventory but are not used to measure orchestration overhead.

The value is not simply fewer lines. The smaller EZGraph implementation keeps
the important decisions close to their domain:

| Conversation concern | EZGraph authoring experience |
| --- | --- |
| Search criteria | `ExploreNode` owns collection, validation, and search transition |
| Hotel selection | `PresentNode` owns list presentation, booking, and comparison entry |
| Feature comparison | `CompareNode` owns comparison generation and booking resumption |
| Conversation end | Shared termination behavior is available in each phase |
| Session continuation | The framework restores the active node and its history space |

## What developers write with EZGraph

The core graph reads as a short description of the conversation:

```ts
graph.nodes(ExploreNode, PresentNode, CompareNode, TerminateSessionNode);
graph.registerTurns(ExploreNode, PresentNode, CompareNode, TerminateSessionNode);

graph.autoRouteOutcomes();
graph.addEdge(/* internal worker */, /* next worker */);
```

Each node then declares its prompt, tools, and semantic outcome. The framework
handles the common conversation runtime around those decisions.

The direct implementation proves that raw LangGraph can accomplish the same
workflow. It also makes the additional responsibilities visible: the direct
version contains explicit agent nodes, explicit tool nodes, tool-call parsing,
conditional routes, input-forwarding flags, state hydration, message
serialization, and three storage adapters.

## One mental model for the whole team

LangGraph gives teams powerful low-level building blocks. That flexibility also
means different developers can adopt different valid idioms for state,
reducers, routing, tool loops, resume behavior, and persistence. A team can
standardize those choices itself, but that standardization is additional design,
review, documentation, and onboarding work.

EZGraph starts each author from the same model:

```text
Business phase -> prompt and tools -> typed outcome -> history -> session
```

The hotel graph makes that model tangible through `ExploreNode`, `PresentNode`,
and `CompareNode`. Developers can locate a behavior by the customer phase it
belongs to, and teams can discuss changes using the same graph, node, outcome,
history, and session vocabulary. That modularity makes knowledge easier to
share as more chatbots are authored.

## A clearer path from idea to multi-turn chatbot

EZGraph gives developers a repeatable shape for conversational work:

```text
Business phase
  -> prompt and typed tools
  -> validated tool effect
  -> semantic transition
  -> persisted continuation
```

That shape is useful when a conversation has several phases and must carry
state between requests. Developers can spend their attention on what the
customer is trying to do instead of reconstructing the surrounding runtime for
every new graph.

The measured 42.9% code reduction is not a direct timing benchmark. It is a
strong development signal: there is less application-specific orchestration to
implement, test, debug, review, and explain before a team can demonstrate a
multi-turn chatbot. In practice, that gives EZGraph a faster route from idea to
an understandable conversation experiment.

## Session documents people can read together

EZGraph persists a logically organized conversation record: graph identity,
status, current node, named histories, node-local business state, tokens,
warnings, errors, model information, and timestamps. The fields answer the
questions a teammate asks while inspecting a session without requiring them to
decode a graph-specific control protocol.

The direct LangGraph document is a useful local state snapshot, but it exposes
author-defined `phase`, `route`, input flags, and message arrays inside one
custom state object. That is flexible; it is not a shared semantic contract.
For a team, EZGraph's consistent session layout improves debugging and machine
comprehension across conversation implementations.

## What this demo demonstrates

This is an authoring experiment, not a claim that one framework changes the
hotel domain itself. Each graph has matching, self-contained copies of the
prompts, catalog, pricing, comparison behavior, and fourteen-turn scenario.

The demonstrated difference is developer experience:

- Direct LangGraph offers complete low-level control and can reproduce the
  workflow.
- EZGraph packages the recurring multi-turn mechanics into a concise,
  domain-oriented authoring model.
- In this hotel-chatbot experiment, that model produces a smaller and more
  phase-oriented application implementation.

See the detailed technical analysis in
[HotelGraph versus HotelLanggraph: critical evaluation](./hotel-graph-critical-evaluation.md).
