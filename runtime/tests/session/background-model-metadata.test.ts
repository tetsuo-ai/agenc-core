import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfigs, type AgenCConfig } from "../../src/config/schema.js";
import { StaticModelsManager } from "../../src/llm/models-manager.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import { getPreSamplingAutoCompactTokenLimit } from "../../src/session/run-turn-compaction.js";
import { buildPrompt } from "../../src/session/run-turn-sampling-request.js";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { createTestConfigStore, drain, mkProvider, mkSession } from "../fixtures.js";

const model = "deepseek-flash";
const config = mergeConfigs(defaultConfig(), { model_provider: "deepseek", model });

afterEach(() => setAutoCompactImplForTests(null));

async function fixture(base: AgenCConfig = config, history: LLMMessage[] = []) {
  const download = Promise.withResolvers<Response>();
  const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(download.promise);
  const manager = new StaticModelsManager({ config: base, metadata: {
    fetchImpl, env: { DEEPSEEK_BASE_URL: "https://metadata.example/v1" },
  } });
  const initial = await manager.getModelInfoForProvider("deepseek", model);
  const provider = mkProvider();
  const { session, events } = mkSession({
    model, provider, modelInfo: initial, history,
    services: {
      modelsManager: manager,
      configStore: createTestConfigStore({ base }),
      providerService: new SessionProviderService({
        initialProvider: provider, initialProviderName: "deepseek", initialModel: model,
        environment: {}, sessionId: "metadata-session",
      }),
    },
  });
  const refresh = async (contextWindow: number, maxOutputTokens: number) => {
    download.resolve(new Response(JSON.stringify({ data: [{
      id: model, context_window: contextWindow, max_output_tokens: maxOutputTokens,
    }] })));
    await vi.waitFor(() => expect(manager.tryGetModelInfoForProvider("deepseek", model)?.contextWindow).toBe(contextWindow));
  };
  return { session, events, provider, manager, initial, refresh, fetchImpl };
}

describe("background metadata at session turn boundaries", () => {
  it.each([32_768, 2_097_152].flatMap(window => [false, true].map(overrides => ({ window, overrides }))))(
    "adopts a $window-token live window (overrides=$overrides) without changing an existing turn", async ({ window, overrides }) => {
    const { session, refresh, fetchImpl } = await fixture();
    const first = session.newDefaultTurnWithSubId("first");
    const initial = session.modelInfo;
    expect(first.modelInfo.contextWindow).toBe(1_048_576);
    expect(buildPrompt([], [], first, "").maxOutputTokens).toBe(64_000);

    await refresh(window, 4_096);
    expect(session.modelInfo).toBe(initial);
    expect(first.modelInfo.contextWindow).toBe(1_048_576);
    const second = overrides
      ? session.newTurnWithSubId("second", {})
      : session.newDefaultTurnWithSubId("second");
    expect(second.modelInfo).toMatchObject({ contextWindow: window, maxOutputTokens: 4_096 });
    const effectiveWindow = Math.floor(window * second.modelInfo.effectiveContextWindowPercent / 100);
    expect(buildPrompt([], [], second, "")).toMatchObject({ contextWindowTokens: effectiveWindow, maxOutputTokens: 4_096 });
    const limit = getPreSamplingAutoCompactTokenLimit(second)!;
    expect(limit).toBeLessThan(effectiveWindow);
    expect(limit > getPreSamplingAutoCompactTokenLimit(first)!).toBe(window > 1_048_576);
    expect(first.modelInfo.contextWindow).toBe(1_048_576);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the global explicit output cap when live context metadata arrives", async () => {
    const { session, refresh } = await fixture(mergeConfigs(config, { max_output_tokens: 2_000 }));
    expect(session.newDefaultTurn().modelInfo.maxOutputTokens).toBe(2_000);
    await refresh(48_000, 4_096);
    expect(session.newDefaultTurn().modelInfo).toMatchObject({ contextWindow: 48_000, maxOutputTokens: 2_000 });
  });

  it("keeps explicitly configured context and output limits on every turn", async () => {
    const { session, fetchImpl } = await fixture(mergeConfigs(config, { providers: { deepseek: {
      context_window_tokens: 48_000, max_output_tokens: 3_000,
    } } }));
    for (const ctx of [session.newDefaultTurn(), session.newTurnWithSubId("next", {})]) {
      expect(ctx.modelInfo).toMatchObject({ contextWindow: 48_000, maxOutputTokens: 3_000 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("compacts retained history using the smaller live window before sampling the next turn", async () => {
    const retained = "retained history ".repeat(20_000);
    const { session, provider, refresh, events } = await fixture(config, [
      { role: "user", content: "Read the archive" },
      { role: "assistant", content: retained },
    ]);
    session.newDefaultTurnWithSubId("first");
    await refresh(32_768, 4_096);
    const order: string[] = [];
    const samples: Array<{ messages: readonly LLMMessage[]; options: unknown }> = [];
    const compact = vi.fn(async () => {
      order.push("compact");
      return {
        wasCompacted: true,
        compactionResult: {
          message: "short archive summary",
          replacementHistory: [{ role: "user" as const, content: "short archive summary" }],
        },
      };
    });
    setAutoCompactImplForTests(compact);
    provider.chatStream = async (messages, _onChunk, options): Promise<LLMResponse> => {
      order.push("sample");
      samples.push({ messages, options });
      return { content: "Finished.", toolCalls: [], model, finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 2, totalTokens: 102 } };
    };
    await drain(session.runTurn("Summarize the archive", { subId: "second" }));
    expect(order, JSON.stringify(events)).toEqual(["compact", "sample"]);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(samples[0]?.messages)).not.toContain(retained);
    expect(samples[0]?.options).toMatchObject({ contextWindowTokens: Math.floor(32_768 * 0.95), maxOutputTokens: 4_096 });
    expect(events.map(event => classifyTurnTerminal(event.msg)))
      .toContainEqual(expect.objectContaining({ outcome: "completed", code: 0 }));
  });
});
