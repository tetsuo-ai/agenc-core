import { describe, expect, test } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const result = JSON.stringify({
  code: "tool_arguments_truncated", retryable: true, executed: false,
  error: "Output limit interrupted tool arguments. Retry a complete tool call.",
});

describe("output-limited tool handoffs", () => {
  test.each(["Write", "spawn_agent"])("shows a truthful retry notice for buffered %s arguments", toolName => {
    const event = { type: "tool_call_completed", payload: { callId: "cut", toolName, result, isError: true } };
    const transcript = adaptTranscriptEvents([event, event]);
    const notices = transcript.messages.filter(message => message.type === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toBe("Output limit interrupted tool arguments. Retry a complete tool call.");
    expect(JSON.stringify(transcript.messages)).not.toContain("out of order");
  });

  test("keeps a truncated collaboration handoff visible after its input cell was suppressed", () => {
    const transcript = adaptTranscriptEvents([
      { type: "tool_input_block_start", payload: { callId: "cut", index: 0,
        contentBlock: { type: "tool_use", id: "cut", name: "spawn_agent", input: {} } } },
      { type: "tool_input_delta", payload: { callId: "cut", index: 0, partialJson: '{"message":"unfinished' } },
      { type: "tool_call_completed", payload: { callId: "cut", toolName: "spawn_agent", result, isError: true } },
    ]);
    expect(JSON.stringify(transcript.messages)).toContain("Output limit interrupted tool arguments");
    expect(transcript.streamingToolUses).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test.each([
    ["tool_call_started", "tool_call_completed", false],
    ["mcp_tool_call_begin", "mcp_tool_call_end", false],
    ["tool_call_started", "tool_call_completed", true],
    ["mcp_tool_call_begin", "mcp_tool_call_end", true],
  ])("preserves started %s / %s result data when isError=%s", (startType, endType, isError) => {
    const returnedData = JSON.stringify({
      code: "tool_arguments_truncated", executed: false,
      error: "This is the tool's returned data", data: "keep this result",
    });
    const transcript = adaptTranscriptEvents([
      { type: startType, payload: { callId: "ordinary", toolName: "mcp.example", arguments: {} } },
      { type: endType, payload: { callId: "ordinary", toolName: "mcp.example", result: returnedData, isError } },
    ]);
    expect(transcript.messages.some(message => message.type === "system" &&
      message.content === "This is the tool's returned data")).toBe(false);
    expect(JSON.stringify(transcript.messages)).toContain("keep this result");
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("preserves unmatched successful data resembling a truncation failure", () => {
    const returnedData = { code: "tool_arguments_truncated", executed: false,
      error: "Returned data", data: "keep unmatched result" };
    const transcript = adaptTranscriptEvents([
      { type: "tool_call_completed", payload: { callId: "ordinary", result: JSON.stringify(returnedData), isError: false } },
    ]);
    expect(transcript.messages.some(message => message.type === "system" &&
      message.content === "Returned data")).toBe(false);
    expect(JSON.stringify(transcript.messages)).toContain("keep unmatched result");
  });

  test("keeps completed collaboration calls on their normal lifecycle path", () => {
    const transcript = adaptTranscriptEvents([
      { type: "tool_call_started", payload: { callId: "started", toolName: "spawn_agent", arguments: {} } },
      { type: "tool_call_completed", payload: { callId: "started", toolName: "spawn_agent", result, isError: true } },
    ]);
    expect(transcript.messages).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

});
