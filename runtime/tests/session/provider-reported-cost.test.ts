import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { chatCompletionsCapabilityHintsForProvider } from "../../src/llm/wire/capability-gating.js";
import { parseChatCompletionsResponse } from "../../src/llm/wire/chat-completions.js";
import type { LLMUsage } from "../../src/llm/types.js";
import {
  computeUsdCostWithResolution,
  COST_TOTALS_FILENAME,
  COST_TOTALS_SCHEMA_VERSION,
  CostSidecar,
  DEFAULT_MODEL_COSTS,
} from "../../src/session/cost.js";
import { cumulativeUsage } from "../../src/session/cumulative-usage.js";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const MODEL = "deepseek/deepseek-v4.1-flash";

// Shape of a live OpenRouter response on 2026-10-17 (DeepInfra endpoint).
function openRouterUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_tokens: 37,
    completion_tokens: 20,
    total_tokens: 57,
    cost: 1.358e-5,
    is_byok: false,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    cost_details: { upstream_inference_cost: 1.358e-5 },
    completion_tokens_details: { reasoning_tokens: 20 },
    ...overrides,
  };
}

function parseUsage(provider: string, usage: Record<string, unknown>, managedGateway = false): LLMUsage {
  return parseChatCompletionsResponse(
    MODEL,
    { id: "gen-1", model: MODEL, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage },
    {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, MODEL, { managedGateway }),
    },
  ).usage;
}

describe("the charge a provider reports for a call", () => {
  test("is read from OpenRouter's usage.cost", () => {
    expect(parseUsage("openrouter", openRouterUsage()).providerCostUsd).toBe(1.358e-5);
  });

  test("adds the upstream charge when the call ran on the user's own provider key", () => {
    const usage = openRouterUsage({ cost: 2e-6, is_byok: true, cost_details: { upstream_inference_cost: 4e-5 } });
    expect(parseUsage("openrouter", usage).providerCostUsd).toBeCloseTo(4.2e-5, 12);
    // Without the upstream part only OpenRouter's fee is known: no charge.
    expect(parseUsage("openrouter", openRouterUsage({ is_byok: true, cost_details: {} })).providerCostUsd)
      .toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({ is_byok: true, cost_details: null })).providerCostUsd)
      .toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({ is_byok: true, cost_details: [] })).providerCostUsd)
      .toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({
      is_byok: true, cost_details: { upstream_inference_cost: 0 },
    })).providerCostUsd).toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({
      is_byok: true, cost_details: { upstream_inference_cost: -1 },
    })).providerCostUsd).toBeUndefined();
    // A string flag is not BYOK: OpenRouter's fee is the whole charge.
    expect(parseUsage("openrouter", openRouterUsage({ is_byok: "true" })).providerCostUsd).toBe(1.358e-5);
  });

  test("is ignored when absent, malformed, from another provider or from the managed gateway", () => {
    expect(parseUsage("openrouter", openRouterUsage({ cost: undefined })).providerCostUsd).toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({ cost: -1 })).providerCostUsd).toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({ cost: "0.01" })).providerCostUsd).toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({ cost: Number.NaN })).providerCostUsd).toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage({ cost: Number.POSITIVE_INFINITY })).providerCostUsd)
      .toBeUndefined();
    expect(parseUsage("deepseek", openRouterUsage()).providerCostUsd).toBeUndefined();
    expect(parseUsage("openrouter", openRouterUsage(), true).providerCostUsd).toBeUndefined();
  });

  test("a free OpenRouter route is a known zero, not the conservative ceiling", () => {
    expect(parseUsage("openrouter", openRouterUsage({ cost: 0 })).providerCostUsd).toBe(0);
    const base = {
      model: MODEL, provider: "openrouter", inputTokens: 5_000, outputTokens: 300, cachedInputTokens: 0,
      cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 5_300,
      turns: 1, singleCall: true as const,
    };
    expect(computeUsdCostWithResolution({ ...base, providerCostUsd: 0 }, DEFAULT_MODEL_COSTS))
      .toMatchObject({ costUsd: 0, known: true });
    const ceiling = computeUsdCostWithResolution(base, DEFAULT_MODEL_COSTS);
    expect(ceiling.known).toBe(false);
    expect(ceiling.costUsd).toBeGreaterThan(0.5);
    expect(computeUsdCostWithResolution({ ...base, providerCostUsd: Number.NaN }, DEFAULT_MODEL_COSTS))
      .toMatchObject({ known: false, costUsd: ceiling.costUsd });
    expect(computeUsdCostWithResolution({ ...base, providerCostUsd: Number.POSITIVE_INFINITY }, DEFAULT_MODEL_COSTS))
      .toMatchObject({ known: false, costUsd: ceiling.costUsd });
  });

  test("is the call's known price instead of the conservative ceiling", () => {
    const base = {
      model: MODEL, provider: "openrouter", inputTokens: 5_000, outputTokens: 300, cachedInputTokens: 0,
      cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 5_300,
      turns: 1, singleCall: true as const,
    };
    // Before this fix every paid OpenRouter call priced at the registry ceiling.
    const ceiling = computeUsdCostWithResolution(base, DEFAULT_MODEL_COSTS);
    expect(ceiling.known).toBe(false);
    expect(ceiling.costUsd).toBeGreaterThan(0.5);
    const charged = computeUsdCostWithResolution({ ...base, providerCostUsd: 0.0033 }, DEFAULT_MODEL_COSTS);
    expect(charged).toMatchObject({ costUsd: 0.0033, known: true });
  });

  test("sums across a turn only while every call carried one", () => {
    const empty: LLMUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const call = (providerCostUsd?: number): LLMUsage => ({
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
      ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
    });
    const two = cumulativeUsage(cumulativeUsage(empty, call(0.001)), call(0.002));
    expect(two.providerCostUsd).toBeCloseTo(0.003, 12);
    expect(cumulativeUsage(two, call()).providerCostUsd).toBeUndefined();
    expect(cumulativeUsage(cumulativeUsage(empty, call()), call(0.002)).providerCostUsd).toBeUndefined();
  });
});

function tokenCount(id: string, providerCostUsd?: number) {
  return {
    id,
    seq: 1,
    msg: {
      type: "token_count" as const,
      payload: {
        promptTokens: 5_000, completionTokens: 300, totalTokens: 5_300, model: MODEL, provider: "openrouter",
        ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
      },
    },
  };
}

describe("session cost with reported charges", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("the cost tracker totals the charges and knows every price", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent(tokenCount("a", 0.0033));
    sidecar.onEvent(tokenCount("b", 0.0021));
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.0054, 12);
    expect(sidecar.hasUnknownModelCost()).toBe(false);
    expect(sidecar.getSessionModelUsage()[0]).toMatchObject({ inputTokens: 10_000, costKnown: true });
  });

  test("a call without a charge stays an estimate and marks the session cost unknown", () => {
    const sidecar = new CostSidecar();
    sidecar.onEvent(tokenCount("a", 0.0033));
    sidecar.onEvent(tokenCount("b"));
    expect(sidecar.hasUnknownModelCost()).toBe(true);
    const unreported = computeUsdCostWithResolution({
      model: MODEL, provider: "openrouter", inputTokens: 5_000, outputTokens: 300, cachedInputTokens: 0,
      cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 5_300,
      turns: 0, singleCall: true,
    }, DEFAULT_MODEL_COSTS).costUsd;
    expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.0033 + unreported, 9);
  });

  test("a resumed session keeps a known charge known", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "reported-cost-"));
    dirs.push(projectDir);
    const first = new CostSidecar({ projectDir, sessionId: "s1" });
    await first.loadFromDisk();
    first.onEvent(tokenCount("a", 0.0033));
    await first.saveCurrentSessionCosts();

    const resumed = new CostSidecar({ projectDir, sessionId: "s1" });
    await resumed.loadFromDisk();
    expect(resumed.restoreSessionCostsForSession("s1")).toBe(true);
    expect(resumed.getTotalCostUsd()).toBeCloseTo(0.0033, 12);
    expect(resumed.hasUnknownModelCost()).toBe(false);
    resumed.onEvent(tokenCount("b", 0.001));
    expect(resumed.getTotalCostUsd()).toBeCloseTo(0.0043, 12);
    expect(resumed.hasUnknownModelCost()).toBe(false);
  });

  test("a record saved before charges were kept restores as an estimate", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "reported-cost-legacy-"));
    dirs.push(projectDir);
    const usage = { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0,
      reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: 5_300 };
    writeFileSync(join(projectDir, COST_TOTALS_FILENAME), JSON.stringify({
      version: COST_TOTALS_SCHEMA_VERSION, totalUsage: usage, totalCostUsd: 0.93, updatedAtMs: 1,
      sessions: [{ sessionId: "old", startedAtMs: 1, endedAtMs: 2, usage, costUsd: 0.93,
        modelUsage: [{ model: MODEL, provider: "openrouter", ...usage, turns: 1, costUsd: 0.93 }] }],
    }));
    const resumed = new CostSidecar({ projectDir, sessionId: "old" });
    await resumed.loadFromDisk();
    expect(resumed.restoreSessionCostsForSession("old")).toBe(true);
    expect(resumed.hasUnknownModelCost()).toBe(true);
  });

  test("the transcript status cost uses the charge", () => {
    const transcript = adaptTranscriptEvents([
      { type: "token_count", payload: { ...tokenCount("a", 0.0033).msg.payload } },
      { type: "token_count", payload: { ...tokenCount("b", 0.0021).msg.payload } },
    ]);
    expect(transcript.sessionCostUsd).toBeCloseTo(0.0054, 12);
  });
});
