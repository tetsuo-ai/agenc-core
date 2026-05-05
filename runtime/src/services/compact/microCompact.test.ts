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
