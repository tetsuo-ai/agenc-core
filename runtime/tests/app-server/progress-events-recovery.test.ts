import { describe, expect, it } from "vitest";

import {
  canonicalSessionEventFromRecoveredProgress,
  interruptedToolResultContent,
} from "../../src/app-server/background-agent-runner/progress-events.js";

describe("canonicalSessionEventFromRecoveredProgress", () => {
  it("projects a recovered tool start with a default empty-args payload", () => {
    expect(
      canonicalSessionEventFromRecoveredProgress({
        kind: "tool_call",
        callId: "call-1",
        toolName: "exec_command",
      }),
    ).toEqual({
      id: "recovery-tool-start:call-1",
      msg: {
        type: "tool_call_started",
        payload: {
          callId: "call-1",
          toolName: "exec_command",
          args: "{}",
        },
      },
    });
  });

  it("preserves supplied arguments and marks a recovered tool result", () => {
    expect(
      canonicalSessionEventFromRecoveredProgress({
        kind: "tool_call",
        callId: "call-2",
        toolName: "FileRead",
        arguments: '{"path":"README.md"}',
      }),
    ).toMatchObject({
      msg: { payload: { args: '{"path":"README.md"}' } },
    });

    expect(
      canonicalSessionEventFromRecoveredProgress({
        kind: "tool_result",
        callId: "call-2",
        toolName: "FileRead",
        result: "ok",
        isError: false,
      }),
    ).toEqual({
      id: "recovery-tool-result:call-2",
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: "call-2",
          result: "ok",
          isError: false,
          metadata: { toolName: "FileRead", recovered: true },
        },
      },
    });
  });

  it("treats a missing isError as a successful recovered result", () => {
    expect(
      canonicalSessionEventFromRecoveredProgress({
        kind: "tool_result",
        callId: "call-3",
        toolName: "exec_command",
        result: "done",
      } as never),
    ).toMatchObject({
      msg: { payload: { isError: false, metadata: { recovered: true } } },
    });
  });

  it("does not invent session events for non-tool progress", () => {
    expect(
      canonicalSessionEventFromRecoveredProgress({
        kind: "turn_complete",
        turnId: "turn-1",
        toolCallCount: 0,
      }),
    ).toBeNull();
    expect(
      canonicalSessionEventFromRecoveredProgress({
        kind: "status",
        text: "working",
      }),
    ).toBeNull();
  });
});

describe("interruptedToolResultContent", () => {
  it("encodes a user-interrupt error the tool-result consumer already understands", () => {
    expect(JSON.parse(interruptedToolResultContent("call-9", "cancelled"))).toEqual({
      tool_use_id: "call-9",
      is_error: true,
      content: "<tool_use_error>user interrupted - cancelled</tool_use_error>",
    });
  });
});
