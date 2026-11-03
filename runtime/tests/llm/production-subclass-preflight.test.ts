import { expect, test, vi } from "vitest";
import { LLMCapabilityError } from "../../src/llm/errors.js";
import { KimiProvider } from "../../src/llm/providers/kimi/index.js";
import { ZaiCodingPlanProvider, ZaiProvider } from "../../src/llm/providers/zai/index.js";
import type { LLMChatOptions, LLMMessage } from "../../src/llm/types.js";

const messages: LLMMessage[] = [{ role: "user", content: "Summarize this request." }];

test.each([
  ["kimi", { stopSequences: ["a", "b", "c", "d", "e", "f"] }],
  ["kimi", { stopSequences: ["é".repeat(17)] }],
  ["kimi", { model: "removed-kimi-model" }],
  ["zai", { temperature: 1.01 }],
  ["zai-coding-plan", { temperature: -0.1 }],
  ["zai-coding-plan", { model: "glm-5.2" }],
] as const)("preflights the production %s subclass request %j", async (name, options) => {
  const fetchImpl = vi.fn<typeof fetch>();
  const provider = name === "kimi"
    ? new KimiProvider({ apiKey: "test-only", model: "kimi-k3", fetchImpl })
    : name === "zai"
      ? new ZaiProvider({ apiKey: "test-only", model: "glm-5.3", fetchImpl })
      : new ZaiCodingPlanProvider({ apiKey: "test-only", model: "glm-5.3", fetchImpl });
  await expect(Promise.resolve().then(() => provider.validateRequest(messages, options as LLMChatOptions)))
    .rejects.toBeInstanceOf(LLMCapabilityError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("production subclass preflight keeps accepted sampling and stop normalization", () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const kimi = new KimiProvider({ apiKey: "test-only", model: "kimi-k3", fetchImpl });
  const zai = new ZaiProvider({ apiKey: "test-only", model: "glm-5.3", temperature: 1, fetchImpl });
  expect(() => kimi.validateRequest(messages, { temperature: 5, stopSequences: ["é".repeat(16)] })).not.toThrow();
  expect(() => zai.validateRequest(messages, {})).not.toThrow();
  expect(() => zai.validateRequest(messages, { temperature: 0 })).not.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
