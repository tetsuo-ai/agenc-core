import { beforeEach, describe, expect, test } from "vitest";
import {
  getMicrocompactSequenceForTests,
  microcompactMessages,
  resetMicrocompactState,
} from "./microCompact.js";
import type { RuntimeMessage } from "./types.js";

describe("micro compact", () => {
  beforeEach(() => {
    resetMicrocompactState();
  });

  test("clears older compactable tool results while preserving the most recent five", async () => {
    const messages = [
      assistantToolUse(
        Array.from({ length: 6 }, (_, index) => ({
          id: `tool-${index + 1}`,
          name: "Read",
        })),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        toolResult(`tool-${index + 1}`, "x".repeat(6_500))),
    ];

    const result = await microcompactMessages(messages);
    const contents = result.messages.slice(1).map((entry) => entry.content);

    expect(contents[0]).toBe(
      "[microcompact:1] Older tool output compressed; original length 6,500 characters.",
    );
    expect(contents.slice(1)).toHaveLength(5);
    expect(contents.slice(1).every((content) => content === "x".repeat(6_500)))
      .toBe(true);
    expect(getMicrocompactSequenceForTests()).toBe(1);
  });

  test("keeps recent tool results inside the time-based clear window", async () => {
    const recentTimestamp = new Date().toISOString();
    const messages = [
      assistantToolUse(
        Array.from({ length: 6 }, (_, index) => ({
          id: `tool-${index + 1}`,
          name: "Read",
        })),
      ),
      {
        ...toolResult("tool-1", "x".repeat(6_500)),
        timestamp: recentTimestamp,
      },
      ...Array.from({ length: 5 }, (_, index) =>
        toolResult(`tool-${index + 2}`, "x".repeat(6_500))),
    ];

    const result = await microcompactMessages(messages);
    const contents = result.messages.slice(1).map((entry) => entry.content);

    expect(contents.every((content) => content === "x".repeat(6_500)))
      .toBe(true);
    expect(getMicrocompactSequenceForTests()).toBe(0);
  });

  test("keeps the latest read of the active file path beyond the recent window", async () => {
    // Read /active/file.ts first, then >5 unrelated compactable reads. Even
    // though the active read falls outside the flat recent-5 window, its
    // content must survive so the agent does not re-read it.
    const messages = [
      {
        ...assistantToolUse([{ id: "active", name: "Read" }]),
        toolCalls: [
          {
            id: "active",
            name: "Read",
            arguments: JSON.stringify({ file_path: "/active/file.ts" }),
          },
        ],
      },
      toolResult("active", "A".repeat(16_000)),
      assistantToolUse(
        Array.from({ length: 6 }, (_, index) => ({
          id: `other-${index + 1}`,
          name: "Read",
        })),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        toolResult(`other-${index + 1}`, "x".repeat(6_500))),
    ];

    const result = await microcompactMessages(messages);
    const byId = new Map(
      result.messages
        .filter((entry) => entry.toolCallId !== undefined)
        .map((entry) => [entry.toolCallId, entry.content]),
    );

    // Active file content retained despite being old.
    expect(byId.get("active")).toBe("A".repeat(16_000));
    // The oldest unrelated read is still cleared.
    expect(byId.get("other-1")).toMatch(/^\[microcompact:\d+\]/);
  });

  test("clears the older duplicate read of a path but keeps the newest", async () => {
    const readArgs = JSON.stringify({ file_path: "/dup/file.ts" });
    const messages = [
      {
        ...assistantToolUse([{ id: "dup-old", name: "Read" }]),
        toolCalls: [{ id: "dup-old", name: "Read", arguments: readArgs }],
      },
      toolResult("dup-old", "O".repeat(16_000)),
      assistantToolUse(
        Array.from({ length: 6 }, (_, index) => ({
          id: `mid-${index + 1}`,
          name: "Read",
        })),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        toolResult(`mid-${index + 1}`, "x".repeat(6_500))),
      {
        ...assistantToolUse([{ id: "dup-new", name: "Read" }]),
        toolCalls: [{ id: "dup-new", name: "Read", arguments: readArgs }],
      },
      toolResult("dup-new", "N".repeat(16_000)),
    ];

    const result = await microcompactMessages(messages);
    const byId = new Map(
      result.messages
        .filter((entry) => entry.toolCallId !== undefined)
        .map((entry) => [entry.toolCallId, entry.content]),
    );

    // Newest read of the path retained.
    expect(byId.get("dup-new")).toBe("N".repeat(16_000));
    // Older duplicate read of the same path cleared.
    expect(byId.get("dup-old")).toMatch(/^\[microcompact:\d+\]/);
  });

  test("path-aware retention applies to the block-form content path", async () => {
    const longText = "B".repeat(16_000);
    // First (older) read of /active.ts.
    const oldActiveUse = [
      { type: "tool_use", id: "active-old", name: "Read", input: { file_path: "/active.ts" } },
    ];
    const oldActiveResult = [
      { type: "tool_result", tool_use_id: "active-old", content: longText },
    ];
    const fillerToolUse = Array.from({ length: 6 }, (_, index) => ({
      type: "tool_use",
      id: `filler-${index}`,
      name: "Read",
      input: { file_path: `/filler-${index}.ts` },
    }));
    const fillerResults = Array.from({ length: 6 }, (_, index) => ({
      type: "tool_result",
      tool_use_id: `filler-${index}`,
      content: longText,
    }));
    // Second (newer) read of the same /active.ts path.
    const newActiveUse = [
      { type: "tool_use", id: "active-new", name: "Read", input: { file_path: "/active.ts" } },
    ];
    const newActiveResult = [
      { type: "tool_result", tool_use_id: "active-new", content: longText },
    ];
    const messages = [
      blockMessage("assistant", oldActiveUse),
      blockMessage("user", oldActiveResult),
      blockMessage("assistant", fillerToolUse),
      blockMessage("user", fillerResults),
      blockMessage("assistant", newActiveUse),
      blockMessage("user", newActiveResult),
    ] satisfies RuntimeMessage[];

    const result = await microcompactMessages(messages);
    const oldActiveBlocks = result.messages[1]?.content as Array<
      Record<string, unknown>
    >;
    const newActiveBlocks = result.messages[5]?.content as Array<
      Record<string, unknown>
    >;

    // Newest read of /active.ts survives.
    expect(newActiveBlocks[0]?.content).toBe(longText);
    // Older duplicate read of the same path is cleared (path-aware retention
    // keeps only the latest result per path in the block-form path too).
    expect(oldActiveBlocks[0]?.content).toBe("[Old tool result content cleared]");
  });

  test("does not use array-shaped tool input for path-aware retention", async () => {
    const longText = "P".repeat(16_000);
    const spoofedInput = Object.assign(["spoof"], {
      file_path: "/spoofed.ts",
    });
    const spoofedReadUse = [
      { type: "tool_use", id: "spoofed-read", name: "Read", input: spoofedInput },
    ];
    const spoofedReadResult = [
      { type: "tool_result", tool_use_id: "spoofed-read", content: longText },
    ];
    const fillerToolUse = Array.from({ length: 6 }, (_, index) => ({
      type: "tool_use",
      id: `filler-${index}`,
      name: "Read",
      input: { file_path: `/filler-${index}.ts` },
    }));
    const fillerResults = Array.from({ length: 6 }, (_, index) => ({
      type: "tool_result",
      tool_use_id: `filler-${index}`,
      content: longText,
    }));
    const messages = [
      blockMessage("assistant", spoofedReadUse),
      blockMessage("user", spoofedReadResult),
      blockMessage("assistant", fillerToolUse),
      blockMessage("user", fillerResults),
    ] satisfies RuntimeMessage[];

    const result = await microcompactMessages(messages);
    const spoofedResultBlocks = result.messages[1]?.content as Array<
      Record<string, unknown>
    >;

    expect(spoofedResultBlocks[0]?.content)
      .toBe("[Old tool result content cleared]");
  });

  test("ignores array-shaped content blocks when clearing old tool results", async () => {
    const longText = "S".repeat(16_000);
    const spoofedResultBlock = Object.assign(["spoof"], {
      type: "tool_result",
      tool_use_id: "spoofed-result",
      content: longText,
    }) as unknown as Record<string, unknown>;
    const messages = [
      blockMessage("user", [spoofedResultBlock]),
      ...Array.from({ length: 6 }, (_, index) =>
        blockMessage("user", [
          {
            type: "tool_result",
            tool_use_id: `recent-${index}`,
            content: longText,
          },
        ])),
    ] satisfies RuntimeMessage[];

    const result = await microcompactMessages(messages);
    const spoofedBlocks = result.messages[0]?.content as Array<
      Record<string, unknown>
    >;

    expect(spoofedBlocks[0]).toBe(spoofedResultBlock);
    expect(spoofedBlocks[0]?.content).toBe(longText);
  });

  test("reports API context-management microcompact settings", async () => {
    const result = await microcompactMessages([], {
      options: {
        apiMicrocompact: {
          clearToolResults: true,
        },
      },
    });

    expect(result.compactionInfo?.apiContextManagement).toEqual({
      clearThinking: false,
      clearToolResults: true,
      clearToolUses: false,
    });
  });

  test("supports MCP-prefixed tool uses in content blocks", async () => {
    const longText = "m".repeat(6_500);
    const toolUseBlocks = [
      { type: "tool_use", id: "mcp-1", name: "mcp__search" },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "tool_use",
        id: `recent-${index}`,
        name: "Read",
      })),
    ];
    const toolResultBlocks = [
      { type: "tool_result", tool_use_id: "mcp-1", content: longText },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "tool_result",
        tool_use_id: `recent-${index}`,
        content: longText,
      })),
    ];
    const messages = [
      {
        role: "assistant",
        type: "assistant",
        content: toolUseBlocks,
        message: {
          role: "assistant",
          content: toolUseBlocks,
        },
      },
      {
        role: "user",
        type: "user",
        content: toolResultBlocks,
        message: {
          role: "user",
          content: toolResultBlocks,
        },
      },
    ] satisfies RuntimeMessage[];

    const result = await microcompactMessages(messages);
    const rewrittenBlocks = result.messages[1]?.content;

    expect(Array.isArray(rewrittenBlocks)).toBe(true);
    expect((rewrittenBlocks as Array<Record<string, unknown>>)[0]?.content)
      .toBe("[Old tool result content cleared]");
  });
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

function blockMessage(
  role: "assistant" | "user",
  content: Array<Record<string, unknown>>,
): RuntimeMessage {
  return {
    role,
    type: role,
    content,
    message: { role, content },
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
