import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMicrocompactSequenceForTests,
  microcompactMessages,
  resetMicrocompactState,
} from "src/services/compact/microCompact.js";
import { autoCompactIfNeeded } from "src/services/compact/autoCompact.js";
import { compactConversation } from "src/services/compact/compact.js";
import type { RuntimeMessage } from "src/services/compact/types.js";
import type { Session } from "src/session/session.js";

/**
 * Revert-sensitive regression tests for gaphunt #3 compaction findings.
 *
 * #3  microCompact standalone-tool-message branch must honor the
 *     COMPACTABLE_TOOLS allowlist (preserve non-compactable tool results).
 * #10 compaction summarizer must summarize the WHOLE over-limit transcript
 *     hierarchically (map-reduce) instead of dropping its middle.
 * #41 auto-compaction must classify user/provider aborts structurally so the
 *     circuit-breaker counter is not tripped and the cancel propagates.
 */

describe("gaphunt3 #3 — microcompact standalone branch honors COMPACTABLE_TOOLS", () => {
  beforeEach(() => {
    resetMicrocompactState();
  });

  it("preserves a large non-compactable standalone tool result verbatim", async () => {
    const original = "A".repeat(8_000);
    const messages: RuntimeMessage[] = [
      // One non-compactable tool result (e.g. an agent/Task tool). It must be
      // preserved even though it is large and outside the recent window.
      standaloneToolResult("non-compactable", "SomeNonCompactableTool", original),
      // Enough recent COMPACTABLE tool results to push the above out of the
      // recent-N keep window (keepIds only tracks compactable positions).
      ...Array.from({ length: 6 }, (_, index) =>
        standaloneToolResult(`read-${index}`, "FileRead", "x".repeat(7_000))),
    ];

    const result = await microcompactMessages(messages);
    const preserved = result.messages.find(
      (entry) => entry.toolCallId === "non-compactable",
    );

    // Before the fix the standalone branch cleared it to a "[microcompact:N]"
    // placeholder regardless of the allowlist; after the fix it is untouched.
    expect(preserved?.content).toBe(original);
    expect(preserved?.content).not.toMatch(/^\[microcompact:/);
  });

  it("still clears a large compactable standalone tool result (gate is scoped)", async () => {
    // Confirms the gate does not over-protect: an old, large, COMPACTABLE
    // result outside the recent window is still compressed.
    const messages: RuntimeMessage[] = [
      standaloneToolResult("old-read", "FileRead", "y".repeat(8_000)),
      ...Array.from({ length: 6 }, (_, index) =>
        standaloneToolResult(`recent-${index}`, "FileRead", "z".repeat(7_000))),
    ];

    const result = await microcompactMessages(messages);
    const cleared = result.messages.find(
      (entry) => entry.toolCallId === "old-read",
    );

    expect(cleared?.content).toMatch(/^\[microcompact:/);
    expect(getMicrocompactSequenceForTests()).toBeGreaterThan(0);
  });
});

describe("gaphunt3 #10 — oversized transcript is summarized whole (map-reduce)", () => {
  it("the summarizer sees every chunk, including the middle, not a head/tail truncation", async () => {
    // Sentinel that exists ONLY in the middle of the to-summarize transcript.
    // Under the old behavior boundTranscript replaced the middle with an
    // omission marker, so the sentinel never reached the provider. Under
    // chunked map-reduce summarization every chunk is sent, so the sentinel
    // appears in one of the provider calls.
    const MIDDLE_SENTINEL = "UNIQUE_MIDDLE_SENTINEL_7f3a2b";
    const seenTranscripts: string[] = [];
    const provider = {
      name: "test",
      chat: vi.fn(async (msgs: Array<{ readonly content: string }>) => {
        seenTranscripts.push(msgs[0]?.content ?? "");
        return { content: "chunk summary" };
      }),
    };

    // Build a >200k-char prefix to summarize with the sentinel in the middle.
    const head = makeMessage("h".repeat(100_000));
    const middle = makeMessage(`prefix ${MIDDLE_SENTINEL} suffix`);
    const tail = makeMessage("t".repeat(100_000));
    const recentUser = makeMessage("most recent request");
    const messages: RuntimeMessage[] = [head, middle, tail, recentUser];

    await compactConversation(messages, {
      provider: provider as never,
      admissionSession: admissionSessionFor(provider),
      options: { contextWindowTokens: 200, mainLoopModel: "qwen3:8b" },
    });

    expect(provider.chat).toHaveBeenCalled();
    const allTranscripts = seenTranscripts.join("\n");
    // The middle sentinel reached the summarizer (no middle was dropped).
    expect(allTranscripts).toContain(MIDDLE_SENTINEL);
    // And the old omission marker is NOT present.
    expect(allTranscripts).not.toContain("[...middle omitted during compaction...]");
    // Map-reduce: head, middle, and tail were all summarized → more than one
    // provider call for an over-limit input.
    expect(provider.chat.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not chunk a small transcript (single summarizer call, unchanged path)", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "small summary" })),
    };

    await compactConversation(
      [makeMessage("short history"), makeMessage("recent", "assistant")],
      {
        provider: provider as never,
        admissionSession: admissionSessionFor(provider),
        options: { contextWindowTokens: 200, mainLoopModel: "qwen3:8b" },
      },
    );

    expect(provider.chat).toHaveBeenCalledOnce();
  });
});

describe("gaphunt3 #41 — auto-compaction does not count aborts as failures", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("re-throws and does not increment consecutiveFailures when the context is aborted", async () => {
    const abortController = new AbortController();
    abortController.abort("user pressed esc");

    // Provider whose summary call throws once aborted. The abort discriminator
    // must surface the cancel rather than swallowing it into a failure count.
    const provider = {
      name: "test",
      chat: vi.fn(async () => {
        throw new Error("Partial compaction aborted");
      }),
    };

    await expect(
      autoCompactIfNeeded(
        [makeMessage("x".repeat(10_000)), makeMessage("recent request")],
        {
          provider: provider as never,
          admissionSession: admissionSessionFor(provider),
          abortController,
          options: { contextWindowTokens: 100, mainLoopModel: "qwen3:8b" },
        },
        undefined,
        undefined,
        { consecutiveFailures: 0 },
        0,
        { force: true },
      ),
    ).rejects.toThrow(/abort/i);
  });

  it("classifies a provider AbortError as a cancel even without an aborted controller", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const provider = {
      name: "test",
      chat: vi.fn(async () => {
        throw abortError;
      }),
    };

    await expect(
      autoCompactIfNeeded(
        [makeMessage("x".repeat(10_000)), makeMessage("recent request")],
        {
          provider: provider as never,
          admissionSession: admissionSessionFor(provider),
          options: { contextWindowTokens: 100, mainLoopModel: "qwen3:8b" },
        },
        undefined,
        undefined,
        { consecutiveFailures: 0 },
        0,
        { force: true },
      ),
    ).rejects.toBe(abortError);
  });

  it("still counts a genuine (non-abort) compaction failure", async () => {
    // Control: a real error that propagates to autoCompactIfNeeded's catch
    // (here a hook-results dep failure — provider summary errors are swallowed
    // into a fallback summary) must still increment the circuit-breaker counter
    // so the abort carve-out does not mask genuine failures.
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "summary" })),
    };

    const result = await autoCompactIfNeeded(
      [makeMessage("x".repeat(10_000)), makeMessage("recent request")],
      {
        provider: provider as never,
        admissionSession: admissionSessionFor(provider),
        options: { contextWindowTokens: 100, mainLoopModel: "qwen3:8b" },
        deps: {
          createHookResults: () => {
            throw new Error("post-compact hook exploded");
          },
        },
      },
      undefined,
      undefined,
      { consecutiveFailures: 0 },
      0,
      { force: true },
    );

    expect(result.wasCompacted).toBe(false);
    expect(result.consecutiveFailures).toBe(1);
  });
});

function makeMessage(
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

function admissionSessionFor(provider: unknown): Session {
  return {
    conversationId: "gaphunt-compact-test",
    nextInternalSubId: () => "compact-step",
    modelInfo: { slug: "test-model" },
    services: {
      provider,
      admissionRequired: false,
    },
  } as unknown as Session;
}

function standaloneToolResult(
  toolCallId: string,
  toolName: string,
  content: string,
): RuntimeMessage {
  return {
    role: "tool",
    originalRole: "tool",
    type: "tool_result",
    toolCallId,
    toolName,
    content,
    message: { role: "tool", content },
  };
}
