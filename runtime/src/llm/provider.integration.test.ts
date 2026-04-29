import { describe, expect, test } from "vitest";

import { createProvider, type ProviderName } from "./provider.js";

function envEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const RUN_REMOTE = envEnabled("AGENC_RUN_PROVIDER_INTEGRATION_TESTS");
const RUN_LOCAL = envEnabled("AGENC_RUN_LOCAL_PROVIDER_TESTS");

const PROVIDER_CASES: ReadonlyArray<{
  readonly provider: ProviderName;
  readonly model: string;
  readonly enabled: boolean;
  readonly envKey?: string;
}> = [
  {
    provider: "grok",
    model: process.env.AGENC_GROK_INTEGRATION_MODEL ?? "grok-4-fast",
    enabled: RUN_REMOTE && Boolean(process.env.XAI_API_KEY ?? process.env.GROK_API_KEY),
    envKey: "XAI_API_KEY",
  },
  {
    provider: "openai",
    model: process.env.AGENC_OPENAI_INTEGRATION_MODEL ?? "gpt-5",
    enabled: RUN_REMOTE && Boolean(process.env.OPENAI_API_KEY),
    envKey: "OPENAI_API_KEY",
  },
  {
    provider: "anthropic",
    model: process.env.AGENC_ANTHROPIC_INTEGRATION_MODEL ?? "claude-opus-4-7",
    enabled: RUN_REMOTE && Boolean(process.env.ANTHROPIC_API_KEY),
    envKey: "ANTHROPIC_API_KEY",
  },
  {
    provider: "openrouter",
    model: process.env.AGENC_OPENROUTER_INTEGRATION_MODEL ?? "openai/gpt-5",
    enabled: RUN_REMOTE && Boolean(process.env.OPENROUTER_API_KEY),
    envKey: "OPENROUTER_API_KEY",
  },
  {
    provider: "groq",
    model:
      process.env.AGENC_GROQ_INTEGRATION_MODEL ?? "llama-3.3-70b-versatile",
    enabled: RUN_REMOTE && Boolean(process.env.GROQ_API_KEY),
    envKey: "GROQ_API_KEY",
  },
  {
    provider: "deepseek",
    model:
      process.env.AGENC_DEEPSEEK_INTEGRATION_MODEL ?? "deepseek-reasoner",
    enabled: RUN_REMOTE && Boolean(process.env.DEEPSEEK_API_KEY),
    envKey: "DEEPSEEK_API_KEY",
  },
  {
    provider: "gemini",
    model: process.env.AGENC_GEMINI_INTEGRATION_MODEL ?? "gemini-2.5-pro",
    enabled: RUN_REMOTE && Boolean(process.env.GEMINI_API_KEY),
    envKey: "GEMINI_API_KEY",
  },
  {
    provider: "ollama",
    model: process.env.AGENC_OLLAMA_INTEGRATION_MODEL ?? "llama3.3",
    enabled: RUN_LOCAL,
  },
  {
    provider: "lmstudio",
    model: process.env.AGENC_LMSTUDIO_INTEGRATION_MODEL ?? "gpt-4o-mini",
    enabled: RUN_LOCAL,
  },
];

describe("provider integration (env-gated)", () => {
  for (const testCase of PROVIDER_CASES) {
    test.skipIf(!testCase.enabled)(
      `${testCase.provider} chat smoke`,
      async () => {
        const provider = createProvider(testCase.provider, {
          model: testCase.model,
        });
        const response = await provider.chat(
          [{ role: "user", content: "Reply with OK." }],
          { timeoutMs: 60_000 },
        );
        expect(typeof response.content).toBe("string");
        expect(response.content.trim().length).toBeGreaterThan(0);
        expect(typeof response.model).toBe("string");
      },
      90_000,
    );
  }
});
