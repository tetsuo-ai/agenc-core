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

  test("coalesces deltas + tool_call + final agent_message into a single assistant row (regression: TUI-doubled-text)", () => {
    // Real failure mode from a `--yolo + /plan` session against
    // grok-4.20-0309-non-reasoning: the model emits deltas, then a
    // tool_call_started, then the terminal `agent_message`. Pre-fix,
    // `tool_call_started`'s `markAssistantComplete()` cleared
    // `activeAssistantIndex` and the terminal `agent_message` couldn't
    // find the streaming row, so it pushed a brand-new row with the
    // full final text — the user saw the assistant text rendered
    // twice in a row before the tool cell. Mirrors openclaude's
    // atomic streamingText→onMessage transition (utils/messages.ts:2980-2985)
    // which never lets the streaming preview and the final message
    // coexist for the same content.
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-coalesce" } },
      { type: "agent_message_delta", payload: { delta: "I'll write the plan file." } },
      {
        type: "tool_call_started",
        payload: {
          callId: "call-1",
          toolName: "Write",
          args: '{"path":"/home/u/.agenc/plans/foo.md","content":"hi"}',
        },
      },
      { type: "agent_message", payload: { message: "I'll write the plan file." } },
      {
        type: "tool_call_completed",
        payload: { callId: "call-1", result: '{"ok":true}', isError: false },
      },
    ];

    const messages = eventsToMessages(events);
    const assistantRows = messages.filter((m) => m.kind === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      kind: "assistant",
      turnId: "turn-coalesce",
      content: "I'll write the plan file.",
      isComplete: true,
    });
    // The tool cell still renders.
    expect(messages.filter((m) => m.kind === "tool_call")).toHaveLength(1);
  });

  test("final agent_message without preceding deltas still creates one row", () => {
    // Sanity: providers that don't emit `agent_message_delta` at all
    // (final-only) must still produce exactly one assistant row.
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-final-only" } },
      { type: "agent_message", payload: { message: "Done." } },
    ];
    const messages = eventsToMessages(events);
    const assistantRows = messages.filter((m) => m.kind === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      content: "Done.",
      isComplete: true,
    });
  });

  test("each turn's assistant message gets its own row (no cross-turn fold)", () => {
    // Two-turn conversation. The per-turn `lastAssistantIndexByTurn`
    // map must NOT collapse turn 2's final message into turn 1's row.
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "turn-1" } },
      { type: "agent_message_delta", payload: { delta: "first" } },
      { type: "agent_message", payload: { message: "first response" } },
      { type: "turn_complete", payload: { turnId: "turn-1" } },
      { type: "turn_started", payload: { turnId: "turn-2" } },
      { type: "agent_message_delta", payload: { delta: "second" } },
      { type: "agent_message", payload: { message: "second response" } },
    ];
    const messages = eventsToMessages(events);
    const assistantRows = messages.filter((m) => m.kind === "assistant");
    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]).toMatchObject({
      turnId: "turn-1",
      content: "first response",
    });
    expect(assistantRows[1]).toMatchObject({
      turnId: "turn-2",
      content: "second response",
    });
  });

  test("plan_exited with a bogus payload turnId does not contaminate currentTurnId (regression: stray dot rows)", () => {
    // Real failure mode from a `--yolo + /plan` session: the
    // workflow-controller's `emitPlanExited` hardcoded
    // `turnId: "ExitPlanMode"` on the event payload. Pre-fix,
    // `ensureTurnId` had a side effect that wrote that bogus value
    // into `currentTurnId`, contaminating every subsequent assistant
    // row in the same turn — and the per-turn `lastAssistantIndexByTurn`
    // map keyed off the now-corrupt id, so each filtered "Calling tool."
    // lifecycle group leaked a stray `● .` row into the transcript.
    //
    // Post-fix:
    //   1) `emitPlanExited` uses the real active turn id (workflow-controller).
    //   2) `ensureTurnId` is a pure function — never mutates
    //      `currentTurnId`. Only the `turn_started` handler advances
    //      the canonical turn id.
    //
    // This test simulates the broken event stream (bogus payload turnId)
    // and asserts that subsequent assistant rows keep the real turn id
    // and that no stray `● .` rows leak through the lifecycle filter.
    const events: TranscriptSourceEvent[] = [
      { type: "turn_started", payload: { turnId: "real-turn-id" } },
      {
        type: "tool_call_started",
        payload: { callId: "call-exit", toolName: "ExitPlanMode", args: "{}" },
      },
      // Buggy upstream emitter — payload.turnId is the tool name, not
      // the conversation turn. Even if a runtime regresses, the reducer
      // must not contaminate currentTurnId from it.
      { type: "plan_exited", payload: { turnId: "ExitPlanMode" } },
      {
        type: "tool_call_completed",
        payload: { callId: "call-exit", result: "{}", isError: false },
      },
      // A lifecycle "Calling tool." group — must be filtered cleanly.
      { type: "agent_message_delta", payload: { delta: "Calling" } },
      { type: "agent_message_delta", payload: { delta: " tool" } },
      { type: "agent_message_delta", payload: { delta: "." } },
      {
        type: "tool_call_started",
        payload: { callId: "call-2", toolName: "FileRead", args: "{}" },
      },
      { type: "agent_message", payload: { message: "Calling tool." } },
      {
        type: "tool_call_completed",
        payload: { callId: "call-2", result: '"ok"', isError: false },
      },
      // Real final message after the tool work.
      { type: "agent_message_delta", payload: { delta: "All done" } },
      { type: "agent_message", payload: { message: "All done" } },
    ];

    const messages = eventsToMessages(events);
    const assistantRows = messages.filter((m) => m.kind === "assistant");
    // Exactly one assistant row — no stray "." rows from the lifecycle
    // group.
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      content: "All done",
      isComplete: true,
      // Critical: turn id is the real one, NOT "ExitPlanMode".
      turnId: "real-turn-id",
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
          toolName: "Write",
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
      toolName: "Write",
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
          toolName: "FileRead",
          args: '{"path":"README.md"}',
        },
      },
    ];

    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      toolName: "FileRead",
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
          message: "FileRead -> readonly",
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
          toolName: "FileRead",
          args: '{"path":"README.md"}',
        },
      },
      {
        type: "tool_progress",
        payload: {
          callId: "read-1",
          toolName: "FileRead",
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
      toolName: "FileRead",
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
          toolName: "Write",
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
      toolName: "Write",
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

  test("caps large tool results in display messages", () => {
    const largeResult = "x".repeat(80_000);
    const messages = eventsToMessages([
      { type: "turn_started", payload: { turnId: "turn-large-result" } },
      {
        type: "tool_call_started",
        payload: { callId: "call-large", toolName: "Read", args: "{}" },
      },
      {
        type: "tool_call_completed",
        payload: {
          callId: "call-large",
          result: largeResult,
          isError: false,
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolResultContent?.length).toBeLessThan(
      largeResult.length,
    );
    expect(messages[0]?.toolResultContent).toContain(
      "omitted from TUI transcript",
    );
  });

  test("caps large exec output in display messages", () => {
    const stdout = `head\n${"x".repeat(80_000)}\ntail`;
    const messages = eventsToMessages([
      { type: "turn_started", payload: { turnId: "turn-large-exec" } },
      {
        type: "exec_command_begin",
        payload: { callId: "exec-large", command: "yes", cwd: "/tmp" },
      },
      {
        type: "exec_command_end",
        payload: {
          callId: "exec-large",
          exitCode: 0,
          stdout,
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.execStdout?.length).toBeLessThan(stdout.length);
    expect(messages[0]?.execStdout).toContain("head");
    expect(messages[0]?.execStdout).toContain("tail");
    expect(messages[0]?.execStdout).toContain("omitted from TUI transcript");
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
