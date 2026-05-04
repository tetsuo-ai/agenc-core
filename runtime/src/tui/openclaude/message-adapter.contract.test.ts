import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../bridges/message-adapter.js";

// Contract: begin/end branches in message-adapter must drop events whose
// payload.callId is not a string, mirroring the pre-existing tool_progress
// precedent. Without this guard, randomUUID() fallbacks gave the begin and
// end of a pair different ids and orphaned the tool-use card in the UI.

describe("tool-call correlation contract", () => {
  test("tool-call-begin-callid-required: begin+end without callId emits zero tool messages", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "begin",
        msg: { type: "tool_call_started", payload: { toolName: "Bash" } },
      },
      {
        id: "end",
        msg: { type: "tool_call_completed", payload: { toolName: "Bash", exitCode: 0 } },
      },
    ]);

    expect(transcript.messages).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect([...transcript.toolNames]).toEqual([]);
  });

  test("tool-call-begin-callid-required: begin+end with callId still correlates on the same id", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "begin",
        msg: {
          type: "tool_call_started",
          payload: { callId: "call-42", toolName: "Bash" },
        },
      },
      {
        id: "end",
        msg: {
          type: "tool_call_completed",
          payload: { callId: "call-42", toolName: "Bash", exitCode: 0, stdout: "ok" },
        },
      },
    ]);

    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.messages.map((m) => m.type)).toEqual(["assistant", "user"]);
    const toolUse = transcript.messages[0]?.message.content as Array<{ id?: string }>;
    const toolResult = transcript.messages[1]?.message.content as Array<{ tool_use_id?: string }>;
    expect(toolUse?.[0]?.id).toBe("call-42");
    expect(toolResult?.[0]?.tool_use_id).toBe("call-42");
  });

  test("tool-call-end-callid-required: exec_command end without callId is dropped", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "end-only",
        msg: { type: "exec_command_end", payload: { exitCode: 0, stdout: "x" } },
      },
    ]);

    expect(transcript.messages).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("tool-call-end-callid-required: mcp_tool_call_end without callId is dropped", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "end-only",
        msg: { type: "mcp_tool_call_end", payload: { isError: false } },
      },
    ]);

    expect(transcript.messages).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("collab-spawn-begin-callid-required: spawn_begin without callId emits no Task tool-use", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "spawn",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: { prompt: "review", agentRole: "reviewer", model: "gpt" },
        },
      },
    ]);

    expect(transcript.messages).toEqual([]);
    expect([...transcript.toolNames]).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("collab-spawn-begin-callid-required: spawn_begin with callId still emits Task tool-use", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "spawn",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: { callId: "agent-7", prompt: "review", agentRole: "reviewer", model: "gpt" },
        },
      },
    ]);

    expect([...transcript.toolNames]).toEqual(["Task"]);
    expect(transcript.inProgressToolUseIDs.has("agent-7")).toBe(true);
  });

  test("collab-end-callid-required: spawn_begin+spawn_end without callId emits zero messages", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "spawn-begin",
        msg: { type: "collab_agent_spawn_begin", payload: { prompt: "review" } },
      },
      {
        id: "spawn-end",
        msg: { type: "collab_agent_spawn_end", payload: { status: { status: "completed" } } },
      },
    ]);

    expect(transcript.messages).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("collab-end-callid-required: collab_agent_interaction_end without callId is dropped", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "end",
        msg: {
          type: "collab_agent_interaction_end",
          payload: { status: { status: "completed" } },
        },
      },
    ]);

    expect(transcript.messages).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("collab-end-callid-required: spawn_begin+spawn_end with callId correlates on the same id", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "spawn-begin",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: { callId: "agent-9", prompt: "review" },
        },
      },
      {
        id: "spawn-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: { callId: "agent-9", status: { status: "completed" } },
        },
      },
    ]);

    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.messages.map((m) => m.type)).toEqual(["assistant", "user"]);
    const toolUse = transcript.messages[0]?.message.content as Array<{ id?: string }>;
    const toolResult = transcript.messages[1]?.message.content as Array<{ tool_use_id?: string }>;
    expect(toolUse?.[0]?.id).toBe("agent-9");
    expect(toolResult?.[0]?.tool_use_id).toBe("agent-9");
  });
});
