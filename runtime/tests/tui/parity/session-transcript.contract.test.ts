import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../session-transcript.js";

// Contract: begin/end branches in session-transcript must drop events whose
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

  test("collab-spawn-begin-callid-required: spawn_begin without callId emits no collab row", () => {
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

  test("collab-spawn-begin-callid-required: spawn_begin with callId emits a running collab row", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "spawn",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: { callId: "agent-7", prompt: "review", agentRole: "reviewer", model: "gpt" },
        },
      },
    ]);

    expect([...transcript.toolNames]).toEqual([]);
    expect(transcript.inProgressToolUseIDs.has("agent-7")).toBe(true);
    expect(transcript.messages).toMatchObject([
      { type: "system", subtype: "collab_agent", title: "Spawning agent", state: "running" },
    ]);
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

  test("collab-wait-begin/end renders visible waiting rows and clears spinner state", () => {
    const waiting = adaptTranscriptEvents([
      {
        id: "wait-begin",
        msg: {
          type: "collab_waiting_begin",
          payload: {
            callId: "wait-1",
            senderThreadId: "main",
            receiverThreadIds: ["thread-a", "thread-b"],
            receiverAgents: [
              { threadId: "thread-a", agentNickname: "audit" },
              { threadId: "thread-b", agentNickname: "ui" },
            ],
          },
        },
      },
    ]);

    expect(waiting.inProgressToolUseIDs.has("wait-1")).toBe(true);
    expect(waiting.messages).toMatchObject([
      { type: "system", subtype: "collab_agent", title: "Waiting for 2 agents", state: "running" },
    ]);

    const completed = adaptTranscriptEvents([
      {
        id: "wait-begin",
        msg: {
          type: "collab_waiting_begin",
          payload: {
            callId: "wait-1",
            senderThreadId: "main",
            receiverThreadIds: ["thread-a", "thread-b"],
            receiverAgents: [
              { threadId: "thread-a", agentNickname: "audit" },
              { threadId: "thread-b", agentNickname: "ui" },
            ],
          },
        },
      },
      {
        id: "wait-end",
        msg: {
          type: "collab_waiting_end",
          payload: {
            callId: "wait-1",
            senderThreadId: "main",
            statuses: {},
            agentStatuses: [
              { threadId: "thread-a", agentNickname: "audit", status: { status: "completed", lastMessage: "done" } },
              { threadId: "thread-b", agentNickname: "ui", status: { status: "running" } },
            ],
          },
        },
      },
    ]);

    expect(completed.inProgressToolUseIDs.size).toBe(0);
    expect(completed.messages).toMatchObject([
      { type: "system", subtype: "collab_agent", title: "Waiting for 2 agents", state: "running" },
      { type: "system", subtype: "collab_agent", title: "Finished waiting", state: "success" },
    ]);
    expect(completed.messages[1]?.details).toEqual([
      "audit: Completed - done",
      "ui: Running",
    ]);
  });

  test("collab-end-callid-required: spawn_begin+spawn_end with callId collapses to the settled status row", () => {
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
          payload: {
            callId: "agent-9",
            newThreadId: "thread-9",
            newAgentNickname: "reviewer",
            status: { status: "completed" },
          },
        },
      },
    ]);

    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.messages).toMatchObject([
      { type: "system", subtype: "collab_agent", title: "Spawned reviewer", state: "success" },
    ]);
  });

  test("collab-v2 raw spawn_agent tool events do not duplicate the structured agent row", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "raw-spawn-input-start",
        msg: {
          type: "tool_input_block_start",
          payload: {
            callId: "agent-10",
            index: 1,
            contentBlock: {
              type: "tool_use",
              id: "agent-10",
              name: "spawn_agent",
              input: {},
            },
          },
        },
      },
      {
        id: "raw-spawn-input-delta",
        msg: {
          type: "tool_input_delta",
          payload: {
            callId: "agent-10",
            index: 1,
            partialJson:
              '{"task_name":"reviewer","message":"review the diff"}',
          },
        },
      },
      {
        id: "raw-spawn-begin",
        msg: {
          type: "tool_call_started",
          payload: {
            callId: "agent-10",
            toolName: "spawn_agent",
            input: {
              task_name: "reviewer",
              message: "review the diff",
            },
          },
        },
      },
      {
        id: "spawn-begin",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: {
            callId: "agent-10",
            prompt: "review the diff",
            agentRole: "reviewer",
          },
        },
      },
      {
        id: "raw-spawn-end",
        msg: {
          type: "tool_call_completed",
          payload: {
            callId: "agent-10",
            toolName: "spawn_agent",
            result: { agentId: "thread-10" },
          },
        },
      },
      {
        id: "spawn-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: {
            callId: "agent-10",
            newThreadId: "thread-10",
            newAgentNickname: "reviewer",
            status: { status: "completed" },
          },
        },
      },
    ]);

    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    // The suppressed raw call must not produce a duplicate ROW — but its
    // NAME must still register so the renderer can resolve replayed
    // spawn_agent tool_use blocks (the resumed-swarm "Tool use
    // unavailable" cards). Name registration is display-metadata, not a
    // row.
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
    // Provider input streaming is another generic rendering path. It must
    // not leak a second `spawn_agent ({})` row beside the structured card.
    expect(transcript.streamingToolUses).toEqual([]);
    expect(transcript.messages).toMatchObject([
      { type: "system", subtype: "collab_agent", title: "Spawned reviewer", state: "success" },
    ]);
    expect(transcript.messages).toHaveLength(1);
  });

  test("collab-spawn-failure: spawn_end error is visible and clears running state", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "spawn-begin",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: { callId: "agent-fail", prompt: "review" },
        },
      },
      {
        id: "spawn-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: {
            callId: "agent-fail",
            prompt: "review",
            status: {
              status: "errored",
              turnId: "agent-fail",
              error: "task_name is required",
            },
          },
        },
      },
    ]);

    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.messages).toMatchObject([
      {
        type: "system",
        subtype: "collab_agent",
        title: "Agent spawn failed",
        state: "error",
      },
    ]);
    expect(transcript.messages[0]?.details).toContain(
      "status: Error - task_name is required",
    );
  });
});
