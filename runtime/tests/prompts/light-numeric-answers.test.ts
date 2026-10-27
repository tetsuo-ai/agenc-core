/**
 * The default Light finish paragraph says to compute numeric answers from data with a command:
 * gpt-6-luna summed CSV rows in its head and lost solves on slips, while DeepSeek Light computed such totals with a
 * command. DeepSeek's limited finish paragraph, standard mode and custom output styles stay as they were.
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

const COMPUTE = "Compute numeric answers from data with a command, not mentally.";

function count(text: string, part: string): number {
  return text.toLowerCase().split(part.toLowerCase()).length - 1;
}

async function head(profile: "light" | "standard", provider: string, model: string, outputStyle?: { name: string; prompt: string }) {
  const session = { services: { runtimeOptions: { lightMode: profile === "light", nonInteractive: true }, providerEnvironment: {} } } as unknown as Session;
  return (await assembleSystemPromptSnapshot({ profile, ctx: mkCtx(), session, provider, promptIdentity: { provider, model }, outputStyle })).staticPrefix;
}

describe("Light numeric answers from data", () => {
  test("the default finish paragraph carries the rule once and the DeepSeek paragraph does not", () => {
    expect(count(LIGHT_FINISH, COMPUTE)).toBe(1);
    expect(count(LIGHT_LIMITED_FINISH, COMPUTE)).toBe(0);
    // Large V2's batched variant of the default paragraph carries it too; its limited variant does not.
    expect(count(lightBudgetWorkflow(false, false, false, true), COMPUTE)).toBe(1);
    expect(count(lightBudgetWorkflow(false, false, true, true), COMPUTE)).toBe(0);
  });

  test.each([
    ["openai", "gpt-6-luna", 1],
    ["anthropic", "claude-haiku-5-5", 1],
    ["openrouter", "z-ai/glm-5.3", 1],
    ["deepseek", "deepseek-flash", 0],
  ])("the assembled Light head for %s (%s) carries it %i time(s)", async (provider, model, times) => {
    expect(count(await head("light", provider, model), COMPUTE)).toBe(times);
  });

  test("standard mode and a custom output style do not receive it", async () => {
    expect(count(await head("standard", "openai", "gpt-6-luna"), COMPUTE)).toBe(0);
    const styled = await head("light", "openai", "gpt-6-luna", { name: "custom", prompt: "STYLE_SENTINEL" });
    expect(count(styled, COMPUTE)).toBe(0);
  });

  test("the rule stays general: it names no task, file type, tool or language", () => {
    for (const word of ["csv", "sales", "revenue", "python", "awk", "spreadsheet", "refund"]) {
      expect(COMPUTE.toLowerCase().includes(word), word).toBe(false);
    }
  });
});
