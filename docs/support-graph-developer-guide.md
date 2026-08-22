# SupportGraph developer guide

SupportGraph is a post-purchase customer support agent for a fictional outdoor
gear retailer, Northwind Outfitters. It verifies a customer's identity, answers
order and shipping questions, processes returns and refunds, and opens billing
escalations.

It is the reference in this repository for three things the other graphs do not
cover:

- a **hub-and-spoke topology** where a front desk delegates to specialists and
  every specialist comes back, instead of a linear wizard;
- **worker nodes that run inside a single user turn**, one of them entirely
  deterministic and one of them a single schema-validated model call;
- a **human-in-the-loop approval gate** for an irreversible action, built from
  ordinary multi-turn state rather than a checkpointer or an interrupt.

Use the other tutorials for complementary patterns:

- [DemoGraph developer guide](./demo-graph-developer-guide.md) is the broadest
  feature tour: isolated histories, fan-out and join, concurrency inside a node.
- [HotelGraph developer guide](./hotel-graph-developer-guide.md) is the most
  complete linear transactional conversation, with backward navigation.
- [InvoiceGraph developer guide](./invoice-graph-developer-guide.md) is a
  single-shot document workflow with multimodal file handling and JSON output.

This guide follows the implementation under
[`src/graphs/support-graph`](../src/graphs/support-graph/). It assumes working
TypeScript, but **no prior EZGraph or LangGraph experience**.

---

## Start here: the six ideas EZGraph is built from

If this is your first EZGraph graph, read this section before anything else.
Everything later in the guide is an application of these six ideas.

### 1. A graph is node classes plus a topology, and nothing else

You write one class per meaningful step. A separate graph file says how control
may move between those classes. Prompts live in nodes; routing lives in the
graph. Neither file has to know how the other is implemented.

```ts
export class SupportGraph extends BaseGraph<SupportGraphStateType> {
  static getGraphDefinition(): GraphDefinition { /* shared policy */ }
  protected buildGraph() { /* topology */ }
}
```

LangGraph is still the execution engine underneath. EZGraph wraps it so that
routing, history, tool sequencing, and persistence are not re-implemented per
graph.

### 2. A request is one graph invocation, and it usually stops mid-graph

An HTTP request runs the graph until a node decides the turn is over. That is
normal. It does **not** mean the conversation ended. Three different notions of
"end" exist and confusing them is the single most common beginner mistake:

| Term | Meaning |
| --- | --- |
| LangGraph `END` | Stop executing nodes *for this invocation*. The yield point between user turns. |
| `GRAPH_END_NODE` (`"end"`) | EZGraph's persisted terminal state, stored in `currentNode`. |
| `completed: true` | The business workflow is finished. Set only by `finish(...)`. |

### 3. State has three layers with three different lifetimes

| Layer | Lives for | Owned by | Example in SupportGraph |
| --- | --- | --- | --- |
| Protocol state | The whole session | The framework | `currentNode`, `histories`, `tokens`, `completed` |
| Node local state | The whole session | One node | `TriageNode.refunds`, `ApprovalNode.pending` |
| Tool context | One turn | One node invocation | `context.department`, `context.confirmed` |

Node local state is namespaced by node ID, so two nodes can never accidentally
share a field name. Tool context is a plain object created fresh at the start of
every turn; if you want a value to survive the response, you must copy it into
local state explicitly.

### 4. A conversational turn ends with a *semantic outcome*, not a state patch

You never hand-write `{ currentNode: "...", response: "...", inputConsumed: true }`.
You pick one of five verbs, and EZGraph derives both the state update and the
LangGraph route from it:

| Outcome | Meaning | Requires a response |
| --- | --- | --- |
| `stay(conversation)` | Keep this stage active and wait for the next user message. | Yes |
| `advance(TargetNode, conversation)` | Move the workflow to another stage. | No |
| `quit(conversation)` | The user explicitly asked to end the chat. | No |
| `finish(response, conversation)` | The business workflow is complete. | Yes |
| `resumeAt(TargetNode, conversation)` | Record the next resume point without choosing this invocation's route. | No |

Each returns an immutable builder you can compose:
`.withState(...)`, `.withStateFor(OtherNode, ...)`, `.withHistory(space, msg)`,
`.via(WorkerNode)`, `.forwardInput(state, fallback)`.

### 5. Tools separate *ownership* from *usage*

`defineTool()` publishes a tool's name, description, and Zod schema — that is
ownership, and a tool name may be owned by exactly one node in the graph.
`@Tool("name")` binds a handler method — that is usage. Splitting them means a
node can only call a tool it declared, and the framework can validate the whole
tool surface at compile time.

```ts
defineTool() {
  return [{ name: "verify_order", description: "...", schema: z.object({ ... }) }];
}

@Tool("verify_order")
async verifyOrder(input, context) { /* ... */ }
```

### 6. Persistence is one session document, not a checkpoint graph

EZGraph serializes exactly one document per session ID: graph identity, status,
`currentNode`, every named history, every node's local state, token totals,
warnings, and errors. It deliberately does **not** use LangGraph checkpointers.

The practical consequence matters for this guide: because the resume point is a
plain persisted field, "wait for a human" needs no special machinery. A node
that returns `stay()` *is* an interrupt. Section 6 builds the entire approval
gate out of that one fact.

---

## What SupportGraph demonstrates

- a hub-and-spoke topology with a front desk and three specialist stages;
- **`branch()` driven by a typed `route()` method**, with route labels checked
  at compile time — the only explicit branch in this repository;
- **two worker nodes that execute inside a single user turn**, reached with
  `.via(...)` and fixed or branch edges;
- **`llmGateway.structured()`** — one Zod-validated model call, no tool loop,
  no user-facing text;
- a **human-in-the-loop confirmation gate** for an irreversible refund;
- a **real `onRestoreSessionDoc()` policy** that replaces the framework's
  default expiry and releases stale approval holds;
- the **`undefined` deletion marker** for clearing node local state;
- a deterministic policy backend that owns every amount and every eligibility
  decision, with the model unable to override either;
- five named history spaces, cross-node state handoffs, and per-stage model
  policy;
- deterministic orchestration tests plus an optional live semantic evaluation.

The implementation is split by responsibility:

| Area | Source | Responsibility |
| --- | --- | --- |
| Graph definition | [`support-graph.ts`](../src/graphs/support-graph/support-graph.ts) | Model policy, history spaces, topology, session policy |
| State contract | [`support-graph.state.ts`](../src/graphs/support-graph/support-graph.state.ts) | Case types and per-node durable state |
| Conversation stages | [`nodes/triage`](../src/graphs/support-graph/nodes/triage.node.ts), [`returns`](../src/graphs/support-graph/nodes/returns.node.ts), [`billing`](../src/graphs/support-graph/nodes/billing.node.ts), [`approval`](../src/graphs/support-graph/nodes/approval.node.ts) | Prompts, tools, validation, semantic outcomes |
| In-turn workers | [`adjudicate`](../src/graphs/support-graph/nodes/adjudicate.node.ts), [`escalate`](../src/graphs/support-graph/nodes/escalate.node.ts) | Deterministic decision and structured ticket drafting |
| Domain backend | [`backend/`](../src/graphs/support-graph/backend/) | Read-only order catalog and the entire refund policy |
| Prompt assets | [`prompt/`](../src/graphs/support-graph/prompt/) | Role and one file per stage |
| Presentation | [`gen-receipt.ts`](../src/graphs/support-graph/gen-receipt.ts) | Refund breakdown table and currency formatting |
| Shared helper | [`deterministic-turn.ts`](../src/graphs/support-graph/deterministic-turn.ts) | Outcome record for a node that skipped the agent loop |
| Tests | [`test/support-graph/`](../test/support-graph/) | Scripted deterministic coverage, session policy, live evaluation |

---

## The workflow at a glance

The graph starts at `TriageNode`.

```text
                              explicit end request
                          ┌──────────────────────────► TerminateSessionNode ──► END
                          │
START/resume ──►  ┌── TriageNode ◄────────────────────────────────────┐
                  │       │                                           │
                  │       │ route_request                             │
        close_case│       ├──────────────► ReturnsNode                │
                  │       │                    │                      │
                  ▼       │                    │ .via()               │
                 end      │                    ▼                      │
                          │             AdjudicateNode                │
                          │           (deterministic, no model)       │
                          │        branch(AdjudicateNode.route())     │
                          │      ┌──────────┬──────────┬──────────┐   │
                          │    auto       review      deny        │   │
                          │      │          │          │          │   │
                          │      │          ▼          └──► ReturnsNode
                          │      │    ApprovalNode                 │
                          │      │      │        │                 │
                          │      │  confirm   decline ──► ReturnsNode
                          │      │      │                          │
                          │      └──────┴──────────────────────────┤
                          │                                        │
                          └──────────────► BillingNode             │
                                               │ .via()            │
                                               ▼                   │
                                         EscalateNode ─────────────┘
                                    (one structured model call)
```

Solid rule: **only `TriageNode` can complete the graph.** Specialists resolve
one department and hand control back.

---

## 1. The domain: a case that must not be improvised

Support agents commit money. That makes SupportGraph a good demonstration of a
boundary every serious agent needs: the model may *request* an outcome, but it
may never *decide* one.

Every eligibility rule and every amount lives in
[`backend/policy-engine.ts`](../src/graphs/support-graph/backend/policy-engine.ts):

```ts
const RETURN_WINDOW_DAYS = { apparel: 60, footwear: 60, gear: 45, electronics: 30 };
const RESTOCKING_FEE_RATE = 0.15;   // opened electronics only
const AUTO_APPROVAL_LIMIT = 250;    // net refund inside agent authority
const SHIPPING_REFUND_REASONS = ["damaged", "wrong_item"];
```

`PolicyEngine.adjudicate()` returns one of three decisions:

| Decision | When | What happens |
| --- | --- | --- |
| `deny` | Not delivered, final sale, already returned, or past the category window | The request is refused with explicit reasons. |
| `auto` | Inside the window, no deduction, net refund at or below $250 | Committed immediately by the agent. |
| `review` | A restocking fee applies, or the net refund exceeds $250 | Held at the confirmation gate until the customer explicitly approves. |

[`backend/order-book.ts`](../src/graphs/support-graph/backend/order-book.ts)
loads [`data/orders.json`](../src/graphs/support-graph/data/orders.json) and is
strictly read-only. Six fixture orders exercise every branch:

| Order | Notable property | Exercises |
| --- | --- | --- |
| `NW-100412` | $289 jacket, 2 x $68 base layers | `review` and `auto` on the same order |
| `NW-100517` | Same $429 posted twice; opened electronics | Duplicate charge, restocking fee |
| `NW-100236` | Delivered February 2027 | `deny` (past the 60-day apparel window) |
| `NW-100604` | A final-sale beanie | `deny` (non-returnable) |
| `NW-100559` | Still `in_transit` | `deny` (not delivered), shipping questions |
| `NW-100341` | Pack plus an opened lantern | Mixed-category adjudication |

Returns produced during a conversation are recorded in **graph state**, never
written back to the fixture, so every session sees identical data.

---

## 2. Graph definition: policy, history spaces, topology

### 2.1 Shared policy

`getGraphDefinition()` is a static method because `GraphEngine` reads it before
it constructs the graph, to build the right model gateway.

```ts
static getGraphDefinition(): GraphDefinition {
  return {
    llmConfig: ModelCatalog.model("openai:gpt-4o", { retries: 3 }),
    endNode: GRAPH_END_NODE,
    initialHistorySpace: "support-triage",
    historySpaces: [
      [TriageNode, "support-triage"],
      [ReturnsNode, "support-returns"],
      [AdjudicateNode, "support-returns"],
      [ApprovalNode, "support-approval"],
      [BillingNode, "support-billing"],
      [EscalateNode, "support-billing"],
      [TerminateSessionNode, "support-terminal"],
    ],
  };
}
```

`ModelCatalog.model(...)` is compile-time validated: the model ID must exist in
the catalog and the parameters must be legal for that model's family. Passing
`reasoningEffort` to a non-reasoning model is a type error, not a runtime
surprise.

### 2.2 History spaces are the reason stages do not confuse each other

A **history space** is an independently persisted `BaseMessage[]`. Each node
reads and appends to exactly one. `ApprovalNode` therefore never sees the
transcript in which the customer described a torn zipper — its prompt contains a
breakdown and a yes/no question, and nothing else.

Two mappings above are deliberate and worth copying:

- `AdjudicateNode` shares `"support-returns"` so its denial annotations land in
  the transcript `ReturnsNode` will read next.
- `EscalateNode` shares `"support-billing"` because the billing transcript *is*
  the evidence the ticket has to summarize. `this.history(state)` then returns
  exactly the right messages with no plumbing.

### 2.3 Topology

```ts
protected buildGraph() {
  const graph = this.createStateGraph(SupportGraphState);
  graph.nodes(AdjudicateNode, EscalateNode);
  graph.registerTurnNodes(
    TriageNode, ReturnsNode, BillingNode, ApprovalNode, TerminateSessionNode,
  );
  graph.configAutoRoute();
  graph.branch(AdjudicateNode, {
    auto: TriageNode,
    review: ApprovalNode,
    deny: ReturnsNode,
  });
  graph.addEdge(EscalateNode, TriageNode);
  graph.addEdge(TerminateSessionNode, END);
  return graph.compile();
}
```

Four distinct topology contracts appear here. Learn the difference once:

| Call | Meaning | Used for |
| --- | --- | --- |
| `nodes(...)` | Register classes and their tool contracts. | Worker nodes that must never receive a user message. |
| `registerTurnNodes(...)` | `nodes(...)` **plus** `registerTurns(...)`: adds a `START` branch that dispatches on the persisted `currentNode`. | Every stage that can receive the *next* HTTP request. |
| `configAutoRoute()` | Derive conditional edges from `stay` / `advance` / `quit` / `finish` metadata. | All conversational stages. |
| `branch(NodeClass, destinations)` | An explicit conditional edge driven by that node's `route()` method. | The one node whose next step is a classification, not a conversation. |

`AdjudicateNode` and `EscalateNode` are registered with `nodes(...)` and left out
of `registerTurnNodes(...)`. This is a safety property, not a style preference:
a user message can never resume the session *inside* a half-finished worker.

Ordering matters. A node must be registered before it can be used as an edge
source or target, so worker registration comes first.

### 2.4 `branch()` is checked at compile time

`StateGraphExt.branch()` infers the legal route labels from the node's `route()`
return type:

```ts
// nodes/adjudicate.node.ts
override route(state: SupportGraphStateType): AdjudicationDecision {
  return this.state(state).decision ?? "deny";
}
```

`AdjudicationDecision` is `"auto" | "review" | "deny"`, so the destination map
must have exactly those three keys. Both of these are type errors:

```ts
// Error: 'maybe' is not a route AdjudicateNode.route() can return.
graph.branch(AdjudicateNode, { auto: A, review: B, deny: C, maybe: D });

// Error: every declared route needs exactly one destination.
graph.branch(AdjudicateNode, { auto: A, review: B });
```

Note the mechanics: `route()` runs **after** the node returns, against the
reduced state. That is why `AdjudicateNode.run()` persists its decision into
local state and `route()` merely reads it back. The decision is made once, in
one place, and is auditable in the session document afterwards.

---

## 3. State: the case record, and how to clear a field

```ts
export type SupportGraphNodes = {
  /** The hub owns the case record: identity, routing, and committed outcomes. */
  TriageNode?: NodeStateValue<{
    order?: VerifiedOrder;
    verifyAttempts?: number;
    refunds?: RefundRecord[];
    tickets?: EscalationTicket[];
  }>;
  ReturnsNode?: NodeStateValue<{ returnedLineIds?: string[]; lastDenial?: string[] }>;
  BillingNode?: NodeStateValue<{ dispute?: BillingDispute }>;
  ApprovalNode?: NodeStateValue<{
    pending?: PendingRefund | undefined;
    decidedAt?: string;
  }>;
  AdjudicateNode?: NodeStateValue<{
    request?: ReturnRequest;
    decision?: Adjudication["decision"];
    adjudication?: Adjudication;
  }>;
  EscalateNode?: NodeStateValue<{ dispute?: BillingDispute; ticket?: EscalationTicket }>;
};

export const SupportGraphState = createGraphStateAnnotation(
  TriageNode.name,
  () => ({} as SupportGraphNodes),
);
```

Two design choices are worth stealing.

**Committed outcomes live on the hub, not on whoever produced them.** A refund
can be committed by `AdjudicateNode` (auto) or by `ApprovalNode` (confirmed).
Both write to `TriageNode.refunds` with `withStateFor(TriageNode, ...)`. There is
one list to read, one list to summarize, and one list to assert on in tests.

**`pending?: PendingRefund | undefined` is deliberate.** The node-state reducer
treats an explicit `undefined` in an *update* as a deletion marker:

```ts
// nodes/approval.node.ts
return this.advance(TriageNode, conversation)
  .withState({ pending: undefined, decidedAt: new Date().toISOString() })
```

Under `exactOptionalPropertyTypes` (which this repository enables), a plain
`pending?: PendingRefund` would reject that assignment. Widening the field to
include `undefined` is what makes the deletion marker usable. Every other
optional field in this graph stays narrow, because nothing ever clears them.

### Local state versus tool context

`createContext(state)` builds a fresh object for the current turn. Tool handlers
patch it. `nextStep(...)` is the only place that decides what becomes durable.

```ts
protected createContext(state: SupportGraphStateType): TriageContext {
  const local = this.state(state);
  return {
    ...(local.order ? { order: local.order } : {}),
    verifyAttempts: local.verifyAttempts ?? 0,
  };
}
```

If you set `context.department` and forget `withState`, the value is gone the
moment the response is returned. That is intentional: it forces every persisted
field to be a conscious decision.

---

## 4. Anatomy of a conversation stage

`TriageNode` is the best node to read first because it uses every part of the
`ConversationNode` contract.

### 4.1 The lifecycle

```text
persisted state
  -> createContext(state)      // fresh working data for this one turn
  -> model and tool loop       // runs until the model stops or a tool halts it
  -> typed tool effects patch context
  -> nextStep(state, context, conversation)   // one business decision
  -> state update + graph route
```

You implement four members and the framework supplies the rest:

| Member | Responsibility |
| --- | --- |
| `getPrompt(state)` | The system prompt for this stage. |
| `defineTool()` | Tool names, descriptions, and Zod schemas this node owns. |
| `@Tool("name") method` | Validate, run domain logic, patch context. |
| `createContext(state)` | Fresh per-turn working data. |
| `nextStep(...)` | Select exactly one semantic outcome. |
| `getLlmConfig()` | Optional per-node model override. |

### 4.2 Prompts are composed, not concatenated by hand

```ts
getPrompt(state: SupportGraphStateType): string {
  const local = this.state(state);
  return `${supportPrompt.role}\n\n${fillPrompt(supportPrompt.triage, {
    TODAY: PolicyEngine.today().toISOString().slice(0, 10),
    ORDER: JSON.stringify(local.order ?? null),
    CASE: JSON.stringify({
      refunds: local.refunds ?? [],
      tickets: local.tickets ?? [],
    }),
  })}\n\n${endChatInstruction}`;
}
```

Every stage prompt is a markdown file under
[`prompt/`](../src/graphs/support-graph/prompt/) with `{{VARIABLE}}` slots. The
role block and the end-chat instruction are shared. Prompt text is a *briefing*,
never a validation layer — see section 9.

### 4.3 Tools: schema first, then domain validation

```ts
defineTool(): readonly (
  | ToolDefinition<VerifyOrderInput>
  | ToolDefinition<RouteRequestInput>
  | ToolDefinition<CloseCaseInput>
)[] {
  return [
    {
      name: "verify_order",
      description:
        "Verify an order number against the email address or shipping ZIP code on the order.",
      schema: z.object({
        orderId: z.string().min(1).describe("The customer's order number"),
        secret: z.string().min(1)
          .describe("The email address or shipping ZIP code on the order"),
      }),
    },
    /* route_request, close_case */
  ];
}
```

Handlers return a typed, immutable builder:

```ts
@Tool("verify_order")
async verifyOrder({ orderId, secret }: VerifyOrderInput, _context: TriageContext) {
  const order = OrderBook.verify(orderId, secret);
  if (!order) {
    return this.toolResult({
      accepted: false,
      error: "That order number and email or ZIP code do not match. Ask the customer to check both.",
    }).withContext((context) => ({ verifyAttempts: context.verifyAttempts + 1 }));
  }
  const verified = summarizeOrder(order);
  return this.toolResult({ accepted: true, order: verified })
    .withContext({ order: verified, verifyAttempts: 0 });
}
```

The builder methods:

| Method | Effect |
| --- | --- |
| `.withContext(patch \| fn)` | Merge a typed patch into the turn's context. |
| `.haltAfterBatch()` | Stop the agent loop after the current tool batch finishes. |
| `.stopAfterBatchWhen(pred)` | Same, but conditional on the resulting context. |
| `.withMessages(...)` | Add extra model-visible messages (used by InvoiceGraph for attachments). |
| `.withCleanup(fn)` | Release a provider-side resource after the next model turn. |

Notice what a failing tool returns: **a structured error the model must recover
from**, not an exception. `{ accepted: false, error: "..." }` becomes a
`ToolMessage`, the loop continues, and the model asks the customer to re-check
their details. Throwing would abort the request instead.

`haltAfterBatch()` matters for correctness, not just efficiency. Without it,
after `route_request` succeeds the model would take another turn and generate a
reply for a stage it is about to leave.

### 4.4 One outcome per turn

```ts
protected nextStep(state, context, conversation) {
  if (conversation.quitRequested) {
    return this.quit(conversation).withState(this.snapshot(context));
  }
  if (context.closing) {
    return this.finish(this.caseSummary(state, context.closing), conversation)
      .withState(this.snapshot(context));
  }
  if (context.department === "returns") {
    return this.advance(ReturnsNode, conversation)
      .withState(this.snapshot(context))
      .forwardInput(state, "Start a return request for this order.");
  }
  if (context.department === "billing") {
    return this.advance(BillingNode, conversation)
      .withState(this.snapshot(context))
      .forwardInput(state, "Start a billing dispute for this order.");
  }
  return this.stay(conversation).withState(this.snapshot(context));
}
```

Always check `conversation.quitRequested` **first**. `ConversationNode` inherits
a `terminate_session` tool; if the user asked to end the chat while a domain
tool also succeeded, the explicit request wins.

`forwardInput(state, fallback)` is the detail beginners miss. `advance()`
normally marks the user's message as consumed. Here, "I want to return the rain
jacket" is exactly the message `ReturnsNode` needs, and `ReturnsNode` reads a
different history space. `forwardInput` copies the latest `HumanMessage` across
and clears `inputConsumed`, so the target stage handles the same request in the
same turn instead of asking "how can I help?".

### 4.5 Per-stage model policy

Different stages have different failure costs, so they use different models:

| Node | Model | Rationale |
| --- | --- | --- |
| `TriageNode` | Graph default `gpt-4o`, `temperature: 0.3` | Conversational routing; wording variety is fine. |
| `ReturnsNode` | `gpt-5.1`, `reasoningEffort: "low"` | Must map free text onto exact line IDs and one reason code. |
| `ApprovalNode` | `gpt-5.1`, `reasoningEffort: "low"` | The gate that commits money gets the strongest model. |
| `BillingNode` | Graph default | Charge selection is validated against the ledger anyway. |
| `EscalateNode` | `gpt-4o` | Single structured extraction. |

Only the model metadata that *differs* from the graph default is written into
the session document, so per-node overrides stay visible during debugging.

---

## 5. Running nodes inside a single turn

This is the pattern most people reach for second and understand last.

### 5.1 The problem

When the customer says "it's too big", one turn has to do four things: capture
the request, apply the policy, decide who speaks next, and produce a reply. Only
the last of those is conversational. The middle two must be deterministic and
auditable.

### 5.2 The mechanism

A conversational node picks a **durable** resume point with `advance(...)` and a
**this-invocation** route with `.via(...)`:

```ts
// nodes/returns.node.ts
if (context.request) {
  // ApprovalNode is the safe resume point while adjudication is unknown.
  // AdjudicateNode runs first in this same turn and replaces it with the
  // node its own decision selects.
  return this.advance(ApprovalNode, conversation)
    .via(AdjudicateNode)
    .withState({ lastDenial: [] })
    .withStateFor(AdjudicateNode, { request: context.request });
}
```

`.withStateFor(AdjudicateNode, { request })` is the hand-off: `ReturnsNode`
writes into another node's local-state namespace, type-checked against that
node's declared local state.

The worker then corrects the resume point with `resumeAt(...)`, which records a
resume node **without** choosing the current invocation's route — the `branch()`
does that:

```ts
// nodes/adjudicate.node.ts
if (adjudication.decision === "deny") {
  return this.resumeAt(ReturnsNode, turn)
    .withState({ decision: "deny", adjudication })
    .withStateFor(ReturnsNode, { lastDenial: adjudication.reasons })
    .withHistory("support-returns", new HumanMessage(
      "The return request was refused by policy. Explain every reason in LastDenial plainly and offer what is still available.",
    ));
}
```

The `.withHistory(...)` call is a **nudge**: a synthetic `HumanMessage` posted
into the destination stage's history space so that when the stage runs later in
this same turn, it knows what job it just inherited.

### 5.3 `deterministicTurn()`

Every outcome builder records the conversation that produced it — messages and
token usage. `AdjudicateNode` never calls a model, and `EscalateNode` calls the
gateway directly rather than through the agent loop. Both still owe that record:

```ts
export function deterministicTurn(
  usage: TokenUsage = emptyTokenUsage(),
): ConversationRunResult {
  return { messages: [], usage, stoppedAfterTool: false };
}
```

`EscalateNode` passes real usage so the graph's token accounting stays complete
even though no conversational turn happened.

### 5.4 Worker A: `AdjudicateNode`, deterministic

It calls no model at all. `getPrompt()` exists only because `GraphNode` declares
it abstract, and says so:

```ts
/** Never sent to a model. This node is deterministic by design. */
getPrompt(_state: SupportGraphStateType): string {
  return "Deterministic return adjudication. No model turn is taken in this node.";
}
```

The `auto` path is the one that commits money without asking anyone:

```ts
const refund: RefundRecord = {
  rma: generateRma(),
  orderId: order.orderId,
  lineIds: request.lineIds,
  netRefund: quote.netRefund,
  refundTarget: quote.refundTarget,
  authority: "agent",
};
return this.resumeAt(TriageNode, turn)
  .withState({ decision: "auto", adjudication })
  .withStateFor(TriageNode, {
    refunds: [...(state.nodes.TriageNode?.refunds ?? []), refund],
  })
  .withStateFor(ReturnsNode, {
    returnedLineIds: [...returnedLineIds, ...request.lineIds],
  })
  .withHistory("support-triage", new HumanMessage(
    "A refund was just issued. Report the RMA number and net refund from Case, then ask what else the customer needs.",
  ));
```

Note `authority: "agent"` versus `authority: "customer_confirmed"` on the
approval path. The session document records *who* authorized every refund.

Because `mergeNodeStates` replaces array values rather than appending, appending
to `refunds` is an explicit read-then-concat. That is deliberate: array merge
semantics that "helpfully" append are a reliable source of duplicate records.

### 5.5 Worker B: `EscalateNode`, one structured call

This is the only node in the repository that uses `llmGateway.structured()` — a
single model call bound to a Zod schema, with no tool loop and no user-facing
text:

```ts
const draft = await this.llmGateway.structured(
  EscalationTicketDraft,
  this.getPrompt(state),
  JSON.stringify({ order: { /* ... */ }, dispute }),
  "escalation_ticket",
  this.llmConfig(),
  this.history(state),      // the billing transcript, via its history space
);

const ticket: EscalationTicket = {
  ...draft.value,
  // The ledger owns the disputed amount; the draft only describes it.
  amountInDispute: dispute.amountInDispute,
  ticketId: generateTicketId(),
  openedAt: new Date().toISOString(),
};
return this.resumeAt(TriageNode, deterministicTurn(draft.usage))
  .withState({ ticket })
  .withStateFor(TriageNode, {
    tickets: [...(state.nodes.TriageNode?.tickets ?? []), ticket],
  });
```

Read the `amountInDispute` line carefully. The schema *requires* the field, so
the model always produces one, and the node **overwrites it from the ledger
anyway**. Schema validation guarantees shape, never truth. The deterministic
test deliberately scripts a wrong draft amount and asserts the ledger value wins.

`EscalateNode` is reached by `BillingNode` with `.via(EscalateNode)`, and a fixed
edge `addEdge(EscalateNode, TriageNode)` returns control to the hub — so the
customer sees one reply, written by triage, naming the new ticket.

---

## 6. The human-in-the-loop approval gate

### 6.1 Why this is interesting

The canonical LangGraph approach to "let a human approve this tool call" needs a
checkpointer, `interrupt_before`, a thread configuration, and an explicit
`update_state()` call to resume. That is real machinery to configure, test, and
operate.

EZGraph already persists `currentNode` between requests. So the gate is just a
node that returns `stay()`:

```text
turn N     AdjudicateNode decides `review`
           -> ApprovalNode presents the breakdown, returns stay()
           -> invocation ends, currentNode = "ApprovalNode" is persisted
           -> HTTP response goes to the customer

  ...the customer thinks about it, closes the tab, comes back...

turn N+1   START dispatches on currentNode -> ApprovalNode
           -> "yes" -> confirm_refund -> committed
           -> "no"  -> decline_refund -> nothing committed, back to ReturnsNode
```

There is no checkpoint, no interrupt, no resume protocol. The pending action is
ordinary node local state.

### 6.2 What the gate holds

```ts
export type PendingRefund = {
  request: ReturnRequest;
  quote: RefundQuote;
  reasons: string[];
};
```

`AdjudicateNode` writes it with `withStateFor(ApprovalNode, { pending })`. Until
someone confirms, **nothing exists**: no RMA, no refund record, no line item
marked returned.

### 6.3 The prompt is a decision contract

[`prompt/approval.md`](../src/graphs/support-graph/prompt/approval.md) is written
as a three-way contract, not a persona:

- unambiguous yes -> `confirm_refund`
- unambiguous no, "not yet", "let me think", "change the items" -> `decline_refund`
- **anything else -> call neither tool**, answer from the breakdown, ask again

The third rule is the important one. A gate that guesses is not a gate. The
node reinforces it in code — `confirm_refund` rejects `confirmed: false` rather
than treating it as a decision:

```ts
@Tool("confirm_refund")
async confirmRefund({ confirmed }: ConfirmRefundInput, _context: ApprovalContext) {
  if (!confirmed) {
    return this.toolResult({
      accepted: false,
      error: "Only an explicit confirmation commits this refund.",
    });
  }
  return this.toolResult({ accepted: true }).withContext({ confirmed: true }).haltAfterBatch();
}
```

### 6.4 Quitting does not commit

```ts
// Quitting leaves the gate closed. The pending action is never committed
// by silence, only by an explicit confirmation.
if (conversation.quitRequested) return this.quit(conversation);
```

Ending the chat while a refund is pending abandons it. Section 8 shows how a
gate abandoned by *inactivity* is released too.

### 6.5 The numbers the customer sees are not written by the model

```ts
BREAKDOWN: GenReceipt.quoteTable(pending.quote),
```

`GenReceipt` renders a markdown table from the quote. The prompt instructs the
model to present it *exactly as given*, and the amounts in it were produced by
`PolicyEngine`, not by generation. If the model paraphrases a number wrong, the
live scenario test's judge fails that turn.

---

## 7. Follow one request end to end

Input: `"it is too big"`, session already verified and inside `ReturnsNode`.

**Superstep 1 — `ReturnsNode`.**
`GraphEngine` loads the session document, appends the `HumanMessage` to
`"support-returns"`, and dispatches `START` on `currentNode`.
`createContext()` reads the verified order. The agent loop runs; the model calls
`request_return({ lineIds: ["L1"], reason: "too_large" })`. The handler checks
`L1` is really on the order and was not already returned this session, patches
`context.request`, and halts the batch.
`nextStep()` returns `advance(ApprovalNode).via(AdjudicateNode)` and writes the
request into `AdjudicateNode`'s namespace.

**Superstep 2 — `AdjudicateNode`.**
Reached by the auto-route edge because `outcomeRoute` was set by `.via(...)`.
No model call. `PolicyEngine.adjudicate()` computes: delivered 12 days ago,
inside the 60-day apparel window, subtotal $289, no restocking fee, shipping not
refundable for `too_large` — net refund **$289**, which exceeds the $250 limit.
Decision `review`. It persists the decision, writes `pending` into
`ApprovalNode`, and nudges `"support-approval"`.

**Superstep 3 — routing.**
`graph.branch(AdjudicateNode, ...)` calls `route(state)` against the reduced
state, reads `"review"`, and routes to `ApprovalNode`.

**Superstep 4 — `ApprovalNode`.**
Its history space was empty, so it now contains just the nudge. The prompt
carries the rendered breakdown. The model presents the table, explains that
$289 exceeds the agent approval limit, and asks for an explicit yes or no. No
tool is called. `nextStep()` falls through to `stay(conversation)`.

**Persistence.** `currentNode` is saved as `"ApprovalNode"`, four history spaces
and six node states are serialized, token usage from every model call in the
turn is accumulated, and the response is returned with `completed: false`.

One HTTP request; four supersteps; two nodes talked to a model; one node
decided the money; nothing was committed.

---

## 8. Session policy with `onRestoreSessionDoc()`

`BaseGraph` applies a default expiration policy. Override the hook to replace it,
migrate a document, or reject a session. Returning `null` discards the session
and starts fresh for that ID.

SupportGraph overrides it for two reasons:

```ts
protected override async onRestoreSessionDoc(
  sessionDoc: SessionDocument<SupportGraphStateType>,
): Promise<SessionDocument<SupportGraphStateType> | null> {
  const modifiedAt = Date.parse(sessionDoc.modifiedAt);
  const idleMs = Number.isFinite(modifiedAt) ? Date.now() - modifiedAt : 0;
  if (idleMs >= readMs("SUPPORT_GRAPH_IDLE_MS", DEFAULT_IDLE_MS)) return null;

  const holdingApproval =
    sessionDoc.graph.currentNode === ApprovalNode.name &&
    idleMs >= readMs("SUPPORT_GRAPH_APPROVAL_HOLD_MS", DEFAULT_APPROVAL_HOLD_MS);
  if (!holdingApproval) return sessionDoc;

  const released: SupportGraphNodes["ApprovalNode"] = {
    ...sessionDoc.graph.nodes?.ApprovalNode,
    pending: undefined,
  };
  return {
    ...sessionDoc,
    graph: {
      ...sessionDoc.graph,
      currentNode: TriageNode.name,
      nodes: { ...sessionDoc.graph.nodes, ApprovalNode: released },
      histories: { ...sessionDoc.graph.histories, [APPROVAL_HISTORY_SPACE]: [] },
    },
  };
}
```

**Reason one: a support case is not a chat session.** The framework default is
short. A customer who opens the returns policy in another tab for ten minutes
should not lose a verified order. SupportGraph uses a 30-minute working window.

**Reason two: an unanswered irreversible action must not wait forever.** A gate
held past ten minutes is *released* — never auto-confirmed. The pending action is
dropped with the `undefined` deletion marker, the stale confirmation transcript
is cleared so it cannot be replayed, and `currentNode` is rewound to the hub.
The customer comes back to "how can I help?", not to a stale "confirm $289?".

Both windows are environment-tunable, and all three behaviors are unit tested in
[`support-graph.spec.ts`](../test/support-graph/support-graph.spec.ts):

```ts
it("releases an approval gate held past its hold window", async () => {
  const restored = await graph.restoreSessionDoc(heldApprovalSession(15 * 60_000));
  assert.equal(restored?.graph.currentNode, "TriageNode");
  assert.equal(restored?.graph.nodes?.ApprovalNode?.pending, undefined);
  assert.deepEqual(restored?.graph.histories["support-approval"], []);
});
```

---

## 9. Guardrails: three layers, and only one of them is the prompt

| Layer | Enforces | Failure mode if you skip it |
| --- | --- | --- |
| Zod schema | Shape and types of tool input | Malformed arguments crash the handler |
| Handler validation | The arguments refer to real, eligible domain objects | The model invents a line ID or charge ID |
| Deterministic backend | Eligibility and every amount | The model negotiates a refund |

Prompts influence behavior; they never enforce it. Three concrete examples:

**Hallucinated identifiers are rejected, in the handler.**

```ts
const unknown = selected.filter((lineId) => !known.has(lineId));
if (unknown.length > 0) {
  return this.toolResult({
    accepted: false,
    error: `These line items are not on order ${context.order.orderId}: ${unknown.join(", ")}.`,
  });
}
```

**Model arithmetic is a hint, not an input.** `BillingNode.open_dispute` accepts
an `amountInDispute` argument and then ignores it:

```ts
// The ledger owns the arithmetic. A model-supplied total is only a hint.
const ledgerAmount = round(
  selected.reduce((total, id) => total + (ledger.get(id)?.amount ?? 0), 0),
);
```

When the two disagree, the tool result *tells the model it was corrected*, so
the eventual reply to the customer is consistent with the ledger.

**Illegal state transitions are refused.** `close_case` will not close a case
with no committed outcome, and `request_return` will not resubmit a line item
already returned in this conversation.

---

## 10. Run SupportGraph locally

```bash
cp .env.example .env       # set OPENAI_API_KEY
npm run start
```

Every registered graph is served by the shared controller. Send `graphName` in
the body and carry the `SESSION_ID` header between turns:

```bash
curl -s localhost:8000/ai/run \
  -H 'content-type: application/json' \
  -d '{"graphName":"SupportGraph","message":"Hi, I need help with an order"}' -i
```

The response body is `{ success, completed, message, bot, session }` and the
`SESSION_ID` header carries the session forward:

```bash
curl -s localhost:8000/ai/run \
  -H 'content-type: application/json' \
  -H "SESSION_ID: <session-from-previous-response>" \
  -d '{"graphName":"SupportGraph","message":"NW-100412, dana.whitfield@example.com"}'
```

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `SUPPORT_GRAPH_CURRENT_DATE` | Freezes "today" so return windows and amounts are repeatable. |
| `SUPPORT_GRAPH_IDLE_MS` | Session working window (default 30 minutes). |
| `SUPPORT_GRAPH_APPROVAL_HOLD_MS` | How long an approval gate is held (default 10 minutes). |
| `SESSION_STORE` | `memory`, `sqlite`, `mongodb`, or `cosmos`. |

To inspect what was persisted, read the session document:
`GraphEngine.getSession<SupportGraphStateType>(sessionId)`.

---

## 11. Testing: prove orchestration before prompt quality

### Layer 1 — deterministic, no network

[`support-graph.spec.ts`](../test/support-graph/support-graph.spec.ts) supplies a
hand-written `LlmGateway` and drives the graph directly. The fake decides what
to "say" from the tools currently visible, which is a reliable proxy for which
stage is active:

```ts
async agent(_systemPrompt, history, tools, config) {
  const names = new Set(tools.map(({ name }) => name));
  if (names.has("verify_order"))    return this.triage(history, input, active);
  if (names.has("request_return"))  return this.returns(input, active);
  if (names.has("confirm_refund"))  return this.approval(input, active);
  if (names.has("open_dispute"))    return this.billing(input, active);
  throw new Error(`Unexpected support stage for input '${input}'.`);
}
```

Seven tests cover all three adjudication branches, both approval answers, the
escalation path, and the session policy. They assert **state and routing**, not
wording:

```ts
state = await invoke(graph, state, "it is too big");
assert.equal(state.nodes.AdjudicateNode?.decision, "review");
assert.equal(state.currentNode, "ApprovalNode");
assert.equal(state.nodes.ApprovalNode?.pending?.quote.netRefund, 289);
assert.equal(state.nodes.TriageNode?.refunds, undefined);   // nothing committed
```

That last assertion is the whole gate, in one line.

### Layer 2 — live semantic evaluation

[`support-graph.scenario.json`](../test/support-graph/support-graph.scenario.json)
declares nine turns with expected *behavior*, not expected text.
[`support-graph.e2e.spec.ts`](../test/support-graph/support-graph.e2e.spec.ts)
replays them through the real HTTP surface and grades each reply with a judge
model, then asserts the final session document.

The scenario is designed so that a passing run proves the money rules held:

| Turn | Proves |
| --- | --- |
| approval gate presents the breakdown | `$289.00` is stated, no RMA is given |
| declining leaves nothing committed | no refund appears despite an approval having been offered |
| auto approved refund is reported | `$136.00` and an `RMA-######` are reported |
| escalation ticket opened | an `ESC-#####` is given with no promise of a credit |

```ts
// The declined $289 refund must never have been committed.
const refunds = session.graph.nodes.TriageNode?.refunds ?? [];
assert.equal(refunds.length, 1);
assert.equal(refunds[0]?.netRefund, 136);
```

Run them:

```bash
npm run test:support-graph     # deterministic
npm run test2:support-graph    # live, needs OPENAI_API_KEY
```

### Layer 3 — the compile-time contract

`branch()` route labels are checked by `tsc`, so `npm run typecheck` is a real
topology test. A `route()` return type and its destination map cannot drift apart.

---

## 12. Extend it: add a warranty specialist

Adding a stage is five mechanical steps.

**Step 1 — give it owned state.** In
[`support-graph.state.ts`](../src/graphs/support-graph/support-graph.state.ts):

```ts
WarrantyNode?: NodeStateValue<{ claim?: WarrantyClaim; lastDenial?: string[] }>;
```

**Step 2 — write the node.** Copy `BillingNode`'s shape: `getPrompt`,
`defineTool`, `@Tool` handlers that validate against the order, `createContext`,
and a `nextStep` that covers incomplete input, success, quit, and going back.

**Step 3 — teach the hub about it.** Add `"warranty"` to the `route_request`
enum, add a routing rule to
[`prompt/triage.md`](../src/graphs/support-graph/prompt/triage.md), and add a
branch to `TriageNode.nextStep`:

```ts
if (context.department === "warranty") {
  return this.advance(WarrantyNode, conversation)
    .withState(this.snapshot(context))
    .forwardInput(state, "Start a warranty claim for this order.");
}
```

**Step 4 — register every runtime relationship.** All four are required:

```ts
historySpaces: [ /* ... */ [WarrantyNode, "support-warranty"] ],
graph.registerTurnNodes(/* ... */ WarrantyNode, TerminateSessionNode);
```

Plus the return path — `advance(TriageNode).withHistory("support-triage", ...)`
in the node itself.

**Step 5 — extend both test layers.** Add a stage arm to the scripted gateway
(`if (names.has("submit_claim")) ...`), assert the new state and routing, then
add scenario turns for the live run.

If the new stage needs a deterministic decision, reuse the section 5 pattern:
`advance(NextStage).via(WarrantyAdjudicateNode)`, a `route()` returning a small
union, and a `graph.branch(...)`.

---

## Common pitfalls

### Confusing the three kinds of "end"

`stay()` routes to LangGraph `END`. That is the normal yield between user turns
and does not complete anything. Only `finish(...)` sets `completed: true`.

### Registering a worker node as a turn node

If `AdjudicateNode` appeared in `registerTurnNodes(...)`, a user message could
resume the session directly inside the adjudicator, with no pending request in
state. Worker nodes get `nodes(...)` and edges only.

### Expecting tool context to persist

`context.department`, `context.confirmed`, and `context.request` all vanish when
the turn ends. Every value that must survive needs `withState` or
`withStateFor` on the outcome.

### Forgetting the history nudge on a cross-stage handoff

A stage entered mid-turn reads a history space that may be empty or may end with
an old assistant message. Either `forwardInput(...)` (the user's own message is
the right input) or `withHistory(space, new HumanMessage(...))` (the stage
inherited a job). Choosing neither produces a stage that greets the customer
instead of doing its work.

### Treating a schema as a truth guarantee

`EscalationTicketDraft` requires `amountInDispute`, so the model always supplies
one — and it can still be wrong. Anything authoritative must be recomputed from
the domain backend after validation.

### Letting the model decide eligibility

If a prompt says "approve returns under $250", the model *will* eventually
approve $260. Decisions belong in `PolicyEngine`, where they are testable.

### Auto-confirming a stale gate

Timing out an approval must release it, never commit it. `onRestoreSessionDoc()`
clears `pending` and rewinds to the hub.

### Appending to a state array by returning only the new item

`mergeNodeStates` replaces arrays. `refunds: [refund]` silently discards earlier
refunds. Always read then concat.

### Letting time make tests nondeterministic

`PolicyEngine.today()` falls back to `new Date()`. Pin
`SUPPORT_GRAPH_CURRENT_DATE` whenever a window or an amount is asserted.

### Treating the demo refund as a real one

`generateRma()` and `generateTicketId()` produce random in-memory identifiers.
There is no payment processor, no idempotency key, and no ticketing system. A
production `confirm_refund` should perform an idempotent external transaction and
persist the authoritative reference *before* returning its outcome.

---

## Design checklist

Before merging a SupportGraph change, confirm that:

- every amount and every eligibility decision still comes from `PolicyEngine`;
- tool handlers validate identifiers against the order, not against the prompt;
- `conversation.quitRequested` is checked before any domain success;
- `stay(...)` always has a non-empty response;
- cross-node writes use `withStateFor`, and committed outcomes land on the hub;
- every stage transition deliberately chooses `forwardInput` or `withHistory`;
- a new node appears in history spaces, node registration, resume registration,
  and topology — all four;
- worker nodes are registered with `nodes(...)` and never as resume points;
- `branch()` destinations still match the `route()` return type (`npm run typecheck`);
- nothing irreversible can be committed by silence, ambiguity, or a timeout;
- deterministic tests prove routing and state before the live test judges prompts.

SupportGraph's central design rule: **the model decides what the customer
wants; the policy engine decides what the business does; the graph decides who
speaks next.** Keeping those three separate is what makes an agent that touches
money reviewable.
