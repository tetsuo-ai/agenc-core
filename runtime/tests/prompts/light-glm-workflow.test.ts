import { expect, test } from "vitest";
import {
  lightBudgetWorkflow, LIGHT_FINISH, LIGHT_LIMITED_FINISH, LIGHT_GLM_BATCHED_STEPS,
} from "../../src/prompts/light-budget-prompt.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import type { Session } from "../../src/session/session.js";
import { mkCtx } from "../fixtures.js";

test.each([false, true])("Large V2 batches reads, changes and diagnosable failures (task limits=%s)", taskLimits => {
  const prompt = lightBudgetWorkflow(false, false, taskLimits, true);
  expect(prompt).toContain(LIGHT_GLM_BATCHED_STEPS);
  expect(prompt).not.toContain("first failure");
  expect(prompt).toContain("all failures you can diagnose");
  const legacy = lightBudgetWorkflow(false, false, taskLimits);
  expect(legacy).toContain(taskLimits ? LIGHT_LIMITED_FINISH : LIGHT_FINISH);
  expect(legacy).not.toContain(LIGHT_GLM_BATCHED_STEPS);
});

test("custom style still receives the gated workflow without default finish text", () => {
  const prompt = lightBudgetWorkflow(true, false, false, true);
  expect(prompt).toContain(LIGHT_GLM_BATCHED_STEPS);
  expect(prompt).not.toContain(LIGHT_FINISH);
});

test.each([
  ["abliteration", "abliterated-model-large-v2", true],
  [" ABLITERATION ", " ABLITERATED-MODEL-LARGE-V2 ", true],
  ["abliteration", "abliterated-model-large", false],
  ["abliteration", "abliterated-model", false],
  ["zai", "abliterated-model-large-v2", false],
  ["openrouter", "z-ai/glm-5.3", false],
  ["deepseek", "deepseek-v4-pro", false],
  ["openai", "gpt-6-luna", false],
] as const)("assembled Light head gates batched steps: %s %s", async (provider, model, expected) => {
  const session = { services: { runtimeOptions: { lightMode: true, nonInteractive: true }, providerEnvironment: {} } } as unknown as Session;
  const options = { profile: "light" as const, ctx: mkCtx(), session, provider, promptIdentity: { provider, model } };
  const light = await assembleSystemPromptSnapshot(options);
  expect(light.staticPrefix.includes(LIGHT_GLM_BATCHED_STEPS)).toBe(expected);
  const standard = await assembleSystemPromptSnapshot({ ...options, profile: "standard",
    session: { services: { runtimeOptions: { lightMode: false, nonInteractive: true }, providerEnvironment: {} } } as unknown as Session });
  expect(standard.staticPrefix).not.toContain(LIGHT_GLM_BATCHED_STEPS);
});
