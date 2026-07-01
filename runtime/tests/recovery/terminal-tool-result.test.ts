import { describe, expect, test } from "vitest";
import {
  appendTerminalToolResults,
  buildTerminalToolResult,
  findOrphanToolCalls,
  synthesizeTerminalResults,
  terminalToolCauseFromAbortReason,
  terminalToolCauseFromError,
} from "./terminal-tool-result.js";

describe("terminal-tool-result", () => {
  test("buildTerminalToolResult by cause", () => {
    const out = buildTerminalToolResult({
      toolCall: { id: "c1", name: "FileRead", arguments: "{}" },
      cause: "timeout",
      elapsedMs: 30000,
    });
    expect(out.isError).toBe(true);
    expect(out.cause).toBe("timeout");
    expect(out.content).toContain("timed out");
    expect(out.toolCallId).toBe("c1");
  });

  test("synthesizeTerminalResults maps a batch of orphans", () => {
    const orphans = [
      { id: "c1", name: "tool1", arguments: "{}" },
      { id: "c2", name: "tool2", arguments: "{}" },
    ];
    const results = synthesizeTerminalResults(orphans, "aborted");
    expect(results).toHaveLength(2);
    expect(results[0]!.cause).toBe("aborted");
    expect(results[1]!.cause).toBe("aborted");
  });

  test("provider_switched cause text", () => {
    const out = buildTerminalToolResult({
      toolCall: { id: "c1", name: "system.bash", arguments: "{}" },
      cause: "provider_switched",
    });
    expect(out.content).toContain("provider switched");
  });

  test("maps abort reasons and timeout errors to terminal causes", () => {
    expect(terminalToolCauseFromAbortReason("mode_changed")).toBe(
      "mode_changed",
    );
    expect(terminalToolCauseFromAbortReason("interrupted")).toBe(
      "user_interrupted",
    );
    expect(
      terminalToolCauseFromError(
        new Error("tool stub exceeded 50ms timeout"),
      ),
    ).toBe("timeout");
  });

  test("findOrphanToolCalls falls back to toolUseBlocks and dedupes resolved ids", () => {
    const orphans = findOrphanToolCalls({
      assistantMessages: [],
      toolUseBlocks: [
        { type: "tool_use", id: "tc-1", name: "system.bash", input: { command: "ls" } },
        { type: "tool_use", id: "tc-2", name: "FileRead", input: { path: "x" } },
      ],
      toolResults: [
        {
          uuid: "u1",
          role: "user",
          toolCallId: "tc-1",
          toolName: "system.bash",
          content: "done",
        },
      ],
      messages: [],
    });

    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.id).toBe("tc-2");
  });

  test("appendTerminalToolResults appends tool messages and user records once", () => {
    const state = {
      assistantMessages: [
        {
          uuid: "a1",
          role: "assistant" as const,
          text: "partial",
          toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
        },
      ],
      toolUseBlocks: [],
      toolResults: [],
      messages: [],
    };

    const first = appendTerminalToolResults(state, "aborted", "cleanup");
    const second = appendTerminalToolResults(state, "aborted", "cleanup");

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(state.toolResults).toHaveLength(1);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "tc-1" }],
    });
    expect(state.messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "tc-1",
    });
  });

  test("appendTerminalToolResults pairs toolUseBlocks with assistant tool calls", () => {
    const state = {
      assistantMessages: [],
      toolUseBlocks: [
        {
          type: "tool_use" as const,
          id: "tc-1",
          name: "system.bash",
          input: { command: "ls" },
        },
      ],
      toolResults: [],
      messages: [],
    };

    appendTerminalToolResults(state, "aborted", "cleanup");

    const assistantIndex = state.messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === "tc-1") === true,
    );
    const toolIndex = state.messages.findIndex(
      (message) => message.role === "tool" && message.toolCallId === "tc-1",
    );

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(assistantIndex);
  });
});
