import { describe, expect, test } from "vitest";

import {
  findToolTurnValidationIssue,
  repairToolTurnSequence,
  validateToolTurnSequence,
} from "../../src/llm/tool-turn-validator.js";
import type { LLMMessage, LLMToolCall } from "../../src/llm/types.js";

function toolCall(id: string, name = "FileRead"): LLMToolCall {
  return { id, name, arguments: "{}" };
}

function assistantWithCalls(
  calls: readonly LLMToolCall[],
  content = "",
): LLMMessage {
  return { role: "assistant", content, toolCalls: [...calls] };
}

function toolResult(
  toolCallId: string,
  toolName = "FileRead",
  content = "ok",
): LLMMessage {
  return { role: "tool", toolCallId, toolName, content };
}

function user(content: string): LLMMessage {
  return { role: "user", content };
}

describe("repairToolTurnSequence", () => {
  test("returns the same array when the sequence is already valid", () => {
    const messages: readonly LLMMessage[] = [
      user("read it"),
      assistantWithCalls([toolCall("call-1")]),
      toolResult("call-1"),
    ];

    expect(repairToolTurnSequence(messages)).toBe(messages);
    expect(findToolTurnValidationIssue(messages)).toBeNull();
  });

  test("synthesizes one assistant envelope for consecutive orphaned tool results", () => {
    const orphaned: readonly LLMMessage[] = [
      user("continue"),
      toolResult("call-a", "FileRead", "a"),
      toolResult("call-b", "FileWrite", "b"),
    ];

    const repaired = repairToolTurnSequence(orphaned);
    expect(repaired).not.toBe(orphaned);
    expect(repaired).toEqual([
      user("continue"),
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-a", name: "FileRead", arguments: "{}" },
          { id: "call-b", name: "FileWrite", arguments: "{}" },
        ],
      },
      toolResult("call-a", "FileRead", "a"),
      toolResult("call-b", "FileWrite", "b"),
    ]);
    expect(findToolTurnValidationIssue(repaired)).toBeNull();
    expect(() =>
      validateToolTurnSequence(repaired, { providerName: "grok" }),
    ).not.toThrow();
    expect(repairToolTurnSequence(repaired)).toBe(repaired);
  });

  test("drops a tool result with an empty toolCallId instead of inventing a call", () => {
    const messages: readonly LLMMessage[] = [
      user("continue"),
      { role: "tool", toolCallId: "   ", toolName: "FileRead", content: "x" },
      toolResult("call-1"),
    ];

    const repaired = repairToolTurnSequence(messages);
    expect(repaired).toEqual([
      user("continue"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "FileRead", arguments: "{}" }],
      },
      toolResult("call-1"),
    ]);
    expect(findToolTurnValidationIssue(repaired)).toBeNull();
  });

  test("does not invent missing tool results on the default provider path", () => {
    const messages: readonly LLMMessage[] = [
      assistantWithCalls([toolCall("call-1")]),
      user("what next"),
    ];

    const repaired = repairToolTurnSequence(messages);
    expect(repaired).toEqual(messages);
    expect(findToolTurnValidationIssue(repaired)?.code).toBe(
      "tool_result_missing",
    );
  });

  test("names a recovered orphaned tool unknown when the result omits toolName", () => {
    const messages: readonly LLMMessage[] = [
      { role: "tool", toolCallId: "call-x", content: "payload" },
    ];

    const repaired = repairToolTurnSequence(messages);
    expect(repaired[0]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-x", name: "unknown", arguments: "{}" }],
    });
    expect(repaired[1]).toEqual(messages[0]);
    expect(findToolTurnValidationIssue(repaired)).toBeNull();
  });

  test("inserts missing tool results when aggressive recovery is requested", () => {
    const messages: readonly LLMMessage[] = [
      assistantWithCalls([toolCall("call-1")]),
      user("what next"),
    ];

    const repaired = repairToolTurnSequence(messages, {
      repairMissingResults: true,
    });
    expect(repaired).toEqual([
      assistantWithCalls([toolCall("call-1")]),
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "FileRead",
        content: "[missing tool result inserted during transcript recovery]",
      },
      user("what next"),
    ]);
    expect(findToolTurnValidationIssue(repaired)).toBeNull();
  });

  test("drops duplicate and empty tool-call ids during aggressive recovery", () => {
    const messages: readonly LLMMessage[] = [
      assistantWithCalls([
        toolCall("call-1"),
        toolCall("call-1"),
        { id: "  ", name: "FileWrite", arguments: "{}" },
      ]),
    ];

    const repaired = repairToolTurnSequence(messages, {
      repairMissingResults: true,
    });
    expect(repaired).toEqual([
      assistantWithCalls([toolCall("call-1")]),
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "FileRead",
        content: "[missing tool result inserted during transcript recovery]",
      },
    ]);
    expect(findToolTurnValidationIssue(repaired)).toBeNull();
  });

  test("keeps assistant text when aggressive recovery strips every tool call", () => {
    const messages: readonly LLMMessage[] = [
      {
        role: "assistant",
        content: "hello",
        toolCalls: [{ id: "  ", name: "FileRead", arguments: "{}" }],
      },
    ];

    const repaired = repairToolTurnSequence(messages, {
      repairMissingResults: true,
    });
    expect(repaired).toEqual([
      {
        role: "assistant",
        content: "hello",
        toolCalls: undefined,
      },
    ]);
    expect(findToolTurnValidationIssue(repaired)).toBeNull();
  });
});
