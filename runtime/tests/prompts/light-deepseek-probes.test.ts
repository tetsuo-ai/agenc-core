/**
 * Interactive DeepSeek Light (round 4 job dsw) runs checks directly instead of probing tool versions or
 * availability first, and does not search git history for the intended behavior. Every other head is unchanged.
 */
import { describe, expect, test } from "vitest";
import type { Session } from "../../src/session/session.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import { LIGHT_DEEPSEEK_PROBES } from "../../src/prompts/light-budget-prompt.js";
import { mkCtx } from "../fixtures.js";

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function head(
  provider: string,
  model: string,
  options: { profile?: "light" | "standard"; nonInteractive?: boolean; env?: Record<string, string> } = {},
) {
  const profile = options.profile ?? "light";
  const session = {
    services: {
      runtimeOptions: { lightMode: profile === "light", nonInteractive: options.nonInteractive === true },
      providerEnvironment: options.env ?? {},
    },
  } as unknown as Session;
  return (await assembleSystemPromptSnapshot({
    profile, ctx: mkCtx(), session, provider, promptIdentity: { provider, model },
  })).staticPrefix;
}

describe("DeepSeek Light probes", () => {
  test.each([
    ["deepseek", "deepseek-flash"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
    ["ollama-cloud", "deepseek-v4.1-flash:1017"],
  ])("interactive DeepSeek through %s (%s) says it once, after the search sentence", async (provider, model) => {
    for (const env of [{}, { AGENC_LIGHT_TASK_LIMITS: "0" }]) {
      const prompt = await head(provider, model, { env });
      expect(count(prompt, LIGHT_DEEPSEEK_PROBES)).toBe(1);
      expect(prompt).toContain(`Search only for missing context needed for the change. ${LIGHT_DEEPSEEK_PROBES} `);
    }
  });

  test.each([
    ["deepseek", "deepseek-flash", { nonInteractive: true }],
    ["deepseek", "deepseek-flash", { profile: "standard" as const }],
    ["openai", "gpt-6-luna", {}],
    ["openai", "gpt-6-luna", { env: { AGENC_LIGHT_TASK_LIMITS: "1" } }],
    ["qwen-token-plan", "qwen3.8-max", {}],
    ["abliteration", "abliterated-model-large-flash", {}],
    ["abliteration", "abliterated-model-large-v2", {}],
    ["anthropic", "claude-haiku-5-5", {}],
  ])("%s (%s, %j) does not get it", async (provider, model, options) => {
    expect(await head(provider, model, options)).not.toContain(LIGHT_DEEPSEEK_PROBES);
  });
});
