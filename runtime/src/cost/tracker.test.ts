import { describe, expect, test } from "vitest";
import { CostSidecar } from "../session/cost.js";
import {
  addToTotalDurationState,
  addToTotalSessionCost,
  addToTotalLinesChanged,
  addToToolDuration,
  bindActiveCostSidecar,
  formatTotalCost,
  getActiveCostSidecar,
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalToolDuration,
  resetStateForTests,
  restoreCostStateForSession,
} from "./tracker.js";
import { registerCostSummaryFallbackOnExit } from "./hook.js";

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

  test("token-dollar producer records explicit API cost and cache usage", () => {
    resetStateForTests();
    const sidecar = new CostSidecar({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
    });
    const dispose = bindActiveCostSidecar(sidecar);

    const returned = addToTotalSessionCost(
      0.1234,
      {
        input_tokens: 1000,
        output_tokens: 250,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 25,
        server_tool_use: { web_search_requests: 2 },
      },
      "gpt-4o",
    );

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
});
