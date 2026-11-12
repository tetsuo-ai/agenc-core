import { expect, test } from "vitest";
import { listRegisteredModelCatalogEntries } from "../../../src/llm/registry/model-catalog.js";
import type { LLMChatOptions } from "../../../src/llm/types.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { compactionProviderOutputReserve } from "../../../src/services/compact/plan.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";

test.each([
  { provider: "openai", model: "gpt-4-turbo", ceiling: 4096, mode: "manual" as const },
  { provider: "qwen", model: "qwen3-32b", ceiling: 8192, mode: "manual" as const },
  { provider: "qwen", model: "qwen3-32b", ceiling: 8192, mode: "automatic" as const },
  { provider: "qwen", model: "qwen-max", ceiling: 8192, mode: "automatic" as const },
])("$provider/$model $mode summary requests fit the model ceiling", async ({ provider, model, ceiling, mode }) => {
  const source = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? "assistant" as const : "user" as const,
    content: `source-${index}:${"x".repeat(1000)}`,
  }));
  const harness = createCompactionTransactionHarness(source, {
    maxOutputTokens: ceiling, contextWindowTokens: 64_000, compactionMode: mode,
  });
  Object.assign(harness.provider, { name: provider });
  Object.assign(harness.context.options!, { mainLoopModel: model });
  try {
    const result = await compactConversation(source, harness.context, "");
    expect(result.transaction).toBeDefined();
    const calls = harness.provider.chat.mock.calls as unknown as [unknown, LLMChatOptions][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, options] of calls) expect(options.maxOutputTokens).toBeLessThanOrEqual(ceiling);
  } finally { harness.close(); }
});

test("every catalog route bounds the summary's total output, including reasoning", () => {
  for (const entry of listRegisteredModelCatalogEntries()) {
    const ceiling = entry.maxOutputTokensUpperLimit ?? entry.maxOutputTokens;
    if (ceiling === undefined) continue;
    expect(compactionProviderOutputReserve(ceiling, entry.provider, entry.model, entry.contextWindow ?? 128_000),
      `${entry.provider}/${entry.model}`).toBeLessThanOrEqual(ceiling);
  }
});

test("non-reasoning models get no reasoning allowance", () => {
  expect(compactionProviderOutputReserve(1024, "openai", "gpt-4-turbo", 128_000)).toBe(1024);
});

test("turn metadata bounds discovered routes and native DeepSeek keeps its reserve", () => {
  expect(compactionProviderOutputReserve(8192, "openai-compatible", "discovered", 128_000,
    { maxOutputTokensUpperLimit: 6000, supportsReasoning: true })).toBe(6000);
  expect(compactionProviderOutputReserve(8192, "deepseek", "deepseek-flash", 128_000)).toBe(8192);
});
