# DemoGraph developer guide

`DemoGraph` is the broadest EZGraph tutorial in this repository. It combines a
durable, multi-turn conversation with typed tools, isolated histories,
application state, semantic outcomes, graph-level fan-out, a join, and explicit
in-node concurrency. Start here when building an intake or onboarding workflow
whose next question depends on previously accepted data.

The other examples specialize the same framework in different directions:

- [HotelGraph developer guide](hotel-graph-developer-guide.md) covers a
  conversational search, comparison, and booking workflow that can move back
  and forth between stages.
- [InvoiceGraph developer guide](invoice-graph-developer-guide.md) covers a
  single-request, multimodal extraction graph that returns JSON rather than a
  chat envelope.
- [SupportGraph developer guide](support-graph-developer-guide.md) covers a
  hub-and-spoke agent with in-turn worker nodes, an explicit typed `branch()`,
  and a human-in-the-loop approval gate.

The implementation discussed below is in
[`src/graphs/demo-graph`](../src/graphs/demo-graph/). Its deterministic end-to-end
spec is
[`test/e2e/chat.e2e.spec.ts`](../test/e2e/chat.e2e.spec.ts#L15).

## Start here: the custom-graph authoring contract

Build a custom graph in this order: define the durable state, declare the
graph policy and topology, then give every node one clear lifecycle. The graph
owns *where work goes*; a node owns *what happens at that stage*. Keeping that
boundary is what makes a multi-turn graph understandable and testable.

### 1. Define state and the graph shell

Choose the initial conversational node, create the shared state annotation,
and extend `BaseGraph`. The graph definition sets model defaults, the terminal
state, and the history space belonging to each conversational stage. In
`buildGraph()`, register every node before adding edges; only conversational
nodes that may receive a later HTTP request belong in `registerTurns(...)`.

```ts
export const ProfileState = createGraphStateAnnotation(CollectNameNode.name);
export type ProfileStateType = typeof ProfileState.State;

export class ProfileGraph extends BaseGraph<typeof ProfileState.State> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("google:gemini-3.1-flash-lite", { retries: 3 }),
      endNode: GRAPH_END_NODE,
      historySpaces: [[CollectNameNode, "profile"]],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, ProfileGraph.getGraphDefinition());
  }

  protected buildGraph() {
    const graph = this.createStateGraph(ProfileState);
    graph.nodes(CollectNameNode, NormalizeNameNode, TerminateSessionNode);
    graph.registerTurns(CollectNameNode, TerminateSessionNode);
    graph.autoRouteOutcomes();
    graph.addEdge(NormalizeNameNode, END);
    graph.addEdge(TerminateSessionNode, END);
    return graph.compile();
  }
}
```

Conversation graphs have three topology contracts. `registerTurns(...)` defines which
nodes may receive a later user request. `autoRouteOutcomes()` routes standard
`stay()`, `advance()`, `quit()`, and `finish()` outcomes. `addEdge()` connects
unconditional internal work such as workers, fan-out, joins, and terminal edges.
`branchBy(...)` remains the lower-level explicit-routing API.

### 2. Choose the node lifecycle deliberately

There are two node styles. They are not “LLM node versus non-LLM node.” Both
can call a model and define tools. The distinction is who owns the turn
lifecycle.

| Use this base class | Use it when | Developer responsibilities | Why |
| --- | --- | --- | --- |
| `ConversationNode` | A user-facing stage can ask, wait, accept tools, and decide whether another user turn is needed. | Implement `getPrompt`, `createContext`, optional `defineTool` and `@Tool` handlers, and `nextStep`. | The framework owns the model/tool loop, histories, and `terminate_session`; the node supplies domain policy. |
| `GraphNode` | An internal/worker step should run as part of the current invocation, or it needs complete control of its own execution. | Implement `getPrompt` and `run`; optionally call `runConversation`, make direct gateway calls, or perform deterministic work. Return a `GraphNodeUpdate`. | The node controls exactly when work runs and how its result becomes state. |

“Internal” does not mean a child object is nested inside another class. It
means topology invokes the `GraphNode` after another node. `FooLogicNode`, the
parallel children, and `InContextNode` are examples in this graph.

### 3. Implement a conversational stage

For a normal interactive stage, do **not** override `run()`. The base class
performs this lifecycle:

```text
load durable state
  -> createContext(state)        // fresh, per-turn working data
  -> run model/tool loop
  -> tool handlers update context or return typed effects
  -> nextStep(state, context, conversation)
  -> persist one outcome and let graph topology route it
```

Your required hooks have distinct jobs:

```ts
class CollectNameNode extends ConversationNode<
  ProfileStateType,
  { name?: string },              // durable state owned by this node
  { name?: string }               // transient context for one turn
> {
  getPrompt(_state: ProfileStateType) {
    return "Collect the user's full name with the save_name tool.";
  }

  createContext(state: ProfileStateType) {
    return { name: this.state(state).name };
  }

  defineTool() {
    return [
      {
        name: "save_name",
        description: "Save a full name",
        schema: z.object({ name: z.string().min(1) }),
      },
    ];
  }

  @Tool("save_name")
  saveName(input: { name: string }, context: { name?: string }) {
    return this.toolResult({ accepted: true }).withContext({
      name: input.name.trim(),
    });
  }

  nextStep(_state: ProfileStateType, context: { name?: string }, conversation: ConversationNodeRunResult) {
    return context.name
      ? this.finish(`Saved ${context.name}.`, conversation).withState(context)
      : this.stay(conversation).withState(context);
  }
}
```

`createContext()` must return a fresh object. It is safe for tools to enrich
that object during this one model/tool loop, but it is discarded afterwards.
Use `withContext(...)` for typed tool effects and `withState(...)` in
`nextStep()` to make accepted values durable. `nextStep()` is the domain
decision point: it chooses `stay`, `advance`, `quit`, or `finish`, rather than
leaking route strings or LangGraph mechanics into a prompt or tool.

### 4. Implement an internal worker node

Use `GraphNode` for a deterministic transformation, a one-shot direct model
call, or a custom agent loop. Its `run()` method is the lifecycle boundary:

```ts
class NormalizeNameNode extends GraphNode<ProfileStateType, { normalized?: string }> {
  getPrompt() {
    return "Unused by this deterministic node.";
  }

  run(state: ProfileStateType): GraphNodeUpdate<ProfileStateType> {
    void state;
    return this.save({ normalized: "NORMALIZED WORKER RESULT" });
  }
}
```

When a worker needs tools, it creates its own context inside `run()`, calls
`runConversation(state, context)`, and returns `stay`, `advance`, `finish`, or
a direct update itself. `InvoiceGraph` demonstrates this lower-level pattern.

### 5. Keep ownership and routing separate

- Persist only durable domain values with `save`, `withState`, or
  `withStateFor`; never mutate `state` in place.
- Put a node in a named history space when it has an independent conversation
  with the model. Pass values explicitly when stages need each other’s data.
- Let `nextStep()` return the durable outcome and let `autoRouteOutcomes()`
  route it. A `stay()` outcome ends the invocation while preserving the node
  for the next request.
- Test every decision: incomplete input stays, accepted input advances or
  finishes, `terminate_session` quits, and any worker updates are present on the next
  stage.

## What the graph does

The user supplies weather cities, favorites, a name, a date of birth, and an
address over several HTTP requests. Between those conversational stages the
graph performs internal work that is never presented as another user question.

```text
                                 ┌──────────────────────┐
                                 │ user asks to stop    │
                                 ▼                      │
Weather ─► FooLogic ─► GooLogic ─► Favorites ─► Name ──┤
   │                                      │            │
   │ stay                                 │ stay       ▼
   └──────── end this invocation          │         Quit ─► END
                                          ▼
                                      InContext
                                          │
                                          ▼
                                      Parallel
                                      /      \
                                  Child1    Child2
                                      \      /
                                         DOB
                                          │
                                       Address
                                          │ finish
                                          ▼
                                 ManualConcurrent ─► END
```

`END` in this diagram is LangGraph's end-of-invocation marker. Reaching it after
`stay(...)` merely yields a response and waits for the next HTTP request. A
conversation is terminal only when state has `completed: true` and
`currentNode: GRAPH_END_NODE`.

## Tour of every node

The topology is defined in
[`demo-graph.ts`](../src/graphs/demo-graph/demo-graph.ts#L23). Each class has one
substantial responsibility:

| Node | Kind | Durable local state | Role and outcome |
| --- | --- | --- | --- |
| `WeatherNode` | `ConversationNode` | `weather` | Calls `getCityTemperature`; stays until LA and NYC are present, advances to `FavoritesNode`, or quits. |
| `FooLogicNode` | `GraphNode` | `fooData` | Demonstrates a synchronous non-LLM state update. |
| `GooLogicNode` | `GraphNode` | `gooData` | Demonstrates another fixed internal step. |
| `FavoritesNode` | `ConversationNode` | partial `favorites` | Accumulates color, movie, and season over multiple turns, then advances to `NameNode`. |
| `NameNode` | `ConversationNode` | `name` | Rejects `John Doe`, accepts another full name, then advances to `InContextNode`. |
| `InContextNode` | lower-level `GraphNode` | `movieIdea` | Runs the shared agent/tool loop directly to generate structured internal enrichment, then calls `resumeAt(DobNode, ...)` to set the next user-facing stage. |
| `ParallelNode` | `GraphNode` | none | Empty fan-out point for two concurrent graph branches. |
| `Child1Node` | `GraphNode` | `joke` | Makes one direct model call on the first branch. |
| `Child2Node` | `GraphNode` | `joke` | Makes one direct model call on the second branch. |
| `DobNode` | `ConversationNode` | `jokes`, `dob` | Reads both joined child results, validates a real calendar date, and advances to `AddressNode`. |
| `AddressNode` | `ConversationNode` | `address` | Validates a US address and calls `finish(...)` when accepted. |
| `ManualConcurrentNode` | `GraphNode` | `task` | Runs four direct model calls with `Promise.all` after the final response has been composed but before the HTTP request returns. |
| `TerminateSessionNode` | framework `GraphNode` | none | Produces a polite terminal response after any conversational stage handles `terminate_session`. |

Use `ConversationNode` when a stage participates in the normal agent/tool loop
and may wait for another user turn. Use `GraphNode` when the node needs direct
control over generation or performs deterministic/internal work.

## 1. Define the graph contract and state

[`demo-graph.state.ts`](../src/graphs/demo-graph/demo-graph.state.ts) creates the
standard state channels and makes `WeatherNode` the initial resume node:

```ts
export const DemoGraphState = createGraphStateAnnotation(WeatherNode.name);
export type DemoGraphStateType = typeof DemoGraphState.State;
```

The resulting state contains:

| Field | Meaning |
| --- | --- |
| `currentNode` | Node that receives the next request. |
| `histories` | LangChain messages partitioned by named history space. |
| `nodes` | Durable local state keyed by node class name. |
| `config` | Session/request configuration supplied through the API. |
| `tokens` | Cumulative normalized usage from every model call. |
| `inputConsumed` | Whether the current user input has already been handled. |
| `response` | User-visible response for this invocation. |
| `completed` | Whether future turns must be rejected as already complete. |

The reducers matter. History updates append messages, token updates add usage,
and node-state patches shallow-merge independently under each node name. A
property set to `undefined` in a local-state patch is deleted. Do not mutate the
persisted `state` object in place; return an update or use an outcome builder.

The graph definition declares shared runtime policy:

```ts
static getGraphDefinition(): GraphDefinition {
  return {
    llmConfig: ModelCatalog.model("google:gemini-3.1-flash-lite", {
      retries: 3,
      temperature: 0.2,
    }),
    endNode: GRAPH_END_NODE,
    maxAgentRounds: 8,
    historySpaces: [
      [WeatherNode, "default"],
      [FavoritesNode, "favorites"],
      [NameNode, "name"],
      [InContextNode, "isolated"],
      [DobNode, "dob"],
      [AddressNode, "address"],
      [TerminateSessionNode, "terminal"],
    ],
  };
}
```

The definition also owns the rest of the conversation policy, so the shared
agent loop holds no provider-specific behavior:

| Field | Default | Purpose |
| --- | --- | --- |
| `maxAgentRounds` | `8` | Sequential model↔tool rounds in one node invocation. |
| `llmTimeoutMs` | unbounded | Wall-clock budget for one model request. Applied per attempt, so a retrying `llmConfig` spends it once per try. |
| `emptyHistorySeed` | `"Start"` | Message that seeds a newly entered history space, because some providers reject a system-only request. `null` sends the system prompt alone. |
| `emptyResponseRecovery` | 2 retries + nudge | Retry policy for an *unexplained* empty model turn (Gemini can emit one after a file attachment). `null` accepts the empty turn as final. |

A timeout surfaces as a normal turn failure naming the model and the budget, so
it is recorded in the session document like any other provider error. Nodes that
call the gateway directly can forward the same policy with
`this.llmCallOptions()`, which every `LlmGateway` method accepts as its trailing
`LlmCallOptions` argument alongside an optional `signal`.

### Empty model responses

A turn with neither text nor a tool call is not always the same event, so
`emptyResponseRecovery` is not applied blindly. The framework first reads the
provider's own reason out of the message metadata — Gemini's `finishReason`,
OpenAI's `finish_reason`, Anthropic's `stop_reason`, or a Gemini
`promptFeedback.blockReason` — and maps it to a provider-neutral category:

| Category | Provider reasons | Nudge? |
| --- | --- | --- |
| `blocked` | `SAFETY`, `content_filter`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `refusal` | No. Retrying re-trips the same filter. |
| `truncated` | `MAX_TOKENS`, `length` | No. The output hit a token cap. |
| `malformed_tool_call` | `MALFORMED_FUNCTION_CALL` | Yes. A retry can produce a valid call. |
| `complete` | `STOP`, `end_turn`, `tool_use` | Yes. The empty body is the model's own choice. |
| `unspecified` | `OTHER`, `FINISH_REASON_UNSPECIFIED`, or no metadata at all | Yes. This is the case the nudge exists for. |

Every empty turn records a session warning naming the category and the raw
provider value, so a filtered conversation is diagnosable rather than looking
like a silent retry loop.

Once retries are exhausted or the reason rules them out, the node decides what
the user sees. `onEmptyModelResponse` receives the classified reason and returns
the replacement text; the default throws `EmptyModelResponseError` rather than
answering with an empty message:

```typescript
// ExploreNode
protected override onEmptyModelResponse(
  context: EmptyModelResponseContext<HotelGraphStateType>,
): string | Promise<string> {
  if (context.reason.category === "blocked") {
    return "I can't help with that request, but I can still find you a hotel. What city and dates are you looking at?";
  }
  return super.onEmptyModelResponse(context);
}
```

Delegating to `super` for the categories the node does not recognize keeps a
truncated or unexplained empty turn a loud failure instead of silently
answering with the safety copy.

`WeatherNode.getLlmConfig()` returns a complete, statically checked
`google:gemini-3.5-flash` configuration. Parameter-only overrides use
`{ params: { ... } }` and retain the selected model.

`FavoritesNode` demonstrates the complete provider-extension path. First, the
application registers a provider that EZGraph and LangChain do not know:

```ts
export const AppModelProviders = ModelProviderRegistry.create().register("glm", {
  initialize({ model, options }) {
    const apiKey = process.env.GLM_API_KEY;
    if (!apiKey) throw new Error("GLM_API_KEY is required.");
    const baseURL = process.env.GLM_BASE_URL || "https://api.z.ai/api/paas/v4";
    return {
      model,
      options: {
        modelProvider: "openai",
        ...options,
        apiKey,
        configuration: { baseURL },
      },
      cacheKey: JSON.stringify({ provider: "glm", model, baseURL, options }),
    };
  },
});
```

GLM supports the OpenAI protocol, so the adapter reuses LangChain's OpenAI
integration while retaining `glm` as EZGraph's provider identity. The JSON
catalog then declares the provider parameters and model:

```json
{
  "version": 1,
  "profiles": {
    "glm.chat": {
      "provider": "glm",
      "family": "chat",
      "paramsSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["retries"],
        "properties": {
          "retries": { "type": "integer", "minimum": 0 },
          "temperature": { "type": "number" }
        }
      },
      "parameterMappings": {
        "retries": "maxRetries",
        "temperature": "temperature"
      }
    }
  },
  "models": {
    "glm:glm-5.1": {
      "profile": "glm.chat"
    }
  }
}
```

[`app-model-catalog.ts`](../src/config/app-model-catalog.ts) reads and validates
that document once during application startup and receives the provider
registry explicitly. Favorites then uses the branded runtime configuration:

```ts
getLlmConfig(): GraphLlmConfigOverride {
  return AppModelCatalog.model("glm:glm-5.1", {
    retries: 3,
    temperature: 0.2,
  });
}
```

Persisted session metadata uses `glm:glm-5.1`. Invalid parameters and
unregistered provider IDs throw before provider initialization. The API key and
endpoint stay in application configuration and are never persisted model
parameters.

## 2. Register nodes, resumption, and topology

`buildGraph()` follows three steps:

1. Register every node class with `graph.nodes(...)`.
2. Register every possible user-turn entry point with `graph.registerTurns(...)`.
3. Connect registered nodes and compile.

Registration constructs each node, registers its tool definitions, rejects
duplicate tool names and handlers, and verifies that every decorated handler
refers to a registered tool. Handler signatures and unhandled definitions
still rely on TypeScript and tests; graph compilation does not validate them.
`registerTurns(...)` creates the special `START` branch that dispatches a later request
using persisted `currentNode`. Internal-only nodes such as `FooLogicNode` and
`Child1Node` are connected in the topology but are not user-turn resume points.

### The three-part graph contract

The persisted resume target and the immediate destination can differ when an
outcome uses `.via(...)`:

```ts
return this.advance(FavoritesNode, conversation)
  .via(FooLogicNode)
  .withState({ weather });
graph.autoRouteOutcomes();
graph.addEdge(FooLogicNode, GooLogicNode);
graph.addEdge(GooLogicNode, FavoritesNode);
```

After `WeatherNode` calls `advance(FavoritesNode, conversation)`, state says the
next durable conversational stage is `FavoritesNode`. The current invocation,
however, first executes `FooLogicNode` and `GooLogicNode`, then enters
`FavoritesNode` and obtains its opening question. If Weather stays, its
`currentNode` is still `WeatherNode`, no case matches, and `otherwise: END`
yields the current reply.

Normal direct outcomes do not need graph-level cases. `advance(NameNode)` routes
to `NameNode`, `quit()` routes to `TerminateSessionNode`, and `stay()` ends the
current invocation while preserving the current node. Use `branchBy()` only
when explicit conditional topology is required.

The Address branch demonstrates a second useful variation:

```ts
return this.finish(conversation.response ?? "", conversation)
  .via(ManualConcurrentNode)
  .withState({ address: context.address });
graph.autoRouteOutcomes();
graph.addEdge(ManualConcurrentNode, END);
```

`AddressNode.finish(...)` marks the application conversation complete, but the
same invocation can still perform internal follow-up work in
`ManualConcurrentNode` before LangGraph reaches `END`.

## 3. Follow one session through the graph

Understanding a few transitions is more useful than memorizing the diagram.

### Weather stays

On an initial `"Hi"`, `WeatherNode` has no accepted cities. Its agent produces a
question and the node returns `stay(conversation)`. The outcome stores the reply,
history, tokens, `inputConsumed: true`, and `currentNode: "WeatherNode"`. The
Weather branch falls through to `END`, so the API returns while the session
remains resumable at Weather.

### Weather advances and internal nodes run

When the user supplies LA and NYC, the model can issue both temperature tool
calls in one assistant-message batch. Once both effects are applied,
`WeatherNode` advances to `FavoritesNode`. `FooLogicNode` and `GooLogicNode` run,
then Favorites sees `inputConsumed: true`: it knows the previous input belonged
to Weather and asks a new question instead of treating `"LA and NYC"` as a
favorite answer.

The same pattern advances from Favorites to Name. Partial favorites use `stay`,
so values such as a color and movie can be collected over separate requests.

### Accepted name triggers enrichment and fan-out

An accepted name advances to `InContextNode`. That node records a structured
movie idea and calls `resumeAt(DobNode, ...)` to set `DobNode` as the durable
next user-facing stage. Its fixed edge enters `ParallelNode`, which starts both
child branches. The joined state then enters `DobNode`, where the user receives
the next question.

### Address finishes

An invalid address stays at Address. A valid address lets the runner produce a
final confirmation, and `finish(...)` stores that response, sets
`currentNode: GRAPH_END_NODE`, and sets `completed: true`. The graph performs its
manual concurrent follow-up before saving the terminal session.

### Quit is a graph path, not session deletion

All `ConversationNode` subclasses inherit an `terminate_session` handler. If the model
calls it, `conversation.quitRequested` becomes true. Nodes check that flag before
domain success and return `quit(conversation)`, which targets the shared
`TerminateSessionNode`. Quit generates a polite response and completes the graph.

By contrast, `POST /ai/end` deletes the session document. It is an operational
reset, not the conversational quit path.

## 4. Build a conversational node

[`WeatherNode`](../src/graphs/demo-graph/nodes/weather.node.ts#L14) is the most
complete example of the current semantic API.

### Declare three separate types

```ts
type WeatherNodeState = { weather?: Record<string, number> };
type WeatherToolContext = { weather: Record<string, number> };

class WeatherNode extends ConversationNode<
  DemoGraphStateType,
  WeatherNodeState,
  WeatherToolContext
> {
  // ...
}
```

- Graph state is the shared workflow state.
- Node state is the durable state stored under `nodes.WeatherNode`.
- Tool context is a mutable-per-turn working value. It is discarded unless the
  final outcome persists selected values with `.withState(...)`.

`createContext()` copies durable values into the new turn. Copy
nested objects so speculative tool effects do not mutate restored session state.

### Define and handle a typed tool

```ts
defineTool(): readonly ToolDefinition<{ city: string }>[] {
  return [{
    name: "getCityTemperature",
    description: "Return the demo temperature for LA or NYC.",
    schema: z.object({ city: z.string() }),
  }];
}

@Tool("getCityTemperature")
async getCityTemperature(
  { city }: { city: string },
  context: WeatherToolContext,
): Promise<ConversationToolResult> {
  const normalized = city.trim().toUpperCase();
  const temperature = normalized === "LA" ? 72
    : normalized === "NYC" ? 83
    : null;
  const weather = { ...context.weather };
  if (temperature !== null) weather[normalized] = temperature;

  return this.toolResult({ temperature })
    .withContext({ weather })
    .stopAfterBatchWhen(this.hasBothCities(weather));
}
```

The Zod schema validates model-supplied arguments before the handler runs. The
object passed to `toolResult(...)` becomes the model-visible `ToolMessage`.
`.withContext(...)` is a typed control effect and is not itself exposed to the
model. Effects are applied in tool-call order after each handler returns.

`stopAfterBatchWhen(...)` means “execute every tool call in this assistant
message, append every tool result, and then stop before another model turn if
the condition is true.” This is why a two-call LA/NYC batch cannot lose the
second call. If the condition is false, the agent continues and can formulate a
user-facing reply.

Prefer this immutable tool-result form in new code. Directly mutating a
per-turn context, as some smaller demo nodes do, is supported but makes the
model-visible output, control effect, and stopping decision less explicit.

Additional tool-result modifiers are:

- `.withMessages(...)` for additional model-visible messages;
- `.withCleanup(...)` for releasing temporary resources after the next model
  turn, when a stopped batch returns, or when the runner encounters an error;
- `.haltAfterBatch()` for an unconditional stop.

### Select exactly one turn outcome

`ConversationNode.run()` owns the agent loop. The subclass only creates context
and selects the semantic result:

```ts
protected nextStep(
  _state: DemoGraphStateType,
  context: WeatherToolContext,
  conversation: ConversationNodeRunResult,
): GraphNodeUpdate<DemoGraphStateType> {
  const { weather } = context;
  if (conversation.quitRequested) {
    return this.quit(conversation).withState({ weather });
  }
  if (this.hasBothCities(weather)) {
    return this.advance(FavoritesNode, conversation).withState({ weather });
  }
  return this.stay(conversation).withState({ weather });
}
```

Always give an explicit quit request priority over a domain transition. A model
may call more than one tool in a batch.

### Outcome reference

| Helper | Use it when | Framework guarantees |
| --- | --- | --- |
| `stay(conversation, response?)` | This node needs another user turn. | Keeps this node active, requires a non-empty response, consumes input, and records messages and tokens. |
| `advance(Target, conversation)` | This turn completed and another stage should run or resume. | Sets `currentNode` to `Target`, clears the response, consumes input, and records messages and tokens. |
| `resumeAt(Target, conversation)` | An internal `run()` completed model/tool work and needs to name the next user-facing stage. | Sets `currentNode` to `Target`, clears the response, consumes input, and records messages and tokens without choosing the current invocation's route. |
| `quit(conversation)` | The inherited `terminate_session` tool was called. | Targets `TerminateSessionNode`; input forwarding is intentionally unavailable. |
| `finish(response, conversation)` | The entire application workflow is complete. | Stores the final response, terminal node, completion flag, messages, and tokens. |

All four return immutable builders supporting:

```ts
.withState({ ... })
.withStateFor(AnotherNode, { ... })
.withHistory("another-space", message)
```

Only `advance(...)` can call `.forwardInput(state, fallback?)`. Use it when the
same human message intentionally belongs to the next node too. It sets
`inputConsumed: false` and copies the latest `HumanMessage` when source and
target use different histories. DemoGraph deliberately does not forward input:
each accepted answer should trigger a fresh question from the next stage.

`stay(...)` and `finish(...)` require a response. If a tool stops the runner
before it produces one, either advance/quit or supply an intentional response;
do not manufacture an empty chat message.

## 5. Keep histories stage-specific

History spaces are not labels for reporting; they determine exactly which
messages a node sends back to the model.

| History | Nodes in DemoGraph | Purpose |
| --- | --- | --- |
| `default` | Weather and unmapped nodes | Weather conversation and the default fallback. |
| `favorites` | Favorites | Prevent weather answers from becoming favorite values. |
| `name` | Name | Keeps name validation and retries together. |
| `isolated` | InContext | Gives internal movie generation a clean context. |
| `dob` | DOB | Isolates date collection. |
| `address` | Address | Isolates address collection. |
| `terminal` | Quit | Keeps the cancellation response separate. |

When `GraphEngine` receives a request, `BaseGraph.prepareInput()` appends the new
`HumanMessage` to the history for the restored `currentNode`. The active node
reads and updates only that space. The E2E spec verifies that `"blue"` appears in
the favorites history while `"LA and NYC"` remains in the default history, and
that Address never receives the initial `"Hi"` as model context.

A fresh history receives a neutral `"Start"` crossing message because Gemini
cannot process a system-only request. Treat it as framework plumbing: prompts
should use `inputConsumed` to distinguish stage entry, and application code
should not interpret `"Start"` as user data.

Assign stages to the same history only when they intentionally need shared
conversation context. Otherwise add the new node to `historySpaces`.

## 6. Understand both concurrency patterns

### Graph-level fan-out and join

```ts
graph.addEdge(InContextNode, ParallelNode);
graph.addEdge(ParallelNode, Child1Node);
graph.addEdge(ParallelNode, Child2Node);
graph.addEdge(Child1Node, DobNode);
graph.addEdge(Child2Node, DobNode);
```

`ParallelNode` returns `{}`. Its two outgoing edges schedule `Child1Node` and
`Child2Node` concurrently. Each child writes under a different local-state key
and returns its own token usage; the graph reducers merge those node patches and
sum the tokens before the joined `DobNode` runs. `DobNode.childJokes()` reads
both results and copies them into its own durable state.

The deterministic test gateway delays direct generations and records peak
concurrency. The E2E test asserts `maxActiveGenerations === 2`, proving that the
two child branches overlap.

For concurrent branches, write to independently reducible channels. Two
branches returning unrelated values for the same scalar channel are ambiguous
unless that channel has an appropriate reducer.

### Concurrency inside one node

`ManualConcurrentNode` uses `Promise.all` for four calls that naturally belong
to one implementation unit. Since it calls `llmGateway.generate()` directly,
it also combines usage explicitly:

```ts
const results = await Promise.all(calls.map(([step, ordinal]) =>
  this.llmGateway.generate(/* ... */)
));

return {
  ...this.save({ task: /* map results by step */ }),
  tokens: results.reduce(
    (total, result) => addTokenUsage(total, result.usage),
    emptyTokenUsage(),
  ),
};
```

Use graph fan-out when branches are meaningful workflow units that should be
visible and independently testable. Use `Promise.all` inside one node when the
calls are merely an implementation detail of one stage.

## 7. Sessions and the HTTP API

[`AppModule`](../src/app.module.ts#L9) registers `DemoGraph`, `HotelGraph`, and
`InvoiceGraph` with one `GraphEngine`. The
[`AiController`](../src/controllers/ai-controller.ts#L23) exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /ai/graphs` | List registered graph class names. |
| `POST /ai/run` | Start or resume a graph. |
| `POST /ai/end` | Delete the session identified by `SESSION_ID`. |
| `/api` | Swagger UI when the application is running. |

For every successful turn, `GraphEngine` restores the session, appends the new
message to the active history, resets per-request response flags, invokes the
compiled graph, and persists the resulting state. Reuse the same `SESSION_ID`
header to continue. A session cannot silently switch graphs. Once completed, a
later run does not invoke the graph: a `chat` graph returns 200 with
`"This conversation is already complete."`, and a `json` graph returns 409 with
`code: "SESSION_COMPLETED"` because its success body is the graph's own result
object, which a rejected turn never produced.

Errors are appended to the session document even when a graph update cannot be
saved. The E2E test injects a provider failure, verifies the recorded error, and
then successfully retries the same session.

### Customize session restoration with `onRestoreSessionDoc()`

[`DemoGraph`](../src/graphs/demo-graph/demo-graph.ts#L127) overrides the
`BaseGraph` restore hook:

```ts
protected async onRestoreSessionDoc(
  sessionDoc: SessionDocument<DemoGraphStateType>,
): Promise<SessionDocument<DemoGraphStateType> | null> {
  return sessionDoc;
}
```

The hook runs after a persisted document is loaded and before the graph resumes
it. The framework default keeps the document; there is no stored `expireAfter`
field. Use this hook when the graph needs to expire an idle session, validate
restored state, or reshape a document. `this.idleMs(sessionDoc)` is the idle
helper. Return the updated document to continue, or `null` to start a fresh
run for that session ID.

### Run the demo locally

This repository requires Node.js 22.5 or later. Install dependencies, expose
the Google and GLM credentials to the server process, and choose a session store
(`memory` is convenient for an ephemeral tutorial; `sqlite` is durable
locally). Weather uses `GOOGLE_API_KEY`; Favorites uses `GLM_API_KEY` and the
optional `GLM_BASE_URL` override:

```bash
npm install
export GOOGLE_API_KEY='<key>'
export GLM_API_KEY='<key>'
export SESSION_STORE=memory
npm run start
```

The server defaults to port 8000. Supplying your own valid session identifier
makes the sequence easy to replay:

```bash
curl -i http://localhost:8000/ai/run \
  -H 'content-type: application/json' \
  -H 'SESSION_ID: demo-tutorial-1' \
  -d '{"graphName":"DemoGraph","message":"Hi","config":{}}'

curl -i http://localhost:8000/ai/run \
  -H 'content-type: application/json' \
  -H 'SESSION_ID: demo-tutorial-1' \
  -d '{"graphName":"DemoGraph","message":"LA and NYC","config":{}}'
```

Continue with favorites, a non-`John Doe` name, an ISO-style date such as
`1990-01-02`, and an address such as
`123 Main St., New York, NY 10001`. Responses are LLM-authored, so assert intent
and state rather than exact prose outside deterministic tests.

## 8. Test the graph

Run the fast, deterministic checks first:

```bash
npm run typecheck
npm run build
npm run test:e2e
```

The E2E suite replaces `GraphEngine` with a `ScriptedLlmGateway` and exercises
the complete multi-turn path. It verifies partial state, history isolation,
tool-message persistence, overlapping child generations, accumulated tokens,
terminal replay, session deletion, and provider-error recovery without calling
a hosted model. Add explicit child-state and joined-value assertions if those
become business-critical contracts.

The captured-conversation evaluation uses live graph and evaluator models:

```bash
npm run test:demo-graph
```

It requires the corresponding Google and OpenAI credentials and grades response
meaning rather than fixed wording. Keep domain transitions and stored state
covered by deterministic tests; use live evaluations for prompt behavior.

## 9. Add a new conversational stage

Suppose a phone-number stage should run after Name and before InContext.

### Step 1: create the node

```ts
type PhoneState = { phone?: string };
type PhoneContext = { phone?: string };

export class PhoneNode extends ConversationNode<
  DemoGraphStateType,
  PhoneState,
  PhoneContext
> {
  getPrompt(state: DemoGraphStateType): string {
    return `${state.inputConsumed ? "Ask for a phone number now." : ""}
      Call recordPhone when the user supplies one. If the user asks to stop,
      call terminate_session.`;
  }

  defineTool(): readonly ToolDefinition<{ phone: string }>[] {
    return [{
      name: "recordPhone",
      description: "Validate and record a phone number.",
      schema: z.object({ phone: z.string() }),
    }];
  }

  @Tool("recordPhone")
  async recordPhone(
    { phone }: { phone: string },
    _context: PhoneContext,
  ): Promise<ConversationToolResult> {
    const normalized = phone.replace(/[\s()-]/g, "");
    const accepted = /^\+?[1-9]\d{7,14}$/.test(normalized);
    return this.toolResult({ accepted })
      .withContext(accepted ? { phone: normalized } : {})
      .stopAfterBatchWhen(accepted);
  }

  protected createContext(state: DemoGraphStateType): PhoneContext {
    return { phone: this.state(state).phone };
  }

  protected nextStep(
    _state: DemoGraphStateType,
    context: PhoneContext,
    conversation: ConversationNodeRunResult,
  ): GraphNodeUpdate<DemoGraphStateType> {
    if (conversation.quitRequested) return this.quit(conversation);
    if (context.phone) {
      return this.advance(InContextNode, conversation)
        .withState({ phone: context.phone });
    }
    return this.stay(conversation);
  }
}
```

### Step 2: make Name target it

Change Name's accepted outcome from `advance(InContextNode, conversation)` to
`advance(PhoneNode, conversation)`.

### Step 3: make topology and persistence agree

- Add `PhoneNode` to `graph.nodes(...)`.
- Add `[PhoneNode, "phone"]` to `historySpaces`.
- Add `PhoneNode` to `graph.registerTurns(...)`.
- Change Name's current-node case to `{ when: PhoneNode, routeTo: PhoneNode }`.
- Enable `autoRouteOutcomes()` so `advance(PhoneNode)`, `quit()`, and `stay()`
  are routed automatically.

### Step 4: test all outcomes

Add deterministic cases for stage entry, invalid input/stay, accepted
input/advance, explicit quit, local-state persistence, history isolation, and
resumption using a second HTTP request. Typecheck catches mismatched local-state
patches; the runtime tests prove that topology and session behavior agree.

## Common pitfalls

- **Confusing LangGraph `END` with application completion.** `END` often means
  “return this turn.” Use `finish(...)` or `TerminateSessionNode` to set `completed`.
- **Adding a node to only one list.** A conversational stage generally needs
  registration, a history mapping, a resume entry, and incoming/outgoing edges.
- **Calling `stay(...)` after a stopped tool batch with no response.** `stay`
  rejects empty responses. Let the runner produce a reply or choose an outcome
  that does not require one.
- **Checking domain completion before `quitRequested`.** An explicit user quit
  should win when both effects occur in the same tool batch.
- **Persisting the tool context implicitly.** Context is per-turn. Commit
  durable values with `.withState(...)` in the selected outcome.
- **Mutating restored nested state.** Clone it in
  `createContext()` and use typed `.withContext(...)` effects.
- **Sharing every history.** Earlier answers can be misread as current-stage
  input and increase model cost. Map stages deliberately.
- **Forgetting token accounting on direct calls.** Conversation outcomes include
  runner usage automatically; direct `generate()` calls must return usage.
- **Routing to the resume target when internal work must run first.** Use
  `advance(TargetNode).via(WorkerNode)` to preserve the durable target while
  routing the current invocation through internal work. `branchBy()` remains
  available when explicit graph-owned routing is required.
- **Expecting exact production wording.** Tool acceptance, state, routing, and
  completion are hard contracts; natural-language phrasing is not.

## Design checklist

Before considering a new graph stage complete, verify:

1. Its prompt owns one clear responsibility.
2. Every model-selected action has a Zod definition and matching `@Tool` method.
3. Tool output tells the model what happened; context effects record control
   state separately.
4. `nextStep()` chooses one of stay, advance, quit, or finish.
5. Durable values are committed with a typed state helper.
6. History sharing or isolation is intentional.
7. The target appears in both topology and `registerTurns(...)` when it can handle a
   later request.
8. Concurrent branches update reducible, non-conflicting state.
9. Direct model calls return token usage.
10. Deterministic tests cover invalid input, successful transition, resume,
    quit, and completion.
