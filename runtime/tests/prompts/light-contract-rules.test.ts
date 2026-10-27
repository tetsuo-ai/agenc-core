/**
 * Light's finish paragraphs carry one contract rule (round 4 job sq): keep behavior the request does not change,
 * naming the parts of a code contract (inputs it accepts, data it keeps, outputs and errors). It is a general working
 * principle; the assembled heads carry it for every Light provider family, and no other profile or a custom output
 * style receives it.
 */
import { describe, expect, test } from "vitest";
import type { Session } from "../../src/session/session.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import {
  LIGHT_FINISH,
  LIGHT_LIMITED_FINISH,
  lightBudgetWorkflow,
} from "../../src/prompts/light-budget-prompt.js";
import { mkCtx } from "../fixtures.js";

const KEEP = "Keep behavior the request does not change: inputs the code accepts, data it keeps, its outputs and errors.";

function count(text: string, part: string): number {
  return text.toLowerCase().split(part.toLowerCase()).length - 1;
}

async function head(profile: "light" | "standard", provider: string, model: string, env: Record<string, string> = {}, outputStyle?: { name: string; prompt: string }) {
  const session = { services: { runtimeOptions: { lightMode: profile === "light", nonInteractive: true }, providerEnvironment: env } } as unknown as Session;
  return (await assembleSystemPromptSnapshot({ profile, ctx: mkCtx(), session, provider, promptIdentity: { provider, model }, outputStyle })).staticPrefix;
}

describe("Light contract rules", () => {
  test("both finish paragraphs keep the behavior the request does not change", () => {
    for (const finish of [LIGHT_FINISH, LIGHT_LIMITED_FINISH]) {
      expect(count(finish, KEEP)).toBe(1);
    }
    // Large V2 batched variants carry the same rules.
    for (const limits of [false, true]) {
      const glm = lightBudgetWorkflow(false, false, limits, true);
      expect(count(glm, KEEP)).toBe(1);
    }
  });

  test.each([
    ["deepseek", "deepseek-flash"],
    ["openai", "gpt-6-luna"],
    ["anthropic", "claude-haiku-5-5"],
    ["openrouter", "z-ai/glm-5.3"],
  ])("the assembled Light head for %s carries the rule once", async (provider, model) => {
    const prompt = await head("light", provider, model);
    expect(count(prompt, KEEP)).toBe(1);
  });

  test.each([["deepseek", "deepseek-flash"], ["openai", "gpt-6-luna"]])(
    "standard mode and a custom output style do not receive the Light rule (%s)", async (provider, model) => {
      expect(count(await head("standard", provider, model), KEEP)).toBe(0);
      const styled = await head("light", provider, model, {}, { name: "custom", prompt: "STYLE_SENTINEL" });
      expect(count(styled, KEEP)).toBe(0);
    });

  test("the rules stay general: they name no task, field, value or option", () => {
    for (const finish of [LIGHT_FINISH, LIGHT_LIMITED_FINISH]) {
      for (const word of ["done", "default", "pending", "filter", "flag", "CLI", "true", "false"]) {
        expect(finish.toLowerCase().includes(word.toLowerCase()), word).toBe(false);
      }
    }
  });
});
