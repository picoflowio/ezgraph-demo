import { readFileSync } from "node:fs";

const invoiceInstructions = readFileSync(
  new URL("./invoice.md", import.meta.url),
  "utf8",
);
const invoiceExample = readFileSync(
  new URL("./invoice-example.json", import.meta.url),
  "utf8",
);

/** Prompt and example schema ported from the original invoice flow. */
export const extractInvoicePrompt = `${invoiceInstructions}

## Data Extraction JSON Example
${invoiceExample}`;
