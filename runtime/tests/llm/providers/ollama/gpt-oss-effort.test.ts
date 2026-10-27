import { describe, expect, test } from "vitest";

import { OllamaProvider } from "./adapter.js";
import type { LLMChatOptions, LLMMessage } from "../../../../src/llm/types.js";
import { resolveReasoningEffort } from "../../../../src/llm/reasoning-effort.js";
import { reasoningEffortAcceptedByModel } from "../../../../src/session/reasoning-effort-for-model.js";
import { isOllamaGptOssModel, ollamaGptOssThinkLevel } from "../../../../src/llm/registry/ollama-gpt-oss.js";

async function profiledParams(provider: OllamaProvider, messages: LLMMessage[], options: LLMChatOptions = {}) {
  (provider as unknown as { client: unknown }).client = {};
  const profile = await provider.getExecutionProfile(options);
  return (provider as any).buildParams(messages, {
    ...options,
    providerExecutionHandle: profile.providerExecutionHandle,
  }) as Record<string, unknown>;
}

describe("gpt-oss effort on a local Ollama server", () => {
  test.each([
    ["gpt-oss:20b", true],
    ["gpt-oss:120b", true],
    ["gpt-oss", true],
    ["GPT-OSS:latest", true],
    ["library/gpt-oss:20b", true],
    ["gpt-oss-safeguard:20b", true],
    ["gptoss-test:20b", false],
    ["hf.co/unsloth/gpt-oss-20b-GGUF:F16", false],
    ["qwen3:8b", false],
    [undefined, false],
  ])("%s is a gpt-oss library model: %s", (model, expected) => {
    expect(isOllamaGptOssModel(model)).toBe(expected);
  });

  test("the levels are low, medium and high, and only for gpt-oss", () => {
    expect(resolveReasoningEffort({ provider: "ollama", model: "gpt-oss:20b" })).toMatchObject({
      levels: ["low", "medium", "high"],
      acceptsChatEffort: true,
    });
    expect(resolveReasoningEffort({ provider: "ollama", model: "qwen3:8b" })).toMatchObject({
      levels: [],
      acceptsChatEffort: false,
    });
    expect(reasoningEffortAcceptedByModel({ provider: "ollama", model: "gpt-oss:20b", reasoningEffort: "high" })).toBe(true);
    expect(reasoningEffortAcceptedByModel({ provider: "ollama", model: "gpt-oss:20b", reasoningEffort: "max" })).toBe(false);
    expect(reasoningEffortAcceptedByModel({ provider: "ollama", model: "qwen3:8b", reasoningEffort: "high" })).toBe(false);
  });

  test.each([
    ["none", "low"], ["minimal", "low"], ["low", "low"], ["medium", "medium"],
    ["high", "high"], ["xhigh", "high"], ["max", "high"], [undefined, undefined],
  ])("effort %s is think %s", (effort, think) => {
    expect(ollamaGptOssThinkLevel(effort)).toBe(think);
  });

  test("the request carries the session's level as think", async () => {
    const provider = new OllamaProvider({ model: "gpt-oss:20b" });
    const messages: LLMMessage[] = [{ role: "user", content: "hi" }];
    expect((await profiledParams(provider, messages, { reasoningEffort: "high" })).think).toBe("high");
    expect((await profiledParams(provider, messages, { reasoningEffort: "low" })).think).toBe("low");
    expect(await profiledParams(provider, messages)).not.toHaveProperty("think");
  });

  test("other models get no think field, whatever the effort", async () => {
    const provider = new OllamaProvider({ model: "qwen3:8b" });
    expect(await profiledParams(provider, [{ role: "user", content: "hi" }], { reasoningEffort: "high" }))
      .not.toHaveProperty("think");
  });
});
