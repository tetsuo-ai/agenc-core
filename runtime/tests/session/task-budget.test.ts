import { DEFAULT_TASK_TOKEN_BUDGET } from "../../src/config/task-budget.js";
import { describe, expect, it } from "vitest";
import { TaskBudget, taskUsageTokens, taskBudgetOf } from "../../src/session/task-budget.js";
import type { LLMResponse } from "../../src/llm/types.js";
import { readStartupCliFlags } from "../../src/bin/startup-cli-flags.js";
import { startupConfigLayerOptions } from "../../src/bin/startup-selection.js";
import { defaultConfig } from "../../src/config/schema.js";

import type { Session } from "../../src/session/session.js";
import { validateStrictAgenCConfigFields } from "../../src/config/strict-schema.js";

const response = (tokens = 20): LLMResponse => ({ content: "ok", toolCalls: [], model: "test",
  usage: { promptTokens: tokens - 5, completionTokens: 5, totalTokens: tokens, availability: "reported" } });
describe("task allocation", () => {
  it("defaults on and passes CLI flags through the canonical config layer", () => {
    expect(defaultConfig().task_token_budget).toBe(DEFAULT_TASK_TOKEN_BUDGET);
    expect(defaultConfig().task_max_calls).toBeUndefined();
    const cli = readStartupCliFlags(["node", "agenc", "--task-token-budget", "1000", "--task-max-calls=5", "--", "prompt"]);
    expect(startupConfigLayerOptions({ cli, cwd: "/tmp" }).cliOverrides).toEqual({task_token_budget:1000, task_max_calls:5});
    expect(readStartupCliFlags(["node", "agenc", "--", "--task-token-budget", "1"]).taskTokenBudget).toBeUndefined();
  });
  it.each(["-1", "NaN", "1.5", "Infinity", "9007199254740992", "", " "])("rejects invalid CLI budget %s", value => {
    expect(() => readStartupCliFlags(["node", "agenc", `--task-token-budget=${value}`])).toThrow();
  });
  it("preserves explicit zero through CLI/config and disables each limit independently", () => {
    const cli = readStartupCliFlags(["node", "agenc", "--task-token-budget=0", "--task-max-calls", "0"]);
    const config = startupConfigLayerOptions({ cli, cwd: "/tmp" }).cliOverrides!;
    expect(config).toEqual({ task_token_budget: 0, task_max_calls: 0 });
    expect(() => validateStrictAgenCConfigFields({ ...defaultConfig(), ...config })).not.toThrow();
    const session = (config: object) => ({ config, services: {} }) as unknown as Session;
    expect(taskBudgetOf(session({}))?.limit).toBe(DEFAULT_TASK_TOKEN_BUDGET);
    expect(taskBudgetOf(session({ taskTokenBudget: 0, taskMaxCalls: 0 }))).toBeUndefined();
    expect(taskBudgetOf(session({ taskTokenBudget: 0, taskMaxCalls: 2 }))).toMatchObject({ limit: undefined, maxCalls: 2 });
    expect(taskBudgetOf(session({ taskTokenBudget: 5, taskMaxCalls: 0 }))).toMatchObject({ limit: 5, maxCalls: undefined });
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid config budget %s", value => {
    for (const key of ["task_token_budget", "task_max_calls"] as const) {
      expect(() => validateStrictAgenCConfigFields({ ...defaultConfig(), [key]: value })).toThrow();
    }
  });
  it("explains the active limits and how to increase or disable them", () => {
    const summary = new TaskBudget(100, 3).summary("A decisive check is still needed.");
    expect(summary).toContain("Limits: 100 tokens, 3 model calls");
    expect(summary).toContain("--task-token-budget");
    expect(summary).toContain("--task-max-calls");
    expect(summary).toContain("Use 0 to disable");
  });
  it("counts inclusive provider reasoning and cached input once", () => {
    expect(taskUsageTokens({promptTokens:100, completionTokens:30, reasoningOutputTokens:20, cachedInputTokens:80, totalTokens:130})).toBe(130);
    expect(taskUsageTokens({promptTokens:100, completionTokens:10, reasoningOutputTokens:20, totalTokens:130})).toBe(130);
  });
  it("announces the 80 percent threshold once and refuses an over-budget reservation", async () => {
    const b = new TaskBudget(100);
    for (let i=0; i<4; i++) await b.invoke(20, async () => response());
    expect(b.reminder()?.content).toContain("decisive check");
    expect(b.reminder()).toBeUndefined();
    let called = false;
    await expect(b.invoke(21, async () => { called = true; return response(); })).rejects.toThrow("Task budget");
    expect(called).toBe(false);
    expect(b.calls).toBe(4);
    expect(b.summary("Tests passed")).toContain("Tests passed");
  });
  it("warns before a growing request consumes the chance to deliver the 80% reminder", async () => {
    const b = new TaskBudget(1000);
    for (let i = 0; i < 2; i++) {
      await b.invoke(250, async () => response(200));
      expect(b.reminder()).toBeUndefined();
    }
    await b.invoke(250, async () => response(200));
    expect(b.tokens).toBe(600);
    const reminder = b.reminder();
    expect(reminder?.content).toContain("decisive check");
    let received = false;
    await b.invoke(250, async () => { received = reminder !== undefined; return response(200); });
    expect(received).toBe(true);
    expect(b.reminder()).toBeUndefined();
    await expect(b.invoke(250, async () => response(200))).rejects.toThrow("Task budget");
    expect(b.calls).toBe(4);
  });
  it("lets the last admitted call settle and prevents concurrent overspend", async () => {
    const b = new TaskBudget(100, 2);
    let finish!: (r: LLMResponse) => void;
    const active = b.invoke(80, () => new Promise(resolve => { finish = resolve; }));
    await expect(b.invoke(30, async () => response())).rejects.toThrow();
    finish(response(70));
    await active;
    expect(b.tokens).toBe(70);
    expect(b.reached).toBe(true);
  });
  it("charges failed and missing-usage requests conservatively", async () => {
    const b = new TaskBudget(100);
    await expect(b.invoke(40, async () => { throw new Error("network"); })).rejects.toThrow("network");
    await b.invoke(60, async () => ({...response(),usage:{...response().usage, availability:"unknown"}}));
    expect(b.tokens).toBe(100);
    expect(b.reached).toBe(true);
  });
});
