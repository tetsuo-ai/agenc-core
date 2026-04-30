import { describe, expect, test } from "vitest";

import {
  eventsToMessages,
  type TranscriptSourceEvent,
} from "../state/events-to-messages.js";
import { normalizeTranscriptMessages } from "./normalize.js";

describe("OpenClaude transcript tool grouping parity", () => {
  test("hides assistant tool narration after the final answer arrives", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-clean" } },
      {
        type: "agent_message",
        payload: {
          turnId: "turn-clean",
          message: "Let me inspect the file first.",
        },
      },
      {
        type: "tool_call_started",
        payload: {
          turnId: "turn-clean",
          callId: "call-read",
          toolName: "Read",
          args: JSON.stringify({ file_path: "src/a.ts" }),
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          turnId: "turn-clean",
          callId: "call-read",
          result: "export const value = 1;",
          isError: false,
        },
      },
      {
        type: "agent_message",
        payload: {
          turnId: "turn-clean",
          message: "The file exports value.",
        },
      },
      { type: "turn_complete", payload: { turnId: "turn-clean" } },
    ];

    const messages = normalizeTranscriptMessages(eventsToMessages(events));

    expect(messages.filter((message) => message.kind === "assistant")).toEqual([
      expect.objectContaining({ content: "The file exports value." }),
    ]);
  });

  test("read and search bursts preserve child result data in one group", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-tools" } },
      {
        type: "tool_call_started",
        payload: {
          turnId: "turn-tools",
          callId: "read-1",
          toolName: "Read",
          args: JSON.stringify({ file_path: "src/a.ts" }),
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          turnId: "turn-tools",
          callId: "read-1",
          result: "export const value = 1;",
          isError: false,
        },
      },
      {
        type: "tool_call_started",
        payload: {
          turnId: "turn-tools",
          callId: "grep-1",
          toolName: "Grep",
          args: JSON.stringify({ pattern: "value", path: "src" }),
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          turnId: "turn-tools",
          callId: "grep-1",
          result: "src/a.ts:1:export const value = 1;",
          isError: false,
        },
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
