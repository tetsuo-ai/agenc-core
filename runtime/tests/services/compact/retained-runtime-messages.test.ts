import { expect, test } from "vitest";
import type { LLMMessage } from "../../../src/llm/types.js";
import { retainedUserPromptByteLimit, retainedUserPromptIndexes } from "../../../src/services/compact/compact.js";
import { toAgenCRuntimeMessages } from "../../../src/session/runtime-message-conversion.js";
import { llmMessageToResponseItem, responseItemToLlmMessage } from "../../../src/session/message-history-conversion.js";

function history(hook = "hook output"): LLMMessage[] {
  return [
    { role: "user", content: "The task", runtimeOnly: { userMessageId: "task", responseItemId: "task" } },
    { role: "assistant", content: "work" },
    { role: "user", content: "Correction: keep the staging endpoint", runtimeOnly: { userMessageId: "correction", responseItemId: "correction" } },
    { role: "assistant", content: "work" },
    { role: "user", content: "Continue generating directly from where you left off..." },
    { role: "assistant", content: "work" },
    { role: "user", content: hook, runtimeOnly: { mergeBoundary: "user_context" } },
    { role: "user", content: "stop-hook feedback" },
    { role: "user", content: "<system-reminder>check the tests</system-reminder>" },
    { role: "user", content: "Compaction removed 3 images" },
  ];
}

test.each(["hook output", "x".repeat(12_750)])("runtime user messages never consume the prompt budget (%#)", hook => {
  const messages = toAgenCRuntimeMessages(history(hook));
  expect([...retainedUserPromptIndexes(messages, messages.length, retainedUserPromptByteLimit(64_000))].sort()).toEqual([0, 2]);
});

test("durable response-item IDs do not turn runtime messages into submitted prompts", () => {
  const messages = history().map((message, index) => ({
    ...message, runtimeOnly: { ...message.runtimeOnly, responseItemId: message.runtimeOnly?.responseItemId ?? `agenc-user-${index}` },
  }));
  const restored = messages.map(message => responseItemToLlmMessage(llmMessageToResponseItem(message)));
  expect(restored[0]?.runtimeOnly?.userMessageId).toBe("task");
  const runtime = toAgenCRuntimeMessages(restored);
  expect([...retainedUserPromptIndexes(runtime, runtime.length)].sort()).toEqual([0, 2]);
});
