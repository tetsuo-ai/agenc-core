import { describe, expect, test } from "vitest";

import { resolveBudgetPolicy } from "../../src/budget/config.js";

describe("resolveBudgetPolicy", () => {
  test("is disabled by default with no caps", () => {
    const { policy } = resolveBudgetPolicy(undefined, {});

    expect(policy.enabled).toBe(false);
    expect(policy.caps).toEqual({});
    expect(policy.softThreshold).toBe(0.8);
    expect(policy.enforceInteractive).toBe(false);
  });

  test("lets environment values override configuration values", () => {
    const { policy, sources } = resolveBudgetPolicy(
      { enabled: true, daily_usd: 5, monthly_usd: 100 },
      { AGENC_BUDGET_DAILY_USD: "2" },
    );

    expect(policy.enabled).toBe(true);
    expect(policy.caps.dailyUsd).toBe(2);
    expect(policy.caps.monthlyUsd).toBe(100);
    expect(sources.dailyUsd).toBe("env");
    expect(sources.monthlyUsd).toBe("config");
  });

  test("honors the environment kill switch", () => {
    const { policy } = resolveBudgetPolicy(
      { enabled: true, daily_usd: 5 },
      { AGENC_BUDGET: "off" },
    );

    expect(policy.enabled).toBe(false);
  });

  test("resolves the soft threshold and interactive policy", () => {
    const { policy } = resolveBudgetPolicy({
      enabled: true,
      soft_threshold: 0.5,
      enforce_interactive: true,
    });

    expect(policy.softThreshold).toBe(0.5);
    expect(policy.enforceInteractive).toBe(true);
  });
});
