import { describe, expect, test, vi } from "vitest";

import { parseAnthropicMessagesResponse } from "../../src/llm/wire/messages-anthropic.js";
import { billableTokenUsage } from "../../src/llm/usage.js";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import { TaskBudget } from "../../src/session/task-budget.js";
import { sseResponse } from "../llm/providers/anthropic/stream-test-helpers.js";

const MODEL = "claude-sonnet-4.5";

function response(usage: Record<string, unknown>) {
  return parseAnthropicMessagesResponse(
    MODEL,
    { model: MODEL, stop_reason: "end_turn", content: [], usage },
    { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [] },
  );
}

describe("Anthropic negative cache counters", () => {
  test.each([
    ["read", { cache_read_input_tokens: -500 }],
    ["write", { cache_creation_input_tokens: -500 }],
    ["read and write", { cache_read_input_tokens: -500, cache_creation_input_tokens: -500 }],
  ] as const)("negative %s usage cannot credit previous task spend", async (_label, cache) => {
    const budget = new TaskBudget(1000);
    await budget.invoke(100, async () => response({ input_tokens: 100, output_tokens: 0 }));
    expect(budget.tokens).toBe(100);

    const next = response({ input_tokens: 120, output_tokens: 348, ...cache });
    await budget.invoke(468, async () => next);

    expect(budget.tokens).toBe(568);
    expect(next.usage.totalTokens).toBe(468);
    expect(billableTokenUsage(next.usage)).toEqual({ inputTokens: 120, outputTokens: 348 });
    if ("cache_read_input_tokens" in cache) expect(next.usage.cachedInputTokens).toBe(0);
    if ("cache_creation_input_tokens" in cache) expect(next.usage.cacheCreationInputTokens).toBe(0);
    expect(() => budget.assertFits(433)).toThrow("Task budget reached");
  });

  test.each([
    ["read", { cache_read_input_tokens: -500, cache_creation_input_tokens: 1024 }, 1492,
      { cachedInputTokens: 0, cacheCreationInputTokens: 1024 }],
    ["write", { cache_read_input_tokens: 2048, cache_creation_input_tokens: -500 }, 2516,
      { cachedInputTokens: 2048, cacheCreationInputTokens: 0 }],
  ] as const)("negative %s count does not subtract from a valid other cache bucket", (_label, cache, total, fields) => {
    const usage = response({ input_tokens: 120, output_tokens: 348, ...cache }).usage;
    expect(usage).toMatchObject({ totalTokens: total, ...fields });
    expect(billableTokenUsage(usage)).toEqual({ inputTokens: total - 348, outputTokens: 348 });
  });

  test.each(["chat", "stream"] as const)("%s cannot credit task spend from malformed cache usage", async (transport) => {
    const usage = { input_tokens: 120, output_tokens: 348,
      cache_read_input_tokens: -500, cache_creation_input_tokens: -500 };
    const frame = (event: string, data: Record<string, unknown>) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => transport === "chat"
      ? Response.json({ model: MODEL, stop_reason: "end_turn", content: [], usage })
      : sseResponse([
        frame("message_start", { message: { model: MODEL, usage: { ...usage, output_tokens: 0 } } }),
        frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 348 } }),
        frame("message_stop", { type: "message_stop" }),
      ]));
    const provider = new AnthropicProvider({ apiKey: "anthropic-test", model: MODEL, fetchImpl });
    const budget = new TaskBudget(1000);
    await budget.invoke(100, async () => response({ input_tokens: 100, output_tokens: 0 }));
    const messages = [{ role: "user" as const, content: "hi" }];
    const next = await budget.invoke(468, () => transport === "chat"
      ? provider.chat(messages)
      : provider.chatStream(messages, () => {}));
    expect(next.usage).toMatchObject({ totalTokens: 468, cachedInputTokens: 0,
      cacheCreationInputTokens: 0, availability: "reported" });
    expect(budget.tokens).toBe(568);
    expect(() => budget.assertFits(433)).toThrow("Task budget reached");
  });
});
