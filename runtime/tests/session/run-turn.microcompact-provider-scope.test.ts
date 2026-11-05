import { expect, test } from "vitest";

import type { LLMMessage } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

/** How microcompaction replaces an old standalone tool result. */
const CLEARED = /^\[microcompact:\d+\] Older tool output compressed/;

/** Twelve 20 KB log reads: well past the 120,000-character microcompaction valve. */
function logHistory(): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: "user", content: "Inspect every log." }];
  for (let index = 0; index < 12; index++) {
    messages.push(
      { role: "assistant", content: "Read the next log.", toolCalls: [{ id: `call-${index}`, name: "exec_command", arguments: "{}" }] },
      { role: "tool", toolCallId: `call-${index}`, toolName: "exec_command", content: `Log ${index}\n${"evidence ".repeat(2300)}` },
    );
  }
  messages.push({ role: "assistant", content: "All logs read." });
  return messages;
}

test.each([
  { provider: "deepseek", cleared: false },
  { provider: "openai-compatible", cleared: true },
  { provider: "openrouter", cleared: true },
  { provider: "anthropic", cleared: true },
  { provider: "gemini", cleared: true },
  { provider: "openai", cleared: true },
  { provider: "grok", cleared: true },
  { provider: "local-test", cleared: true },
])("$provider: old tool output is cleared by microcompaction: $cleared", async ({ provider, cleared }) => {
  const seen: LLMMessage[][] = [];
  const llm = mkProvider({ content: "Done." }, { onChatStream: (messages) => seen.push(messages) });
  const { session } = mkSession({ provider: llm, history: logHistory(), modelInfo: { contextWindow: 1_048_576 } });
  Object.assign(session.config, { taskTokenBudget: 0 });
  await drain(runTurn(session, mkCtx({ modelProviderId: provider, modelInfo: session.modelInfo }), "Summarize the logs."));
  expect(seen).toHaveLength(1);
  const results = seen[0]!.filter((message) => message.role === "tool").map((message) => String(message.content));
  expect(results).toHaveLength(12);
  expect(results.some((content) => CLEARED.test(content))).toBe(cleared);
  // The newest results always reach the model in full.
  expect(results.slice(-5).every((content) => content.startsWith("Log "))).toBe(true);
});
