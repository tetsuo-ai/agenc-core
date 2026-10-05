import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ESCALATED_MAX_OUTPUT_TOKENS } from "../../src/llm/openai-compatible-token-limits.js";
import {
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  RETRY_REASONING_ONLY_CONTENT,
} from "../../src/recovery/max-output-tokens.js";

describe("max-output-tokens recovery docs", () => {
  it("pins the shipped escalate ceiling, retry cap, and operator strings", async () => {
    expect(ESCALATED_MAX_OUTPUT_TOKENS).toBe(64_000);
    expect(MAX_OUTPUT_TOKENS_RECOVERY_LIMIT).toBe(3);
    expect(RETRY_REASONING_ONLY_CONTENT).toBe(
      "The previous response exhausted its output budget on reasoning without returning an answer or a tool call. " +
        "Choose the next concrete step now: make one short, complete call to an available tool, or give a concise final answer if the task is complete. " +
        "Do not restart the analysis. Stay within the task's scope and current tool permissions.",
    );

    const daemon = await readFile("../docs/reference/daemon.md", "utf8");
    const architecture = await readFile("../docs/ARCHITECTURE.md", "utf8");

    expect(daemon).toContain("### Max-output-tokens recovery");
    expect(daemon).toContain("`messagesAtSampleStart`");
    expect(daemon).toContain("Does **not** copy `messagesForQuery`");
    expect(daemon).toContain("`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`");
    expect(daemon).toContain("`ESCALATED_MAX_OUTPUT_TOKENS`");
    expect(daemon).toContain("maxOutputTokensCappedDefault");
    expect(daemon).toContain("AGENC_MAX_OUTPUT_TOKENS");
    expect(daemon).toContain(
      "The model repeatedly reached its output limit. Output recovery is exhausted; the task did not complete.",
    );
    expect(daemon).toContain("`max_output_tokens_exhausted`");
    expect(daemon).toContain("caller history is not an ordered projection of canonical active history");
    expect(daemon).toContain("not used — there is nothing visible to continue");
    expect(daemon).toContain("There is no env or `config.toml` override for the 3-retry limit");
    expect(daemon).toContain("Distinct from");
    expect(daemon).toContain("`compact_failed`");
    expect(daemon).toContain("`prompt_too_long_exhausted`");

    expect(architecture).toContain("### Max-output-tokens recovery");
    expect(architecture).toContain("messagesAtSampleStart");
    expect(architecture).toContain("MAX_OUTPUT_TOKENS_RECOVERY_LIMIT");
    expect(architecture).toContain(
      "The model repeatedly reached its output limit. Output recovery is exhausted; the task did not complete.",
    );
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
  });
});
