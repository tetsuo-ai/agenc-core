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

  test("uses a conservative floor for unrecognized models in warnings", () => {
    const state = calculateTokenWarningState(31_000, "unrecognized-model");

    expect(state.percentLeft).toBe(3);
    expect(state.isAboveWarningThreshold).toBe(true);
    expect(state.isAboveErrorThreshold).toBe(true);
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
