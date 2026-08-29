import { describe, expect, test } from "vitest";

import { resolveBudgetPolicy } from "../../src/budget/config.js";
import { applyEnvOverrides } from "../../src/config/env.js";
import { defaultConfig } from "../../src/config/schema.js";

describe("resolveBudgetPolicy", () => {
  test("is disabled by default with no caps", () => {
    const policy = resolveBudgetPolicy();

    expect(policy.enabled).toBe(false);
    expect(policy.caps).toEqual({});
    expect(policy.softThreshold).toBe(0.8);
    expect(policy.enforceInteractive).toBe(false);
  });

  test("uses the single canonical environment layer", () => {
    const config = applyEnvOverrides(
      {
        ...defaultConfig(),
        budget: { enabled: true, daily_usd: 5, monthly_usd: 100 },
      },
      { AGENC_BUDGET_DAILY_USD: "2" },
    );
    const policy = resolveBudgetPolicy(config.budget);

    expect(policy.enabled).toBe(true);
    expect(policy.caps.dailyUsd).toBe(2);
    expect(policy.caps.monthlyUsd).toBe(100);
  });

  test("canonical environment layer applies the kill switch", () => {
    const config = applyEnvOverrides(
      { ...defaultConfig(), budget: { enabled: true, daily_usd: 5 } },
      { AGENC_BUDGET: "off" },
    );
    const policy = resolveBudgetPolicy(config.budget);

    expect(policy.enabled).toBe(false);
  });

  test("resolves the soft threshold and interactive policy", () => {
    const policy = resolveBudgetPolicy({
      enabled: true,
      soft_threshold: 0.5,
      enforce_interactive: true,
    });

    expect(policy.softThreshold).toBe(0.5);
    expect(policy.enforceInteractive).toBe(true);
  });
});
