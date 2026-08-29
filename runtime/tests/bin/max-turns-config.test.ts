import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config/schema.js";
import {
  maxBudgetUsdFromAgenCConfig,
  maxTurnsFromAgenCConfig,
} from "./bootstrap.js";

describe("maxTurnsFromAgenCConfig (todo-105)", () => {
  it("maps positive max_turns from schema/TOML config", () => {
    expect(maxTurnsFromAgenCConfig({ max_turns: 7 })).toBe(7);
  });

  it("default config has no turn cap", () => {
    expect(defaultConfig().max_turns).toBeUndefined();
    expect(maxTurnsFromAgenCConfig(defaultConfig())).toBeUndefined();
  });

  it("ignores non-positive values", () => {
    expect(maxTurnsFromAgenCConfig({ max_turns: 0 })).toBeUndefined();
    expect(maxTurnsFromAgenCConfig({ max_turns: -1 })).toBeUndefined();
    expect(maxTurnsFromAgenCConfig({})).toBeUndefined();
  });
});

describe("maxBudgetUsdFromAgenCConfig", () => {
  it("maps a positive canonical session budget", () => {
    expect(maxBudgetUsdFromAgenCConfig({ max_budget_usd: 12.5 })).toBe(12.5);
  });

  it("does not invent or accept an invalid cap", () => {
    expect(maxBudgetUsdFromAgenCConfig(defaultConfig())).toBeUndefined();
    expect(maxBudgetUsdFromAgenCConfig({ max_budget_usd: 0 })).toBeUndefined();
    expect(maxBudgetUsdFromAgenCConfig({ max_budget_usd: -1 })).toBeUndefined();
  });
});
