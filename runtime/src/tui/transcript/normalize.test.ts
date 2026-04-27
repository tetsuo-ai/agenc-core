import { describe, expect, test } from "vitest";

import type { TranscriptMessage } from "./MessageList.js";
import { normalizeTranscriptMessages } from "./normalize.js";

function msg(
  partial: Partial<TranscriptMessage> & Pick<TranscriptMessage, "id" | "kind">,
): TranscriptMessage {
  return {
    turnId: "turn-1",
    content: "",
    timestamp: 0,
    ...partial,
  };
}

describe("normalizeTranscriptMessages", () => {
  test("collapses consecutive read/search tool bursts", () => {
    const messages = normalizeTranscriptMessages([
      msg({
        id: "read-1",
        kind: "tool_call",
        toolName: "FileRead",
        toolArgs: { path: "src/a.ts" },
        isComplete: true,
      }),
      msg({
        id: "grep-1",
        kind: "tool_call",
        toolName: "Grep",
        toolArgs: { pattern: "TODO" },
        isComplete: true,
      }),
      msg({
        id: "assistant",
        kind: "assistant",
        content: "done",
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      kind: "tool_group",
      content: "1 read, 1 search",
      groupedTools: [
        { toolName: "FileRead", target: "src/a.ts" },
        { toolName: "Grep", target: "TODO" },
      ],
    });
  });

  test("verbose mode keeps raw rows", () => {
    const raw = [
      msg({ id: "read-1", kind: "tool_call", toolName: "FileRead" }),
      msg({ id: "grep-1", kind: "tool_call", toolName: "Grep" }),
    ];

    expect(normalizeTranscriptMessages(raw, { verbose: true })).toEqual(raw);
  });

  test("collapses hook and teammate summaries", () => {
    const messages = normalizeTranscriptMessages([
      msg({
        id: "hook-1",
        kind: "meta",
        label: "hook",
        content: "hook_additional_context",
      }),
      msg({
        id: "hook-2",
        kind: "meta",
        label: "hook",
        content: "hook_permission_decision",
      }),
      msg({
        id: "team-1",
        kind: "meta",
        content: "teammate alpha completed",
      }),
      msg({
        id: "team-2",
        kind: "meta",
        content: "subagent beta stopped",
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      kind: "meta",
      label: "hooks",
      content: "2 hook events",
    });
    expect(messages[1]).toMatchObject({
      kind: "meta",
      label: "teammates",
      content: "2 teammate updates",
    });
  });
});
