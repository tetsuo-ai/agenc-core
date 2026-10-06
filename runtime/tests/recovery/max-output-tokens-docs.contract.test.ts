import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ESCALATED_MAX_OUTPUT_TOKENS } from "../../src/llm/openai-compatible-token-limits.js";
import { MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from "../../src/recovery/max-output-tokens.js";
import { supportsThinkingOffRecovery } from "../../src/session/session-reasoning-effort.js";

const EXHAUSTED_TEXT =
  "The model repeatedly reached its output limit. Output recovery is exhausted; the task did not complete.";

const NO_EXPLICIT_BUDGET =
  "no explicit budget (`max_output_tokens`, `AGENC_MAX_OUTPUT_TOKENS` or `providers.<provider>.max_output_tokens`)";

const DEEPSEEK_THINKING_OFF =
  "On native DeepSeek, the call after a reasoning-only cap is sent with thinking disabled. " +
  "If it returns a tool call or a final answer, `reasoningOnlyRecoveryCount` resets to 0, " +
  "so only unproductive reasoning-only retries count. " +
  "Empty DeepSeek tool-call reasoning is kept and sent back, so the next thinking-on call is accepted.";

/** Markdown prose wraps at any space; compare sentences with whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("max-output-tokens recovery docs", () => {
  it("pins the shipped escalate ceiling, retry cap, thinking-off route, and source strings", async () => {
    expect(ESCALATED_MAX_OUTPUT_TOKENS).toBe(64_000);
    expect(MAX_OUTPUT_TOKENS_RECOVERY_LIMIT).toBe(3);
    expect(supportsThinkingOffRecovery("deepseek", "deepseek-flash")).toBe(true);
    expect(supportsThinkingOffRecovery("openrouter", "deepseek-flash")).toBe(false);

    const [runTurn, postSampleRecovery] = await Promise.all([
      readFile("src/session/run-turn.ts", "utf8"),
      readFile("src/phases/post-sample-recovery.ts", "utf8"),
    ]);
    expect(runTurn).toContain(EXHAUSTED_TEXT);
    expect(postSampleRecovery).toContain("max_output_tokens_exhausted");
  });

  it("documents escalation, counted retries, and exhaustion in daemon.md and ARCHITECTURE.md", async () => {
    const daemon = await readFile("../docs/reference/daemon.md", "utf8");
    const architecture = await readFile("../docs/ARCHITECTURE.md", "utf8");

    expect(daemon).toContain("### Max-output-tokens recovery");
    expect(daemon).toContain("`messagesAtSampleStart`");
    expect(daemon).toContain("Does **not** copy `messagesForQuery`");
    expect(daemon).toContain("`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`");
    expect(daemon).toContain("`ESCALATED_MAX_OUTPUT_TOKENS`");
    expect(daemon).toContain("maxOutputTokensCappedDefault");
    expect(daemon).toContain("AGENC_MAX_OUTPUT_TOKENS");
    expect(daemon).toContain(EXHAUSTED_TEXT);
    expect(daemon).toContain("`max_output_tokens_exhausted`");
    expect(daemon).toContain("caller history is not an ordered projection of canonical active history");
    expect(flat(daemon)).toContain("is not used. There is nothing visible to continue.");
    expect(daemon).toContain("There is no env or `config.toml` override for the 3-retry limit");
    expect(daemon).toContain("Distinct from");
    expect(daemon).toContain("`compact_failed`");
    expect(daemon).toContain("`prompt_too_long_exhausted`");
    expect(flat(daemon)).toContain(NO_EXPLICIT_BUDGET);
    expect(flat(daemon)).toContain(DEEPSEEK_THINKING_OFF);

    expect(architecture).toContain("### Max-output-tokens recovery");
    expect(architecture).toContain("messagesAtSampleStart");
    expect(architecture).toContain("MAX_OUTPUT_TOKENS_RECOVERY_LIMIT");
    expect(architecture).toContain(EXHAUSTED_TEXT);
    expect(flat(architecture)).toContain(NO_EXPLICIT_BUDGET);
    expect(flat(architecture)).toContain(DEEPSEEK_THINKING_OFF);
  });

  it("points INDEX, providers, env, and config at the same contract", async () => {
    const [index, providers, env, config] = await Promise.all([
      readFile("../docs/INDEX.md", "utf8"),
      readFile("../docs/reference/providers.md", "utf8"),
      readFile("../docs/reference/env.md", "utf8"),
      readFile("../docs/reference/config.md", "utf8"),
    ]);

    expect(index).toContain("daemon.md#max-output-tokens-recovery");
    expect(index).toContain("ARCHITECTURE.md#max-output-tokens-recovery");
    expect(providers).toContain("daemon.md#max-output-tokens-recovery");
    expect(env).toContain("daemon.md#max-output-tokens-recovery");
    expect(config).toContain("daemon.md#max-output-tokens-recovery");

    expect(flat(providers)).toContain(NO_EXPLICIT_BUDGET);
    expect(flat(providers)).toContain(DEEPSEEK_THINKING_OFF);
    expect(flat(env)).toContain(NO_EXPLICIT_BUDGET);
    expect(flat(config)).toContain(NO_EXPLICIT_BUDGET);
  });
});
