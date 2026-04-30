import { describe, expect, test } from "vitest";

import {
  adaptTranscriptEvents,
  formatStructuredToolResult,
} from "./message-adapter.js";

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

  test("maps tool calls and AgenC agent events to upstream tool rows", () => {
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

  test("accumulates tool_progress chunks per call_id and clears on tool_call_completed", () => {
    const mid = adaptTranscriptEvents([
      {
        id: "turn",
        msg: { type: "turn_started", payload: { turnId: "t1" } },
      },
      {
        id: "begin",
        msg: {
          type: "exec_command_begin",
          payload: { callId: "c1", toolName: "Bash" },
        },
      },
      {
        id: "p1",
        msg: {
          type: "tool_progress",
          payload: {
            callId: "c1",
            toolName: "Bash",
            chunk: "first chunk",
            stream: "stdout",
          },
        },
      },
      {
        id: "p2",
        msg: {
          type: "tool_progress",
          payload: {
            callId: "c1",
            toolName: "Bash",
            chunk: "second chunk",
            stream: "stdout",
          },
        },
      },
    ]);
    expect(mid.runningToolProgress.size).toBe(1);
    const progress = mid.runningToolProgress.get("c1");
    expect(progress?.toolName).toBe("Bash");
    expect(progress?.latestChunk).toBe("second chunk");
    expect(progress?.chunkCount).toBe(2);
    expect(progress?.stream).toBe("stdout");

    const after = adaptTranscriptEvents([
      ...[
        { id: "turn", msg: { type: "turn_started", payload: { turnId: "t1" } } },
        {
          id: "begin",
          msg: {
            type: "exec_command_begin",
            payload: { callId: "c1", toolName: "Bash" },
          },
        },
        {
          id: "p1",
          msg: {
            type: "tool_progress",
            payload: { callId: "c1", chunk: "x" },
          },
        },
        {
          id: "end",
          msg: {
            type: "exec_command_end",
            payload: { callId: "c1", stdout: "done", exitCode: 0 },
          },
        },
      ],
    ]);
    expect(after.runningToolProgress.size).toBe(0);
    expect(after.inProgressToolUseIDs.size).toBe(0);
  });

  test("formatStructuredToolResult preserves Bash stdout/stderr/exit_code as separate text blocks", () => {
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout: "hello world",
      stderr: "warn",
      exitCode: 0,
      durationMs: 42,
    });
    expect(blocks.length).toBe(3);
    expect(blocks[0]?.text).toBe("[stdout]\nhello world");
    expect(blocks[1]?.text).toBe("[stderr]\nwarn");
    expect(blocks[2]?.text).toBe("[exit_code=0 duration_ms=42]");
  });

  test("formatStructuredToolResult emits only the metadata block when stdout/stderr are both empty (avoids confusing [no output] when an exit code is present)", () => {
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(blocks.map((b) => b.text)).toEqual(["[exit_code=0]"]);
  });

  test("formatStructuredToolResult emits a [no output] block when nothing — no stdio, no exit code, no duration — is present", () => {
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {});
    expect(blocks.map((b) => b.text)).toEqual(["[no output]"]);
  });

  test("formatStructuredToolResult preserves the live FILE_EDIT_TOOL_NAME (\"Edit\") diff payload as path + diff blocks", () => {
    const blocks = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: {
        path: "src/foo.ts",
        diff: "--- a\n+++ b\n@@ ... @@\n-old\n+new",
      },
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toBe("[file]\nsrc/foo.ts");
    expect(blocks[1]?.text).toContain("[diff]\n--- a");
  });

  test("formatStructuredToolResult falls back to a single text block for unknown tools", () => {
    const blocks = formatStructuredToolResult("WeirdTool", "tool_call_completed", {
      result: { foo: 1, bar: "baz" },
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.text).toContain("foo");
    expect(blocks[0]?.text).toContain("baz");
  });
});
