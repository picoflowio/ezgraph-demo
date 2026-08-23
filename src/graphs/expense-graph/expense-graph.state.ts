import { createGraphStateAnnotation } from "ezgraph";
import type { NodeStateValue } from "ezgraph";
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
