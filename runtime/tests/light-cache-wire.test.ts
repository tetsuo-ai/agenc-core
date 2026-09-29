import assert from "node:assert/strict";
import { test } from "vitest";
import type { LLMMessage, LLMTool } from "../src/llm/types.js";
import { buildToolRegistry } from "../src/tool-registry.js";
import { buildOpenAIResponsesRequest } from "../src/llm/wire/responses-openai.js";
import { buildChatCompletionsRequest } from "../src/llm/wire/chat-completions.js";
import { buildXaiResponsesRequest } from "../src/llm/wire/responses-xai.js";
import { toXaiResponsesTools } from "../src/llm/wire/tools.js";

test("advanced discovery preserves each provider schema prefix", async () => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, requireAdmission: false });
  const initial = registry.toLLMTools();
  const search = registry.tools.find(tool => tool.name === "system.searchTools")!;
  const result = await search.execute({ select: "exec_command" });
  assert(JSON.parse(result.content).argumentSchemas[0].parameters.properties.yield_time_ms);
  assert.deepEqual(registry.toLLMTools(), initial);

  const messages: LLMMessage[] = [
    { role: "system", content: "Fixed instructions." },
    { role: "user", content: "Inspect the advanced arguments." },
  ];
  const later: LLMMessage[] = [
    ...messages,
    { role: "assistant", content: "", toolCalls: [{ id: "probe", name: "system.searchTools", arguments: '{"select":"exec_command"}' }] },
    { role: "tool", toolCallId: "probe", content: result.content },
  ];
  type Input = { model: string; messages: LLMMessage[]; tools: LLMTool[] };
  const cases: Array<{ model: string; build: (input: Input) => Record<string, unknown> }> = [
    { model: "gpt-6-luna", build: buildOpenAIResponsesRequest },
    { model: "gpt-6-sol", build: buildOpenAIResponsesRequest },
    { model: "deepseek-flash", build: buildChatCompletionsRequest },
    { model: "deepseek-v4-pro", build: buildChatCompletionsRequest },
    { model: "MiniMax-M3", build: buildChatCompletionsRequest },
    { model: "grok-4.7", build: input => buildXaiResponsesRequest({ ...input, tools: toXaiResponsesTools(input.tools) }) },
  ];
  for (const { model, build } of cases) {
    const before = build({ model, messages, tools: initial });
    const after = build({ model, messages: later, tools: registry.toLLMTools() });
    assert.deepEqual(after.tools, before.tools, model);
    assert(JSON.stringify(after).includes("argumentSchemas"), model);
  }
  await search.execute({ select: "TodoWrite" });
  assert.deepEqual(registry.toLLMTools().slice(0, initial.length), initial);
});
