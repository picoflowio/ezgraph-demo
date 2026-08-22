import { readFileSync } from "node:fs";

function readPrompt(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8").trim();
}

export const hotelPrompt = {
  role: readPrompt("./role.md"),
  explore: readPrompt("./explore.md"),
  present: readPrompt("./present.md"),
  compare: readPrompt("./compare.md"),
  exploreTemplate: JSON.parse(readPrompt("./explore.json")) as Record<
    string,
    unknown
  >,
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
