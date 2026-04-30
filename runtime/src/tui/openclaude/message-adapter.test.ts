import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "./message-adapter.js";

describe("OpenClaude TUI transcript bridge", () => {
  test("maps AgenC user and streaming assistant events into upstream messages", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "turn",
        msg: { type: "turn_started", payload: { turnId: "t1" } },
      },
      {
        id: "user",
        msg: { type: "user_message", payload: { message: "hello" } },
      },
      {
        id: "delta",
        msg: { type: "agent_message_delta", payload: { delta: "hi" } },
      },
    ]);

    expect(transcript.isStreaming).toBe(true);
    expect(transcript.currentTurnId).toBe("t1");
    expect(transcript.streamingText).toBe("hi");
    expect(transcript.messages.at(-1)).toMatchObject({
      type: "user",
      message: { content: "hello" },
    });
  });

  test("finalizes streamed text at turn completion", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "turn",
        msg: { type: "turn_started", payload: { turnId: "t1" } },
      },
      {
        id: "delta",
        msg: { type: "agent_message_delta", payload: { delta: "done" } },
      },
      {
        id: "complete",
        msg: {
          type: "turn_complete",
          payload: { turnId: "t1", lastAgentMessage: "done" },
        },
      },
    ]);

    expect(transcript.isStreaming).toBe(false);
    expect(transcript.streamingText).toBeNull();
    expect(transcript.messages.at(-1)?.message.content).toEqual([
      { type: "text", text: "done" },
    ]);
  });

  test("maps tools and codex-style agent events to upstream tool rows", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "tool-start",
        msg: {
          type: "exec_command_begin",
          payload: { callId: "exec-1", command: "npm test" },
        },
      },
      {
        id: "tool-end",
        msg: {
          type: "exec_command_end",
          payload: { callId: "exec-1", exitCode: 0, stdout: "ok" },
        },
      },
      {
        id: "agent-start",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: {
            callId: "agent-1",
            prompt: "review",
            model: "gpt",
            senderThreadId: "main",
          },
        },
      },
      {
        id: "agent-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: {
            callId: "agent-1",
            senderThreadId: "main",
            status: { status: "completed" },
          },
        },
      },
    ]);

    expect([...transcript.toolNames]).toEqual(["Bash", "Task"]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.messages.map((message) => message.type)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });
});
