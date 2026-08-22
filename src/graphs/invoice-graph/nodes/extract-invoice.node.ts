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
} from "ezgraph";
import type { InvoiceGraphStateType } from "../invoice-graph.state.js";
import { extractInvoicePrompt } from "../prompt/invoice-prompt.js";

const bundledInvoices = new Map([
  ["ACME.png", new URL("../data/ACME.png", import.meta.url)],
  ["Evergreen.png", new URL("../data/Evergreen.png", import.meta.url)],
  ["ACME.pdf", new URL("../data/ACME.pdf", import.meta.url)],
  ["Evergreen.pdf", new URL("../data/Evergreen.pdf", import.meta.url)],
  ["invoice-0-4.pdf", new URL("../data/invoice-0-4.pdf", import.meta.url)],
]);

type ExtractInvoiceContext = {
  configuredFileName: string;
  fetched: boolean;
  invoice?: Record<string, unknown>;
};
type ExtractInvoiceNodeState = {
  fileName?: string;
  invoice?: Record<string, unknown>;
};
type FetchInvoiceFileInput = { name: string };
type CaptureInvoiceJsonInput = { json: string };

export type InvoiceFileUploader = {
  uploadFile(filePath: string): Promise<LlmFile>;
};

/** Port of the reference flow's ExtractInvoice3Step for bundled invoice files. */
export class ExtractInvoiceNode extends GraphNode<
  InvoiceGraphStateType,
  ExtractInvoiceNodeState,
  ExtractInvoiceContext
> {
  constructor(
    llmGateway: LlmGateway,
    runtime: GraphNodeRuntime<InvoiceGraphStateType>,
    private readonly uploader?: InvoiceFileUploader,
  ) {
    super(llmGateway, runtime);
  }

  getPrompt(state: InvoiceGraphStateType): string {
    const fileName = this.configuredFileName(state);
    return `${extractInvoicePrompt}

The configured invoice is ${fileName}. Immediately call fetch_file with that exact name. Do not attempt to access any other local path. After the file is attached, extract its data and call capture_json exactly once, with its json argument set to a JSON-encoded string containing the complete invoice object. Never return the invoice JSON as normal chat text.`;
  }

  defineTool(): readonly (
    | ToolDefinition<FetchInvoiceFileInput>
    | ToolDefinition<CaptureInvoiceJsonInput>
  )[] {
    return [
      {
        name: "fetch_file",
        description:
          "Fetch the configured invoice image or PDF for visual extraction.",
        schema: z.object({ name: z.string().min(1) }),
      },
      {
        name: "capture_json",
        description:
          "Submit the complete extracted invoice as a JSON-encoded string.",
        // Keep the extracted object in a JSON string so the tool contract remains
        // portable across providers and can be validated after the call.
        schema: z.object({ json: z.string().min(2) }),
      },
    ];
  }

  @Tool("fetch_file")
  async fetchFile(
    { name }: FetchInvoiceFileInput,
    context: ExtractInvoiceContext,
  ): Promise<ConversationToolResult> {
    if (name !== context.configuredFileName) {
      return {
        output: {
          attached: false,
          error: `Only the configured invoice '${context.configuredFileName}' may be fetched.`,
        },
      };
    }

    const asset = bundledInvoices.get(name);
    if (!asset) {
      return {
        output: {
          attached: false,
          error: `Invoice '${name}' is unavailable.`,
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
              text: "The requested invoice file is attached. Analyze it and call capture_json with the completed extraction.",
            },
            upload.contentPart as any,
          ],
        }),
      ],
    };
  }

  @Tool("capture_json")
  async captureJson(
    { json: encodedJson }: CaptureInvoiceJsonInput,
    context: ExtractInvoiceContext,
  ): Promise<ConversationToolResult> {
    try {
      const json = JSON.parse(encodedJson);
      if (!context.fetched) {
        return {
          output: {
            captured: false,
            error: "Fetch the configured invoice before submitting JSON.",
          },
        };
      }
      context.invoice = json;
      return { output: { captured: true }, stopAfterBatch: true };
    } catch {
      throw new Error("capture_json.json must be a valid JSON object string.");
    }
  }

  async run(
    state: InvoiceGraphStateType,
  ): Promise<GraphNodeUpdate<InvoiceGraphStateType>> {
    const savedInvoice = this.state(state).invoice;
    if (savedInvoice) {
      return this.complete(JSON.stringify(savedInvoice, null, 2));
    }

    const context: ExtractInvoiceContext = {
      configuredFileName: this.configuredFileName(state),
      fetched: false,
    };
    const conversation = await this.runConversation(state, context);
    if (!context.invoice) {
      return this.stay(conversation);
    }

    const response = JSON.stringify(context.invoice, null, 2);
    return this.finish(response, conversation).withState({
      fileName: context.configuredFileName,
      invoice: context.invoice,
    });
  }

  /** Demonstrates the extension point for an invalid final JSON response. */
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

  private configuredFileName(state: InvoiceGraphStateType): string {
    const configured = state.config.fileName;
    if (typeof configured !== "string" || !configured.trim()) {
      throw new Error(
        `InvoiceGraph requires config.fileName (${this.supportedInvoiceNames()}).`,
      );
    }
    const fileName = basename(configured.trim());
    if (!bundledInvoices.has(fileName)) {
      throw new Error(
        `InvoiceGraph config.fileName must be one of ${this.supportedInvoiceNames()}.`,
      );
    }
    return fileName;
  }

  private supportedInvoiceNames(): string {
    return [...bundledInvoices.keys()].map((name) => `'${name}'`).join(", ");
  }
}
