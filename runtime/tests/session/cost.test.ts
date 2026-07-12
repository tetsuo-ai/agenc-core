import { describe, expect, test } from "vitest";
import {
  CostSidecar,
  computeUsdCostWithResolution,
  computeUsdCost,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
  formatUsdCost,
  formatTokenCount,
  formatDuration,
  registerCostSummaryOnExit,
} from "./cost.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS } from "../config/resolve-provider.js";

const ZERO_COST_DEFAULT_PROVIDERS = new Set([
  "lmstudio",
  "ollama",
  "openai-compatible",
]);

describe("cost helpers", () => {
  test("formatUsdCost", () => {
    expect(formatUsdCost(0)).toBe("$0.00");
    expect(formatUsdCost(0.0001)).toBe("$0.0001");
    expect(formatUsdCost(0.5)).toBe("$0.500");
    expect(formatUsdCost(12.345)).toBe("$12.35");
  });

  test("formatTokenCount", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(1500)).toBe("1.5K");
    expect(formatTokenCount(2_500_000)).toBe("2.50M");
  });

  test("formatDuration", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(15_000)).toBe("15.0s");
    expect(formatDuration(125_000)).toBe("2m5s");
  });

  test("computeUsdCost with known model", () => {
    const usage = {
      model: "grok-4-fast",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 15_000,
      turns: 1,
    };
    const cost = computeUsdCost(usage, DEFAULT_MODEL_COSTS);
    // input 10_000 * 0.002 / 1000 = 0.02; output 5_000 * 0.01 / 1000 = 0.05 → 0.07
    expect(cost).toBeCloseTo(0.07, 4);
  });

  test("computeUsdCost resolves provider-specific local pricing before model fallback", () => {
    const usage = {
      provider: "lmstudio",
      model: "gpt-4o",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cachedInputTokens: 1_000,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 15_000,
      turns: 1,
    };
    const resolution = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(resolution.known).toBe(true);
    expect(resolution.matchedKey).toBe("lmstudio");
    expect(resolution.costUsd).toBe(0);
  });

  test("computeUsdCost applies hosted cached-input pricing", () => {
    const usage = {
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000,
      outputTokens: 0,
      cachedInputTokens: 1_000,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 1_000,
      turns: 1,
    };
    const resolution = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(resolution.known).toBe(true);
    expect(resolution.matchedKey).toBe("openai:gpt-4o");
    expect(resolution.costUsd).toBeCloseTo(0.00125, 8);
  });

  test("computeUsdCost only charges uncached input at full rate", () => {
    const usage = {
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 2_000,
      outputTokens: 0,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 2_000,
      turns: 1,
    };
    const resolution = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(resolution.known).toBe(true);
    expect(resolution.matchedKey).toBe("openai:gpt-4o");
    expect(resolution.costUsd).toBeCloseTo(0.004375, 8);
  });

  test("computeUsdCost applies mini-model cached-input pricing", () => {
    const usage = {
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 1_000,
      outputTokens: 0,
      cachedInputTokens: 1_000,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 1_000,
      turns: 1,
    };
    const resolution = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(resolution.known).toBe(true);
    expect(resolution.matchedKey).toBe("openai:gpt-4o-mini");
    expect(resolution.costUsd).toBeCloseTo(0.000075, 8);
  });

  test.each([
    ["gpt-5.4", 0.0025, 0.00025],
    ["gpt-5.4-mini", 0.00075, 0.000075],
    ["gpt-4.1", 0.002, 0.0005],
    ["o4-mini", 0.0011, 0.000275],
  ])(
    "computeUsdCost uses current cached-input accounting for %s",
    (model, inputUsdPer1K, cachedInputUsdPer1K) => {
      const fullCache = computeUsdCostWithResolution(
        {
          provider: "openai",
          model,
          inputTokens: 1_000,
          outputTokens: 0,
          cachedInputTokens: 1_000,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          webSearchRequests: 0,
          totalTokens: 1_000,
          turns: 1,
        },
        DEFAULT_MODEL_COSTS,
      );
      expect(fullCache.known).toBe(true);
      expect(fullCache.matchedKey).toBe(`openai:${model}`);
      expect(fullCache.costUsd).toBeCloseTo(cachedInputUsdPer1K, 8);

      const partialCache = computeUsdCostWithResolution(
        {
          provider: "openai",
          model,
          inputTokens: 2_000,
          outputTokens: 0,
          cachedInputTokens: 500,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          webSearchRequests: 0,
          totalTokens: 2_000,
          turns: 1,
        },
        DEFAULT_MODEL_COSTS,
      );
      expect(partialCache.known).toBe(true);
      expect(partialCache.matchedKey).toBe(`openai:${model}`);
      expect(partialCache.costUsd).toBeCloseTo(
        (1.5 * inputUsdPer1K) + (0.5 * cachedInputUsdPer1K),
        8,
      );
    },
  );

  test("computeUsdCost reports unknown pricing without throwing", () => {
    const usage = {
      provider: "unknown-provider",
      model: "unknown-model",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 15_000,
      turns: 1,
    };
    const resolution = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(resolution.known).toBe(false);
    expect(resolution.costUsd).toBeCloseTo(0.175, 6);
  });

  test("built-in provider default models resolve as known costs", () => {
    for (const [provider, model] of Object.entries(
      BUILT_IN_PROVIDER_DEFAULT_MODELS,
    )) {
      const sidecar = new CostSidecar({
        defaultProvider: provider,
        defaultModel: model,
      });
      sidecar.onEvent({
        id: `usage-${provider}`,
        seq: 1,
        msg: {
          type: "token_count",
          payload: {
            promptTokens: 1000,
            completionTokens: 500,
            totalTokens: 1500,
          },
        },
      });

      expect(
        sidecar.hasUnknownModelCost(),
        `${provider}:${model} should use a known registry entry`,
      ).toBe(false);
      expect(
        computeUsdCostWithResolution(
          sidecar.getPerModelUsage()[0]!,
          DEFAULT_MODEL_COSTS,
        ).known,
        `${provider}:${model} should resolve with known=true`,
      ).toBe(true);
      if (!ZERO_COST_DEFAULT_PROVIDERS.has(provider)) {
        expect(sidecar.getTotalCostUsd()).toBeGreaterThan(0);
      }
    }
  });

  test("default + catalog grok models price as known and non-reasoning ones are not charged the reasoning surcharge", () => {
    // grok-4.3 is the grok provider default (provider-info.ts). Both it and
    // grok-build-0.1 used to mis-resolve: grok-4.3 collapsed onto the
    // reasoning entry (wrong reasoning surcharge) and grok-build-0.1 fell to
    // DEFAULT_UNKNOWN_MODEL_COST. Since DEFAULT_MODEL_COSTS feeds dollar_cap
    // enforcement, mispricing here enforces budgets at the wrong threshold.
    const nonReasoningModels = [
      "grok-4.5",
      "grok-4.3",
      "grok-build-0.1",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ];
    for (const model of nonReasoningModels) {
      const match = resolveModelCostEntry(
        { model, provider: "grok" },
        DEFAULT_MODEL_COSTS,
      );
      expect(match, `${model} should resolve to a known cost entry`).not.toBe(
        null,
      );
      // Resolves to its OWN key — not collapsed onto grok-4.20-0309-reasoning.
      expect(
        match!.key,
        `${model} should not collapse onto the reasoning entry`,
      ).not.toBe("grok-4.20-0309-reasoning");
      // Non-reasoning variants must NOT carry the reasoning surcharge.
      expect(
        match!.entry.reasoningOutputUsdPer1K,
        `${model} should not be charged the reasoning surcharge`,
      ).toBeUndefined();
    }

    // Concretely: grok-4.3 with reasoning tokens reported is billed at the
    // plain output rate only (no reasoning add-on). input 10k * 0.003/1k = 0.03;
    // output 5k * 0.012/1k = 0.06 → 0.09. If grok-4.3 collapsed onto the
    // reasoning entry, the 2k reasoning tokens would add 2k * 0.012/1k = 0.024.
    const usage = {
      model: "grok-4.3",
      provider: "grok",
      inputTokens: 10_000,
      outputTokens: 5_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 2_000,
      webSearchRequests: 0,
      totalTokens: 17_000,
      turns: 1,
    };
    const resolution = computeUsdCostWithResolution(usage, DEFAULT_MODEL_COSTS);
    expect(resolution.known).toBe(true);
    expect(resolution.costUsd).toBeCloseTo(0.09, 6);

    // The grok provider default specifically must be a known cost.
    const defaultModel = BUILT_IN_PROVIDER_DEFAULT_MODELS.grok;
    expect(defaultModel).toBe("grok-4.5");
    expect(
      resolveModelCostEntry(
        { model: defaultModel, provider: "grok" },
        DEFAULT_MODEL_COSTS,
      ),
    ).not.toBe(null);

    // The genuine reasoning variant keeps its surcharge.
    const reasoning = resolveModelCostEntry(
      { model: "grok-4.20-0309-reasoning", provider: "grok" },
      DEFAULT_MODEL_COSTS,
    );
    expect(reasoning?.entry.reasoningOutputUsdPer1K).toBe(0.012);
  });

  test("grok-4.5 uses official input, cached-input, and output pricing", () => {
    const match = resolveModelCostEntry(
      { model: "grok-4.5-latest", provider: "grok" },
      DEFAULT_MODEL_COSTS,
    );

    expect(match).toMatchObject({
      key: "grok-4.5",
      entry: {
        inputUsdPer1K: 0.002,
        cachedInputUsdPer1K: 0.0005,
        outputUsdPer1K: 0.006,
      },
    });
    expect(match?.entry.reasoningOutputUsdPer1K).toBeUndefined();
  });

  test("computeUsdCost prices cache writes and web search requests", () => {
    const usage = {
      // branding-scan: allow documented Anthropic API model identifier
      model: "claude-sonnet-4-5",
      inputTokens: 1_000,
      outputTokens: 1_000,
      cachedInputTokens: 1_000,
      cacheCreationInputTokens: 1_000,
      reasoningOutputTokens: 0,
      webSearchRequests: 2,
      totalTokens: 2_000,
      turns: 1,
    };
    const cost = computeUsdCost(usage, DEFAULT_MODEL_COSTS);
    expect(cost).toBeCloseTo(0.04205, 6);
  });
});

describe("CostSidecar", () => {
  test("accumulates per-model token usage", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "session_meta", payload: { sessionId: "s", timestamp: "", cwd: "", originator: "", agencVersion: "0.2.0", rolloutSchemaVersion: 1, model: "grok-4-fast" } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: {
        type: "token_count",
        payload: { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 },
      },
    });
    expect(sidecar.getTotalInputTokens()).toBe(3000);
    expect(sidecar.getTotalOutputTokens()).toBe(1500);
    expect(sidecar.getTotalCostUsd()).toBeGreaterThan(0);
  });

  test("keeps provider/model usage buckets separate", () => {
    const sidecar = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "token_count",
        payload: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: {
          provider: "lmstudio",
          model: "gpt-4o",
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
        },
      },
    });
    const usage = sidecar.getPerModelUsage();
    expect(usage).toHaveLength(2);
    expect(usage.map((u) => `${u.provider}/${u.model}`).sort()).toEqual([
      "lmstudio/gpt-4o",
      "openai/gpt-4o",
    ]);
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.0075, 4);
  });

  test("tracks unknown-cost models and marks summaries", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "token_count",
        payload: {
          provider: "unknown-provider",
          model: "unknown-model",
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
        },
      },
    });
    expect(sidecar.hasUnknownModelCost()).toBe(true);
    expect(sidecar.getUnknownCostModels()).toEqual([
      "unknown-provider:unknown-model",
    ]);
    expect(sidecar.formatSummary()).toContain("unknown-cost");
    expect(sidecar.formatTotalCost()).toContain("unknown model pricing");
  });

  test("tracks cache writes and web search usage", () => {
    const sidecar = new CostSidecar({
      defaultProvider: "anthropic",
      // branding-scan: allow documented Anthropic API model identifier
      defaultModel: "claude-sonnet-4-5",
    });
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: {
        type: "token_count",
        payload: {
          promptTokens: 1000,
          completionTokens: 500,
          cachedInputTokens: 200,
          cacheCreationInputTokens: 300,
          reasoningOutputTokens: 25,
          webSearchRequests: 2,
          totalTokens: 1525,
        },
      },
    });

    const usage = sidecar.getPerModelUsage()[0]!;
    expect(usage.cacheCreationInputTokens).toBe(300);
    expect(usage.webSearchRequests).toBe(2);
    expect(sidecar.getTotalCacheCreationInputTokens()).toBe(300);
    expect(sidecar.getTotalWebSearchRequests()).toBe(2);
    expect(sidecar.getTotalCostUsd()).toBeGreaterThan(0.02);
    expect(sidecar.formatTotalCost()).toContain("300 cache write");
    expect(sidecar.formatTotalCost()).toContain("2 web search");
  });

  test("tracks current-session API-without-retry and tool durations", async () => {
    const sidecar = new CostSidecar();
    sidecar.addToTotalApiDuration(23);
    sidecar.addToTotalApiDurationWithoutRetries(17);
    sidecar.onEvent({
      id: "tool-start",
      seq: 1,
      msg: {
        type: "tool_call_started",
        payload: {
          callId: "tool-1",
          toolName: "Read",
          args: "{}",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    sidecar.onEvent({
      id: "tool-end",
      seq: 2,
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: "tool-1",
          result: "ok",
          isError: false,
        },
      },
    });

    expect(sidecar.getTotalApiDurationMs()).toBe(23);
    expect(sidecar.getTotalApiDurationWithoutRetriesMs()).toBe(17);
    expect(sidecar.getTotalToolDurationMs()).toBeGreaterThan(0);
  });

  test("turn_complete does not duplicate API duration already recorded by API logging", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent({
      id: "turn-start",
      seq: 1,
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    });
    sidecar.addToTotalApiDuration(23);
    sidecar.addToTotalApiDurationWithoutRetries(17);
    sidecar.onEvent({
      id: "turn-complete",
      seq: 2,
      msg: { type: "turn_complete", payload: { turnId: "t1", durationMs: 99 } },
    });

    expect(sidecar.getTotalApiDurationMs()).toBe(23);
    expect(sidecar.getTotalApiDurationWithoutRetriesMs()).toBe(17);
  });

  test("formatTotalCost includes code change totals", () => {
    const sidecar = new CostSidecar();
    sidecar.addToTotalLinesChanged(1234, 2);

    expect(sidecar.formatTotalCost()).toContain(
      "Total code changes: 1.2K lines added, 2 lines removed",
    );
  });

  test("turn_complete increments turn count for active model", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "turn_context", payload: {
        cwd: "/",
        approvalPolicy: "never",
        sandboxPolicy: "read_only",
        model: "grok-4-fast",
      } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: {
        type: "turn_complete",
        payload: { turnId: "t1" },
      },
    });
    expect(sidecar.getTotalTurns()).toBe(1);
  });

  test("turn_complete increments provider-scoped usage", () => {
    const sidecar = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "token_count",
        payload: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: {
        type: "turn_complete",
        payload: { turnId: "t1" },
      },
    });

    expect(sidecar.getPerModelUsage()).toMatchObject([
      { provider: "openai", model: "gpt-4o", turns: 1 },
    ]);
    expect(sidecar.formatSummary()).toContain("turns=1");
  });

  test("turn_context provider id updates attribution after provider switches", () => {
    const sidecar = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    sidecar.onEvent({
      id: "1",
      seq: 1,
      msg: { type: "turn_started", payload: { turnId: "t1" } },
    });
    sidecar.onEvent({
      id: "2",
      seq: 2,
      msg: {
        type: "turn_context",
        payload: {
          cwd: "/",
          approvalPolicy: "never",
          sandboxPolicy: "read_only",
          model: "gpt-4o",
          modelProviderId: "lmstudio",
        },
      },
    });
    sidecar.onEvent({
      id: "3",
      seq: 3,
      msg: {
        type: "token_count",
        payload: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      },
    });
    sidecar.onEvent({
      id: "4",
      seq: 4,
      msg: {
        type: "turn_complete",
        payload: { turnId: "t1" },
      },
    });

    expect(sidecar.getPerModelUsage()).toMatchObject([
      { provider: "lmstudio", model: "gpt-4o", turns: 1 },
    ]);
    expect(sidecar.getTotalCostUsd()).toBe(0);
  });

  test("lifecycle start installs and stop disposes the exit summary hook", async () => {
    const handlers: Array<() => void> = [];
    const writes: string[] = [];
    const processLike = {
      stdout: { write: (value: string) => writes.push(value) },
      on: (event: "exit", handler: () => void) => {
        handlers.push(handler);
        return processLike;
      },
      off: (event: "exit", handler: () => void) => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
        return processLike;
      },
    };
    const sidecar = new CostSidecar({
      exitSummary: {
        processLike,
        getSummary: () => "lifecycle-summary",
      },
    });

    sidecar.start();
    expect(handlers).toHaveLength(1);
    await sidecar.stop();

    expect(handlers).toHaveLength(0);
    expect(writes).toEqual(["\nlifecycle-summary\n"]);
  });

  test("formatSummary produces one-line output", () => {
    const sidecar = new CostSidecar();
    const line = sidecar.formatSummary();
    expect(line).toContain("turns=0");
  });

  test("registerCostSummaryOnExit writes and unregisters the summary hook", () => {
    const sidecar = new CostSidecar();
    const handlers: Array<() => void> = [];
    const writes: string[] = [];
    const processLike = {
      stdout: { write: (value: string) => writes.push(value) },
      on: (event: string, handler: () => void) => {
        if (event === "exit") handlers.push(handler);
        return processLike;
      },
      off: (event: string, handler: () => void) => {
        if (event === "exit") {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        }
        return processLike;
      },
    };

    const dispose = registerCostSummaryOnExit(sidecar, {
      processLike,
      getSummary: () => "summary",
    });
    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(writes).toEqual(["\nsummary\n"]);

    dispose();
    expect(handlers).toHaveLength(0);
  });
});
