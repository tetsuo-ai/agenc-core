/**
 * Regression: memory-bound-naming (GAP #1 + #5).
 *
 * Microcompact keyed its compactable / path-bearing sets on the upstream tool
 * names "Read"/"Bash", but the LIVE tool registry registers the whole-file
 * reader as "FileRead" (`FILE_READ_TOOL_NAME` in
 * `src/tools/system/file-read.ts`) and the shell tool as "exec_command"
 * (`src/tools/system/exec-command.ts`). As a result the two LARGEST tool
 * outputs — whole-file reads and shell/build/test logs — were NEVER
 * microcompacted, and path-aware retention never fired for FileRead.
 *
 * These tests use the LIVE tool names and FAIL if the names are reverted:
 *  - (a) the most-recent large "FileRead" result is kept full (counts toward
 *    the recent-N keep window) alongside other compactable tools,
 *  - (b) the same for "exec_command",
 *  - (c) the LATEST "FileRead" of the active path is retained full even when
 *    it falls OUTSIDE the recent-N window (path-aware retention).
 */

import { beforeEach, describe, expect, test } from "vitest";
import { FILE_READ_TOOL_NAME } from "../../../src/tools/system/file-read.js";
import {
  microcompactMessages,
  resetMicrocompactState,
} from "../../../src/services/compact/microCompact.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";

const EXEC_COMMAND_TOOL_NAME = "exec_command";

describe("micro compact — memory-bound-naming (live tool names)", () => {
  beforeEach(() => {
    resetMicrocompactState();
  });

  // A recent FileRead/exec_command result must count toward the recent-N keep
  // window. With the naming bug, FileRead/exec_command ids are absent from
  // `compactableIds`, so when OTHER compactable tools make the set non-empty
  // their result positions are NOT collected, they fall out of `keepIds`, and
  // the standalone rewrite path WRONGLY compacts the most-recent FileRead /
  // exec_command output the model still relies on. The non-compactable check
  // here has no size===0 escape hatch, so these genuinely regress.

  test(
    "keeps the most-recent large FileRead full alongside other compactable " +
      "tools (regresses when COMPACTABLE_TOOLS keys on 'Read' not 'FileRead')",
    async () => {
      const big = "x".repeat(10_000);
      const messages = [
        assistantToolUse([
          // Other compactable tool uses make `compactableIds` non-empty, so the
          // size===0 fallback that masks the bug cannot apply.
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `grep-${index + 1}`,
            name: "Grep",
          })),
          { id: "fr-recent", name: FILE_READ_TOOL_NAME },
        ]),
        ...Array.from({ length: 6 }, (_, index) =>
          toolResult(`grep-${index + 1}`, big)),
        // The most-recent tool result overall is the FileRead.
        toolResult("fr-recent", big),
      ];

      const result = await microcompactMessages(messages);
      const byId = new Map(
        result.messages
          .filter((entry) => entry.toolCallId !== undefined)
          .map((entry) => [entry.toolCallId, entry.content]),
      );

      // The most-recent FileRead output is preserved full (it is inside the
      // recent-N window only if FileRead is a recognized compactable tool).
      expect(byId.get("fr-recent")).toBe(big);
    },
  );

  test(
    "keeps the most-recent large exec_command full alongside other compactable " +
      "tools (regresses when COMPACTABLE_TOOLS keys on 'Bash' not 'exec_command')",
    async () => {
      const big = "x".repeat(10_000);
      const messages = [
        assistantToolUse([
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `grep-${index + 1}`,
            name: "Grep",
          })),
          { id: "ec-recent", name: EXEC_COMMAND_TOOL_NAME },
        ]),
        ...Array.from({ length: 6 }, (_, index) =>
          toolResult(`grep-${index + 1}`, big)),
        toolResult("ec-recent", big),
      ];

      const result = await microcompactMessages(messages);
      const byId = new Map(
        result.messages
          .filter((entry) => entry.toolCallId !== undefined)
          .map((entry) => [entry.toolCallId, entry.content]),
      );

      expect(byId.get("ec-recent")).toBe(big);
    },
  );

  test(
    "retains the LATEST FileRead of the active path even OUTSIDE the recent-N " +
      "window (regresses when PATH_BEARING_READ_TOOLS keys on 'Read' not " +
      "'FileRead' — then the active read is evicted and the agent re-reads it)",
    async () => {
      // Read /active/file.ts, then >5 unrelated FileReads. The active read now
      // falls OUTSIDE the flat recent-5 window, so ONLY path-aware retention
      // (which requires FileRead in PATH_BEARING_READ_TOOLS) keeps it full.
      const activeArgs = JSON.stringify({ file_path: "/active/file.ts" });
      const messages = [
        {
          ...assistantToolUse([{ id: "active", name: FILE_READ_TOOL_NAME }]),
          toolCalls: [
            { id: "active", name: FILE_READ_TOOL_NAME, arguments: activeArgs },
          ],
        },
        toolResult("active", "A".repeat(16_000)),
        assistantToolUse(
          Array.from({ length: 6 }, (_, index) => ({
            id: `other-${index + 1}`,
            name: FILE_READ_TOOL_NAME,
          })),
        ),
        ...Array.from({ length: 6 }, (_, index) =>
          toolResult(`other-${index + 1}`, "y".repeat(6_500))),
      ];

      const result = await microcompactMessages(messages);
      const byId = new Map(
        result.messages
          .filter((entry) => entry.toolCallId !== undefined)
          .map((entry) => [entry.toolCallId, entry.content]),
      );

      // Active file content retained full despite being old (path-aware).
      expect(byId.get("active")).toBe("A".repeat(16_000));
      // The oldest unrelated read is still cleared (proves the recent-N window
      // really did evict the active read's position, so retention is what saved
      // it — not merely the window).
      expect(byId.get("other-1")).toMatch(/^\[microcompact:\d+\]/);
    },
  );
});

function assistantToolUse(
  toolCalls: Array<{ readonly id: string; readonly name: string }>,
): RuntimeMessage {
  return {
    role: "assistant",
    type: "assistant",
    toolCalls,
    content: "",
    message: { role: "assistant", content: "" },
  };
}

function toolResult(toolCallId: string, content: string): RuntimeMessage {
  return {
    role: "tool",
    originalRole: "tool",
    type: "tool_result",
    toolCallId,
    content,
    message: { role: "tool", content },
  };
}
