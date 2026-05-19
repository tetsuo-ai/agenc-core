import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  autoCompactIfNeeded,
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from "./autoCompact.js";
import type { RuntimeMessage } from "./types.js";

describe("auto compact", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  test("uses context-window data and percentage overrides for thresholds", () => {
    process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "50";

    expect(getEffectiveContextWindowSize({
      options: { contextWindowTokens: 1_000 },
    })).toBe(1_000);
    expect(getAutoCompactThreshold({
      options: { contextWindowTokens: 1_000 },
    })).toBe(500);
  });

  test("unknown models fall back to the 128k openai-compat window, not the legacy 32k haiku-era default", () => {
    // Previously this test pinned the old 32k fallback behavior:
    // 31k usage on an unrecognized model reported percentLeft=3 and
    // crossed both warning and error thresholds. That fallback was
    // wrong — every model id outside haiku/sonnet/opus (qwen, llama,
    // mistral, gemma, deepseek, ...) silently shrank to a 32k window,
    // triggering false warnings and aggressive compression on local
    // providers whose real context windows are 128k+.
    //
    // The new fallback reuses the openai-compat table's 128k
    // OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW. At 31k usage on a
    // 128k window the user is at ~24% used, well below any warning
    // band — which matches operator expectations.
    const state = calculateTokenWarningState(31_000, "unrecognized-model");

    expect(state.percentLeft).toBe(76);
    expect(state.isAboveWarningThreshold).toBe(false);
    expect(state.isAboveErrorThreshold).toBe(false);
    expect(state.isAtBlockingLimit).toBe(false);
  });

  test("qwen / llama family models resolve to their real context windows via the openai-compat table", () => {
    // Regression for the audit finding "autoCompact contextWindowForModel
    // returns 32k for qwen/llama". The fix delegates contextWindowForModel
    // to the shared lookupContextWindowForModel helper so any model id
    // present in OPENAI_CONTEXT_WINDOWS resolves to its real window.
    const qwen3 = calculateTokenWarningState(50_000, "qwen3:8b");
    expect(qwen3.percentLeft).toBe(61); // 128k window
    expect(qwen3.isAboveWarningThreshold).toBe(false);

    const qwen3plus = calculateTokenWarningState(50_000, "qwen3.6-plus");
    expect(qwen3plus.percentLeft).toBe(95); // 1M window
    expect(qwen3plus.isAboveWarningThreshold).toBe(false);

    const llama = calculateTokenWarningState(50_000, "llama-3.3-70b-versatile");
    expect(llama.percentLeft).toBe(61); // 128k window
    expect(llama.isAboveWarningThreshold).toBe(false);
  });

  test("haiku/sonnet/opus family literals keep the 200k window unchanged", () => {
    // The fix preserves the existing family-literal short-circuit;
    // these model-id shapes must continue to resolve to 200k.
    expect(getEffectiveContextWindowSize("claude-haiku-4-5")).toBe(200_000);
    expect(getEffectiveContextWindowSize("claude-sonnet-4-6")).toBe(200_000);
    expect(getEffectiveContextWindowSize("claude-opus-4-7")).toBe(200_000);
  });

  test("compacts when usage crosses threshold with only context-window data", async () => {
    const messages = [
      message("x".repeat(10_000)),
      message("recent request"),
    ];

    const result = await autoCompactIfNeeded(messages, {
      options: { contextWindowTokens: 100 },
    });

    expect(result.wasCompacted).toBe(true);
    expect(result.compactionResult?.summaryMessages[0]?.content)
      .toContain("recent request");
  });

  test("prefers session-memory compaction and runs cleanup after success", async () => {
    process.env.AGENC_ENABLE_SESSION_MEMORY_COMPACT = "1";
    const cleanup = {
      clearReadFileState: vi.fn(),
      clearProviderResponseId: vi.fn(),
      resetMicrocompactState: vi.fn(),
    };

    const result = await autoCompactIfNeeded(
      [message("x".repeat(10_000)), message("recent request")],
      {
        options: { contextWindowTokens: 100 },
        deps: {
          cleanup,
          sessionMemory: {
            getContent: async () => "remembered decisions",
          },
        },
      },
    );

    expect(result.wasCompacted).toBe(true);
    expect(result.compactionResult?.summaryMessages[0]?.content)
      .toContain("remembered decisions");
    expect(result.compactionResult?.userDisplayMessage)
      .toBe("Conversation compacted with session memory");
    expect(cleanup.clearReadFileState).toHaveBeenCalledOnce();
    expect(cleanup.clearProviderResponseId).toHaveBeenCalledOnce();
    expect(cleanup.resetMicrocompactState).toHaveBeenCalledOnce();
  });

  test("respects AgenC disable switches", async () => {
    process.env.AGENC_DISABLE_AUTO_COMPACT = "1";

    expect(isAutoCompactEnabled()).toBe(false);
    await expect(autoCompactIfNeeded(
      [message("x".repeat(10_000))],
      { options: { contextWindowTokens: 100 } },
    )).resolves.toEqual({ wasCompacted: false });
  });
});

function message(content: string): RuntimeMessage {
  return {
    role: "user",
    type: "user",
    content,
    message: { role: "user", content },
  };
}
