import { emptyTokenUsage, type ConversationRunResult, type TokenUsage } from "ezgraph";

/**
 * A completed node turn that did not run the shared agent loop.
 *
 * The semantic-outcome builders (`resumeAt`, `advance`, `stay`) all record the
 * conversation that produced them. A worker GraphNode that decides
 * deterministically, or that calls the model once through the gateway instead
 * of through `runConversation()`, still has to report its messages and token
 * usage. This is that report.
 */
export function deterministicTurn(
  usage: TokenUsage = emptyTokenUsage(),
): ConversationRunResult {
  return { messages: [], usage, stoppedAfterTool: false };
}
