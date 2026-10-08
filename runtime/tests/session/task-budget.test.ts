import { describe, expect, it } from "vitest";
import { TaskBudget, taskUsageTokens } from "../../src/session/task-budget.js";
import type { LLMResponse } from "../../src/llm/types.js";
import { readStartupCliFlags } from "../../src/bin/startup-cli-flags.js";
import { startupConfigLayerOptions } from "../../src/bin/startup-selection.js";
import { defaultConfig } from "../../src/config/schema.js";

const response = (tokens = 20): LLMResponse => ({ content: "ok", toolCalls: [], model: "test",
  usage: { promptTokens: tokens - 5, completionTokens: 5, totalTokens: tokens, availability: "reported" } });
describe("task allocation", () => {
  it("is opt-in and passes CLI flags through the canonical config layer", () => {
    expect(defaultConfig().task_token_budget).toBeUndefined();
    expect(defaultConfig().task_max_calls).toBeUndefined();
    const cli = readStartupCliFlags(["node", "agenc", "--task-token-budget", "1000", "--task-max-calls=5", "--", "prompt"]);
    expect(startupConfigLayerOptions({ cli, cwd: "/tmp" }).cliOverrides).toEqual({task_token_budget:1000, task_max_calls:5});
    expect(readStartupCliFlags(["node", "agenc", "--", "--task-token-budget", "1"]).taskTokenBudget).toBeUndefined();
  });
  it.each(["0", "-1", "NaN", "1.5", "Infinity", "9007199254740992", ""])("rejects invalid CLI budget %s", value => {
    expect(() => readStartupCliFlags(["node", "agenc", `--task-token-budget=${value}`])).toThrow();
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
