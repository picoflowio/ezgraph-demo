# DecisionHotelGraph design

`DecisionHotelGraph` is the EZGraph port of PicoFlow's `DecisionHotelFlow`.
The port preserves the business contract while using EZGraph's durable node
state, named history spaces, provider-neutral `DecisionNode`, and real
`GraphEngine` persistence.

## Ownership

- `RouterDecisionNode` classifies the latest request; it never parses or saves
  hotel criteria.
- Five `ConversationNode` collectors validate and save dates, budget, room
  type, amenities, and distance through typed tools.
- `CriteriaReadinessDecisionNode` semantically reviews the normalized record,
  while deterministic validation remains authoritative.
- `SearchHotelsNode` runs a local deterministic catalog and pricing policy.
- `PresentNode` drafts or acts on results through tools.
- `PresentationDecisionNode` gates the draft against trusted result data.
- `DecisionHotelGraph.onDecisionError()` owns bounded graph-wide fallbacks:
  deterministic collection/search routing and grounded result rendering.

## Persistence and histories

All nodes use one durable `currentNode`. The router and collectors share
`hotel-intake`; presentation and its judge share `hotel-present`; terminal
messages use `hotel-terminal`. Node-local business state is authoritative and
the graph does not duplicate a second session model.

## Verification contract

The deterministic acceptance test drives 23 real `GraphEngine` turns through
the public turn harness. It covers invalid values, a cross-step correction,
both semantic judges, provider outages, an empty search, repeated revisions,
grounded presentation, and booking. Framework tests separately cover startup
provider validation, direct decision completion, graph fallback precedence,
multi-node accounting, sanitized audits, and usage from a failed superstep.
