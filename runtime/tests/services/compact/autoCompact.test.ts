import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  autoCompactIfNeeded,
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from "./autoCompact.js";
import type { RuntimeMessage } from "./types.js";
import { createCompactionTransactionHarness } from "../../helpers/compaction-transaction-harness.js";
import { runWithStartupProviderSelection } from "../../utils/model/providers.js";

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
    runWithCapturedEnvironment(() => {
      expect(getEffectiveContextWindowSize({
        options: { contextWindowTokens: 1_000 },
      })).toBe(1_000);
      expect(getAutoCompactThreshold({
        options: { contextWindowTokens: 1_000 },
      })).toBe(500);
    });
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
    process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "1";
    const messages = [
      message("x".repeat(10_000)),
      message("recent request"),
    ];

    const harness = createCompactionTransactionHarness(messages, {
      compactionMode: "automatic",
    });
    installNoopCompactionHooks(harness.session);
    const result = await runWithCapturedEnvironment(() =>
      autoCompactIfNeeded(messages, harness.context)
    );

    expect(result.wasCompacted).toBe(true);
    expect(result.compactionResult?.transaction).toBeDefined();
    harness.close();
  });

  test("force still refuses a candidate that cannot prove shrink", async () => {
    const messages = [message("small current turn")];
    const harness = createCompactionTransactionHarness(messages, {
      compactionMode: "automatic",
    });
    installNoopCompactionHooks(harness.session);

    await expect(autoCompactIfNeeded(messages, harness.context)).resolves.toEqual({
      wasCompacted: false,
      consecutiveFailures: 0,
    });

    const result = await autoCompactIfNeeded(
      messages,
      harness.context,
      undefined,
      "repl_main_thread",
      undefined,
      0,
      { force: true },
    );

    expect(result.wasCompacted).toBe(false);
    expect(result.consecutiveFailures).toBe(1);
    expect(harness.provider.chat).toHaveBeenCalledOnce();
    harness.close();
  });

  test("runs no lifecycle hooks below threshold and one pair for forced auto compaction", async () => {
    const messages = [
      message("x".repeat(10_000)),
      message("recent request"),
    ];
    const harness = createCompactionTransactionHarness(messages, {
      compactionMode: "automatic",
    });
    const context = { ...harness.context, cwd: harness.store.store.cwd };
    const executePreCompact = vi.fn(async () => ({}));
    const executePostCompact = vi.fn(async () => ({}));
    const services = harness.session.services as unknown as {
      hooks?: {
        executePreCompact: typeof executePreCompact;
        executePostCompact: typeof executePostCompact;
      };
    };
    services.hooks = { executePreCompact, executePostCompact };

    await expect(autoCompactIfNeeded(messages, context)).resolves.toEqual({
      wasCompacted: false,
      consecutiveFailures: 0,
    });
    expect(executePreCompact).not.toHaveBeenCalled();
    expect(executePostCompact).not.toHaveBeenCalled();

    const forced = await autoCompactIfNeeded(
      messages,
      context,
      undefined,
      undefined,
      undefined,
      0,
      { force: true },
    );
    expect(forced.wasCompacted).toBe(true);
    expect(executePreCompact).toHaveBeenCalledOnce();
    expect(executePreCompact.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hook_event_name: "PreCompact",
        trigger: "auto",
        custom_instructions: "",
      }),
    );
    expect(executePostCompact).toHaveBeenCalledOnce();
    expect(executePostCompact.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        hook_event_name: "PostCompact",
        trigger: "auto",
      }),
    );
    harness.close();
  });

  test("does not let session memory bypass the canonical transaction", async () => {
    process.env.AGENC_ENABLE_SESSION_MEMORY_COMPACT = "1";
    const cleanup = {
      clearReadFileState: vi.fn(),
      clearProviderResponseId: vi.fn(),
      resetMicrocompactState: vi.fn(),
    };

    const messages = [message("x".repeat(10_000)), message("recent request")];
    const harness = createCompactionTransactionHarness(messages, {
      compactionMode: "automatic",
    });
    process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE = "1";
    installNoopCompactionHooks(harness.session);
    const result = await runWithCapturedEnvironment(() =>
      autoCompactIfNeeded(messages, {
        ...harness.context,
        deps: {
          cleanup,
          sessionMemory: {
            getContent: async () => "remembered decisions",
          },
        },
      })
    );

    expect(result.wasCompacted).toBe(true);
    expect(result.compactionResult?.transaction).toBeDefined();
    expect(String(result.compactionResult?.summaryMessages[0]?.content))
      .not.toContain("remembered decisions");
    expect(result.compactionResult?.userDisplayMessage)
      .toBe("Conversation compacted transactionally");
    expect(cleanup.clearReadFileState).not.toHaveBeenCalled();
    expect(cleanup.clearProviderResponseId).not.toHaveBeenCalled();
    expect(cleanup.resetMicrocompactState).not.toHaveBeenCalled();
    expect(() => harness.store.assertCompactionProjectionReady()).toThrow(
      /reconstruction is required/i,
    );
    harness.close();
  });

  test("respects AgenC disable switches", async () => {
    process.env.AGENC_DISABLE_AUTO_COMPACT = "1";
    await runWithCapturedEnvironment(async () => {
      expect(isAutoCompactEnabled()).toBe(false);
      await expect(autoCompactIfNeeded(
        [message("x".repeat(10_000))],
        { options: { contextWindowTokens: 100 } },
      )).resolves.toEqual({ wasCompacted: false });
    });
  });
});

function installNoopCompactionHooks(
  session: ReturnType<typeof createCompactionTransactionHarness>["session"],
): void {
  const services = session.services as unknown as {
    hooks?: {
      executePreCompact(): Promise<Record<string, never>>;
      executePostCompact(): Promise<Record<string, never>>;
    };
  };
  services.hooks = {
    executePreCompact: async () => ({}),
    executePostCompact: async () => ({}),
  };
}

function runWithCapturedEnvironment<T>(operation: () => T): T {
  return runWithStartupProviderSelection({
    provider: "grok",
    model: "grok-4.6",
    environment: { ...process.env },
  }, operation);
}

function message(content: string): RuntimeMessage {
  return {
    role: "user",
    type: "user",
    content,
    message: { role: "user", content },
  };
}
