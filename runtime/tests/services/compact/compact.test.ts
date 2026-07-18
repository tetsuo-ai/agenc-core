import { describe, expect, test, vi } from "vitest";
import {
  buildPostCompactMessages,
  compactConversation,
  createSyntheticUserCaveatMessage,
  createUserMessage,
  formatCommandInputTags,
  manualCompactCall,
  partialCompactConversation,
  partialCompactConversationAsync,
  resolveAtomicSliceIndex,
} from "./compact.js";
import type { CompactionResult, RuntimeMessage } from "./types.js";
import type { Session } from "../../session/session.js";

describe("compact service", () => {
  test("builds post-compact history in deterministic order", () => {
    const result: CompactionResult = {
      boundaryMarker: message("boundary"),
      summaryMessages: [message("summary")],
      messagesToKeep: [message("kept")],
      attachments: [message("attachment")],
      hookResults: [message("hook")],
    };

    expect(buildPostCompactMessages(result).map((entry) => entry.content))
      .toEqual(["boundary", "summary", "kept", "attachment", "hook"]);
  });

  test("manual compact returns a replacement result without provider deps", async () => {
    const cleanup = {
      clearReadFileState: vi.fn(),
      clearProviderResponseId: vi.fn(),
      resetMicrocompactState: vi.fn(),
    };
    const result = await manualCompactCall("keep decisions", {
      messages: [
        createUserMessage({ content: "Inspect src/a.ts" }),
        message("assistant result", "assistant"),
        createUserMessage({ content: "Pending: run tests" }),
      ],
      options: { contextWindowTokens: 200 },
      deps: { cleanup },
    });

    expect(result.type).toBe("compact");
    expect(result.displayText).toBe("Conversation compacted");
    expect(result.compactionResult.summaryMessages[0]?.content)
      .toContain("Inspect src/a.ts");
    expect(result.compactionResult.messagesToKeep?.at(-1)?.content)
      .toBe("Pending: run tests");
    expect(cleanup.clearReadFileState).toHaveBeenCalledOnce();
    expect(cleanup.clearProviderResponseId).toHaveBeenCalledOnce();
    expect(cleanup.resetMicrocompactState).toHaveBeenCalledOnce();
  });

  test("manual compact emits one ordered progress lifecycle and clears status on cleanup failure", async () => {
    const onCompactProgress = vi.fn();
    const setSDKStatus = vi.fn();

    await expect(
      manualCompactCall("keep decisions", {
        messages: [
          createUserMessage({ content: "Inspect src/a.ts" }),
          message("assistant result", "assistant"),
        ],
        onCompactProgress,
        setSDKStatus,
        deps: {
          cleanup: {
            clearReadFileState: () => {
              throw new Error("cleanup failed");
            },
          },
        },
      }),
    ).rejects.toThrow("cleanup failed");

    expect(onCompactProgress.mock.calls.map(([event]) => event)).toEqual([
      { type: "hooks_start", hookType: "pre_compact" },
      { type: "compact_start" },
      { type: "compact_end" },
    ]);
    expect(setSDKStatus.mock.calls.map(([status]) => status)).toEqual([
      "compacting",
      null,
    ]);
  });

  test("adds callback attachments and hook results to compact output", async () => {
    const result = await manualCompactCall("", {
      messages: [message("history"), message("tail", "assistant")],
      deps: {
        createAttachments: () => [message("attachment")],
        createHookResults: (summary) => [message(`hook:${summary.slice(0, 7)}`)],
      },
    });

    expect(result.compactionResult.attachments.map((entry) => entry.content))
      .toEqual(["attachment"]);
    expect(result.compactionResult.hookResults[0]?.content)
      .toContain("hook:");
    expect(buildPostCompactMessages(result.compactionResult).map((entry) => entry.content))
      .toContain("attachment");
  });

  test("map-reduce summarizes an over-budget transcript in bounded chunks and strips image blocks", async () => {
    // gaphunt3 #10: an over-budget transcript is no longer middle-truncated
    // into a single provider call. summarizeMessagesWithPrompt now chunks the
    // transcript into pieces no larger than MAX_SUMMARY_INPUT_CHARS, summarizes
    // each chunk (the "map" pass), then summarizes the chunk-summaries (the
    // "reduce" pass). So an 80k-char transcript drives MORE THAN ONE provider
    // call, every per-chunk call's transcript stays within the input budget,
    // and the stripped "[image]" marker still reaches at least one chunk. This
    // test must fail if map-reduce is reverted to single-call truncation.
    const MAX_SUMMARY_INPUT_CHARS = 48_000;
    const seen: string[] = [];
    const provider = {
      name: "test",
      chat: vi.fn(async (messages: Array<{ readonly content: string }>) => {
        seen.push(messages[0]?.content ?? "");
        return { content: "<analysis>drop</analysis>bounded summary" };
      }),
    };
    const result = await manualCompactCall("keep image notes", {
      provider: provider as never,
      admissionSession: admissionSessionFor(provider),
      messages: [
        {
          ...message(""),
          content: [
            { type: "text", text: "a".repeat(80_000) },
            { type: "image", source: "data" },
          ],
          message: {
            role: "user",
            content: [
              { type: "text", text: "a".repeat(80_000) },
              { type: "image", source: "data" },
            ],
          },
        },
      ],
    });

    // Map-reduce: the over-budget transcript yields multiple per-chunk calls
    // plus the final reduce pass. A single-call truncation revert would call
    // the provider exactly once and fail this assertion.
    expect(provider.chat.mock.calls.length).toBeGreaterThan(1);
    expect(seen[0]).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(seen[0]).toContain("Additional Instructions:\nkeep image notes");
    expect(seen[0]).toContain("Do NOT use Read, Bash, Grep, Glob, Edit, Write");
    const transcripts = seen.map((payload) => extractTranscript(payload));
    // Every per-chunk provider call must stay within the per-call input budget
    // (no chunk exceeds MAX_SUMMARY_INPUT_CHARS).
    for (const transcript of transcripts) {
      expect(transcript.length).toBeLessThanOrEqual(MAX_SUMMARY_INPUT_CHARS);
    }
    // Image blocks are still stripped to "[image]" — the marker survives into
    // at least one chunk rather than being dropped.
    expect(transcripts.some((transcript) => transcript.includes("[image]")))
      .toBe(true);
    const summaryContent = result.compactionResult.summaryMessages[0]?.content;
    expect(summaryContent).toContain(
      "This session is being continued from a previous conversation",
    );
    expect(summaryContent).toContain("bounded summary");
    expect(summaryContent).not.toContain("<analysis>");
  });

  test("manual compact strips media only from summary input, not kept suffix", async () => {
    const seen: string[] = [];
    const provider = {
      name: "test",
      chat: vi.fn(async (messages: Array<{ readonly content: string }>) => {
        seen.push(messages[0]?.content ?? "");
        return { content: "media-aware summary" };
      }),
    };
    const keptContent = [
      { type: "text", text: "kept tail" },
      {
        type: "image",
        source: { type: "url", url: "file:///tmp/tail.png" },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "ZmFrZS1wZGY=",
        },
        fallbackText: "tail document fallback",
      },
    ] as const;

    const result = await manualCompactCall("keep media references", {
      provider: provider as never,
      admissionSession: admissionSessionFor(provider),
      messages: [
        message([
          { type: "text", text: "summarize older image" },
          { type: "image", source: { type: "url", url: "file:///tmp/old.png" } },
        ]),
        message("middle-1", "assistant"),
        message("middle-2"),
        message("middle-3", "assistant"),
        message(keptContent),
      ],
    });

    expect(seen.some((payload) => payload.includes("[image]"))).toBe(true);
    expect(result.compactionResult.messagesToKeep?.at(-1)?.content)
      .toEqual(keptContent);
  });

  test("provider-backed compaction fails closed without an admission session", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "must not run" })),
    };

    await expect(
      manualCompactCall("", {
        provider: provider as never,
        messages: [message("older"), message("recent", "assistant")],
      }),
    ).rejects.toThrow("compaction_session_unavailable");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  test("preserves prefix and suffix ordering for partial compact projections", () => {
    const messages = ["a", "b", "c", "d", "e"].map((content) => message(content));

    expect(partialCompactConversation(messages, {
      keepPrefixCount: 2,
      keepSuffixCount: 2,
    }).map((entry) => entry.content)).toEqual(["a", "b", "d", "e"]);

    expect(partialCompactConversation(messages, {
      keepPrefixCount: 4,
      keepSuffixCount: 4,
    }).map((entry) => entry.content)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("async partial compact summarizes from the selected message after kept prefix", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "recent summary" })),
    };
    const result = await partialCompactConversationAsync(
      [message("keep"), message("summarize me"), message("tail", "assistant")],
      1,
      {
        provider: provider as never,
        admissionSession: admissionSessionFor(provider),
      },
      { direction: "from" },
    );

    expect(buildPostCompactMessages(result).map((entry) => entry.content))
      .toEqual([
        expect.stringContaining("<compact>"),
        "keep",
        expect.stringContaining("recent summary"),
      ]);
    expect(provider.chat.mock.calls[0]?.[0][0].content).toContain("summarize me");
  });

  test("async partial compact preserves media in kept prefix", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "recent summary" })),
    };
    const keptContent = [
      { type: "text", text: "keep media" },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "ZmFrZS1wZGY=",
        },
        fallbackText: "document fallback",
      },
    ] as const;

    const result = await partialCompactConversationAsync(
      [message(keptContent), message("summarize me")],
      1,
      {
        provider: provider as never,
        admissionSession: admissionSessionFor(provider),
      },
      { direction: "from" },
    );

    expect(result.messagesToKeep?.[0]?.content).toEqual(keptContent);
    expect(provider.chat.mock.calls[0]?.[0][0].content).toContain("summarize me");
  });

  test("async partial compact summarizes up to selected message before kept suffix", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "prefix summary" })),
    };
    const result = await partialCompactConversationAsync(
      [message("older"), message("selected"), message("tail", "assistant")],
      1,
      {
        provider: provider as never,
        admissionSession: admissionSessionFor(provider),
      },
      { direction: "up_to", feedback: "keep constraints" },
    );

    expect(buildPostCompactMessages(result).map((entry) => entry.content))
      .toEqual([
        expect.stringContaining("<compact>"),
        expect.stringContaining("prefix summary"),
        "selected",
        "tail",
      ]);
    expect(provider.chat.mock.calls[0]?.[0][0].content).toContain("older");
    expect(provider.chat.mock.calls[0]?.[0][0].content).toContain(
      "Additional Instructions:\nkeep constraints",
    );
  });

  test("async partial compact keeps all messages for up-to first message without provider call", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "should not be used" })),
    };
    const result = await partialCompactConversationAsync(
      [message("selected"), message("tail", "assistant")],
      0,
      { provider: provider as never },
      { direction: "up_to" },
    );

    expect(provider.chat).not.toHaveBeenCalled();
    expect(buildPostCompactMessages(result).map((entry) => entry.content))
      .toEqual([
        expect.stringContaining("<compact>"),
        expect.stringContaining("No earlier messages to summarize."),
        "selected",
        "tail",
      ]);
  });

  test("async partial compact rejects an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("test");

    await expect(
      partialCompactConversationAsync(
        [message("selected")],
        0,
        {},
        { direction: "from", signal: controller.signal },
      ),
    ).rejects.toThrow("Partial compaction aborted");
  });

  test("formats local command messages and caveat markers", () => {
    expect(formatCommandInputTags("compact", "now")).toContain(
      "<command-name>/compact</command-name>",
    );
    expect(formatCommandInputTags("c<d", "x && <tag>")).toContain(
      "x &amp;&amp; &lt;tag&gt;",
    );
    expect(createSyntheticUserCaveatMessage().content).toContain(
      "<local-command-caveat>",
    );
    expect(createUserMessage({ content: "" }).content).toBe("(no content)");
  });
});

describe("compactConversation per-context lock (#36)", () => {
  test("two concurrent calls against the same context share the in-flight result", async () => {
    // Phase 6 #36: previously, autoCompactIfNeeded (mid-turn) and
    // manualCompactCall (/compact) could both hit compactConversation
    // for the same session in parallel. Both would run summarizeMessages
    // (multi-second LLM call), both would compute different summaries,
    // and the second write to session.history would clobber the first.
    // The user observed a non-deterministic mix of summarized and
    // unsummarized turns. The lock serializes per-context: two
    // concurrent calls return the SAME promise so both observers see
    // the same outcome.
    const context = {
      options: { contextWindowTokens: 200, mainLoopModel: "qwen3:8b" },
    } as const;
    const messages: RuntimeMessage[] = [
      createUserMessage({ content: "first" }),
      message("assistant first", "assistant"),
      createUserMessage({ content: "second" }),
    ];

    const callA = compactConversation(messages, context);
    const callB = compactConversation(messages, context);

    // The resolved CompactionResult instances must be reference-
    // equal: both callers received the SAME object the single
    // in-flight compaction produced. If two parallel summarizations
    // had run, the results would be distinct objects with
    // potentially different boundaryMarker timestamps. (Outer
    // promises differ because `async function` wraps the cached
    // inner promise in a new one — `Object.is(callA, callB)` is
    // false even though both await the same underlying work.)
    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA).toBe(resultB);
  });

  test("after a compaction completes, a new call for the same context starts fresh", async () => {
    // The lock must release on completion so the next compaction
    // can proceed. Otherwise sessions would compact exactly once
    // and then jam forever.
    const context = {
      options: { contextWindowTokens: 200, mainLoopModel: "qwen3:8b" },
    } as const;
    const messages: RuntimeMessage[] = [
      createUserMessage({ content: "first" }),
      message("assistant first", "assistant"),
    ];

    const first = await compactConversation(messages, context);
    const second = await compactConversation(messages, context);
    // Distinct CompactionResult instances — the second call did
    // start fresh (lock was released).
    expect(first).not.toBe(second);
  });
});

describe("resolveAtomicSliceIndex (compaction tool-pair atomicity)", () => {
  // Audit finding: compaction sliced positionally, so a tool_call at
  // index N-1 could be summarized while its matching tool_result at
  // index N was kept verbatim. The kept suffix then started with an
  // orphaned `role: "tool"` message, which every openai-compatible
  // provider rejects with a 400. Pin the resolver here.

  test("walks the candidate split forward past leading tool-result messages", () => {
    const messages: RuntimeMessage[] = [
      message("user1"),
      message("assistant tool-calling", "assistant"),
      toolResultMessage("call-1", "result-1"),
      message("user2"),
    ];

    // Naive split at index 2 would put "tool result" first in the
    // kept suffix → orphaned. Resolver must walk forward to 3.
    expect(resolveAtomicSliceIndex(messages, 2)).toBe(3);
  });

  test("leaves a clean user-boundary split untouched", () => {
    const messages: RuntimeMessage[] = [
      message("user1"),
      message("assistant1", "assistant"),
      message("user2"),
      message("assistant2", "assistant"),
    ];
    // Splitting between message-pairs at index 2 is already clean.
    expect(resolveAtomicSliceIndex(messages, 2)).toBe(2);
  });

  test("walks past consecutive tool-result messages from a multi-tool turn", () => {
    const messages: RuntimeMessage[] = [
      message("user1"),
      message("assistant multi-tool", "assistant"),
      toolResultMessage("call-1", "result-1"),
      toolResultMessage("call-2", "result-2"),
      toolResultMessage("call-3", "result-3"),
      message("user2"),
    ];
    // Naive split at index 2 has THREE leading tool results — all
    // must be moved into the summarized prefix.
    expect(resolveAtomicSliceIndex(messages, 2)).toBe(5);
  });

  test("clamps to messages.length when the candidate is past the end", () => {
    const messages: RuntimeMessage[] = [message("user1")];
    expect(resolveAtomicSliceIndex(messages, 5)).toBe(1);
  });

  test("clamps non-positive candidates to 0", () => {
    const messages: RuntimeMessage[] = [message("user1"), message("user2")];
    expect(resolveAtomicSliceIndex(messages, -3)).toBe(0);
    expect(resolveAtomicSliceIndex(messages, 0)).toBe(0);
  });

  test("manual compact preserves tool-pair atomicity end-to-end", async () => {
    // Integration test: the orchestrator must resolve the slice via
    // resolveAtomicSliceIndex so messagesToKeep never starts with a
    // role:"tool" message. Without the fix, the kept suffix begins
    // with an orphaned tool_result.
    const messages: RuntimeMessage[] = [
      createUserMessage({ content: "Inspect src/a.ts" }),
      message("running tool", "assistant"),
      toolResultMessage("call-1", "ls output"),
      createUserMessage({ content: "Pending: run tests" }),
    ];
    const result = await manualCompactCall("keep decisions", {
      messages,
      options: { contextWindowTokens: 200 },
    });
    const kept = result.compactionResult.messagesToKeep ?? [];
    if (kept.length > 0) {
      const firstKept = kept[0]!;
      const role = firstKept.role ?? firstKept.message?.role;
      expect(role).not.toBe("tool");
      expect(firstKept.toolCallId).toBeUndefined();
    }
  });
});

function message(
  content: RuntimeMessage["content"],
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
    conversationId: "compact-test",
    nextInternalSubId: () => "compact-step",
    modelInfo: { slug: "test-model" },
    services: {
      provider,
      admissionRequired: false,
    },
  } as unknown as Session;
}

function toolResultMessage(toolCallId: string, content: string): RuntimeMessage {
  return {
    role: "tool",
    type: "tool",
    toolCallId,
    content,
    message: { role: "tool", content },
  };
}

function extractTranscript(payload: string): string {
  return /<transcript>\n([\s\S]*)\n<\/transcript>/u.exec(payload)?.[1] ?? "";
}
