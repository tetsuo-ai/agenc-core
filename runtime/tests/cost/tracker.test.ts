import { describe, expect, test, vi } from "vitest";
import { CostSidecar } from "../session/cost.js";
import {
  addToTotalDurationState,
  addToTotalSessionCost,
  addToTotalLinesChanged,
  addToToolDuration,
  bindActiveCostSidecar,
  formatTotalCost,
  getActiveCostSidecar,
  getTotalAPIDuration,
  getTotalCost,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
} from "./tracker.js";
import {
  getCurrentTurnCacheMetrics,
  getSessionCacheMetrics,
  resetSessionCacheStats,
} from "../services/api/cacheStatsTracker.js";

vi.mock("src/utils/modelCost.js", () => ({
  calculateUSDCost: () => 0.1234,
}));
vi.mock("../utils/modelCost.js", () => ({
  calculateUSDCost: () => 0.1234,
}));
vi.mock("../utils/cwd.js", () => ({
  getCwd: () => process.cwd(),
}));
vi.mock("../utils/env.js", () => ({
  env: { isCI: false },
}));
vi.mock("../utils/envUtils.js", () => ({
  getAgenCConfigHomeDir: () => process.cwd(),
  isEnvTruthy: (value: string | boolean | undefined) =>
    value === true || value === "1" || value === "true",
}));
vi.mock("../utils/errors.js", () => ({
  getErrnoCode: (error: { code?: string }) => error.code,
}));
vi.mock("../utils/messages.js", () => ({
  normalizeMessagesForAPI: (messages: unknown) => messages,
}));
vi.mock("../utils/slowOperations.js", () => ({
  jsonParse: JSON.parse,
  jsonStringify: JSON.stringify,
}));

function resetFacadeForTests(): void {
  const sidecar = new CostSidecar();
  const dispose = bindActiveCostSidecar(sidecar);
  sidecar.reset();
  dispose();
}

describe("cost tracker facade", () => {
  test("returns zero defaults without an active sidecar", () => {
    resetFacadeForTests();
    expect(getActiveCostSidecar()).toBeNull();
    expect(getTotalCost()).toBe(0);
    expect(getTotalInputTokens()).toBe(0);
    expect(formatTotalCost()).toContain("Total cost: $0.00");
  });

  test("bindActiveCostSidecar prevents stale disposers from clearing replacements", () => {
    resetFacadeForTests();
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
    resetFacadeForTests();
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
    resetFacadeForTests();
    const sidecar = new CostSidecar();
    const dispose = bindActiveCostSidecar(sidecar);

    addToToolDuration(9);

    expect(sidecar.getTotalToolDurationMs()).toBe(9);
    dispose();
  });

  test("API duration producer records retry and non-retry timings", () => {
    resetFacadeForTests();
    const sidecar = new CostSidecar();
    const dispose = bindActiveCostSidecar(sidecar);

    addToTotalDurationState(23, 17);

    expect(getTotalAPIDuration()).toBe(23);
    expect(sidecar.getTotalApiDurationWithoutRetriesMs()).toBe(17);
    dispose();
  });

  test("token-dollar facade records explicit API cost", () => {
    resetFacadeForTests();
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
    expect(sidecar.getPerModelUsage()[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 250,
      cachedInputTokens: 400,
      cacheCreationInputTokens: 25,
      webSearchRequests: 2,
    });
    dispose();
  });

  test("cached VCR producer records cost and cache usage together", async () => {
    resetFacadeForTests();
    resetSessionCacheStats();
    const { addCachedCostToTotalSessionCost } = await import(
      "../services/vcr.js"
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
    expect(sidecar.getPerModelUsage()[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 250,
      cachedInputTokens: 400,
      cacheCreationInputTokens: 25,
      webSearchRequests: 2,
    });
    dispose();
  });
});
