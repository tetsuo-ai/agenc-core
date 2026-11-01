/**
 * Interactive Light working rules (round 4 job spd, from the 0.19.26 release race receipts). Light spent wall time on
 * work the request did not need: a call before the change on tool versions, git status or history, one long patch
 * planned in full before anything was written, more general code than the request needed, and new edits and checks
 * after the requested checks had passed. Interactive Light heads now say to check those only when a step depends on
 * them, to write the simplest code that meets the request, and to stop reworking and rechecking once the checks
 * pass; GPT sessions, which edit with apply_patch, write a large change as a few patches. DeepSeek models keep the
 * 0.19.26 prompt (the race-task A/B: these rules cost DeepSeek Flash calls, output and reasoning). Unattended Light,
 * standard mode and the other providers' editing rules stay as they were.
 */
import { describe, expect, test } from "vitest";
import type { Session } from "../../src/session/session.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import {
  LIGHT_DEEPSEEK_FINISH,
  LIGHT_FINISH,
  LIGHT_LIMITED_FINISH,
  LIGHT_LOOKUPS,
  LIGHT_PATCH_SIZE,
  LIGHT_READ_FIRST,
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
  options: {
    profile?: "light" | "standard"; nonInteractive?: boolean; outputStyle?: { name: string; prompt: string };
    env?: Record<string, string>;
  } = {},
) {
  const profile = options.profile ?? "light";
  const session = {
    services: {
      runtimeOptions: { lightMode: profile === "light", nonInteractive: options.nonInteractive === true },
      providerEnvironment: options.env ?? {},
    },
  } as unknown as Session;
  return (await assembleSystemPromptSnapshot({
    profile, ctx: mkCtx(), session, provider, promptIdentity: { provider, model }, outputStyle: options.outputStyle,
  })).staticPrefix;
}

describe("interactive Light working rules", () => {
  test.each([
    ["openai", "gpt-6-luna", "few"],
    ["openrouter", "openai/gpt-6-luna", "few"],
    ["anthropic", "claude-haiku-5-5", "none"],
    ["openrouter", "z-ai/glm-5.3", "none"],
  ])("the %s (%s) head checks versions and git state only when needed; apply_patch patches: %s", async (provider, model, patches) => {
    const prompt = await head(provider, model);
    expect(count(prompt, LIGHT_LOOKUPS)).toBe(1);
    // The shorter reading and search sentences replace the 0.19.26 ones.
    expect(prompt).toContain(`omit default arguments. ${LIGHT_READ_FIRST} ${LIGHT_LOOKUPS}`);
    expect(prompt).not.toContain("Read a known file before editing it");
    // GPT writes a large change as a few patches.
    expect(count(prompt, LIGHT_PATCH_SIZE)).toBe(patches === "few" ? 1 : 0);
    expect(prompt).not.toContain(ONE_PATCH);
  });

  test.each([
    ["deepseek", "deepseek-flash"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
    ["ollama-cloud", "deepseek-v4.1-flash:1017"],
  ])("DeepSeek through %s (%s) keeps the 0.19.26 head, with the task limits on or off", async (provider, model) => {
    const limited = await head(provider, model);
    const unlimited = await head(provider, model, { env: { AGENC_LIGHT_TASK_LIMITS: "0" } });
    for (const prompt of [limited, unlimited]) {
      expect(prompt).not.toContain(LIGHT_LOOKUPS);
      expect(prompt).not.toContain(LIGHT_PATCH_SIZE);
      expect(prompt).not.toContain("without rework");
      expect(prompt).not.toContain("with the simplest code");
      expect(prompt).toContain("Read a known file before editing it: FileRead, or cat, sed -n or head of that file.");
    }
    expect(limited).toContain(LIGHT_LIMITED_FINISH);
    expect(unlimited).toContain(LIGHT_DEEPSEEK_FINISH);
    expect(unlimited).toContain("Repeat for new edits, failures or unresolved concerns");
    if (model === "deepseek-flash") expect(count(limited, ONE_PATCH) + count(limited, SAME_PATCH)).toBe(2);
  });

  test("a custom output style keeps the head rules and replaces only the finish paragraph", async () => {
    const styled = await head("openai", "gpt-6-luna", { outputStyle: { name: "custom", prompt: "STYLE_SENTINEL" } });
    expect(count(styled, LIGHT_LOOKUPS)).toBe(1);
    expect(count(styled, LIGHT_PATCH_SIZE)).toBe(1);
    expect(styled).not.toContain(LIGHT_FINISH);
  });

  test.each([
    ["deepseek", "deepseek-flash", true],
    ["openai", "gpt-6-luna", false],
  ])("unattended Light on %s keeps one patch per change and its environment checks", async (provider, model, limits) => {
    const prompt = await head(provider, model, { nonInteractive: true });
    expect(prompt).not.toContain(LIGHT_LOOKUPS);
    expect(prompt).not.toContain(LIGHT_PATCH_SIZE);
    expect(count(prompt, ONE_PATCH)).toBe(1);
    expect(count(prompt, SAME_PATCH)).toBe(limits ? 1 : 0);
    expect(prompt).not.toContain("do not rework");
  });

  test.each([["deepseek", "deepseek-flash"], ["openai", "gpt-6-luna"]])("standard mode on %s receives none of them", async (provider, model) => {
    const prompt = await head(provider, model, { profile: "standard" });
    expect(prompt).not.toContain(LIGHT_LOOKUPS);
    expect(prompt).not.toContain(LIGHT_PATCH_SIZE);
    expect(prompt).not.toContain("do not rework");
  });

  test("the default finish paragraph asks for the simplest code and ends once the checks pass", () => {
    for (const finish of [LIGHT_FINISH, lightBudgetWorkflow(false, false, false, true)]) {
      expect(count(finish, "with the simplest code.")).toBe(1);
      expect(count(finish, "Once they pass, report briefly and stop without rework.")).toBe(1);
      expect(count(finish, "then rerun.")).toBe(1);
      // An unresolved concern after passing checks is no longer a reason to check again.
      expect(finish).not.toContain("unresolved concerns");
    }
  });

  test("the task-limits paragraph and its heads keep the 0.19.26 wording (DeepSeek, Qwen3.8, or the switch)", async () => {
    for (const finish of [LIGHT_LIMITED_FINISH, lightBudgetWorkflow(false, false, true, true)]) {
      expect(count(finish, "do not re-verify what already passed")).toBe(1);
      expect(finish).not.toContain("do not rework");
    }
    const gptWithLimits = await head("openai", "gpt-6-luna", { env: { AGENC_LIGHT_TASK_LIMITS: "1" } });
    expect(gptWithLimits).toContain(LIGHT_LIMITED_FINISH);
    for (const prompt of [await head("qwen-token-plan", "qwen3.8-max"), gptWithLimits]) {
      expect(count(prompt, "do not re-verify what already passed")).toBe(1);
      expect(prompt).not.toContain("do not rework");
      expect(prompt).not.toContain(LIGHT_LOOKUPS);
      expect(prompt).not.toContain(LIGHT_PATCH_SIZE);
      expect(prompt).toContain("Read a known file before editing it: FileRead, or cat, sed -n or head of that file. Search only for missing context needed for the change.");
    }
  });

  test("the rules stay general: they name no task, file, language, value or option", () => {
    for (const rule of [LIGHT_READ_FIRST, LIGHT_LOOKUPS, LIGHT_PATCH_SIZE, LIGHT_FINISH, LIGHT_LIMITED_FINISH]) {
      for (const word of ["done", "default", "pending", "filter", "flag", "CLI", "true", "false", "README", "node", "npm",
        "python", "pytest", "copy", "server", "csv"]) {
        expect(rule.toLowerCase().includes(word.toLowerCase()), `${word} in ${rule.slice(0, 40)}`).toBe(false);
      }
    }
  });
});
