import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  ConversationNode,
  ModelCatalog,
  Tool,
  ProviderFileManager,
  finish,
  stay,
  type ToolResponse,
  type InvalidJsonResponseContext,
  type LlmGateway,
  type GraphNodeRuntime,
  type GraphNodeResult,
  type GraphNodeUpdate,
  type ToolDefinition,
  type LlmFile,
} from "@picoflow/ezgraph";
import type { ExpenseGraphStateType } from "../expense-graph.state.js";
import { extractExpensePrompt } from "../prompt/expense-prompt.js";

const bundledReceipts = new Map([
  ["GrandSequoia.pdf", new URL("../data/GrandSequoia.pdf", import.meta.url)],
]);

type FetchReceiptFileInput = { name: string };
type CaptureExpenseJsonInput = { json: string };

export type ReceiptFileUploader = {
  uploadFile(filePath: string): Promise<LlmFile>;
};

/**
 * Single-request vision extraction of a hotel receipt: the configured folio
 * PDF is uploaded to the provider, read visually, and captured as itemized
 * expense JSON before the graph completes.
 */
export class ExtractExpenseNode extends ConversationNode<ExpenseGraphStateType> {
  constructor(
    llmGateway: LlmGateway,
    runtime: GraphNodeRuntime<ExpenseGraphStateType>,
    private readonly uploader?: ReceiptFileUploader,
  ) {
    super(llmGateway, runtime);
  }

  getPrompt(state: ExpenseGraphStateType): string {
    const fileName = this.configuredFileName(state);
    return `${extractExpensePrompt}

The configured receipt is ${fileName}. Immediately call fetch_file with that exact name. Do not attempt to access any other local path. After the file is attached, extract its data and call capture_json exactly once, with its json argument set to a JSON-encoded string containing the complete expense object. Never return the expense JSON as normal chat text.`;
  }

  defineTool(): readonly (
    | ToolDefinition<FetchReceiptFileInput>
    | ToolDefinition<CaptureExpenseJsonInput>
  )[] {
    return [
      {
        name: "fetch_file",
        description:
          "Fetch the configured hotel receipt PDF for visual extraction.",
        schema: z.object({ name: z.string().min(1) }),
      },
      {
        name: "capture_json",
        description:
          "Submit the complete extracted expense report as a JSON-encoded string.",
        // Keep the extracted object in a JSON string so the tool contract remains
        // portable across providers and can be validated after the call.
        schema: z.object({ json: z.string().min(2) }),
      },
    ];
  }

  @Tool("fetch_file")
  async fetchFile(
    { name }: FetchReceiptFileInput,
  ): Promise<ToolResponse> {
    const configuredFileName = this.configuredFileName(this.graph.graphState());
    if (name !== configuredFileName) {
      return stay(JSON.stringify({
          attached: false,
          error: `Only the configured receipt '${configuredFileName}' may be fetched.`,
        }));
    }

    const asset = bundledReceipts.get(name);
    if (!asset) {
      return stay(JSON.stringify({
          attached: false,
          error: `Receipt '${name}' is unavailable.`,
        }));
    }
    const upload = await (
      this.uploader ??
      new ProviderFileManager(
        ModelCatalog.resolveModelDescriptor(this.llmConfig()).provider,
      )
    ).uploadFile(fileURLToPath(asset));
    this.saveState({ fileName: name });
    return stay(JSON.stringify({ attached: true, fileName: name, fileId: upload.fileId }))
      .withCleanup(upload.cleanup)
      .withMessages([
        new HumanMessage({
          content: [
            {
              type: "text",
              text: "The requested receipt file is attached. Analyze it and call capture_json with the completed extraction.",
            },
            upload.contentPart as any,
          ],
        }),
      ]);
  }

  @Tool("capture_json")
  async captureJson(
    { json: encodedJson }: CaptureExpenseJsonInput,
  ): Promise<ToolResponse> {
    try {
      const json = JSON.parse(encodedJson);
      if (this.getState().fileName !== this.configuredFileName(this.graph.graphState())) {
        return stay(JSON.stringify({
            captured: false,
            error: "Fetch the configured receipt before submitting JSON.",
          }));
      }
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return stay(JSON.stringify({
          captured: false,
          error: "capture_json.json must encode an expense object.",
        }));
      }
      const expense = json as Record<string, unknown>;
      this.saveState({
        fileName: this.configuredFileName(this.graph.graphState()),
        expense,
      });
      return finish(JSON.stringify(expense, null, 2));
    } catch {
      throw new Error("capture_json.json must be a valid JSON object string.");
    }
  }

  async run(
    state: ExpenseGraphStateType,
  ): Promise<GraphNodeResult<ExpenseGraphStateType>> {
    const savedExpense = this.state(state).expense;
    if (savedExpense) {
      return this.complete(JSON.stringify(savedExpense, null, 2));
    }

    return super.run(state);
  }

  /** An invalid final JSON response fails the request rather than shipping junk. */
  protected override async onInvalidJsonResponse(
    context: InvalidJsonResponseContext<ExpenseGraphStateType>,
  ): Promise<GraphNodeUpdate<ExpenseGraphStateType>> {
    throw context.error;
  }

  private configuredFileName(state: ExpenseGraphStateType): string {
    const configured = state.config.fileName;
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error(
        `ExpenseGraph requires config.fileName (${this.supportedReceiptNames()}).`,
      );
    }
    const fileName = basename(configured.trim());
    if (!bundledReceipts.has(fileName)) {
      throw new Error(
        `ExpenseGraph config.fileName must be one of ${this.supportedReceiptNames()}.`,
      );
    }
    return fileName;
  }

  private supportedReceiptNames(): string {
    return [...bundledReceipts.keys()].map((name) => `'${name}'`).join(", ");
  }
}
