import { expect, test } from "vitest";
import { messagesAfterAgenCBoundary } from "../../src/session/run-turn-query-messages.js";
import type { LLMMessage } from "../../src/llm/types.js";

test("outbound context retains the exact user request before a canonical compaction marker", () => {
  const user: LLMMessage = { role: "user", content: "Audit only 01 through 12; one separate raw read per batch." };
  const result: LLMMessage = { role: "tool", toolCallId: "read", content: "batch 02 total 150, latency 71775" };
  const messages: LLMMessage[] = [user, {
    role: "developer", content: "compaction marker",
    runtimeOnly: { compactionHistory: {
      version: 1, kind: "boundary", attempt_id: "compact-test", summary_sha256: "a".repeat(64),
    } },
  }, { role: "user", content: "batch 01 completed; next 02" }, {
    role: "assistant", content: "", toolCalls: [{ id: "read", name: "exec_command", arguments: '{}' }],
  }, result];
  expect(messagesAfterAgenCBoundary(messages)).toEqual([user, ...messages.slice(2)]);
  expect(messagesAfterAgenCBoundary(messages).at(-1)).toEqual(result);
});
