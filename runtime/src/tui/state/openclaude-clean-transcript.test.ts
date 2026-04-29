import { describe, expect, test } from "vitest";

import { normalizeTranscriptMessages } from "../transcript/normalize.js";
import {
  eventsToMessages,
  type TranscriptSourceEvent,
} from "./events-to-messages.js";

describe("OpenClaude clean transcript parity gates", () => {
  test("hides assistant tool narration once a turn resolves to a final response", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-clean" } },
      { type: "user_message", payload: { message: "fix the failing test" } },
      {
        type: "agent_message_delta",
        payload: { delta: "Let me inspect the failing files first." },
      },
      {
        type: "tool_call_started",
        payload: {
          callId: "read-1",
          toolName: "Read",
          args: JSON.stringify({ file_path: "runtime/src/failing.test.ts" }),
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "read-1",
          result: "expect(actual).toBe(expected)",
          isError: false,
        },
      },
      {
        type: "agent_message_delta",
        payload: { delta: "Still failing. I will run the focused test." },
      },
      {
        type: "exec_command_begin",
        payload: {
          callId: "exec-1",
          processId: 10,
          command: "npm test -- failing.test.ts",
          cwd: "/repo",
        },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "exec-1",
          processId: 10,
          exitCode: 0,
          stdout: "PASS failing.test.ts\n",
          durationMs: 10,
        },
      },
      {
        type: "agent_message",
        payload: { message: "Fixed the issue and the focused test passes." },
      },
      { type: "turn_complete", payload: { turnId: "turn-clean" } },
    ];

    const messages = normalizeTranscriptMessages(eventsToMessages(events));
    const assistantContent = messages
      .filter((message) => message.kind === "assistant")
      .map((message) => message.content);

    expect(assistantContent).toEqual([
      "Fixed the issue and the focused test passes.",
    ]);
    expect(JSON.stringify(messages)).not.toContain("Let me inspect");
    expect(JSON.stringify(messages)).not.toContain("Still failing");
  });

  test("preserves child result data when grouping read/search tool bursts", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-tools" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "read-1",
          toolName: "Read",
          args: JSON.stringify({ file_path: "src/a.ts" }),
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "read-1",
          result: "export const value = 1;\n",
          isError: false,
        },
      },
      {
        type: "tool_call_started",
        payload: {
          callId: "grep-1",
          toolName: "Grep",
          args: JSON.stringify({ pattern: "value", path: "src" }),
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "grep-1",
          result: "src/a.ts:1:export const value = 1;\n",
          isError: false,
        },
      },
      {
        type: "agent_message",
        payload: { message: "The value is defined in src/a.ts." },
      },
      { type: "turn_complete", payload: { turnId: "turn-tools" } },
    ];

    const messages = normalizeTranscriptMessages(eventsToMessages(events));
    const group = messages.find((message) => message.kind === "tool_group");

    expect(group).toBeDefined();
    expect(messages.filter((message) => message.kind === "tool_call")).toHaveLength(0);
    expect(JSON.stringify(group)).toContain("export const value = 1");
    expect(JSON.stringify(group)).toContain("src/a.ts:1");
  });
});
