import { describe, expect, test, vi } from "vitest";
import {
  buildPostCompactMessages,
  createSyntheticUserCaveatMessage,
  createUserMessage,
  formatCommandInputTags,
  manualCompactCall,
  partialCompactConversation,
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
