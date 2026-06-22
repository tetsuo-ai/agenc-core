import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { sourceUrl } from "../../helpers/source-path.ts";
import {
  getAPIContextManagement,
} from "./apiMicrocompact.js";
import {
  createCachedMicrocompactState,
  getCachedMicrocompactState,
  isCachedMicrocompactEnabled,
  maybeRunCachedMicrocompact,
  resetCachedMicrocompactState,
} from "./cachedMicrocompact.js";
import {
  clearCompactWarningSuppression,
  compactWarningStore,
  suppressCompactWarning,
} from "./compactWarningState.js";
import { runPostCompactCleanup } from "./postCompactCleanup.js";
import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
  getPartialCompactPrompt,
  stripAnalysisTags,
} from "./prompt.js";
import {
  calculateMessagesToKeepIndex,
  preserveToolPairsFromIndex,
  shouldUseSessionMemoryCompaction,
  trySessionMemoryCompaction,
} from "./sessionMemoryCompact.js";
import { snipCompact } from "./snipCompact.js";
import {
  DEFAULT_MICROCOMPACT_CLEAR_AFTER_MS,
  getTimeBasedMicrocompactClearAfterMs,
} from "./timeBasedMCConfig.js";
import type { RuntimeMessage } from "./types.js";

describe("compact supporting surfaces", () => {
  test("builds API context-management config only for active strategies", () => {
    expect(getAPIContextManagement()).toBeNull();
    expect(getAPIContextManagement({ clearThinking: true })).toEqual({
      clearThinking: true,
      clearToolResults: false,
      clearToolUses: false,
    });
    expect(getAPIContextManagement({
      clearToolResults: true,
      clearToolUses: true,
    })).toEqual({
      clearThinking: false,
      clearToolResults: true,
      clearToolUses: true,
    });
    expect(getAPIContextManagement({}, {
      AGENC_MICROCOMPACT_CLEAR_TOOL_RESULTS: "1",
    })).toEqual({
      clearThinking: false,
      clearToolResults: true,
      clearToolUses: false,
    });
  });

  test("keeps cached micro-compact disabled and does not create a mirror-only config file", async () => {
    const disabledState = { enabled: false, pinnedEdits: [] };

    expect(isCachedMicrocompactEnabled()).toBe(false);
    expect(createCachedMicrocompactState()).toEqual(disabledState);
    expect(getCachedMicrocompactState()).toEqual(disabledState);
    expect(resetCachedMicrocompactState()).toBeUndefined();
    await expect(maybeRunCachedMicrocompact()).resolves.toBeNull();
    expect(existsSync(fileURLToPath(sourceUrl("services/compact/cachedMCConfig.ts"))))
      .toBe(false);
  });

  test("formats compact summaries without analysis blocks", () => {
    expect(stripAnalysisTags("before <analysis>private</analysis> after"))
      .toBe("before  after");
    expect(stripAnalysisTags([
      "keep",
      "<analysis>private one</analysis>",
      "middle",
      "<analysis>private two</analysis>",
      "after",
    ].join("\n"))).toBe("keep\n\nmiddle\n\nafter");
    expect(formatCompactSummary("<analysis>private</analysis>use this"))
      .toBe("use this");
    expect(formatCompactSummary([
      "<analysis>private</analysis>",
      "<analysis>more private</analysis>",
      "<summary>",
      "use this",
      "",
      "",
      "next",
      "</summary>",
    ].join("\n"))).toBe("Summary:\nuse this\n\nnext");
  });

  test("preserves $-sequences in the summary body verbatim", () => {
    // Regression: the summary was injected into String.replace's replacement
    // string, so $&, $1, $$ and shell snippets were reinterpreted as
    // substitution patterns and corrupted the output.
    expect(
      formatCompactSummary(
        "<summary>cost was $5 and $$ and $& and $1 and $`echo`</summary>",
      ),
    ).toBe("Summary:\ncost was $5 and $$ and $& and $1 and $`echo`");
  });

  test("builds compact prompts with no-tool framing and custom instructions", () => {
    const prompt = getCompactPrompt("Focus on runtime files.");

    expect(prompt).toMatch(/^CRITICAL: Respond with TEXT ONLY/u);
    expect(prompt).toContain("Do NOT use Read, Bash, Grep, Glob, Edit, Write");
    expect(prompt).toContain("Primary Request and Intent");
    expect(prompt).toContain("Additional Instructions:\nFocus on runtime files.");
    expect(prompt).toMatch(
      /Tool calls will be rejected and you will fail the task\.$/u,
    );
    expect(getCompactPrompt()).not.toContain("Additional Instructions:");
    expect(getCompactPrompt("   ")).not.toContain("Additional Instructions:");
  });

  test("builds partial compact prompts for recent and prefix summaries", () => {
    const recentPrompt = getPartialCompactPrompt("Keep errors.", "from");
    const prefixPrompt = getPartialCompactPrompt(undefined, "up_to");

    expect(recentPrompt).toContain("RECENT portion of the conversation");
    expect(recentPrompt).toContain("Current Work");
    expect(recentPrompt).toContain("Additional Instructions:\nKeep errors.");
    expect(prefixPrompt).toContain("Context for Continuing Work");
    expect(prefixPrompt).not.toContain("RECENT portion of the conversation");
  });

  test("builds compact continuation messages with transcript context", () => {
    const message = getCompactUserSummaryMessage(
      "<analysis>draft</analysis><summary>done</summary>",
      false,
      "/tmp/agenc-transcript.jsonl",
      true,
    );

    expect(message).toContain("Summary:\ndone");
    expect(message).toContain(
      "read the full transcript at: /tmp/agenc-transcript.jsonl",
    );
    expect(message).toContain("Recent messages are preserved verbatim.");

    const directContinuation = getCompactUserSummaryMessage("done", true);
    expect(directContinuation).toContain("without asking the user");
    expect(directContinuation).toContain("Resume directly - do not acknowledge");
  });

  test("keeps session-memory compact behind AgenC switches", async () => {
    expect(shouldUseSessionMemoryCompaction({
      AGENC_ENABLE_SESSION_MEMORY_COMPACT: "1",
    })).toBe(true);
    expect(shouldUseSessionMemoryCompaction({
      AGENC_ENABLE_SESSION_MEMORY_COMPACT: "1",
      AGENC_DISABLE_SESSION_MEMORY_COMPACT: "true",
    })).toBe(false);

    const messages = [
      message("a"),
      {
        role: "assistant",
        type: "assistant",
        content: "",
        toolCalls: [{ id: "tool-1", name: "Read" }],
        message: { role: "assistant", content: "" },
      },
      {
        role: "tool",
        type: "tool_result",
        toolCallId: "tool-1",
        content: "tool output",
        message: { role: "tool", content: "tool output" },
      },
      message("d"),
    ] satisfies RuntimeMessage[];
    expect(calculateMessagesToKeepIndex(messages, 2)).toBe(2);
    expect(preserveToolPairsFromIndex(messages, 2).map((entry) => entry.content))
      .toEqual(["", "tool output", "d"]);
    await expect(trySessionMemoryCompaction()).resolves.toBeNull();

    const savedSwitch = process.env.AGENC_ENABLE_SESSION_MEMORY_COMPACT;
    try {
      process.env.AGENC_ENABLE_SESSION_MEMORY_COMPACT = "1";
      const result = await trySessionMemoryCompaction(messages, {
        deps: {
          sessionMemory: {
            getContent: () => "memory summary",
          },
        },
      });

      expect(result?.summaryMessages[0]?.content).toContain("memory summary");
      expect(result?.messagesToKeep?.map((entry) => entry.content))
        .toEqual(["a", "", "tool output", "d"]);
      expect(result?.userDisplayMessage)
        .toBe("Conversation compacted with session memory");
    } finally {
      if (savedSwitch === undefined) {
        delete process.env.AGENC_ENABLE_SESSION_MEMORY_COMPACT;
      } else {
        process.env.AGENC_ENABLE_SESSION_MEMORY_COMPACT = savedSwitch;
      }
    }
  });

  test("ignores array-shaped content blocks when preserving session-memory tool pairs", () => {
    const toolUseMessage: RuntimeMessage = {
      role: "assistant",
      type: "assistant",
      content: [{ type: "tool_use", id: "tool-array", name: "Read" }],
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-array", name: "Read" }],
      },
    };
    const spoofedResultBlock = Object.assign(["spoof"], {
      type: "tool_result",
      tool_use_id: "tool-array",
      content: "malformed",
    }) as unknown as Record<string, unknown>;
    const spoofedResultMessage: RuntimeMessage = {
      role: "user",
      type: "user",
      content: [spoofedResultBlock],
      message: { role: "user", content: [spoofedResultBlock] },
    };
    const tailMessage = message("tail");
    const messages = [
      toolUseMessage,
      message("middle"),
      spoofedResultMessage,
      tailMessage,
    ];

    expect(preserveToolPairsFromIndex(messages, 2)).toEqual([
      spoofedResultMessage,
      tailMessage,
    ]);
  });

  test("runs cleanup callbacks and exposes warning suppression state", () => {
    const listener = vi.fn();
    const unsubscribe = compactWarningStore.subscribe(listener);

    suppressCompactWarning();
    expect(compactWarningStore.getState()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    clearCompactWarningSuppression();
    expect(compactWarningStore.getState()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();

    const cleanup = {
      clearReadFileState: vi.fn(),
      clearProviderResponseId: vi.fn(),
      clearSearchIndexes: vi.fn(),
      clearToolIndexes: vi.fn(),
      resetMicrocompactState: vi.fn(),
    };
    runPostCompactCleanup(cleanup);
    expect(Object.values(cleanup).every((fn) => fn.mock.calls.length === 1))
      .toBe(true);
  });

  test("keeps conservative time and snip compact fallbacks", () => {
    expect(getTimeBasedMicrocompactClearAfterMs({})).toBe(
      DEFAULT_MICROCOMPACT_CLEAR_AFTER_MS,
    );
    expect(getTimeBasedMicrocompactClearAfterMs({
      AGENC_MICROCOMPACT_CLEAR_AFTER_MS: "1200",
    })).toBe(1_200);

    const messages = [message("unchanged")];
    expect(snipCompact(messages)).toEqual({ messages, tokensFreed: 0 });

    const longMessages = ["prefix", "middle", "suffix"].map((content) =>
      message(content.repeat(10_000)));
    const result = snipCompact(longMessages, {
      targetTokenCount: 10,
      keepPrefixCount: 1,
      keepSuffixCount: 1,
    });
    expect(result.tokensFreed).toBeGreaterThan(0);
    expect(result.messages.map((entry) => entry.content)).toEqual([
      "prefix".repeat(10_000),
      "[Earlier conversation snipped before compaction]",
      "suffix".repeat(10_000),
    ]);
  });
});

function message(
  content: string,
  role: NonNullable<RuntimeMessage["role"]> = "user",
): RuntimeMessage {
  return {
    role,
    type: role,
    content,
    message: { role, content },
  };
}
