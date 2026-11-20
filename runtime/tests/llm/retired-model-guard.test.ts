import { afterEach, describe, expect, test, vi } from "vitest";

import { isLLMPreGenerationRejection, LLMModelRetiredError } from "../../src/llm/errors.js";
import { createProvider } from "../../src/llm/provider.js";
import { refuseRetiredModelRequests } from "../../src/llm/retired-model-guard.js";
import type { LLMProvider } from "../../src/llm/types.js";
import { isTransientProviderError } from "../../src/recovery/api-errors.js";

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);
const HI = [{ role: "user" as const, content: "hi" }];
const ollamaReply = () => Response.json({
  id: "chat_1", model: "minimax-m3.1-flash",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

afterEach(() => {
  vi.useRealTimers();
});

/** A provider whose every method records that it was reached. */
function fakeProvider() {
  const calls: string[] = [];
  const provider = {
    name: "openai",
    chat: async () => { calls.push("chat"); return { content: "ok" }; },
    chatStream: async () => { calls.push("chatStream"); return { content: "ok" }; },
    healthCheck: async () => true,
    prewarmStartup: () => { calls.push("prewarm"); },
  } as unknown as LLMProvider;
  return { provider, calls };
}

describe("a request for a model its provider retired", () => {
  test("is refused before it is sent, with the plain notice, from the date on", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-12-11", "00:00:00.000") });
    const { provider, calls } = fakeProvider();
    refuseRetiredModelRequests(provider, "openai", "gpt-5", undefined);
    const refused = await provider.chatStream(HI, () => {}).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(LLMModelRetiredError);
    expect((refused as Error).message).toBe("OpenAI retired 'gpt-5' on 2026-12-11. Pick another model.");
    // Admission settles a call refused before generation at zero usage.
    expect(isLLMPreGenerationRejection(refused, "openai")).toBe(true);
    expect(isTransientProviderError(refused)).toBe(false);
    await expect(provider.chat(HI)).rejects.toBeInstanceOf(LLMModelRetiredError);
    expect(provider.prewarmStartup?.({ conversationId: "c", threadId: "c" })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("is sent the day before, and the date is read at every request", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-12-10", "23:59:59.000") });
    const { provider, calls } = fakeProvider();
    refuseRetiredModelRequests(provider, "openai", "o3-pro", undefined);
    await provider.chatStream(HI, () => {});
    await provider.chat(HI);
    provider.prewarmStartup?.({ conversationId: "c", threadId: "c" });
    expect(calls).toEqual(["chatStream", "chat", "prewarm"]);
    // The same provider, still open when the date arrives, stops sending.
    vi.setSystemTime(at("2026-12-11", "00:00:00.000"));
    await expect(provider.chatStream(HI, () => {})).rejects.toThrow("OpenAI retired 'o3-pro' on 2026-12-11.");
    expect(calls).toEqual(["chatStream", "chat", "prewarm"]);
  });

  test("reads the model the request names before the provider's own", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-12-11", "00:00:00.000") });
    // A skill turn names its model on every request of a session made for another.
    const onAstra = fakeProvider();
    refuseRetiredModelRequests(onAstra.provider, "openai", "gpt-6.2-astra", undefined);
    await expect(onAstra.provider.chatStream(HI, () => {}, { model: "gpt-5-mini" }))
      .rejects.toThrow("OpenAI retired 'gpt-5-mini' on 2026-12-11. Pick another model.");
    await expect(onAstra.provider.chat(HI, { model: "gpt-5-mini" })).rejects.toBeInstanceOf(LLMModelRetiredError);
    await onAstra.provider.chatStream(HI, () => {}, {});
    // A session saved on a retired model can still run a skill on a served one.
    const onGpt5 = fakeProvider();
    refuseRetiredModelRequests(onGpt5.provider, "openai", "gpt-5", undefined);
    await onGpt5.provider.chatStream(HI, () => {}, { model: "gpt-6.2-astra" });
    await expect(onGpt5.provider.chatStream(HI, () => {}, {})).rejects.toThrow("OpenAI retired 'gpt-5'");
    // A provider made without a model checks only what a request names.
    const unnamed = fakeProvider();
    refuseRetiredModelRequests(unnamed.provider, "openai", undefined, undefined);
    await expect(unnamed.provider.chat(HI, { model: "o3" })).rejects.toThrow("OpenAI retired 'o3'");
    await unnamed.provider.chat(HI);
    expect([onAstra.calls, onGpt5.calls, unnamed.calls]).toEqual([["chatStream"], ["chatStream"], ["chat"]]);
  });

  test("leaves models without a date, and unknown providers, alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2030-01-01") });
    for (const [name, model] of [["openai", "gpt-6.2-astra"], ["deepseek", "deepseek-flash"], ["not-a-provider", "gpt-5"]] as const) {
      const { provider, calls } = fakeProvider();
      refuseRetiredModelRequests(provider, name, model, undefined);
      await provider.chat(HI);
      expect(calls, `${name}/${model}`).toEqual(["chat"]);
    }
  });

  test("is refused by every provider the factory makes, before any request", async () => {
    // Ollama retired MiniMax M2.7 on 2026-11-09; the test runs on the real clock.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ollamaReply());
    const retired = createProvider("ollama-cloud", { model: "minimax-m2.7", apiKey: "fixture-key", extra: { fetchImpl } });
    await expect(retired.chat(HI)).rejects.toThrow("Ollama Cloud retired 'minimax-m2.7' on 2026-11-09. Pick another model.");
    await expect(retired.chatStream(HI, () => {})).rejects.toBeInstanceOf(LLMModelRetiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    // A served model on the same provider is sent.
    const served = createProvider("ollama-cloud", { model: "minimax-m3.1-flash", apiKey: "fixture-key", extra: { fetchImpl } });
    await served.chat(HI);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("binds NVIDIA's dates to its hosted API only", async () => {
    const hosted = fakeProvider();
    refuseRetiredModelRequests(hosted.provider, "nvidia-nim", "nvidia/nemotron-3-super-120b-a12b", undefined);
    await expect(hosted.provider.chat(HI)).rejects.toThrow("NVIDIA NIM retired 'nvidia/nemotron-3-super-120b-a12b' on 2026-10-03.");
    const selfHosted = fakeProvider();
    refuseRetiredModelRequests(selfHosted.provider, "nvidia-nim", "nvidia/nemotron-3-super-120b-a12b", "http://nim.internal:8000/v1");
    await selfHosted.provider.chat(HI);
    expect([hosted.calls, selfHosted.calls]).toEqual([[], ["chat"]]);
  });
});
