import { expect, test } from "vitest";
import { listRegisteredModelCatalogEntries, resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";

test("cached bundled metadata matches uncached routes, aliases, misses and eviction", () => {
  const routes = [
    ...["openai", "deepseek", "anthropic", "gemini", "qwen", "zai-coding-plan", "mistral", "amazon-bedrock", "meta"]
      .flatMap(provider => listRegisteredModelCatalogEntries(provider).map(({ model }) => ({ provider, model }))),
    ...["openai", "deepseek", "openrouter", "anthropic", undefined].flatMap(provider =>
      ["unknown-model", "gpt-4o", "deepseek-chat", "anthropic/claude-sonnet-4", " GPT-4O ", undefined]
        .map(model => ({ provider, model }))),
  ];
  for (const route of [...routes, ...routes.slice().reverse()]) {
    const expected = resolveRegisteredModelCatalogEntry(route);
    expect(withOneShotFastMode(() => resolveRegisteredModelCatalogEntry(route))).toEqual(expected);
    expect(withOneShotFastMode(() => resolveRegisteredModelCatalogEntry(route))).toEqual(expected);
  }
});
