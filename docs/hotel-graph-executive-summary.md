# Executive brief: the HotelGraph authoring experiment

## Decision

Use EZGraph as the preferred authoring model for multi-turn chatbot
experiments in this repository. Keep direct LangGraph as the comparison
baseline when testing framework value or exploring lower-level capabilities.

## Experiment

The repository implements the same fourteen-turn hotel chatbot in two forms:

| Approach | Graph |
| --- | --- |
| EZGraph on LangGraph | `HotelGraph` |
| Direct LangGraph and LangChain | `HotelLanggraph` |

Both implementations guide a user through hotel criteria, search, comparison,
booking resumption, and confirmation. The comparison isolates the developer
authoring approach rather than changing the conversation objective.

The API boundary is also separate: `HotelGraph` remains in `/ai/*`, while
`HotelLanggraph` is exercised through `/ai-langgraph/*`. This keeps the direct
LangGraph experiment independent of the EZGraph graph registry.

## Measured outcome

| Measure | EZGraph | Direct LangGraph |
| --- | ---: | ---: |
| Self-contained graph files, controllers excluded | 15 | 14 |
| Matching catalog and pricing backend excluded | -236 lines | -236 lines |
| Normalized executable graph code | 845 lines | 1,481 lines |
| Copied prompt and catalog assets | 1,127 lines | 1,127 lines |
| Complete graph footprint, controllers excluded | **2,208 lines** | **2,844 lines** |

EZGraph required 42.9% less normalized executable graph code. Both controllers
are excluded: `AiController` is shared by EZGraph graphs and
`AiLanggraphController` is dedicated to the direct graph. The identical catalog
and pricing backend is excluded from this percentage; copied assets remain
listed only as complete-inventory context.

## Why the difference matters

EZGraph lets the developer express the hotel chatbot as three focused business
phases—explore, present, and compare—plus a short graph topology. It supplies
the recurring multi-turn mechanics around those phases: tool dispatch,
conversation history, state continuation, standardized session documents, and
the application-facing graph runtime.

That topology follows a simple three-part contract: `registerTurns(...)` identifies
the phases that may receive a later request, `autoRouteOutcomes()` handles
standard `stay`, `advance`, `quit`, and `finish` outcomes, and `addEdge()`
connects unconditional internal work. Explicit `branchBy()` remains available
when a graph needs lower-level conditional routing.

The direct implementation demonstrates that pure LangGraph remains capable and
valuable. It also requires the chatbot developer to implement those mechanics
explicitly in addition to the hotel conversation itself.

## Why this accelerates team delivery

The 42.9% reduction is measured code size, not a direct time study. It does,
however, remove application-owned work that otherwise must be designed,
implemented, reviewed, tested, debugged, and explained. That is a credible
time-to-market advantage for comparable multi-turn chatbot experiments.

Raw LangGraph is intentionally flexible: different developers can choose
different state, routing, tool-loop, resume, and persistence idioms. Teams can
build their own conventions, but they must also maintain and teach them.
EZGraph provides a common phase-oriented model and a modular vocabulary for
that work—graph, node, typed outcome, history space, and session.

Its session document reinforces that common picture. A reader sees status,
current node, histories, node state, tokens, warnings, errors, model metadata,
and timestamps in a consistent layout. The direct document is understandable
within its graph, but uses graph-specific control fields and therefore requires
the reader to learn that implementation before diagnosing it. This difference
matters for team knowledge sharing, debugging, and machine comprehension.

## Strategic takeaway

The experiment supports a simple positioning statement:

> LangGraph is the graph runtime; EZGraph is the developer-facing authoring
> layer for repeatable multi-turn chatbot patterns.

For a developer using a free, shared EZGraph library, the relevant comparison
is application effort—not the library’s internal implementation size. The
hotel experiment shows a smaller, more phase-oriented implementation while
preserving the same demonstrated conversation flow.

## Scope

This brief describes an engineering experiment. The hotel chatbot is a demo
used to compare authoring approaches; it is not intended to evaluate a complete
hotel-reservation product.

For implementation evidence and detailed contract/session analysis, see
[the technical evaluation](./hotel-graph-critical-evaluation.md).
