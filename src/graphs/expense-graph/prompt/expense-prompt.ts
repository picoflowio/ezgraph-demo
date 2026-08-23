import { readFileSync } from "node:fs";

const expenseInstructions = readFileSync(
  new URL("./expense.md", import.meta.url),
  "utf8",
);
const expenseExample = readFileSync(
  new URL("./expense-example.json", import.meta.url),
  "utf8",
);

/** Prompt and example schema for hotel-receipt expense extraction. */
export const extractExpensePrompt = `${expenseInstructions}

## Data Extraction JSON Example
${expenseExample}`;
