import { describe, expect, test, vi } from "vitest";

// session-compact.ts now imports from system-prompt.ts (to count the
// per-turn system message in /context) and that pulls in `bun:bundle`
// transitively. Mock it so vitest can load the module without a Bun
// runtime in the test harness.
vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import { computeContextUsageBreakdown } from "./session-compact.js";
import type { LLMMessage, LLMTool } from "../llm/types.js";
import type { RuntimeMessage } from "../services/compact/types.js";

function userMessage(content: string): RuntimeMessage {
  const message: LLMMessage = { role: "user", content };
  return { type: "user", message } as unknown as RuntimeMessage;
}

function tool(name: string, description: string): LLMTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

describe("/context display: computeContextUsageBreakdown", () => {
  test("reports four distinct fields: hard limit, compaction threshold, used, free headroom", () => {
    // Audit finding: previous /context display showed only "X / Y
    // (Z%)" with no separation between hard limit and compaction
    // threshold, violating the global 'UI Semantics' rule. The new
    // breakdown separates the four numbers.
    const breakdown = computeContextUsageBreakdown({
      messages: [userMessage("hello world")],
      tools: [],
      contextWindowTokens: 100_000,
      model: "qwen3:8b",
    });

    expect(breakdown.hardLimit).toBe(100_000);
    // The compaction threshold reuses getAutoCompactThreshold ⇒
    // hardLimit - AUTOCOMPACT_BUFFER_TOKENS (13_000), unless an env
    // override is set; this test runs without overrides.
    expect(breakdown.compactionThreshold).toBeLessThan(breakdown.hardLimit);
    expect(breakdown.compactionThreshold).toBeGreaterThan(0);
    expect(breakdown.totalUsed).toBeGreaterThan(0);
    expect(breakdown.freeUntilHardLimit).toBe(
      breakdown.hardLimit - breakdown.totalUsed,
    );
    expect(breakdown.freeUntilCompact).toBe(
      breakdown.compactionThreshold - breakdown.totalUsed,
    );
  });

  test("includes tool catalog overhead in the total (the previous estimator excluded it)", () => {
    // Audit finding: roughRuntimeTokenCount summed message text only.
    // The model also receives every enabled tool's JSON schema, which
    // for a session with 30+ tools is thousands of tokens. The new
    // breakdown counts them separately so the operator sees the real
    // wire-level usage.
    const messages = [userMessage("hi")];
    const noTools = computeContextUsageBreakdown({
      messages,
      tools: [],
      contextWindowTokens: 100_000,
    });
    const withTools = computeContextUsageBreakdown({
      messages,
      tools: [
        tool(
          "ExecCommand",
          "Run a shell command. Output is the combined stdout+stderr stream.",
        ),
        tool(
          "FileEdit",
          "Performs exact string replacements in files. Use full snapshot.",
        ),
      ],
      contextWindowTokens: 100_000,
    });

    expect(withTools.toolsTokens).toBeGreaterThan(0);
    expect(noTools.toolsTokens).toBe(0);
    expect(withTools.totalUsed).toBeGreaterThan(noTools.totalUsed);
    expect(withTools.totalUsed - noTools.totalUsed).toBe(
      withTools.toolsTokens,
    );
  });

  test("hard limit honors the live config window over the model-string fallback", () => {
    // contextWindowTokens (from providers.<slug>.context_window_tokens)
    // must override any model-string-based lookup. Without this
    // override, an operator who sets a 256k window for qwen3:8b in
    // their config would see only the 128k table-default in /context.
    const breakdown = computeContextUsageBreakdown({
      messages: [],
      tools: [],
      contextWindowTokens: 262_144,
      model: "qwen3:8b", // table default for this id is 128k
    });
    expect(breakdown.hardLimit).toBe(262_144);
  });

  test("hard limit falls back to the table-driven model lookup when no config window is supplied", () => {
    // qwen3:8b is in OPENAI_CONTEXT_WINDOWS at 128_000.
    const breakdown = computeContextUsageBreakdown({
      messages: [],
      tools: [],
      model: "qwen3:8b",
    });
    expect(breakdown.hardLimit).toBe(128_000);
  });

  test("freeUntilCompact / freeUntilHardLimit clamp to 0 when usage exceeds the limit", () => {
    // If the operator runs /context after they've already blown
    // through the window (e.g. 200k tokens of pasted content on a
    // 128k window), the display must not show negative free
    // headroom — that's nonsensical and confuses the operator.
    const massive = "x".repeat(2_000_000);
    const breakdown = computeContextUsageBreakdown({
      messages: [userMessage(massive)],
      tools: [],
      contextWindowTokens: 128_000,
      model: "qwen3:8b",
    });
    expect(breakdown.totalUsed).toBeGreaterThan(breakdown.hardLimit);
    expect(breakdown.freeUntilCompact).toBe(0);
    expect(breakdown.freeUntilHardLimit).toBe(0);
  });

  test("auto-compact disabled flag flips compactionThreshold to the hard limit", () => {
    // When DISABLE_COMPACT or AGENC_DISABLE_COMPACT is set, the
    // compaction threshold should equal the hard limit (no
    // separate threshold to display). The breakdown reports
    // autoCompactEnabled:false so the renderer can show the
    // appropriate message.
    const original = process.env.AGENC_DISABLE_COMPACT;
    try {
      process.env.AGENC_DISABLE_COMPACT = "1";
      const breakdown = computeContextUsageBreakdown({
        messages: [],
        tools: [],
        contextWindowTokens: 200_000,
        model: "qwen3:8b",
      });
      expect(breakdown.autoCompactEnabled).toBe(false);
      expect(breakdown.compactionThreshold).toBe(breakdown.hardLimit);
    } finally {
      if (original === undefined) {
        delete process.env.AGENC_DISABLE_COMPACT;
      } else {
        process.env.AGENC_DISABLE_COMPACT = original;
      }
    }
  });
});
