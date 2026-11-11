import assert from "node:assert/strict";
import { test } from "node:test";
import "dotenv/config";
import { z } from "zod";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ModelCatalog, LangChainLlmGateway } from "@picoflow/ezgraph";

test("Bedrock configured ARN: text, structured output, tools, and tool-result history", { timeout: 180_000 }, async () => {
  assert.ok(process.env.BEDROCK_ARN, "Set BEDROCK_ARN in .env");
  assert.ok(process.env.BEDROCK_API_KEY, "Set BEDROCK_API_KEY in .env");
  const config = ModelCatalog.model("bedrock:configured", { retries: 0, maxOutputTokens: 1024 });
  const gateway = new LangChainLlmGateway(config);
  const policy = { timeoutMs: 30_000 };
  const text = await gateway.generate("Follow the instruction precisely.", "Reply with exactly BEDROCK_OK.", config, policy);
  assert.match(text.value, /BEDROCK_OK/);
  assert.ok(text.usage.total_tokens > 0);
  const schema = z.object({ answer: z.number() });
  const structured = await gateway.structured(schema, "Use the provided tool to return the answer.", "What is 6 multiplied by 7?", "answer", config, undefined, policy);
  assert.equal(structured.value.answer, 42);
  const tools = [{ name: "answer", description: "Return the numeric answer using this tool.", schema }];
  const call = await gateway.toolCall("Always call the answer tool.", "What is 6 multiplied by 7?", tools, config, undefined, policy);
  assert.deepEqual(call.value, { name: "answer", args: { answer: 42 } });
  const history = [new HumanMessage("Use the answer tool to calculate 6 multiplied by 7.")];
  const agent = await gateway.agent("Always call the answer tool to answer the user.", history, tools, config, policy);
  const toolCall = agent.value.tool_calls?.[0];
  assert.equal(toolCall?.name, "answer");
  assert.equal(toolCall?.args.answer, 42);
  assert.ok(toolCall?.id);
  const final = await gateway.respond("Report the tool result to the user.", [
    ...history, agent.value, new ToolMessage({ content: "42", tool_call_id: toolCall.id }),
  ], config, policy);
  assert.match(final.value, /42/);
});
