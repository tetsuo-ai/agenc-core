import { expect, test } from "vitest";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { parseChatCompletionsResponse } from "../../src/llm/wire/chat-completions.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";

test("deferred request metrics match normal metrics and retain their original history length", () => {
  const messages = [{ role: "user" as const, content: "hello" }];
  const request = { model: "test-model", messages, tools: [] };
  const response = { model: "test-model", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: {} };
  const normal = parseChatCompletionsResponse("test-model", response, request);
  const fast = withOneShotFastMode(() => parseChatCompletionsResponse("test-model", response, request));
  messages.push({ role: "user", content: "later request" });
  expect(fast.requestMetrics).toEqual(normal.requestMetrics);
  expect(fast.requestMetrics).toBe(fast.requestMetrics);
});

test("cached capability hints follow request-scoped model changes without changing request bodies", () => {
  const provider = new OpenAIProvider({ model: "gpt-5", apiKey: "fixture", useResponsesApi: false });
  const prepare = (model: string) => (provider as unknown as {
    prepareChatCompletionsRequest(input: unknown): unknown;
  }).prepareChatCompletionsRequest({ model, messages: [{ role: "user", content: "hello" }], tools: [], options: { maxOutputTokens: 128 } });
  for (const model of ["gpt-5", "gpt-5", "gpt-4o", "gpt-5"]) {
    expect(withOneShotFastMode(() => prepare(model))).toEqual(prepare(model));
  }
});
