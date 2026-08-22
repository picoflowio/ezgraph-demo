import { readFileSync } from "node:fs";

function readPrompt(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8").trim();
}

export const supportPrompt = {
  role: readPrompt("./role.md"),
  triage: readPrompt("./triage.md"),
  returns: readPrompt("./returns.md"),
  approval: readPrompt("./approval.md"),
  billing: readPrompt("./billing.md"),
  escalate: readPrompt("./escalate.md"),
};

export const endChatInstruction =
  "If the user explicitly wants to end the conversation, call terminate_session immediately. Never mention internal tools, stages, node names, schemas, or implementation details.";

export function fillPrompt(
  prompt: string,
  replacements: Record<string, string>,
): string {
  let filled = prompt;
  for (const [name, value] of Object.entries(replacements)) {
    filled = filled.replaceAll(`{{${name}}}`, value);
  }
  return filled;
}
