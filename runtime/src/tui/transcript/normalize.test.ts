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

  test("collapses directory listings without counting them as reads", () => {
    const messages = normalizeTranscriptMessages([
      msg({
        id: "list-1",
        kind: "tool_call",
        toolName: "ListDir",
        toolArgs: { path: "src" },
        isComplete: true,
      }),
      msg({
        id: "list-2",
        kind: "tool_call",
        toolName: "ls",
        toolArgs: { path: "tests" },
        isComplete: true,
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_group",
      content: "2 lists",
      groupedTools: [
        { toolName: "ListDir", target: "src" },
        { toolName: "ls", target: "tests" },
      ],
    });
  });

  test("collapses singleton read/search/list tools in normal mode", () => {
    const readMessages = normalizeTranscriptMessages([
      msg({
        id: "read-1",
        kind: "tool_call",
        toolName: "FileRead",
        toolArgs: { path: "src/input.h" },
        toolResultContent: "#define AGENC_INPUT_H 1",
        isComplete: true,
      }),
    ]);
    expect(readMessages).toHaveLength(1);
    expect(readMessages[0]).toMatchObject({
      kind: "tool_group",
      label: "read-search",
      content: "1 read",
      groupedTools: [
        {
          toolName: "FileRead",
          target: "src/input.h",
          collapseTone: "read",
          toolResultContent: "#define AGENC_INPUT_H 1",
        },
      ],
    });

    const searchMessages = normalizeTranscriptMessages([
      msg({
        id: "grep-1",
        kind: "tool_call",
        toolName: "Grep",
        toolArgs: { pattern: "AGENC_INPUT_H" },
        isComplete: true,
      }),
    ]);
    expect(searchMessages[0]).toMatchObject({
      kind: "tool_group",
      content: "1 search",
      groupedTools: [{ toolName: "Grep", collapseTone: "search" }],
    });

    const listMessages = normalizeTranscriptMessages([
      msg({
        id: "list-1",
        kind: "tool_call",
        toolName: "List",
        toolArgs: { path: "runtime/src" },
        isComplete: true,
      }),
    ]);
    expect(listMessages[0]).toMatchObject({
      kind: "tool_group",
      content: "1 list",
      groupedTools: [{ toolName: "List", collapseTone: "list" }],
    });
  });

  test("collapses read-like shell commands and preserves result metadata", () => {
    const messages = normalizeTranscriptMessages([
      msg({
        id: "exec-read",
        kind: "tool_call",
        toolName: "exec_command",
        toolArgs: { command: "cat include/agenc/input.h" },
        execCommand: "cat include/agenc/input.h",
        execStdout: "#ifndef AGENC_INPUT_H\n#define AGENC_INPUT_H\n",
        execStderr: "warning\n",
        execExitCode: 0,
        execDurationMs: 25,
        toolResultMetadata: { bytes: 42 },
        isComplete: true,
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_group",
      label: "read-search",
      content: "1 read",
      groupedTools: [
        {
          toolName: "exec_command",
          target: "cat include/agenc/input.h",
          collapseTone: "read",
          execCommand: "cat include/agenc/input.h",
          execStdout: "#ifndef AGENC_INPUT_H\n#define AGENC_INPUT_H\n",
          execStderr: "warning\n",
          execExitCode: 0,
          execDurationMs: 25,
          toolResultMetadata: { bytes: 42 },
        },
      ],
    });
  });

  test.each([
    ["head runtime/src/index.ts", "read"],
    ["tail -n 20 runtime/src/index.ts", "read"],
    ["wc -l runtime/src/index.ts", "read"],
    ["jq '.scripts' package.json", "read"],
    ["cd /repo && cat include/agenc/input.h", "read"],
    ["cd /repo && wc -l src/*.c", "read"],
    ["rg AGENC_INPUT_H runtime/src", "search"],
    ["grep -R AGENC_INPUT_H include", "search"],
    ["find runtime/src -name '*.ts'", "search"],
    ["cd /repo && grep -n lexer_create src/syntax/lexer.c", "search"],
    ["which node", "search"],
    ["ls runtime/src", "list"],
    ["tree runtime/src/tui", "list"],
    ["du -sh runtime", "list"],
    ["cd /repo && ls build/bin", "list"],
    ["ls runtime/src && echo done && tree runtime/src/tui", "list"],
  ] as const)(
    "collapses upstream-classified shell command %s as %s",
    (command, collapseTone) => {
      const messages = normalizeTranscriptMessages([
        msg({
          id: `exec-${collapseTone}`,
          kind: "tool_call",
          toolName: "Bash",
          toolArgs: { command },
          isComplete: true,
        }),
      ]);

      expect(messages[0]).toMatchObject({
        kind: "tool_group",
        content:
          collapseTone === "search"
            ? "1 search"
            : collapseTone === "list"
              ? "1 list"
              : "1 read",
        groupedTools: [{ collapseTone }],
      });
    },
  );

  test.each([
    "sed -n '1,20p' runtime/src/index.ts",
    "printf 'hello\\n'",
    "npm test",
    "cat runtime/src/index.ts | python -m json.tool",
  ])("keeps non-collapsible singleton shell command %s raw", (command) => {
    const raw = msg({
      id: "exec-raw",
      kind: "tool_call",
      toolName: "Bash",
      toolArgs: { command },
      isComplete: true,
    });

    expect(normalizeTranscriptMessages([raw])).toEqual([raw]);
  });

  test("collapses repeated edit failures against the same file", () => {
    const messages = normalizeTranscriptMessages([
      msg({
        id: "edit-1",
        kind: "tool_call",
        toolName: "Edit",
        toolArgs: { path: "src/expand/parameter.c" },
        toolResultContent: "Error editing file",
        isError: true,
        isComplete: true,
      }),
      msg({
        id: "edit-2",
        kind: "tool_call",
        toolName: "Edit",
        toolArgs: { path: "src/expand/parameter.c" },
        toolResultContent: "Error editing file",
        isError: true,
        isComplete: true,
      }),
      msg({
        id: "edit-3",
        kind: "tool_call",
        toolName: "Edit",
        toolArgs: { path: "src/expand/other.c" },
        toolResultContent: "Error editing file",
        isError: true,
        isComplete: true,
      }),
    ]);

    expect(messages.map((message) => message.id)).toEqual([
      "edit-2",
      "edit-3",
    ]);
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
