import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  COST_TOTALS_FILENAME,
  CostSidecar,
  type CostTotalsFile,
} from "../session/cost.js";
import {
  addToTotalDurationState,
  addToTotalSessionCost,
  addToTotalLinesChanged,
  addToToolDuration,
  bindActiveCostSidecar,
  bindCacheStatsResetHook,
  formatTotalCost,
  getActiveCostSidecar,
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalToolDuration,
  resetCostState,
  resetStateForTests,
  restoreCostStateForSession,
} from "./tracker.js";
import { registerCostSummaryFallbackOnExit } from "./hook.js";
import {
  getCurrentTurnCacheMetrics,
  getSessionCacheMetrics,
  recordUsageCacheStats,
  resetSessionCacheStats,
} from "../agenc/upstream/services/api/cacheStatsTracker.js";

vi.mock("src/utils/modelCost.js", () => ({
  calculateUSDCost: () => 0.1234,
}));
vi.mock("../agenc/upstream/utils/modelCost.js", () => ({
  calculateUSDCost: () => 0.1234,
}));
vi.mock("../agenc/upstream/utils/cwd.js", () => ({
  getCwd: () => process.cwd(),
}));
vi.mock("../agenc/upstream/utils/env.js", () => ({
  env: { isCI: false },
}));
vi.mock("../agenc/upstream/utils/envUtils.js", () => ({
  getAgenCConfigHomeDir: () => process.cwd(),
  isEnvTruthy: (value: string | boolean | undefined) =>
    value === true || value === "1" || value === "true",
}));
vi.mock("../agenc/upstream/utils/errors.js", () => ({
  getErrnoCode: (error: { code?: string }) => error.code,
}));
vi.mock("../agenc/upstream/utils/messages.js", () => ({
  normalizeMessagesForAPI: (messages: unknown) => messages,
}));
vi.mock("../agenc/upstream/utils/slowOperations.js", () => ({
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
}));

describe("cost tracker facade", () => {
  test("returns zero defaults without an active sidecar", () => {
    resetStateForTests();
    expect(getActiveCostSidecar()).toBeNull();
    expect(getTotalCost()).toBe(0);
    expect(getTotalInputTokens()).toBe(0);
    expect(formatTotalCost()).toContain("Total cost: $0.00");
    expect(restoreCostStateForSession("missing")).toBe(false);
  });

  test("bindActiveCostSidecar prevents stale disposers from clearing replacements", () => {
    resetStateForTests();
    const first = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    const second = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
    });
    const disposeFirst = bindActiveCostSidecar(first);
    const disposeSecond = bindActiveCostSidecar(second);

    disposeFirst();
    expect(getActiveCostSidecar()).toBe(second);

    disposeSecond();
    expect(getActiveCostSidecar()).toBeNull();
  });

  test("detached line counters transfer into the sidecar on bind", () => {
    resetStateForTests();
    addToTotalLinesChanged(3, 1);
    expect(getTotalLinesAdded()).toBe(3);
    expect(getTotalLinesRemoved()).toBe(1);

    const sidecar = new CostSidecar();
    const dispose = bindActiveCostSidecar(sidecar);
    expect(sidecar.getTotalLinesAdded()).toBe(3);
    expect(sidecar.getTotalLinesRemoved()).toBe(1);
    expect(getTotalLinesAdded()).toBe(3);
    expect(getTotalLinesRemoved()).toBe(1);

    dispose();
  });

  test("tool duration producer records through the facade", () => {
    resetStateForTests();
    const sidecar = new CostSidecar();
    const dispose = bindActiveCostSidecar(sidecar);

    addToToolDuration(9);

    expect(getTotalToolDuration()).toBe(9);
    dispose();
  });

  test("API duration producer records retry and non-retry timings", () => {
    resetStateForTests();
    const sidecar = new CostSidecar();
    const dispose = bindActiveCostSidecar(sidecar);

    addToTotalDurationState(23, 17);

    expect(getTotalAPIDuration()).toBe(23);
    expect(sidecar.getTotalApiDurationWithoutRetriesMs()).toBe(17);
    dispose();
  });

  test("token-dollar facade records explicit API cost", () => {
    resetStateForTests();
    resetSessionCacheStats();
    const sidecar = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    const dispose = bindActiveCostSidecar(sidecar);
    const usage = {
      input_tokens: 1000,
      output_tokens: 250,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 25,
      server_tool_use: { web_search_requests: 2 },
    };

    const returned = addToTotalSessionCost(0.1234, usage, "gpt-4o");

    expect(returned).toBeCloseTo(0.1234, 6);
    expect(getTotalCost()).toBeCloseTo(0.1234, 6);
    expect(getTotalInputTokens()).toBe(1000);
    expect(getModelUsage()["openai:gpt-4o"]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 25,
      webSearchRequests: 2,
      costUSD: 0.1234,
    });
    dispose();
  });

  test("cached VCR producer records cost and cache usage together", async () => {
    resetStateForTests();
    resetSessionCacheStats();
    const { addCachedCostToTotalSessionCost } = await import(
      "../agenc/upstream/services/vcr.js"
    );
    const sidecar = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    const dispose = bindActiveCostSidecar(sidecar);
    const usage = {
      input_tokens: 1000,
      output_tokens: 250,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 25,
      server_tool_use: { web_search_requests: 2 },
    };

    addCachedCostToTotalSessionCost({
      type: "assistant",
      message: { model: "gpt-4o", usage },
    } as Parameters<typeof addCachedCostToTotalSessionCost>[0]);

    expect(getTotalCost()).toBeGreaterThan(0);
    expect(getTotalInputTokens()).toBe(1000);
    expect(getCurrentTurnCacheMetrics()).toMatchObject({
      read: 400,
      created: 25,
      total: 1425,
      supported: true,
    });
    expect(getSessionCacheMetrics().read).toBe(400);
    expect(getModelUsage()["openai:gpt-4o"]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 25,
      webSearchRequests: 2,
    });
    dispose();
  });

  test("resetCostState clears registered cache stats with cost totals", () => {
    resetStateForTests();
    resetSessionCacheStats();
    const disposeReset = bindCacheStatsResetHook(resetSessionCacheStats);
    recordUsageCacheStats(
      { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80 },
      "gpt-4o",
    );

    expect(getSessionCacheMetrics().read).toBe(80);
    resetCostState();
    expect(getSessionCacheMetrics().supported).toBe(false);

    disposeReset();
  });

  test("fallback exit hook does not register when bootstrap owns an active sidecar", () => {
    resetStateForTests();
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
    const disposeBinding = bindActiveCostSidecar(new CostSidecar());
    const disposeFallback = registerCostSummaryFallbackOnExit(undefined, {
      processLike,
    });

    expect(handlers).toHaveLength(0);
    disposeFallback();
    disposeBinding();
    expect(writes).toEqual([]);
  });

  test("fallback exit hook writes a summary when no sidecar is active", () => {
    resetStateForTests();
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
    const dispose = registerCostSummaryFallbackOnExit(undefined, {
      processLike,
      shouldPrint: () => true,
    });

    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(writes.join("")).toContain("Total cost: $0.00");

    dispose();
    expect(handlers).toHaveLength(0);
  });

  test("fallback exit hook no-ops if bootstrap binds a sidecar later", () => {
    resetStateForTests();
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
    const disposeFallback = registerCostSummaryFallbackOnExit(undefined, {
      processLike,
      shouldPrint: () => true,
    });
    const disposeBinding = bindActiveCostSidecar(new CostSidecar());

    expect(handlers).toHaveLength(1);
    handlers[0]!();
    expect(writes).toEqual([]);

    disposeFallback();
    disposeBinding();
  });

  test("fallback hook registered before bootstrap still supplies FPS metrics", async () => {
    resetStateForTests();
    const handlers: Array<() => void> = [];
    const processLike = {
      stdout: { write: () => undefined },
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
    const projectDir = mkdtempSync(join(tmpdir(), "agenc-cost-hook-"));
    const disposeFallback = registerCostSummaryFallbackOnExit(
      () => ({ averageFps: 58, low1PctFps: 41 }),
      { processLike, shouldPrint: () => true },
    );
    const sidecar = new CostSidecar({
      projectDir,
      sessionId: "fps-session",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    await sidecar.loadFromDisk();
    const disposeBinding = bindActiveCostSidecar(sidecar);

    addToTotalSessionCost(
      0.01,
      { input_tokens: 10, output_tokens: 5 },
      "gpt-4o",
    );
    await sidecar.saveCurrentSessionCosts();

    const parsed = JSON.parse(
      readFileSync(join(projectDir, COST_TOTALS_FILENAME), "utf8"),
    ) as CostTotalsFile;
    expect(parsed.sessions[0]).toMatchObject({
      sessionId: "fps-session",
      fpsAverage: 58,
      fpsLow1Pct: 41,
    });

    disposeFallback();
    disposeBinding();
  });
});
