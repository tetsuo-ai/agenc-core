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

  test("keeps live assistant deltas incomplete until a completion event", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-stream" } },
      { type: "agent_message_delta", payload: { delta: "working" } },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "assistant",
      turnId: "turn-stream",
      content: "working",
      isComplete: false,
    });
  });

  test("hides provider lifecycle assistant chatter in the normal transcript", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-tools" } },
      { type: "agent_message", payload: { message: "Calling tool." } },
      {
        type: "tool_call_started",
        payload: {
          callId: "call-1",
          toolName: "system.writeFile",
          args: '{"path":"note.txt"}',
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "call-1",
          result: '{"path":"note.txt","bytesWritten":2}',
          isError: false,
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "system.writeFile",
    });
  });

  test("hides split provider lifecycle chatter deltas before tool calls", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-tools" } },
      { type: "agent_message_delta", payload: { delta: "Calling " } },
      { type: "agent_message_delta", payload: { delta: "tool." } },
      {
        type: "tool_call_started",
        payload: {
          callId: "call-1",
          toolName: "system.readFile",
          args: '{"path":"README.md"}',
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "system.readFile",
    });
    expect(messages.some((message) => message.content.includes("Calling"))).toBe(
      false,
    );
  });

  test("flushes split lifecycle-like deltas when they become real assistant text", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-text" } },
      { type: "agent_message_delta", payload: { delta: "Calling " } },
      { type: "agent_message_delta", payload: { delta: "out the issue." } },
      { type: "turn_complete", payload: { turnId: "turn-text" } },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "assistant",
      content: "Calling out the issue.",
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
      toolName: "exec_command",
      execCommand: "ls",
      execStdout: "README.md\n",
      execExitCode: 0,
      execDurationMs: 42,
      isComplete: true,
    });
  });

  test("appends write_stdin progress to the original exec process row", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-pty" } },
      {
        type: "exec_command_begin",
        payload: {
          callId: "exec-1",
          command: "bash -i",
          cwd: "/tmp",
          processId: 7,
          tty: true,
        },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "exec-1",
          exitCode: null,
          stdout: "$ ",
          processId: 7,
          tty: true,
        },
      },
      {
        type: "tool_call_started",
        payload: {
          callId: "stdin-1",
          toolName: "write_stdin",
          args: '{"session_id":7,"chars":"echo ok\\n"}',
        },
      },
      {
        type: "tool_progress",
        payload: {
          callId: "stdin-1",
          toolName: "write_stdin",
          chunk: "ok\n",
          stream: "stdout",
          processId: 7,
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "stdin-1",
          result: '{"stdout":"ok\\n","session_id":7}',
          isError: false,
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "exec_command",
      execCommand: "bash -i",
      execStdout: expect.stringContaining("ok"),
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
    expect(messages[0]?.content).toContain("Context compacted");
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

  test("filters internal lifecycle warnings out of the visible transcript", () => {
    const events: TranscriptSourceEvent[] = [
      {
        type: "session_configured",
        payload: {
          sessionId: "sess-2",
          model: "gpt",
          modelProviderId: "openai",
          cwd: "/tmp",
          historyLogId: 2,
          historyEntryCount: 4,
          initialMessages: [],
        },
      },
      {
        type: "warning",
        payload: {
          cause: "system_resumed_from",
          message: "12345",
        },
      },
      {
        type: "warning",
        payload: {
          cause: "snapshot_behind_rollout",
          message: "snapshot replay ignored stale index",
        },
      },
      {
        type: "warning",
        payload: {
          cause: "tool_routing_classified",
          message: "system.readFile -> readonly",
        },
      },
      {
        type: "warning",
        payload: {
          cause: "provider_switched",
          message:
            "provider grok -> grok; model grok-4-fast -> grok-4.20-0309-non-reasoning; previous_response_id reset",
        },
      },
      {
        type: "warning",
        payload: {
          cause: "memory_extract_failed",
          message:
            "memory_extract_timeout: extraction did not finish within 30000ms",
        },
      },
      {
        type: "warning",
        payload: {
          cause: "mcp_auth_required",
          message: "MCP server needs authentication",
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "warning",
      content: "MCP server needs authentication",
    });
    expect(messages.map((message) => message.content).join("\n")).not.toContain(
      "memory_extract_timeout",
    );
  });

  test("can include internal lifecycle warnings for transcript show-all mode", () => {
    const events: TranscriptSourceEvent[] = [
      {
        type: "warning",
        payload: {
          cause: "memory_extract_timeout",
          message:
            "memory_extract_timeout: extraction did not finish within 30000ms",
        },
      },
    ];

    const messages = eventsToMessages(events, { includeHidden: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "warning",
      content:
        "memory_extract_timeout: extraction did not finish within 30000ms",
    });
  });

  test("collapses non-exec tool start/progress/result into one semantic row", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-tool" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "read-1",
          toolName: "system.readFile",
          args: '{"path":"README.md"}',
        },
      },
      {
        type: "tool_progress",
        payload: {
          callId: "read-1",
          toolName: "system.readFile",
          chunk: "reading README.md",
          stream: "status",
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "read-1",
          result: "1→# AgenC\n2→runtime",
          isError: false,
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "system.readFile",
      toolArgs: { path: "README.md" },
      toolProgressContent: "reading README.md",
      toolResultContent: "1→# AgenC\n2→runtime",
      isComplete: true,
      isError: false,
    });
  });

  test("preserves tool name and args when progress arrives before completion", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-tool" } },
      {
        type: "tool_progress",
        payload: {
          callId: "late-1",
          toolName: "system.writeFile",
          chunk: "writing CMakeLists.txt",
          stream: "status",
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "late-1",
          result: '{"path":"CMakeLists.txt","bytesWritten":42}',
          isError: false,
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      kind: "tool_result",
      toolName: "system.writeFile",
      toolResultContent: '{"path":"CMakeLists.txt","bytesWritten":42}',
      isError: false,
    });
  });

  test("absorbs system.searchTools lifecycle rows silently", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-search-tools" } },
      { type: "user_message", payload: { message: "hi" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "search-tools-1",
          toolName: "system.searchTools",
          args: '{"query":"memory"}',
        },
      },
      {
        type: "tool_progress",
        payload: {
          callId: "search-tools-1",
          toolName: "system.searchTools",
          chunk: "searching memory tools",
          stream: "status",
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "search-tools-1",
          result:
            '{"totalCatalogSize":39,"loaded":[],"missingSelections":[],"results":[]}',
          isError: false,
        },
      },
      { type: "agent_message", payload: { message: "hi" } },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.content).join("\n")).not.toContain(
      "searchTools",
    );
    expect(messages.map((message) => message.content).join("\n")).not.toContain(
      "totalCatalogSize",
    );
    expect(messages[0]).toMatchObject({ kind: "user", content: "hi" });
    expect(messages[1]).toMatchObject({ kind: "assistant", content: "hi" });
  });

  test("can include system.searchTools rows for transcript show-all mode", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-search-tools" } },
      {
        type: "tool_call_started",
        payload: {
          callId: "search-tools-1",
          toolName: "system.searchTools",
          args: '{"query":"memory"}',
        },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "search-tools-1",
          result:
            '{"totalCatalogSize":39,"loaded":[],"missingSelections":[],"results":[]}',
          isError: false,
        },
      },
    ];

    const messages = eventsToMessages(events, { includeHidden: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "system.searchTools",
      toolArgs: { query: "memory" },
      toolResultContent:
        '{"totalCatalogSize":39,"loaded":[],"missingSelections":[],"results":[]}',
      isComplete: true,
    });
  });

  test("absorbs phase-event ToolSearch rows silently", () => {
    const events: TranscriptSourceEvent[] = [
      { type: "turn_start", turnIndex: 0 },
      {
        type: "tool_call",
        toolCall: {
          id: "search-tools-phase",
          name: "system.searchTools",
          arguments: '{"query":"memory"}',
        },
      },
      {
        type: "tool_result",
        toolCall: {
          id: "search-tools-phase",
          name: "system.searchTools",
          arguments: '{"query":"memory"}',
        },
        result: {
          content:
            '{"totalCatalogSize":39,"loaded":[],"missingSelections":[],"results":[]}',
          isError: false,
        },
      },
      { type: "assistant_text", content: "no noise" },
      { type: "turn_complete", turnIndex: 0 },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "assistant",
      content: "no noise",
    });
  });
});
