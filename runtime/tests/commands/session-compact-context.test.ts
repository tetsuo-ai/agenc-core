import { describe, expect, test, vi } from "vitest";

// session-compact.ts now imports from system-prompt.ts (to count the
// per-turn system message in /context) and that pulls in `bun:bundle`
// transitively. Mock it so vitest can load the module without a Bun
// runtime in the test harness.
vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import {
  compactCommand,
  computeContextUsageBreakdown,
  contextCommand,
} from "./session-compact.js";
import type { LLMMessage, LLMTool } from "../llm/types.js";
import type { RuntimeMessage } from "../services/compact/types.js";

function userMessage(content: string): RuntimeMessage {
  const message: LLMMessage = { role: "user", content };
  return { type: "user", message } as unknown as RuntimeMessage;
}

/**
 * Build a synthetic system RuntimeMessage matching the exact shape
 * `buildSyntheticSystemMessage` (in session-compact.ts) emits — role +
 * type + content + nested message object. The token estimator at
 * `roughTokenCountEstimationForMessage` walks both `content` and
 * `message.content`, so the redundant nested copy is intentional.
 */
function syntheticSystemMessage(text: string): RuntimeMessage {
  return {
    role: "system",
    type: "system",
    content: text,
    message: { role: "system", content: text },
  } as unknown as RuntimeMessage;
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

  test("synthetic system message produces a non-zero token delta vs conversation-only", () => {
    // Phase 3 reviewer (commit 4ba0b3d4) returned NEEDS_REVISION because
    // BLOCKER #33 was only partially closed — the commit message claimed
    // the system message was counted but `Session.snapshotHistoryMessages`
    // strips it. The follow-up commit reconstructs the per-turn system
    // prompt and prepends it as a synthetic role:"system" RuntimeMessage.
    //
    // This test pins that fix in place. If a future refactor stops
    // prepending the synthetic message (or breaks the field shape that
    // `roughTokenCountEstimationForMessage` walks), the delta drops to
    // zero and this test fails — making the regression observable
    // before it ships, which is what was missing from the prior commits.
    const conversation = [userMessage("hi")];

    // Plausible system-prompt blob: AGENC.md + assembler static head +
    // dynamic sections + MCP catalog + autonomous-work prose. The exact
    // content doesn't matter — what matters is that a non-trivial
    // system prompt produces a non-trivial delta in the displayed
    // count. Production prompts run 5k-50k tokens.
    const systemText = [
      "# AGENC.md project instructions",
      "x".repeat(8_000),
      "# Using your tools",
      "y".repeat(4_000),
      "# Permissions",
      "z".repeat(2_000),
      "# MCP Server Instructions",
      "m".repeat(6_000),
      "# Autonomous work",
      "a".repeat(3_000),
    ].join("\n");

    const withoutSystem = computeContextUsageBreakdown({
      messages: conversation,
      tools: [],
      contextWindowTokens: 200_000,
      model: "qwen3:8b",
    });
    const withSystem = computeContextUsageBreakdown({
      messages: [syntheticSystemMessage(systemText), ...conversation],
      tools: [],
      contextWindowTokens: 200_000,
      model: "qwen3:8b",
    });

    expect(withSystem.totalUsed).toBeGreaterThan(withoutSystem.totalUsed);
    // The delta must reflect the system text size meaningfully — the
    // estimator returns a few thousand tokens for a ~23kB system blob.
    // 1_000 is a conservative floor; the actual delta is much larger.
    expect(withSystem.totalUsed - withoutSystem.totalUsed).toBeGreaterThan(
      1_000,
    );
  });

  describe("cache-hit ratio surfacing", () => {
    test("populates cacheHitRatio when sessionTokenUsage carries cachedInputTokens", () => {
      const breakdown = computeContextUsageBreakdown({
        messages: [],
        tools: [],
        contextWindowTokens: 200_000,
        model: "claude-opus-4-7",
        sessionTokenUsage: {
          promptTokens: 10_000,
          cachedInputTokens: 7_500,
          cacheCreationInputTokens: 1_200,
        },
      });
      expect(breakdown.cacheHitRatio).toBeCloseTo(0.75, 2);
      expect(breakdown.sessionPromptTokens).toBe(10_000);
      expect(breakdown.sessionCachedInputTokens).toBe(7_500);
      expect(breakdown.sessionCacheCreationTokens).toBe(1_200);
    });

    test("omits cacheHitRatio when promptTokens is 0", () => {
      const breakdown = computeContextUsageBreakdown({
        messages: [],
        tools: [],
        contextWindowTokens: 200_000,
        model: "claude-opus-4-7",
        sessionTokenUsage: {
          promptTokens: 0,
          cachedInputTokens: 0,
        },
      });
      expect(breakdown.cacheHitRatio).toBeUndefined();
      expect(breakdown.sessionPromptTokens).toBeUndefined();
    });

    test("omits cacheHitRatio when sessionTokenUsage is missing entirely (no usage data yet)", () => {
      const breakdown = computeContextUsageBreakdown({
        messages: [],
        tools: [],
        contextWindowTokens: 200_000,
        model: "claude-opus-4-7",
      });
      expect(breakdown.cacheHitRatio).toBeUndefined();
    });

    test("omits cacheHitRatio when cachedInputTokens is undefined (provider doesn't report cache split)", () => {
      const breakdown = computeContextUsageBreakdown({
        messages: [],
        tools: [],
        contextWindowTokens: 200_000,
        model: "grok-4.3",
        sessionTokenUsage: {
          promptTokens: 5_000,
        },
      });
      expect(breakdown.cacheHitRatio).toBeUndefined();
    });

    test("clamps the ratio between 0 and 1 if a provider reports cached > prompt", () => {
      // Defensive: if a provider's accounting drifts, don't render
      // 150% hit which would confuse the user.
      const breakdown = computeContextUsageBreakdown({
        messages: [],
        tools: [],
        contextWindowTokens: 200_000,
        model: "claude-opus-4-7",
        sessionTokenUsage: {
          promptTokens: 1000,
          cachedInputTokens: 1500,
        },
      });
      expect(breakdown.cacheHitRatio).toBe(1);
    });
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

describe("/context TUI bridge", () => {
  test("opens the v2 context usage modal from the slash command", async () => {
    const setToolJSX = vi.fn();
    const session = {
      abortController: new AbortController(),
      conversationId: "session-1",
      newDefaultTurnWithSubId: () => ({
        cwd: "/tmp/agenc-context",
        config: {},
        modelInfo: {
          slug: "grok-4",
          contextWindow: 200_000,
          effectiveContextWindowPercent: 100,
        },
        modelProviderId: "xai",
        options: {},
      }),
      nextInternalSubId: () => "sub-1",
      snapshotHistoryMessages: () => [],
      state: {
        unsafePeek: () => ({
          totalTokenUsage: {
            promptTokens: 1_000,
            cachedInputTokens: 250,
          },
        }),
      },
      permissionModeRegistry: {
        current: () => undefined,
      },
      services: {
        registry: {
          toLLMTools: () => [],
          allSpecs: () => [],
        },
        configStore: {
          current: () => ({}),
        },
        permissionModeRegistry: {
          current: () => undefined,
        },
        provider: {},
      },
      emit: vi.fn(),
      clearProviderResponseId: vi.fn(),
    };

    const result = await contextCommand.execute({
      session: session as never,
      argsRaw: "",
      cwd: "/tmp/agenc-context",
      home: "/home/test",
      appState: { setToolJSX },
    });

    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    const payload = setToolJSX.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
    expect(payload?.jsx?.props?.text).toContain("Context:");
    expect(payload?.jsx?.props?.text).toContain("prompt cache");
  });

  test("array-shaped permission context is ignored for synthetic system prompt", async () => {
    const renderContextText = async (current: () => unknown): Promise<string> => {
      const setToolJSX = vi.fn();
      const session = {
        abortController: new AbortController(),
        conversationId: "session-1",
        newDefaultTurnWithSubId: () => ({
          cwd: "/tmp/agenc-context",
          config: {},
          modelInfo: {
            slug: "grok-4",
            contextWindow: 200_000,
            effectiveContextWindowPercent: 100,
          },
          modelProviderId: "xai",
          options: {},
        }),
        nextInternalSubId: () => "sub-1",
        snapshotHistoryMessages: () => [],
        state: {
          unsafePeek: () => ({
            totalTokenUsage: {
              promptTokens: 1_000,
              cachedInputTokens: 250,
            },
          }),
        },
        permissionModeRegistry: { current },
        services: {
          registry: {
            toLLMTools: () => [],
            allSpecs: () => [],
          },
          configStore: {
            current: () => ({}),
          },
          permissionModeRegistry: { current },
          provider: {},
        },
        emit: vi.fn(),
        clearProviderResponseId: vi.fn(),
      };

      const result = await contextCommand.execute({
        session: session as never,
        argsRaw: "",
        cwd: "/tmp/agenc-context",
        home: "/home/test",
        appState: { setToolJSX },
      });

      expect(result).toEqual({ kind: "skip" });
      const payload = setToolJSX.mock.calls[0]?.[0];
      return String(payload?.jsx?.props?.text ?? "");
    };

    const noPermissionContext = await renderContextText(() => undefined);
    const spoofedPermissionContext = await renderContextText(() =>
      Object.assign(["spoof"], { mode: "bypassPermissions" }),
    );

    expect(spoofedPermissionContext).toBe(noPermissionContext);
  });

  test("falls back to daemon token usage when no in-process turn context exists", async () => {
    const setToolJSX = vi.fn();
    const session = {
      conversationId: "bridge-session",
      services: {
        registry: {
          toLLMTools: () => [],
        },
        configStore: {
          current: () => ({
            model: "grok-4",
            model_provider: "grok",
            providers: {
              grok: { context_window_tokens: 200_000 },
            },
          }),
        },
      },
      getDaemonSessionSnapshot: async () => ({
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 2_000,
          totalTokens: 12_000,
        },
      }),
    };

    const result = await contextCommand.execute({
      session: session as never,
      argsRaw: "",
      cwd: "/tmp/agenc-context",
      home: "/home/test",
      appState: {
        setToolJSX,
        getAppState: () => ({ mainLoopModel: "grok-4" }),
      },
    });

    expect(result).toEqual({ kind: "skip" });
    const payload = setToolJSX.mock.calls[0]?.[0];
    expect(payload?.jsx?.props?.text).toContain("Context: 12,000 / 200,000");
    expect(payload?.jsx?.props?.text).toContain("estimate:");
  });
});

describe("/compact TUI bridge", () => {
  test("opens a v2 blocked compact modal with context estimate when turn context is unavailable", async () => {
    const setToolJSX = vi.fn();
    const session = {
      conversationId: "bridge-session",
      services: {
        registry: {
          toLLMTools: () => [],
        },
        configStore: {
          current: () => ({
            model: "grok-4",
            model_provider: "grok",
            providers: {
              grok: { context_window_tokens: 200_000 },
            },
          }),
        },
      },
      getDaemonSessionSnapshot: async () => ({
        tokenUsage: {
          totalTokens: 12_000,
        },
      }),
    };

    const result = await compactCommand.execute({
      session: session as never,
      argsRaw: "",
      cwd: "/tmp/agenc-context",
      home: "/home/test",
      appState: {
        setToolJSX,
        getAppState: () => ({ mainLoopModel: "grok-4" }),
      },
    });

    expect(result).toEqual({ kind: "skip" });
    const payload = setToolJSX.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
    });
    expect(payload?.jsx?.props?.contextText).toContain("Context: 12,000 / 200,000");
    expect(payload?.jsx?.props?.message).toContain("requires the in-process runtime");
  });
});
