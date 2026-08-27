import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  GraphNode,
  ModelCatalog,
  Tool,
  ProviderFileManager,
  type ConversationToolResult,
  type InvalidJsonResponseContext,
  type LlmGateway,
  type GraphNodeRuntime,
  type GraphNodeUpdate,
  type ToolDefinition,
  type LlmFile,
} from "@picoflow/ezgraph";
import type { ExpenseGraphStateType } from "../expense-graph.state.js";
import { extractExpensePrompt } from "../prompt/expense-prompt.js";

const bundledReceipts = new Map([
  ["GrandSequoia.pdf", new URL("../data/GrandSequoia.pdf", import.meta.url)],
]);

type ExtractExpenseContext = {
  configuredFileName: string;
  fetched: boolean;
  expense?: Record<string, unknown>;
};
type ExtractExpenseNodeState = {
  fileName?: string;
  expense?: Record<string, unknown>;
};
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
export class ExtractExpenseNode extends GraphNode<
  ExpenseGraphStateType,
  ExtractExpenseNodeState,
  ExtractExpenseContext
> {
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
    context: ExtractExpenseContext,
  ): Promise<ConversationToolResult> {
    if (name !== context.configuredFileName) {
      return {
        output: {
          attached: false,
          error: `Only the configured receipt '${context.configuredFileName}' may be fetched.`,
        },
      };
    }

    const asset = bundledReceipts.get(name);
    if (!asset) {
      return {
        output: {
          attached: false,
          error: `Receipt '${name}' is unavailable.`,
        },
      };
    }
    const upload = await (
      this.uploader ??
      new ProviderFileManager(
        ModelCatalog.resolveModelDescriptor(this.llmConfig()).provider,
      )
    ).uploadFile(fileURLToPath(asset));
    context.fetched = true;
    return {
      output: { attached: true, fileName: name, fileId: upload.fileId },
      cleanup: upload.cleanup,
      messages: [
        new HumanMessage({
          content: [
            {
              type: "text",
              text: "The requested receipt file is attached. Analyze it and call capture_json with the completed extraction.",
            },
            upload.contentPart as any,
          ],
        }),
      ],
    };
  }

  @Tool("capture_json")
  async captureJson(
    { json: encodedJson }: CaptureExpenseJsonInput,
    context: ExtractExpenseContext,
  ): Promise<ConversationToolResult> {
    try {
      const json = JSON.parse(encodedJson);
      if (!context.fetched) {
        return {
          output: {
            captured: false,
            error: "Fetch the configured receipt before submitting JSON.",
          },
        };
      }
      context.expense = json;
      return { output: { captured: true }, stopAfterBatch: true };
    } catch {
      throw new Error("capture_json.json must be a valid JSON object string.");
    }
  }

  async run(
    state: ExpenseGraphStateType,
  ): Promise<GraphNodeUpdate<ExpenseGraphStateType>> {
    const savedExpense = this.state(state).expense;
    if (savedExpense) {
      return this.complete(JSON.stringify(savedExpense, null, 2));
    }

    const context: ExtractExpenseContext = {
      configuredFileName: this.configuredFileName(state),
      fetched: false,
    };
    const conversation = await this.runConversation(state, context);
    if (!context.expense) {
      return this.stay(conversation);
    }

    const response = JSON.stringify(context.expense, null, 2);
    return this.finish(response, conversation).withState({
      fileName: context.configuredFileName,
      expense: context.expense,
    });
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
