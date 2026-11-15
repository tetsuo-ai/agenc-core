import { describe, expect, test } from "vitest";
import type { Session } from "../../src/session/session.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import { LIGHT_FINISH, LIGHT_LIMITED_FINISH, lightBudgetWorkflow } from "../../src/prompts/light-budget-prompt.js";
import {
  LIGHT_TASK_LIMITS_ENV,
  lightStatesTaskLimits,
  lightUsesBatchEdit,
  lightUsesQwenTuning,
} from "../../src/tools/light-profile.js";
import { mkCtx } from "../fixtures.js";

const COMPUTE = "Compute numeric answers from data with a command, not mentally.";
const LIMITS = "Do what was asked and no more";

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function lightHead(provider: string, model: string, environment: Record<string, string> = {}, nonInteractive = false) {
  const session = { services: { runtimeOptions: { lightMode: true, nonInteractive }, providerEnvironment: environment } } as unknown as Session;
  return (await assembleSystemPromptSnapshot({
    profile: "light", ctx: mkCtx(), session, provider, promptIdentity: { provider, model },
  })).staticPrefix;
}

describe("QwenCloud Qwen3.8 Light tuning", () => {
  test.each([
    ["qwen-token-plan", "qwen3.8-max", true],
    ["qwen-token-plan", "qwen3.8-flash", true],
    ["qwen", "qwen3.8-max", true],
    ["qwen", "qwen3.8-max-0902", true],
    [" QWEN-TOKEN-PLAN ", " QWEN3.8-MAX ", true],
    ["qwen-token-plan", "qwen3.7-max", false],
    ["qwen-token-plan", "qwen3.6-flash", false],
    ["qwen-token-plan", "deepseek-v4.1-flash", false],
    ["qwen", "qwen3.8-2.4t-a95b", false],
    ["openrouter", "qwen/qwen3.8-max", false],
    ["cerebras", "qwen-3.8-27b", false],
    [undefined, "qwen3.8-max", false],
  ] as const)("gate: %s %s -> %s", (provider, model, expected) => {
    expect(lightUsesQwenTuning(provider, model)).toBe(expected);
    expect(lightUsesBatchEdit(provider, model)).toBe(expected);
    expect(lightStatesTaskLimits(provider, {}, model)).toBe(expected);
  });

  test("DeepSeek keeps its own tuning and is not a Qwen session", () => {
    expect(lightUsesQwenTuning("deepseek", "deepseek-flash")).toBe(false);
    expect(lightUsesBatchEdit("deepseek", "deepseek-flash")).toBe(true);
    expect(lightStatesTaskLimits("deepseek", {}, "deepseek-flash")).toBe(true);
  });

  test("the session environment still overrides the task limits", () => {
    expect(lightStatesTaskLimits("qwen-token-plan", { [LIGHT_TASK_LIMITS_ENV]: "0" }, "qwen3.8-max")).toBe(false);
    expect(lightStatesTaskLimits("qwen-token-plan", { [LIGHT_TASK_LIMITS_ENV]: "1" }, "qwen3.7-max")).toBe(true);
  });

  test("the limited paragraph keeps the compute rule only when asked", () => {
    expect(count(LIGHT_LIMITED_FINISH, COMPUTE)).toBe(0);
    expect(count(LIGHT_FINISH, COMPUTE)).toBe(1);
    const qwen = lightBudgetWorkflow(false, false, true, false, false, true);
    expect(count(qwen, LIMITS)).toBe(1);
    expect(count(qwen, COMPUTE)).toBe(1);
    expect(lightBudgetWorkflow(false, false, true)).toBe(lightBudgetWorkflow(false, false, true, false, false, false));
    expect(count(lightBudgetWorkflow(false, false, true, false, true, true), COMPUTE)).toBe(1);
  });

  test("the assembled Light head states the limits for Qwen3.8 and keeps every other head", async () => {
    const qwen = await lightHead("qwen-token-plan", "qwen3.8-max");
    expect(count(qwen, LIMITS)).toBe(1);
    expect(count(qwen, COMPUTE)).toBe(1);
    const off = await lightHead("qwen-token-plan", "qwen3.8-max", { [LIGHT_TASK_LIMITS_ENV]: "0" });
    expect(count(off, LIMITS)).toBe(0);
    expect(count(off, COMPUTE)).toBe(1);
    const older = await lightHead("qwen-token-plan", "qwen3.7-max");
    expect(count(older, LIMITS)).toBe(0);
    const deepseek = await lightHead("deepseek", "deepseek-flash");
    expect(count(deepseek, LIMITS)).toBe(1);
    expect(count(deepseek, COMPUTE)).toBe(0);
  });
});
