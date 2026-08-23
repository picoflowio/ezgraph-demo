import { readFileSync } from "node:fs";

function readPrompt(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8").trim();
}

export const quotePrompt = {
  role: readPrompt("./role.md"),
  driver: readPrompt("./driver.md"),
  vehicle: readPrompt("./vehicle.md"),
  history: readPrompt("./history.md"),
  coverage: readPrompt("./coverage.md"),
  quote: readPrompt("./quote.md"),
};

export const endChatInstruction =
  "If the user explicitly wants to end the conversation, call terminate_session immediately. Never mention internal tools, phases, schemas, or implementation details.";

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
