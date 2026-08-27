import { createGraphStateAnnotation } from "@picoflow/ezgraph";
import type { NodeStateValue } from "@picoflow/ezgraph";
import { ExtractExpenseNode } from "./nodes/extract-expense.node.js";

export type ExpenseGraphNodes = {
  ExtractExpenseNode?: NodeStateValue<{
    fileName?: string;
    expense?: Record<string, unknown>;
  }>;
};

export const ExpenseGraphState = createGraphStateAnnotation(
  ExtractExpenseNode.name,
  () => ({} as ExpenseGraphNodes),
);

export type ExpenseGraphStateType = typeof ExpenseGraphState.State;
