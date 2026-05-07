import { describe, expect, test, vi } from "vitest";
import {
  buildPostCompactMessages,
  createSyntheticUserCaveatMessage,
  createUserMessage,
  formatCommandInputTags,
  manualCompactCall,
  partialCompactConversation,
  partialCompactConversationAsync,
} from "./compact.js";
import type { CompactionResult, RuntimeMessage } from "./types.js";

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

  test("bounds provider summary input and strips image blocks", async () => {
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

    expect(provider.chat).toHaveBeenCalledOnce();
    expect(seen[0]).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(seen[0]).toContain("Additional Instructions:\nkeep image notes");
    expect(seen[0]).toContain("Do NOT use Read, Bash, Grep, Glob, Edit, Write");
    const transcript = extractTranscript(seen[0] ?? "");
    expect(transcript.length).toBeLessThan(48_000);
    expect(transcript).toContain("[image]");
    const summaryContent = result.compactionResult.summaryMessages[0]?.content;
    expect(summaryContent).toContain(
      "This session is being continued from a previous conversation",
    );
    expect(summaryContent).toContain("bounded summary");
    expect(summaryContent).not.toContain("<analysis>");
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
      { provider: provider as never },
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

  test("async partial compact summarizes up to selected message before kept suffix", async () => {
    const provider = {
      name: "test",
      chat: vi.fn(async () => ({ content: "prefix summary" })),
    };
    const result = await partialCompactConversationAsync(
      [message("older"), message("selected"), message("tail", "assistant")],
      1,
      { provider: provider as never },
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

function extractTranscript(payload: string): string {
  return /<transcript>\n([\s\S]*)\n<\/transcript>/u.exec(payload)?.[1] ?? "";
}
