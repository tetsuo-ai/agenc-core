import { describe, expect, test } from "vitest";
import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

const result = JSON.stringify({
  code: "tool_arguments_truncated", retryable: true, executed: false,
  error: "Output limit interrupted tool arguments. Retry a complete tool call.",
});

// Row text only: the test events have no id, so each row's uuid embeds the raw event.
const shown = (transcript: { messages: readonly any[] }): string =>
  JSON.stringify(transcript.messages.map(message => message.content ?? message.message?.content));

describe("output-limited tool handoffs", () => {
  test.each(["Write", "spawn_agent"])("shows a truthful retry notice for buffered %s arguments", toolName => {
    const event = { type: "tool_call_completed", payload: { callId: "cut", toolName, result, isError: true } };
    const transcript = adaptTranscriptEvents([event, event]);
    const notices = transcript.messages.filter(message => message.type === "system");
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toBe("The model's tool call was cut off by the output limit and did not run. The model will retry.");
    expect(shown(transcript)).not.toContain("Retry a complete tool call");
    expect(JSON.stringify(transcript.messages)).not.toContain("out of order");
  });

  test("keeps a truncated collaboration handoff visible after its input cell was suppressed", () => {
    const transcript = adaptTranscriptEvents([
      { type: "tool_input_block_start", payload: { callId: "cut", index: 0,
        contentBlock: { type: "tool_use", id: "cut", name: "spawn_agent", input: {} } } },
      { type: "tool_input_delta", payload: { callId: "cut", index: 0, partialJson: '{"message":"unfinished' } },
      { type: "tool_call_completed", payload: { callId: "cut", toolName: "spawn_agent", result, isError: true } },
    ]);
    expect(JSON.stringify(transcript.messages)).toContain("cut off by the output limit");
    expect(shown(transcript)).not.toContain("Retry a complete tool call");
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

  test("names an unmatched malformed tool call without the model's retry instructions", () => {
    const malformed = JSON.stringify({ code: "malformed_tool_call", cause: "invalid_json", retryable: true, executed: false,
      error: "Invalid or incomplete tool arguments. Retry a complete JSON call using the advertised schema; use spawn_agent.message_ref for large context." });
    const transcript = adaptTranscriptEvents([
      { type: "tool_call_completed", payload: { callId: "bad", result: malformed, isError: true } },
    ]);
    const text = shown(transcript);
    expect(text).toContain("The model sent an incomplete tool call and it did not run. The model will retry.");
    expect(text).not.toContain("advertised schema");
    expect(text).not.toContain("out of order");
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
