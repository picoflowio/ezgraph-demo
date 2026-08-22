# InvoiceGraph developer guide

InvoiceGraph is the smallest graph in this repository, but it demonstrates a
production-relevant pattern that the conversational examples do not: one HTTP
request starts a tool-driven vision workflow, uploads a document to an LLM
provider, captures structured data, and returns the extracted object directly
as JSON.

Use this guide to learn how to:

- run a graph without a user chat message;
- select a trusted server-side document through request configuration;
- force a model to use tools instead of returning unstructured prose;
- attach an uploaded image or PDF to a conversation;
- coordinate `fetch_file` and `capture_json` with typed tool context;
- clean up temporary provider files;
- turn an internal graph result into a raw JSON HTTP response; and
- extend and test a document-extraction graph safely.

For the other graph styles in this project, see the
[DemoGraph developer guide](./demo-graph-developer-guide.md), the
[HotelGraph developer guide](./hotel-graph-developer-guide.md), and the
[SupportGraph developer guide](./support-graph-developer-guide.md).

## Start here: authoring a custom graph

Start with the workflow boundary, not the prompt. A graph owns durable state,
legal transitions, and when an HTTP invocation ends. A node owns the work at
one stage and returns a state update that the graph can route. This guide uses
a one-shot document workflow, but the same contract applies to conversational
graphs.

### 1. Define the graph shell and topology

Create state with the correct initial node, extend `BaseGraph`, define shared
LLM and response policy, and connect only registered nodes:

```ts
export const InvoiceGraphState = createGraphStateAnnotation(ExtractInvoiceNode.name);

export class InvoiceGraph extends BaseGraph<typeof InvoiceGraphState.State> {
  static getGraphDefinition(): GraphDefinition {
    return {
      llmConfig: ModelCatalog.model("openai:gpt-5.4", { retries: 3, forceToolCalls: true }),
      endNode: GRAPH_END_NODE,
      requiresUserMessage: false,
      responseMode: "json",
      historySpaces: [[ExtractInvoiceNode, "invoice"]],
    };
  }

  constructor(llmGateway: LlmGateway) {
    super(llmGateway, InvoiceGraph.getGraphDefinition());
  }

  protected buildGraph() {
    return this.createStateGraph(InvoiceGraphState)
      .nodes(ExtractInvoiceNode)
      .addEdge(START, ExtractInvoiceNode)
      .addEdge(ExtractInvoiceNode, END)
      .compile();
  }
}
```

Use `registerTurns(...)` and `autoRouteOutcomes()` only when a graph can yield and later
accept another user turn. InvoiceGraph has one internal stage and completes in
one request, so its direct `START -> node -> END` topology is the clearest
contract. `END` stops this invocation; `finish(...)` additionally marks the
application session complete.

### 2. Choose `ConversationNode` or `GraphNode`

The two base classes differ by lifecycle ownership, not by whether the node
uses a model:

| Base class | Use it for | Developer implements | Framework provides |
| --- | --- | --- | --- |
| `ConversationNode` | A resumable user-facing stage that may ask, wait, and accept another message. | `getPrompt`, `createContext`, optional tool definitions/handlers, and `nextStep`. | The shared agent/tool loop, histories, token accounting, `terminate_session`, and the call from the loop to the next-stage decision. |
| `GraphNode` | An internal worker, deterministic task, direct model call, or a stage with a custom model/tool lifecycle. | `getPrompt` and `run`; the developer may call `runConversation` inside `run`. | Typed state helpers, tool registration/dispatch, model configuration, and outcome builders. |

“Internal” does not mean a child class nested inside a parent node. It means
the graph invokes that `GraphNode` as part of the current workflow execution.
An internal worker can still use the same model/tool loop as a conversation.

InvoiceGraph intentionally uses `GraphNode`: extraction should not pause to ask
the caller a question, and its JSON completion rule is specific to this one
workflow. The node therefore owns the complete one-shot lifecycle:

```ts
class ExtractInvoiceNode extends GraphNode<State, InvoiceState, InvoiceContext> {
  getPrompt(state: State) { /* describe the allowed file and required tools */ }
  defineTool() { /* fetch_file and capture_json schemas */ }

  @Tool("fetch_file")
  fetchFile(input: FetchInput, context: InvoiceContext) {
    // validate the server-owned asset, attach it, and update context
  }

  @Tool("capture_json")
  captureJson(input: CaptureInput, context: InvoiceContext) {
    // validate JSON and record the accepted extraction in context
  }

  async run(state: State): Promise<GraphNodeUpdate<State>> {
    const context: InvoiceContext = { fileName: this.configuredFileName(state), fetched: false };
    const conversation = await this.runConversation(state, context);
    return context.invoice
      ? this.finish(JSON.stringify(context.invoice), conversation).withState({ invoice: context.invoice })
      : this.stay(conversation);
  }
}
```

### 3. Know the lifecycle contracts

For a `ConversationNode`, EZGraph runs this fixed sequence:

```text
state -> createContext(state) -> model/tool loop -> nextStep(...) -> graph routing
```

`createContext()` must create fresh, transient working data for one turn. Tool
handlers can enrich it with typed `withContext(...)` effects;
`nextStep()` turns that accumulated evidence into `stay`, `advance`, `quit`,
or `finish`, and persists accepted values with `withState(...)`.

For a `GraphNode`, `run()` is the lifecycle boundary. It may perform no model
work, call the gateway directly, or call `runConversation(state, context)` as
InvoiceGraph does. In every case, it must return a typed state update or an
outcome. This is why `GraphNode` is the right escape hatch for a custom
workflow, rather than overriding `ConversationNode.run()`.

### 4. Add a new stage safely

1. Define the node’s durable local-state type and its transient context type.
2. Choose the lifecycle base class before implementing the prompt.
3. Implement validation in typed tool handlers; prompts describe desired model
   behavior but do not enforce security or data correctness.
4. Have the node return one clear semantic outcome or update.
5. Register the node before connecting it. Add a resume target and
   `autoRouteOutcomes()` only for a stage that can handle a later request;
   use `branchBy()` only when explicit conditional topology is required.
6. Test success, incomplete/invalid tool results, terminal behavior, and any
   cleanup actions.

## 1. When to use this pattern

The three example graphs intentionally solve different orchestration problems:

| Graph | Request shape | Primary lesson |
| --- | --- | --- |
| [DemoGraph](./demo-graph-developer-guide.md) | Many user turns | Typed conversational stages, isolated histories, resume routing, and concurrent work |
| [HotelGraph](./hotel-graph-developer-guide.md) | Many user turns | A domain workflow that searches, compares, presents, and books through explicit transitions |
| InvoiceGraph | One request, no chat message | Provider file upload, multimodal tool sequencing, structured capture, and a raw JSON response |

InvoiceGraph is a good starting point for receipt extraction, claim intake,
form digitization, document classification, or another bounded task where the
caller already knows which server-owned asset should be processed. It is not
an arbitrary file browser, and it is not currently a general user-upload API.

## 2. Source map

The implementation is intentionally compact:

| File | Responsibility |
| --- | --- |
| [`invoice-graph.ts`](../src/graphs/invoice-graph/invoice-graph.ts) | Graph policy, model defaults, response mode, history space, and topology |
| [`invoice-graph.state.ts`](../src/graphs/invoice-graph/invoice-graph.state.ts) | Typed graph and node-local persistent state |
| [`extract-invoice.node.ts`](../src/graphs/invoice-graph/nodes/extract-invoice.node.ts) | Prompt, tool definitions and handlers, workflow context, and final outcome |
| [`invoice-prompt.ts`](../src/graphs/invoice-graph/prompt/invoice-prompt.ts) | Loads and combines the instructions and example at startup |
| [`invoice.md`](../src/graphs/invoice-graph/prompt/invoice.md) | Extraction persona and workflow instructions |
| [`invoice-example.json`](../src/graphs/invoice-graph/prompt/invoice-example.json) | Example output shape shown to the model |
| [`data/`](../src/graphs/invoice-graph/data) | Bundled, server-owned invoice images and PDFs |
| [`captured-response.eval.ts`](../test/invoice-graph/captured-response.eval.ts) | Live HTTP/provider evaluation for `ACME.pdf` |
| [`captured-response.json`](../test/invoice-graph/captured-response.json) | Expected captured response for that evaluation |

The application registers InvoiceGraph alongside the other graphs in
[`app.module.ts`](../src/app.module.ts). The generic HTTP adapter in
[`ai-controller.ts`](../src/controllers/ai-controller.ts) does not contain any
invoice-specific behavior.

## 3. Architecture at a glance

The LangGraph topology has only one application node:

```text
START -> ExtractInvoiceNode -> END
```

The interesting orchestration happens inside `ExtractInvoiceNode`:

```text
POST /ai/run
  |
  | config.fileName
  v
ExtractInvoiceNode.run()
  |
  |-- create ephemeral tool context
  |-- run shared conversation loop
  |     |
  |     |-- model calls fetch_file
  |     |-- validate selected bundled filename
  |     |-- upload file through ProviderFileManager
  |     |-- append ToolMessage + multimodal HumanMessage
  |     |-- normally, model sees the document and calls capture_json
  |     |-- parse JSON, update context, stop after tool batch
  |
  |-- finish(serialized invoice).withState(...)
  v
GraphEngine parses the response string and sends the JSON object
```

There are two loops to distinguish:

1. LangGraph executes `ExtractInvoiceNode` once and follows its direct edge to
   `END`.
2. Inside that node, EZGraph's conversation runner may invoke the model and
   execute tools several times before the node returns an outcome.

The second loop is why the graph can remain visually simple without putting
provider and tool-call plumbing in the HTTP controller.

## 4. Graph definition

`InvoiceGraph.getGraphDefinition()` declares four choices that make this graph
behave differently from DemoGraph and HotelGraph:

```ts
return {
  llmConfig: ModelCatalog.model("openai:gpt-5.4", {
    retries: 3,
    reasoningEffort: "medium",
    forceToolCalls: true,
  }),
  endNode: GRAPH_END_NODE,
  requiresUserMessage: false,
  responseMode: "json",
  historySpaces: [[ExtractInvoiceNode, "invoice"]],
};
```

### `requiresUserMessage: false`

The caller starts extraction with configuration alone. `GraphEngine` normally
rejects an empty user message, but this graph opts out because the prompt and
configured file are the complete input.

On a fresh conversation history, the shared runner inserts a neutral
`HumanMessage("Start")`. This satisfies providers that do not accept a
system-only request; it is framework plumbing, not invoice data.

### `responseMode: "json"`

Successful chat-mode graphs return an envelope containing `success`,
`completed`, `message`, and `session`. InvoiceGraph instead treats its final
response string as a serialized object and sends that object as the HTTP body
with `Content-Type: application/json`.

The session ID is still returned in the `SESSION_ID` response header. It is not
added to the JSON body.

This is a strict contract: every successful invocation of a JSON-response
graph must produce a string that parses as a non-array JSON object. A string,
array, empty response, or prose explanation causes this error:

```text
A JSON-response graph completed without an object result.
```

### `onInvalidJsonResponse()`

`GraphNode.invoke()` validates the update returned by `run()`. It calls
`onInvalidJsonResponse()` only when both of these conditions are true:

- the graph uses `responseMode: "json"`; and
- the node update has `completed: true`, but its final `response` is not a
  non-array JSON object string.

The hook does not run merely because `state.invoice` is missing, the model did
not call `capture_json`, a tool argument is malformed, or a provider request
failed. Those failures occur at other stages of the node lifecycle. The hook
also does not automatically retry the model.

This demo deliberately keeps the extension point small and fails fast:

```ts
protected override async onInvalidJsonResponse(
  context: InvalidJsonResponseContext<InvoiceGraphStateType>,
): Promise<GraphNodeUpdate<InvoiceGraphStateType>> {
  // This demo fails fast and lets GraphEngine terminate the graph request.
  // Applications may instead return a valid replacement update here—for
  // example, rebuild the response from trusted state, request user review,
  // or route to a domain-specific recovery node. Avoid asking an LLM to
  // invent missing invoice data.
  throw context.error;
}
```

Throwing `context.error` aborts the compiled graph invocation. `GraphEngine`
catches the exception, records it in the session logs, and returns an HTTP 400
response. No JSON repair or additional LLM request is attempted.

Production applications can replace the throw with a valid
`GraphNodeUpdate` when recovery is safe. Suitable strategies include rebuilding
the response from already validated domain state, returning a structured review
status, or routing to an explicit recovery step. Any replacement that remains
completed must itself contain a valid JSON object response; the framework
validates it before continuing.

### One named history space

All model, tool, and attachment messages belong to the `invoice` history
space. Separate spaces become valuable in multi-stage graphs; compare the
history designs in the DemoGraph and HotelGraph guides.

### Direct topology

The builder registers the node before connecting it:

```ts
return this.createStateGraph(InvoiceGraphState)
  .nodes(ExtractInvoiceNode)
  .addEdge(START, ExtractInvoiceNode)
  .addEdge(ExtractInvoiceNode, END)
  .compile();
```

No `registerTurns()` or `autoRouteOutcomes()` is needed for the intended
single-request happy path. `END` stops the current LangGraph invocation;
`finish()` separately marks the application session as completed.

## 5. Model configuration and forced tools

InvoiceGraph keeps its single node's complete model policy at graph level:

```ts
llmConfig: ModelCatalog.model("openai:gpt-5.4", {
  retries: 3,
  reasoningEffort: "medium",
  forceToolCalls: true,
})
```

`ExtractInvoiceNode` inherits this configuration unchanged.
`ProviderFileManager` reads the resolved provider, so both the uploaded
document and model invocation use OpenAI.

`forceToolCalls: true` binds the tools with a required/`any` tool choice. It
prevents the model from satisfying the task with ordinary prose, but it does
not choose the correct tool or guarantee their order. The prompt requests the
order. The handlers require a successful `fetch_file` call before accepting
`capture_json`, but they do not prove that the model has inspected the uploaded
document; the ordering limitation is detailed below.

Because this graph has only one model-using node, a node override would add no
useful distinction. Add `getLlmConfig()` only when a future node intentionally
requires a different model from the graph default.

## 6. Three kinds of state

It helps to separate request configuration, ephemeral tool context, and
durable graph state:

| Data | Lifetime | Current contents |
| --- | --- | --- |
| `state.config` | Session | Caller-supplied `fileName` |
| `ExtractInvoiceContext` | One `run()` call | Normalized filename, whether a file was fetched, and the captured invoice |
| `state.nodes.ExtractInvoiceNode` | Session | Filename and extracted invoice |
| `state.histories.invoice` | Session | Model/tool/multimodal messages produced by the run |
| `state.tokens` | Session | Accumulated normalized model usage |

The tool context starts as:

```ts
const context: ExtractInvoiceContext = {
  configuredFileName: this.configuredFileName(state),
  fetched: false,
};
```

It is shared by tool handlers within one conversation loop. `fetch_file` sets
`fetched`; `capture_json` reads that flag and sets `invoice`. The context is
discarded when `run()` returns. Only values passed through `.withState(...)`
become durable node state.

This separation prevents half-finished extraction data from silently becoming
session state. If the process must resume after a provider outage, design an
explicit durable phase model instead of assuming tool context will survive.

## 7. Prompt construction

`invoice-prompt.ts` loads two assets when the module starts:

```ts
export const extractInvoicePrompt = `${invoiceInstructions}

## Data Extraction JSON Example
${invoiceExample}`;
```

`getPrompt()` then adds the normalized configured filename and strict runtime
instructions:

- call `fetch_file` immediately with that exact name;
- do not request another local path;
- inspect the attachment before extracting;
- call `capture_json` exactly once;
- encode the invoice object as a JSON string; and
- never return the object as normal chat text.

The example is currently prompt guidance, not an output schema. It helps the
model reproduce field names and nesting, but it does not prove that required
fields, dates, totals, or identifiers are valid. A production financial flow
should parse the string with a strict invoice Zod schema and apply domain
checks after parsing.

Keep all three representations aligned when changing the contract:

1. the prose instructions in `invoice.md`;
2. the sample object in `invoice-example.json`; and
3. the validation performed by `captureJson()`.

In particular, the tool's runtime schema accepts a JSON-encoded **string**, not
an arbitrary object. This portable representation avoids provider limitations
around function schemas with arbitrary object properties.

## 8. Tool registration and validation

`defineTool()` publishes the model-facing contracts:

```ts
{
  name: "fetch_file",
  schema: z.object({ name: z.string().min(1) }),
}

{
  name: "capture_json",
  schema: z.object({ json: z.string().min(2) }),
}
```

The `@Tool(...)` decorators connect those names to application methods:

```ts
@Tool("fetch_file")
async fetchFile(...) { ... }

@Tool("capture_json")
async captureJson(...) { ... }
```

At graph compilation, EZGraph verifies that decorated tools resolve to graph
definitions. At execution, it validates model arguments with Zod before
calling the method. A tool name, decorator, and definition must continue to
match exactly.

The Zod schemas validate only the outer protocol. `captureJson()` must still
parse and validate the encoded payload because the interesting data is inside
the string.

## 9. `fetch_file`: trusted selection and multimodal attachment

The handler performs four steps.

### 9.1 Confirm the requested name

The model must request the exact normalized configured filename. A different
name returns a model-visible error object and does not touch the filesystem or
provider.

### 9.2 Resolve a bundled asset

`bundledInvoices` maps approved names to module-relative URLs:

```ts
const bundledInvoices = new Map([
  ["ACME.png", new URL("../data/ACME.png", import.meta.url)],
  ["Evergreen.png", new URL("../data/Evergreen.png", import.meta.url)],
  ["ACME.pdf", new URL("../data/ACME.pdf", import.meta.url)],
  ["Evergreen.pdf", new URL("../data/Evergreen.pdf", import.meta.url)],
  ["invoice-0-4.pdf", new URL("../data/invoice-0-4.pdf", import.meta.url)],
]);
```

The client configuration is a selector into this map. It is never used as a
filesystem path.

### 9.3 Upload through `ProviderFileManager`

The manager recognizes images and PDFs, uploads the asset with the provider's
SDK, and returns a provider-native LangChain content part:

| Provider | Content-part strategy |
| --- | --- |
| OpenAI | Uploaded `file` reference |
| Google | `media` reference using the active file URI |
| Anthropic | Provider-specific uploaded document or image block |

Google uploads are polled until the file becomes active, fails, or reaches the
60-second processing limit. The manager requires the API key for the resolved
provider.

The optional `InvoiceFileUploader` constructor port is useful when directly
constructing a node in a focused test. The standard graph node factory passes
only the gateway and runtime, so normal InvoiceGraph execution creates
`ProviderFileManager` itself.

### 9.4 Return tool output plus a model-visible attachment

The result includes three channels of information:

```ts
return {
  output: { attached: true, fileName: name, fileId: upload.fileId },
  cleanup: upload.cleanup,
  messages: [
    new HumanMessage({
      content: [
        { type: "text", text: "...analyze it and call capture_json..." },
        upload.contentPart,
      ],
    }),
  ],
};
```

- `output` becomes the `ToolMessage` acknowledging the original tool call.
- `messages` are appended immediately after that tool result. The additional
  `HumanMessage` contains instructions and the provider file reference.
- `cleanup` transfers deletion responsibility to the conversation runner.

The next model invocation therefore receives a valid sequence: assistant tool
call, matching tool result, then a human multimodal message containing the
document reference.

## 10. Attachment lifecycle and cleanup

Once an upload returns a cleanup callback, the conversation runner keeps it
until the attachment has been available to the next model invocation. It then
attempts all pending cleanups with `Promise.allSettled`. It also attempts
registered cleanup when model or tool execution throws and before the runner
exits.

For the normal invoice flow, the lifecycle is:

1. `fetch_file` uploads the provider file and registers its cleanup callback.
2. The next model invocation receives the multimodal message.
3. After that invocation returns, the runner calls the provider deletion API.
4. The returned `capture_json` call is executed locally.

Cleanup means deleting the temporary provider object; it does not erase the
session history. The tool output still contains a file ID, and the multimodal
message still contains its provider reference. The final extracted object is
also stored in node state and in the final history response. Choose a short
session retention policy or customize persistence if even expired provider
references and duplicated extracted data are too sensitive.

Cleanup failures are deliberately settled rather than replacing a successful
model result with a deletion error. There is also a pre-registration gap: for
example, if a Google upload succeeds but activation polling subsequently fails
or times out, `ProviderFileManager` throws before returning the cleanup callback,
so the runner cannot delete that remote file. Applications with strict deletion
SLAs should make upload ownership failure-safe and add monitoring or a retry
queue around provider cleanup.

## 11. `capture_json`: ordering, parsing, and loop termination

`captureJson()` first parses the encoded JSON and requires a non-null,
non-array object. It then verifies that this run has successfully fetched the
configured file:

```ts
if (!context.fetched) {
  return {
    output: {
      captured: false,
      error: "Fetch the configured invoice before submitting JSON.",
    },
  };
}
```

That check rejects `capture_json` before any successful `fetch_file` handler.
It does not guarantee document inspection. The runner executes tool calls from
one assistant message sequentially, so a batch containing `fetch_file` followed
by `capture_json` passes the flag check even though no subsequent model turn has
seen the attachment. If extraction integrity matters, track an explicit
“attachment presented to a later model turn” phase or disallow capture in the
same batch. A valid capture currently sets `context.invoice` and returns:

```ts
return {
  output: { captured: true },
  stopAfterBatch: true,
};
```

`stopAfterBatch` is important. The runner executes and records every tool call
in the current assistant message, then exits before asking the model for
another response. The node—not the model—constructs the final API JSON from the
captured object.

It is not an immediate cancellation signal. If an assistant message contains
several tool calls, all are processed in order. This preserves a complete tool
message sequence and avoids leaving later calls unanswered.

## 12. `stay()` and `finish()` outcomes

After the conversation runner returns, `run()` chooses one semantic outcome:

```ts
if (!context.invoice) {
  return this.stay(conversation);
}

const response = JSON.stringify(context.invoice, null, 2);
return this.finish(response, conversation).withState({
  fileName: context.configuredFileName,
  invoice: context.invoice,
});
```

### Happy path: `finish()`

`finish()` performs the coordinated terminal update:

- stores the JSON string as the graph response;
- marks the input consumed;
- sets `currentNode` to the graph's terminal node;
- sets `completed: true`;
- appends the conversation and final response to the node's history; and
- records token usage.

`.withState(...)` immutably adds the typed local-state patch without manually
assembling a fragile `Partial<GraphState>` object.

### Defensive path: `stay()`

`stay()` keeps `ExtractInvoiceNode` current, consumes the request, stores the
conversation response, history, and tokens, and leaves the graph incomplete.
It also requires a non-empty assistant response.

There is a crucial interaction with this graph's JSON response mode: a normal
plain-text assistant reply from `stay()` fails the HTTP response parser. The
engine saves that incomplete state and history before it parses the response,
then returns HTTP 400, so retrying the same session is not a clean no-op. The
current graph is designed to finish in one request, so this branch is only a
defensive fallback. If recoverable multi-request extraction is a product
requirement, define explicit JSON error/progress objects, persist a durable
phase, and use a resume-aware topology. Otherwise, throwing a clear extraction
error before persisting may be more honest than pretending a prose response is
a valid JSON result.

## 13. Complete request walkthrough

Given this request:

```json
{
  "graphName": "InvoiceGraph",
  "config": {
    "fileName": "data/ACME.pdf"
  }
}
```

the application performs the following steps:

1. `AiController` omits `userMessage` and passes the graph name and config to
   `GraphEngine`.
2. `GraphEngine` creates a session ID, merges config into graph state, and
   invokes InvoiceGraph.
3. `configuredFileName()` trims the value, applies `basename()`, and resolves
   `ACME.pdf` against the bundled allowlist.
4. The fresh `invoice` history receives the runner's neutral `Start` message.
5. The model is invoked with the extraction prompt and the two tools. Forced
   tool choice requires a tool call.
6. The model calls `fetch_file({ name: "ACME.pdf" })`.
7. The node uploads the module-owned PDF, records the tool result, and appends
   a multimodal message.
8. The model sees the PDF and calls `capture_json` with an encoded object.
9. The handler checks the fetched flag and JSON shape, stores the object in
   context, and asks the runner to stop after the batch. As noted above, this
   flag alone does not prove that a later model turn inspected the attachment.
10. The provider attachment is deleted on a best-effort basis.
11. `finish()` completes state and persists the filename and invoice.
12. `GraphEngine` parses the graph response and returns the object directly.

The API does not return the model's acknowledgement text. The captured tool
argument is the source of the response.

## 14. Running InvoiceGraph locally

### Prerequisites

- Node.js 22.5 or later;
- project dependencies installed;
- an OpenAI key in `OPENAI_API_KEY`; and
- an optional session-store configuration (`memory` is the default).

Install dependencies and expose the OpenAI key to the server process. EZGraph's
configuration reader can load session-store settings from `.env`, but
`ProviderFileManager` reads `OPENAI_API_KEY` from `process.env`, so merely
placing the key in `.env` is not sufficient for `npm run start`:

```bash
npm install
export OPENAI_API_KEY='<key>'
export SESSION_STORE=memory
npm run start
```

The default port is 8000. Swagger is available at
`http://localhost:8000/api`, and registered graphs can be checked with:

```bash
curl http://localhost:8000/ai/graphs
```

Run extraction without a `message` field:

```bash
curl -i \
  -X POST http://localhost:8000/ai/run \
  -H 'content-type: application/json' \
  -d '{
    "graphName": "InvoiceGraph",
    "config": { "fileName": "data/ACME.pdf" }
  }'
```

The response body is the invoice object itself:

```json
{
  "vendor_name": "ACME Inc",
  "bill_number": "INV-2025-019",
  "currency": "USD",
  "total": 7301.7
}
```

The real object contains the complete extracted structure. With `-i`, also
verify `Content-Type: application/json` and the `SESSION_ID` response header.

Supported selectors are currently:

- `ACME.png`
- `Evergreen.png`
- `ACME.pdf`
- `Evergreen.pdf`
- `invoice-0-4.pdf`

A directory prefix is discarded by `basename()`, so `data/ACME.pdf` selects
the bundled `ACME.pdf`; it does not read `data/ACME.pdf` relative to the
caller's working directory.

## 15. Testing strategy

Run static verification before any live evaluation:

```bash
npm run typecheck
npm run build
```

The repository's InvoiceGraph evaluation is:

```bash
npm run test:invoice-graph
```

It boots the Nest/Fastify application, sends a real InvoiceGraph request for
`data/ACME.pdf`, checks the raw JSON content type and session header, and
compares the response to `captured-response.json`. It calls the configured
live provider, uploads a document, can incur cost, and requires
`OPENAI_API_KEY`. Its three-minute timeout accounts for provider and file
processing latency.

This is a captured-response evaluation, not a deterministic unit test. Exact
model output can drift across calls or model updates, and a strict deep equality
comparison may fail because of extraction variation rather than a framework bug.
Review differences as extraction changes; do not automatically bless newly
captured financial values.

For production development, add deterministic tests for these boundaries:

| Test | Expected result |
| --- | --- |
| Missing `config.fileName` | Clear configuration error |
| Unsupported filename | Rejected before upload |
| Model asks for another filename | `{ attached: false, error: ... }` |
| Upload succeeds | Tool output, multimodal message, and cleanup are returned |
| Capture occurs before fetch | Model-visible ordering error |
| Fetch and capture occur in one assistant batch | Rejected by a production phase guard, or explicitly documented as unsupported by the demo |
| Capture string is malformed | Parsing error |
| Capture JSON is an array or scalar | Object-shape error |
| Valid capture | Context receives invoice and batch stops |
| Provider/model throws after upload | Cleanup is attempted |
| JSON response is not an object | GraphEngine returns contract error |

Use a fake uploader to assert attachment and cleanup behavior without network
access. The existing uploader constructor seam supports direct node tests. For
full GraphEngine tests with dependency injection, add an application-owned
uploader factory or node factory rather than contacting a real provider.

Also test invoice semantics with a strict schema: required identifiers, ISO
dates, currencies, numeric ranges, line-total arithmetic, tax calculations,
and balance reconciliation.

## 16. Adding another bundled invoice

To add a trusted fixture or supported server-owned invoice:

1. Add the image or PDF under `src/graphs/invoice-graph/data/`.
2. Add an exact public selector and module-relative `URL` to
   `bundledInvoices`.
3. Exercise it through `/ai/run` using that selector.
4. Add a reviewed expected fixture or semantic assertions.
5. Confirm cleanup using a fake uploader, not only a provider dashboard.

Do not replace the allowlist with `resolve(config.fileName)` or another direct
filesystem lookup. If the product must accept user uploads, create a separate
authenticated upload boundary, validate size and MIME type, scan content,
store it under an opaque server-controlled ID, and let the graph resolve only
that trusted ID.

## 17. Changing the extraction contract

When adding invoice fields:

1. update `invoice-example.json`;
2. update the prose when new interpretation rules are required;
3. add or update the strict domain schema in `captureJson()`;
4. update downstream consumers and the typed invoice representation; and
5. review test fixtures using the source document, not only model output.

`Record<string, unknown>` is convenient for a demo, but it gives downstream
code no guarantees. Prefer a named `Invoice` type inferred from the same Zod
schema used at runtime.

## 18. Switching or adding a provider

`ProviderFileManager` currently supports OpenAI, Google, and Anthropic file
uploads. To switch among them:

1. select a tool-capable vision model in `InvoiceGraph`'s graph-level
   `llmConfig`; use a node override only when a future node needs a different
   model;
2. set the corresponding `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or
   `ANTHROPIC_API_KEY`;
3. verify that the selected model supports the required image/PDF type;
4. test the provider-native content block through LangChain;
5. verify forced-tool behavior and JSON-string argument handling; and
6. test provider deletion, failure, file-size, and processing-time behavior.

For a provider not supported by `ProviderFileManager`, implement an uploader
that returns the same three ownership artifacts:

```ts
type UploadedProviderFile = {
  contentPart: Record<string, unknown>;
  fileId: string;
  cleanup: () => Promise<void>;
};
```

Do not return raw file bytes inside `contentPart` unless the chosen gateway's
contract deliberately requires it. Keep credential lookup and provider SDK
code outside the graph's domain logic.

## 19. Security and privacy boundary

The current demo has several useful safeguards:

- `basename()` removes directory components from caller configuration.
- The normalized name must exist in a fixed allowlist.
- The model must request exactly the configured name.
- The resolved filesystem URL comes from application code, not model output.
- Zod validates tool arguments before handler execution.
- Captured data must at least parse as a JSON object.
- Successfully returned provider uploads include an explicit cleanup callback.

These controls prevent directory traversal through `config.fileName`, but they
do not make the demo a production document service. In particular:

- the controller currently has no authentication or authorization;
- CORS is configured broadly for the demo;
- selecting a hosted provider sends invoice contents outside the application;
- provider deletion is best effort and subject to provider retention policy;
- session history retains attachment metadata and extracted financial data;
- the output has no strict invoice schema or arithmetic validation; and
- a document can contain adversarial text intended to influence the model.

Before using this pattern with real invoices, define data classification,
provider and region policy, encryption and retention, API authorization,
audit logging, upload limits, malware scanning, schema validation, prompt
injection handling, and human review thresholds.

## 20. Common pitfalls

### Treating prompt instructions as validation

“Call exactly once” and the example JSON are model guidance. The current
handler does not prevent a second valid `capture_json` call in the same batch;
the later call can overwrite context. Add an explicit already-captured guard
when exactly-once semantics matter.

Likewise, multiple `fetch_file` calls can create multiple uploads. Guard the
state transition if duplicate provider work is unacceptable.

### Assuming `forceToolCalls` chooses the workflow

It only requires some tool call. Keep server-side filename, ordering, and
payload validation even when the prompt is strong.

### Returning prose from a JSON graph

`responseMode: "json"` has no chat-envelope fallback. Ensure every successful
path returns an object string, or deliberately throw an error that the caller
can handle.

### Confusing graph `END` with application completion

The edge to LangGraph `END` stops execution for this invocation. `finish()` is
what sets the persistent terminal node and `completed: true`.

### Persisting too much sensitive data

The extracted object appears in local node state, the final response history,
and the API body. File IDs and attachment references also enter history. Review
the session document before deciding it is appropriate for your retention
policy.

### Expecting cleanup to revoke history

Deleting a provider file does not remove the reference from already persisted
messages, and an ignored cleanup failure can leave the provider object alive.

### Using an exact captured fixture as the only quality test

Combine deterministic protocol tests, field/schema tests, arithmetic checks,
representative document sets, and measured extraction-quality evaluations.

### Adding an arbitrary local path option

The bundled map is a security boundary. Replace it only with another trusted
asset-resolution boundary, never with unchecked caller- or model-controlled
filesystem access.

## 21. Design checklist for a new document graph

Before considering a derivative graph complete, answer these questions:

- Is it single-request, or does it have an explicit durable resume design?
- Does every JSON-mode success path return a non-array object?
- Is the selected asset resolved through a trusted identifier?
- Can the model access only the intended file?
- Are tool order and duplicate calls enforced in code?
- Is the captured object validated against a domain schema?
- Are cross-field calculations verified?
- Is provider upload cleanup observable and retryable?
- Is sensitive session duplication understood and bounded?
- Are live model evaluations separated from deterministic tests?
- Are provider capability, cost, retention, and regional constraints tested?

InvoiceGraph demonstrates the essential mechanics with very little topology.
DemoGraph shows how those mechanics fit into a broad multi-turn framework, and
HotelGraph shows how to turn semantic outcomes into a focused business
workflow. Read all three guides before choosing a structure for a new graph.
