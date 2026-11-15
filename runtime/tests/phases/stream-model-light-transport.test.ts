import { describe, expect, test } from "vitest";

import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { scheduleProviderStartupPrewarm } from "../../src/session/startup-prewarm.js";
import type { LLMProviderStartupPrewarmParams } from "../../src/llm/types.js";

function sessionFor(provider: string, runtimeOptions: Record<string, unknown>, starts: LLMProviderStartupPrewarmParams[] = []) {
  return {
    conversationId: "light-transport",
    config: { model: "m" },
    services: {
      provider: {
        name: provider,
        // Called detached, as the session calls it.
        prewarmStartup: (params: LLMProviderStartupPrewarmParams): void => {
          starts.push(params);
        },
      },
      runtimeOptions,
    },
  };
}

function optionsFor(provider: string, runtimeOptions: Record<string, unknown>) {
  const request = { tools: [], parallelToolCalls: false, baseInstructions: "SYSTEM" };
  return buildProviderOptions(
    request as never,
    { modelInfo: { slug: "m" } } as never,
    new AbortController().signal,
    sessionFor(provider, runtimeOptions) as never,
  );
}

describe("Light sessions on the openai provider are marked for its WebSocket transport", () => {
  test("only a Light session on openai marks its calls", () => {
    expect(optionsFor("openai", { lightMode: true }).lightSession).toBe(true);
    expect("lightSession" in optionsFor("openai", { lightMode: false })).toBe(false);
    expect("lightSession" in optionsFor("openai", {})).toBe(false);
    expect("lightSession" in optionsFor("openai", { lightMode: true, simpleMode: true })).toBe(false);
  });

  test("the options of every other provider are the same with and without Light", () => {
    for (const provider of ["deepseek", "grok", "openrouter", "anthropic", "meta"]) {
      const light = optionsFor(provider, { lightMode: true });
      expect("lightSession" in light, provider).toBe(false);
      const { signal: _lightSignal, ...lightRest } = light;
      const { signal: _signal, ...rest } = optionsFor(provider, { lightMode: false });
      expect(Object.keys(lightRest).sort(), provider).toEqual(Object.keys(rest).sort());
    }
  });

  test("the session start tells the provider the same", () => {
    const starts: LLMProviderStartupPrewarmParams[] = [];
    scheduleProviderStartupPrewarm(sessionFor("openai", { lightMode: true }, starts) as never, "thread-1");
    scheduleProviderStartupPrewarm(sessionFor("openai", { lightMode: false }, starts) as never, "thread-2");
    scheduleProviderStartupPrewarm(sessionFor("deepseek", { lightMode: true }, starts) as never, "thread-3");
    expect(starts).toEqual([
      { conversationId: "light-transport", threadId: "thread-1", lightSession: true },
      { conversationId: "light-transport", threadId: "thread-2" },
      { conversationId: "light-transport", threadId: "thread-3" },
    ]);
  });
});
