/**
 * Interactive Light working rules (round 4 job spd, from the 0.19.26 release race receipts). Light spent wall time on
 * work the request did not need: a call before the change on tool versions, git status or history, one long patch
 * planned in full before anything was written, more general code than the request needed, and new edits and checks
 * after the requested checks had passed. Interactive Light heads now say to check those only when a step depends on
 * them, to write the simplest code that meets the request, and to stop reworking and rechecking once the checks
 * pass; GPT sessions, which edit with apply_patch, write a large change as a few patches. DeepSeek keeps one patch per
 * change. Unattended Light, standard mode and the other providers' editing rules stay as they were.
 */
import { describe, expect, test } from "vitest";
import type { Session } from "../../src/session/session.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import {
  LIGHT_DIRECT_START,
  LIGHT_FINISH,
  LIGHT_LIMITED_FINISH,
  LIGHT_PATCH_SIZE,
  lightBudgetWorkflow,
} from "../../src/prompts/light-budget-prompt.js";
import { mkCtx } from "../fixtures.js";

const ONE_PATCH = "Edit and create files with apply_patch; put all hunks of one change in one patch.";
const SAME_PATCH = "When their contents are known, include the task's source, tests and requested documentation in the same patch.";

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function head(
  provider: string,
  model: string,
  options: { profile?: "light" | "standard"; nonInteractive?: boolean; outputStyle?: { name: string; prompt: string } } = {},
) {
  const profile = options.profile ?? "light";
  const session = {
    services: { runtimeOptions: { lightMode: profile === "light", nonInteractive: options.nonInteractive === true }, providerEnvironment: {} },
  } as unknown as Session;
  return (await assembleSystemPromptSnapshot({
    profile, ctx: mkCtx(), session, provider, promptIdentity: { provider, model }, outputStyle: options.outputStyle,
  })).staticPrefix;
}

describe("interactive Light working rules", () => {
  test.each([
    ["deepseek", "deepseek-flash", "one"],
    ["openai", "gpt-6-luna", "few"],
    ["openrouter", "openai/gpt-6-luna", "few"],
    ["anthropic", "claude-haiku-5-5", "none"],
    ["openrouter", "z-ai/glm-5.3", "none"],
  ])("the %s (%s) head checks versions and git state only when needed; apply_patch patches: %s", async (provider, model, patches) => {
    const prompt = await head(provider, model);
    expect(count(prompt, LIGHT_DIRECT_START)).toBe(1);
    // The rule follows the instruction to search only for context the change needs.
    expect(prompt).toContain(`Search only for missing context needed for the change. ${LIGHT_DIRECT_START}`);
    // GPT writes a large change as a few patches; DeepSeek keeps one patch per change with source, tests and docs.
    expect(count(prompt, LIGHT_PATCH_SIZE)).toBe(patches === "few" ? 1 : 0);
    expect(count(prompt, ONE_PATCH)).toBe(patches === "one" ? 1 : 0);
    expect(count(prompt, SAME_PATCH)).toBe(patches === "one" ? 1 : 0);
  });

  test("a custom output style keeps the head rules and replaces only the finish paragraph", async () => {
    const styled = await head("openai", "gpt-6-luna", { outputStyle: { name: "custom", prompt: "STYLE_SENTINEL" } });
    expect(count(styled, LIGHT_DIRECT_START)).toBe(1);
    expect(count(styled, LIGHT_PATCH_SIZE)).toBe(1);
    expect(styled).not.toContain(LIGHT_FINISH);
  });

  test.each([
    ["deepseek", "deepseek-flash", true],
    ["openai", "gpt-6-luna", false],
  ])("unattended Light on %s keeps one patch per change and its environment checks", async (provider, model, limits) => {
    const prompt = await head(provider, model, { nonInteractive: true });
    expect(prompt).not.toContain(LIGHT_DIRECT_START);
    expect(prompt).not.toContain(LIGHT_PATCH_SIZE);
    expect(count(prompt, ONE_PATCH)).toBe(1);
    expect(count(prompt, SAME_PATCH)).toBe(limits ? 1 : 0);
    expect(prompt).not.toContain("do not rework");
  });

  test.each([["deepseek", "deepseek-flash"], ["openai", "gpt-6-luna"]])("standard mode on %s receives none of them", async (provider, model) => {
    const prompt = await head(provider, model, { profile: "standard" });
    expect(prompt).not.toContain(LIGHT_DIRECT_START);
    expect(prompt).not.toContain(LIGHT_PATCH_SIZE);
    expect(prompt).not.toContain("do not rework");
  });

  test("the default finish paragraph asks for the simplest sufficient code and ends once the checks pass", () => {
    for (const finish of [LIGHT_FINISH, lightBudgetWorkflow(false, false, false, true)]) {
      expect(count(finish, "with the simplest code that meets the request")).toBe(1);
      expect(count(finish, "Once the checks pass, do not rework or recheck working code; briefly report results and stop.")).toBe(1);
      expect(count(finish, "rerun them only after new edits or failures")).toBe(1);
      // An unresolved concern after passing checks is no longer a reason to check again.
      expect(finish).not.toContain("unresolved concerns");
    }
  });

  test("the limited finish paragraph also rules out rework of what passed", () => {
    for (const finish of [LIGHT_LIMITED_FINISH, lightBudgetWorkflow(false, false, true, true)]) {
      expect(count(finish, "do not rework or re-verify what already passed")).toBe(1);
      expect(count(finish, "Try the simplest approach first without going in circles.")).toBe(1);
    }
  });

  test("the rules stay general: they name no task, file, language, value or option", () => {
    for (const rule of [LIGHT_DIRECT_START, LIGHT_PATCH_SIZE, LIGHT_FINISH, LIGHT_LIMITED_FINISH]) {
      for (const word of ["done", "default", "pending", "filter", "flag", "CLI", "true", "false", "README", "node", "npm",
        "python", "pytest", "copy", "server", "csv"]) {
        expect(rule.toLowerCase().includes(word.toLowerCase()), `${word} in ${rule.slice(0, 40)}`).toBe(false);
      }
    }
  });
});
