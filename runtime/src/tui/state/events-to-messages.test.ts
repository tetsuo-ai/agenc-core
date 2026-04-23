import { describe, expect, test } from "vitest";

import {
  eventsToMessages,
  type TranscriptSourceEvent,
} from "./events-to-messages.js";

describe("eventsToMessages", () => {
  test("builds user and streaming assistant rows from event-log truth", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-1" } },
      { type: "user_message", payload: { message: "explain the diff" } },
      { type: "agent_message_delta", payload: { delta: "Hel" } },
      { type: "agent_message_delta", payload: { delta: "lo" } },
      { type: "agent_message", payload: { message: "Hello" } },
      { type: "turn_complete", payload: { turnId: "turn-1" } },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      kind: "user",
      turnId: "turn-1",
      content: "explain the diff",
    });
    expect(messages[1]).toMatchObject({
      kind: "assistant",
      turnId: "turn-1",
      content: "Hello",
      isComplete: true,
    });
  });

  test("hydrates bash activity into a single exec cell row", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-bash" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "call-1",
          toolName: "system.bash",
          args: '{"command":"ls"}',
        },
      },
      {
        type: "tool_progress",
        payload: {
          callId: "call-1",
          toolName: "system.bash",
          chunk: "README.md\n",
          stream: "stdout",
        },
      },
      {
        type: "exec_command_begin",
        payload: {
          callId: "call-1",
          command: "ls",
          cwd: "/tmp",
        },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "call-1",
          exitCode: 0,
          stdout: "README.md\n",
          durationMs: 42,
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "call-1",
          result: "README.md",
          isError: false,
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "system.bash",
      execCommand: "ls",
      execStdout: "README.md\n",
      execExitCode: 0,
      execDurationMs: 42,
      isComplete: true,
    });
  });

  test("renders compact boundaries and slash breadcrumbs as dedicated rows", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-meta" } },
      {
        type: "context_compacted",
        payload: {
          summary: "preserved tail + summary",
          preCompactTokens: 1200,
          postCompactTokens: 420,
        },
      },
      {
        type: "slash_result",
        input: "/compact",
        result: { kind: "compact", text: "Compacted 3 turns" },
        turnId: "turn-meta",
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages[0]).toMatchObject({
      kind: "meta",
      label: "compact",
    });
    expect(messages[0]?.content).toContain("1200 -> 420");
    expect(messages[1]).toMatchObject({
      kind: "slash_result",
      slashInput: "/compact",
    });
  });

  test("collapses plan event-log variants into a dedicated plan_progress row", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-plan" } },
      {
        type: "plan_started",
        payload: {
          turnId: "turn-plan",
          planItemId: "plan-1",
          title: "trace runtime",
        },
      },
      {
        type: "plan_delta",
        payload: {
          turnId: "turn-plan",
          planItemId: "plan-1",
          delta: "inspect transport",
        },
      },
      {
        type: "plan_exited",
        payload: {
          turnId: "turn-plan",
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "plan_progress",
      turnId: "turn-plan",
    });
    expect(messages[0]?.planEvents).toHaveLength(3);
  });
});
