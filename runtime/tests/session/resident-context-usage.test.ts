import { describe, expect, it } from "vitest";

import type { ResidentContextBreakdown } from "../../src/session/resident-context-usage.js";
import {
  configuredContextWindow,
  contextUsagePercentage,
  projectResidentContextUsage,
} from "../../src/session/resident-context-usage.js";

function breakdown(
  overrides: Partial<ResidentContextBreakdown> = {},
): ResidentContextBreakdown {
  return {
    windowTokens: 200_000,
    messageTokens: 20_000,
    systemPromptTokens: 3_000,
    systemToolTokens: 1_000,
    systemToolCount: 1,
    mcpToolTokens: 500,
    mcpToolCount: 1,
    deferredToolTokens: 90_000,
    deferredToolCount: 20,
    memoryFileTokens: 100,
    memoryFileCount: 1,
    ...overrides,
  };
}

describe("contextUsagePercentage", () => {
  it("clamps to 0..100 and treats a non-positive window as empty", () => {
    expect(contextUsagePercentage(50, 100)).toBe(50);
    expect(contextUsagePercentage(0, 100)).toBe(0);
    expect(contextUsagePercentage(150, 100)).toBe(100);
    expect(contextUsagePercentage(-10, 100)).toBe(0);
    expect(contextUsagePercentage(10, 0)).toBe(0);
    expect(contextUsagePercentage(10, -1)).toBe(0);
  });
});

describe("configuredContextWindow", () => {
  it("returns only a finite positive window for the selected provider", () => {
    expect(configuredContextWindow(undefined)).toBeUndefined();
    expect(configuredContextWindow({ model_provider: "grok" })).toBeUndefined();
    expect(
      configuredContextWindow({
        model_provider: "grok",
        providers: { grok: { context_window_tokens: 0 } },
      }),
    ).toBeUndefined();
    expect(
      configuredContextWindow({
        model_provider: "grok",
        providers: { grok: { context_window_tokens: Number.NaN } },
      }),
    ).toBeUndefined();
    expect(
      configuredContextWindow({
        model_provider: "grok",
        providers: { grok: { context_window_tokens: 200_000 } },
      }),
    ).toBe(200_000);
  });
});

describe("projectResidentContextUsage", () => {
  it("uses the prepared input/window/threshold and keeps output reservation separate", () => {
    const resident = {
      ...breakdown({ messageTokens: 2_000_000, effectiveWindowTokens: 83_000 }),
      compactionInputTokens: 75_000,
      compactionWindowTokens: 100_000,
      compactionThresholdTokens: 75_000,
      compactionReservedOutputTokens: 64_000,
    };
    const projected = projectResidentContextUsage(resident, { providerEnvironment: {} });
    expect(projected).toMatchObject({ totalUsed: 75_000, hardLimit: 100_000, compactionThreshold: 75_000, usedPercentage: 75, freeUntilCompact: 0 });
  });

  it("does not re-apply the client compact window when the daemon already published capacity", () => {
    const resident = breakdown({
      windowTokens: 200_000,
      effectiveWindowTokens: 100_000,
    });
    const env = { AGENC_AUTO_COMPACT_WINDOW: "50000" };
    const projected = projectResidentContextUsage(resident, {
      providerEnvironment: env,
      contextWindowTokens: 200_000,
    });

    expect(projected.hardLimit).toBe(100_000);
    expect(projected.totalUsed).toBe(24_600);
    expect(projected.usedPercentage).toBe(25);
    expect(projected.autoCompactEnabled).toBe(true);
    expect(projected.compactionThreshold).toBeLessThan(projected.hardLimit);
  });

  it("uses the client compact window only when the daemon did not publish capacity", () => {
    const projected = projectResidentContextUsage(breakdown(), {
      providerEnvironment: { AGENC_AUTO_COMPACT_WINDOW: "50000" },
      contextWindowTokens: 200_000,
    });

    expect(projected.hardLimit).toBe(50_000);
    expect(projected.totalUsed).toBe(24_600);
    expect(projected.usedPercentage).toBe(49);
  });

  it.each([true, false])("uses the daemon's compaction enabled state (%s) over the client's environment", enabled => {
    const projected = projectResidentContextUsage({
      ...breakdown({ effectiveWindowTokens: 48_000 }),
      compactionWindowTokens: 48_000,
      compactionInputTokens: 36_000,
      compactionThresholdTokens: enabled ? 35_000 : 48_000,
    }, {
      providerEnvironment: enabled ? { AGENC_DISABLE_AUTO_COMPACT: "1" } : {},
    });
    expect(projected.autoCompactEnabled).toBe(enabled);
    expect(projected.compactionThreshold).toBe(enabled ? 35_000 : 48_000);
  });

  it("treats the hard limit as the compact line when auto-compact is disabled", () => {
    const projected = projectResidentContextUsage(
      breakdown({ effectiveWindowTokens: 100_000 }),
      { providerEnvironment: { AGENC_DISABLE_AUTO_COMPACT: "1" } },
    );

    expect(projected.autoCompactEnabled).toBe(false);
    expect(projected.compactionThreshold).toBe(projected.hardLimit);
    expect(projected.freeUntilCompact).toBe(projected.freeUntilHardLimit);
  });

  it("never reports negative free space", () => {
    const projected = projectResidentContextUsage(
      breakdown({
        effectiveWindowTokens: 10_000,
        messageTokens: 20_000,
        systemPromptTokens: 3_000,
        systemToolTokens: 1_000,
        mcpToolTokens: 500,
        memoryFileTokens: 100,
      }),
      { providerEnvironment: {} },
    );

    expect(projected.totalUsed).toBe(24_600);
    expect(projected.usedPercentage).toBe(100);
    expect(projected.freeUntilCompact).toBe(0);
    expect(projected.freeUntilHardLimit).toBe(0);
  });
});
