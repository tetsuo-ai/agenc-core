import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfigs } from "../../src/config/schema.js";
import { validateStrictAgenCConfigFields } from "../../src/config/strict-schema.js";
import { readStartupCliFlags } from "../../src/bin/startup-cli-flags.js";
import { startupConfigLayerOptions } from "../../src/bin/startup-selection.js";
import { TASK_BUDGET_LEVELS, taskBudgetLabel } from "../../src/config/task-budget.js";

describe("named task budgets", () => {
  it.each(Object.entries(TASK_BUDGET_LEVELS))("maps %s through CLI and config layers", (name, tokens) => {
    const cli = readStartupCliFlags(["node", "agenc", "--budget", name]);
    expect(cli.taskTokenBudget).toBe(tokens);
    const options = startupConfigLayerOptions({ cli, cwd: "/tmp" });
    const config = mergeConfigs(defaultConfig(), options.cliOverrides!);
    expect(config.task_token_budget).toBe(tokens);
    expect(config.budget_level).toBe(name);
    validateStrictAgenCConfigFields(config);
  });
  it("replaces lower-layer selections, retaining numeric zero precedence", () => {
    const eco = mergeConfigs(defaultConfig(), { budget_level: "eco" });
    expect(eco.task_token_budget).toBe(1_000_000);
    const numeric = mergeConfigs(eco, { task_token_budget: 0 });
    expect(numeric.task_token_budget).toBe(0);
    expect(numeric.budget_level).toBeUndefined();
    expect(mergeConfigs(numeric, { budget_level: "balanced" }).task_token_budget).toBe(2_400_000);
    expect(mergeConfigs(eco, { budget_level: "balanced", task_token_budget: 0 }).task_token_budget).toBe(0);
  });
  it.each([[], ["wrong"], ["eco", "--task-token-budget", "0"]])("rejects invalid/conflicting CLI choices %j", (args) => {
    expect(() => readStartupCliFlags(["node", "agenc", "--budget", ...args])).toThrow();
  });
  it("does not parse budget text after prompt separator", () => {
    expect(readStartupCliFlags(["node", "agenc", "--", "--budget", "max"]).taskTokenBudget).toBeUndefined();
  });
  it("rejects unknown config levels", () => {
    expect(() => validateStrictAgenCConfigFields({ budget_level: "bad" } as never)).toThrow();
  });
  it("labels custom caps honestly and keeps the pending default unchanged", () => {
    expect(taskBudgetLabel(0)).toBe("max (no token cap)");
    expect(taskBudgetLabel(2_400_000)).toBe("balanced (2,400,000 tokens)");
    expect(taskBudgetLabel(219_000)).toBe("custom (219,000 tokens)");
    expect(defaultConfig().task_token_budget).toBe(219_000);
  });
});
