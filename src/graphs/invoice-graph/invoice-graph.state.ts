import { createGraphStateAnnotation } from "ezgraph";
import type { NodeStateValue } from "ezgraph";
import { ExtractInvoiceNode } from "./nodes/extract-invoice.node.js";

export type InvoiceGraphNodes = {
  ExtractInvoiceNode?: NodeStateValue<{
    fileName?: string;
    invoice?: Record<string, unknown>;
  }>;
};

export const InvoiceGraphState = createGraphStateAnnotation(
  ExtractInvoiceNode.name,
  () => ({} as InvoiceGraphNodes),
);

export type InvoiceGraphStateType = typeof InvoiceGraphState.State;
