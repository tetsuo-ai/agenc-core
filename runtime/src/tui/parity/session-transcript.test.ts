import { describe, expect, test } from "vitest";

import {
  adaptTranscriptEvents,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  formatStructuredToolError,
  formatStructuredToolResult,
} from "../session-transcript.js";
import { pickToolResultDispatch } from "../tool-result-routing.js";
import { createHistoryReplacedEvent } from "../../session/transcript-replacement.js";

describe("AgenC TUI session transcript", () => {
  test("maps AgenC user and streaming assistant events into renderable messages", () => {
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

  test("renders daemon user messages from displayText instead of dropping content-shaped payloads", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "daemon-user",
        msg: {
          type: "user_message",
          payload: {
            message: [{ type: "text", text: "raw block" }],
            displayText: "render this",
          },
        },
      },
    ]);

    expect(transcript.messages.at(-1)).toMatchObject({
      type: "user",
      message: { content: "render this" },
    });
  });

  test("renders elicitation request events instead of dropping pending prompts", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "input",
        msg: {
          type: "request_user_input",
          payload: {
            callId: "call_1",
            turnId: "turn_1",
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Proceed?",
                options: [
                  { label: "Yes", description: "Continue." },
                  { label: "No", description: "Stop." },
                ],
              },
            ],
          },
        },
      },
      {
        id: "mcp",
        msg: {
          type: "mcp_elicitation_request",
          payload: {
            serverName: "srv",
            requestId: "mcp_1",
            turnId: "turn_1",
            request: {
              mode: "form",
              message: "Need details",
              requestedSchema: { type: "object", properties: {} },
            },
          },
        },
      },
    ]);

    expect(transcript.messages.map((message) => message.content)).toEqual([
      "Input requested: Proceed?",
      "MCP elicitation requested: Need details",
    ]);
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

  test("treats history_cleared as a transcript boundary and resets event dedupe", () => {
    const transcript = adaptTranscriptEvents(
      [
        {
          id: "reused-after-clear",
          msg: { type: "user_message", payload: { message: "before" } },
        },
        {
          id: "tool-start",
          msg: {
            type: "exec_command_begin",
            payload: { callId: "exec-1", command: "npm test" },
          },
        },
        {
          id: "delta",
          msg: { type: "agent_message_delta", payload: { delta: "streaming" } },
        },
        {
          id: "clear-1",
          type: "history_cleared",
          timestamp: 1,
        },
        {
          id: "between-clears",
          msg: { type: "user_message", payload: { message: "between" } },
        },
        {
          id: "clear-2",
          type: "history_cleared",
          timestamp: 2,
        },
        {
          id: "reused-after-clear",
          msg: { type: "user_message", payload: { message: "after" } },
        },
      ],
      [{ role: "user", content: "startup" }],
    );

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages.at(0)).toMatchObject({
      type: "user",
      message: { content: "after" },
    });
    expect(transcript.streamingText).toBeNull();
    expect(transcript.isStreaming).toBe(false);
    expect(transcript.currentTurnId).toBeNull();
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect([...transcript.toolNames]).toEqual([]);
    expect(transcript.streamingToolUses).toEqual([]);
  });

  test("resets prior messages when subscribed history_cleared appends through the reducer", () => {
    let state = createSessionTranscriptStateForTesting([
      {
        id: "before-clear",
        msg: { type: "user_message", payload: { message: "before" } },
      },
    ]);

    state = appendSessionTranscriptEventForTesting(state, {
      id: "clear-from-subscription",
      type: "history_cleared",
      timestamp: 3,
    });
    state = appendSessionTranscriptEventForTesting(state, {
      id: "after-clear",
      msg: { type: "user_message", payload: { message: "after" } },
    });

    const transcript = adaptTranscriptEvents(state.events);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages.at(0)).toMatchObject({
      type: "user",
      message: { content: "after" },
    });
  });

  test("history_replaced resets transcript to renderer-safe replacement messages", () => {
    const replacement = {
      type: "user",
      message: { role: "user", content: "summary replacement" },
      uuid: "replacement-user",
      timestamp: "2026-05-07T00:00:00.000Z",
    };
    let state = createSessionTranscriptStateForTesting([
      {
        id: "before-replace",
        msg: { type: "user_message", payload: { message: "before" } },
      },
    ]);

    state = appendSessionTranscriptEventForTesting(state, {
      id: "replace",
      type: "history_replaced",
      acceptedAt: "2026-05-07T00:00:00.000Z",
      payload: {
        reason: "partial_compact",
        messages: [replacement],
      },
    });
    state = appendSessionTranscriptEventForTesting(state, {
      id: "replace",
      type: "history_replaced",
      acceptedAt: "2026-05-07T00:00:00.000Z",
      payload: {
        reason: "partial_compact",
        messages: [{ ...replacement, uuid: "duplicate" }],
      },
    });

    const transcript = adaptTranscriptEvents(state.events);

    expect(transcript.messages).toEqual([replacement]);
    expect(transcript.streamingText).toBeNull();
    expect(transcript.isStreaming).toBe(false);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
  });

  test("history_replaced preserves compact boundary and summary metadata", () => {
    const replacement = createHistoryReplacedEvent({
      acceptedAt: "2026-05-07T00:00:00.000Z",
      replacementHistory: [
        { role: "user", content: "<compact>Conversation compacted</compact>" },
        {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. Summary.",
        },
        { role: "user", content: "active prompt" },
      ],
    });

    const transcript = adaptTranscriptEvents([replacement]);

    expect(transcript.messages.at(0)).toMatchObject({
      type: "user",
      isMeta: true,
      message: { content: "<compact>Conversation compacted</compact>" },
    });
    expect(transcript.messages.at(1)).toMatchObject({
      type: "user",
      isCompactSummary: true,
      message: {
        content:
          "This session is being continued from a previous conversation that ran out of context. Summary.",
      },
    });
    expect(transcript.messages.at(2)).toMatchObject({
      type: "user",
      message: { content: "active prompt" },
    });
  });

  test("interleaves realtime transcript completions and item notifications with surrounding text transcript", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "text-before",
        msg: {
          type: "agent_message",
          payload: { message: "Before voice" },
        },
      },
      {
        id: "rt-user",
        type: "realtime_transcript_done",
        payload: {
          role: "user",
          text: "spoken request",
        },
      },
      {
        id: "rt-item",
        type: "realtime_item_added",
        payload: {
          item: { type: "message", id: "item_1" },
        },
      },
      {
        id: "rt-assistant",
        type: "realtime_transcript_done",
        payload: {
          role: "assistant",
          text: "spoken response",
        },
      },
      {
        id: "rt-error",
        type: "realtime_error",
        payload: {
          message: "voice failed",
        },
      },
      {
        id: "rt-closed",
        type: "realtime_closed",
        payload: {
          reason: "requested",
        },
      },
    ]);

    expect(
      transcript.messages.map((message) =>
        message.type === "system"
          ? message.content
          : message.message.content,
      ),
    ).toEqual([
      [{ type: "text", text: "Before voice" }],
      "spoken request",
      "Realtime item: message item_1",
      [{ type: "text", text: "spoken response" }],
      "voice failed",
      "Realtime closed: requested",
    ]);
  });

  test("keeps realtime transcript events separate from ordinary streaming text", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "turn",
        msg: { type: "turn_started", payload: { turnId: "t1" } },
      },
      {
        id: "text-delta-1",
        msg: { type: "agent_message_delta", payload: { delta: "text " } },
      },
      {
        id: "rt-delta",
        type: "realtime_transcript_delta",
        payload: { role: "assistant", delta: "voice preview" },
      },
      {
        id: "rt-done",
        type: "realtime_transcript_done",
        payload: { role: "assistant", text: "voice final" },
      },
      {
        id: "rt-error",
        type: "realtime_error",
        payload: { message: "voice failed" },
      },
      {
        id: "text-delta-2",
        msg: { type: "agent_message_delta", payload: { delta: "stream" } },
      },
    ]);

    expect(transcript.streamingText).toBe("text stream");
    expect(
      transcript.messages.map((message) =>
        message.type === "system"
          ? message.content
          : message.message.content,
      ),
    ).toEqual([
      [{ type: "text", text: "voice final" }],
      "voice failed",
    ]);
  });

  test("maps tool calls and AgenC agent events to renderable tool rows", () => {
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

  test("tool_progress events are no longer captured into a runningToolProgress map and streamingToolUses is the live-tool contract", () => {
    const transcript = adaptTranscriptEvents([
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
    ]);
    expect(transcript).not.toHaveProperty("runningToolProgress");
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(Array.isArray(transcript.streamingToolUses)).toBe(true);
  });

  test("formatStructuredToolResult wraps Bash stdout/stderr in <bash-stdout>/<bash-stderr> tags so the renderer can consume the joined content", () => {
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout: "hello world",
      stderr: "warn",
      exitCode: 0,
      durationMs: 42,
    });
    expect(blocks.length).toBe(3);
    expect(blocks[0]?.text).toBe("<bash-stdout>hello world</bash-stdout>");
    expect(blocks[1]?.text).toBe("<bash-stderr>warn</bash-stderr>");
    expect(blocks[2]?.text).toBe("[exit_code=0 duration_ms=42]");
  });

  test("formatStructuredToolResult always emits an empty <bash-stdout></bash-stdout> envelope so silent Bash commands still have a stdout block", () => {
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(blocks[0]?.text).toBe("<bash-stdout></bash-stdout>");
    expect(blocks.map((b) => b.text)).toContain("[exit_code=0]");
  });

  test("formatStructuredToolResult omits the <bash-stderr> tag entirely when stderr is empty so the renderer can hide the stderr block instead of showing an empty box", () => {
    const blocks = formatStructuredToolResult("Bash", "exec_command_end", {
      stdout: "ok",
      stderr: "",
    });
    expect(blocks.some((b) => b.text.startsWith("<bash-stderr>"))).toBe(false);
  });

  test("formatStructuredToolResult wraps live FILE_EDIT_TOOL_NAME (\"Edit\") diff payload in <edit-file>/<edit-diff> tags so EditDiffView can extract file path and diff body separately", () => {
    const blocks = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: {
        path: "src/foo.ts",
        diff: "--- a\n+++ b\n@@ ... @@\n-old\n+new",
      },
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toBe("<edit-file>src/foo.ts</edit-file>");
    expect(blocks[1]?.text).toBe(
      "<edit-diff>--- a\n+++ b\n@@ ... @@\n-old\n+new</edit-diff>",
    );
  });

  test("formatStructuredToolResult Edit envelope omits <edit-file> when path is missing (defensive — diff still goes through tagged)", () => {
    const blocks = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: { diff: "minimal" },
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.text).toBe("<edit-diff>minimal</edit-diff>");
  });

  test("formatStructuredToolResult FileRead wraps content in <read-content> envelope plus optional <read-file> and <read-lines> tags", () => {
    const blocks = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result: {
        path: "src/foo.ts",
        startLine: 10,
        endLine: 20,
        content: "function hello() { return 42; }",
      },
    });
    expect(blocks.length).toBe(3);
    expect(blocks[0]?.text).toBe("<read-file>src/foo.ts</read-file>");
    expect(blocks[1]?.text).toBe("<read-lines>10-20</read-lines>");
    expect(blocks[2]?.text).toBe(
      "<read-content>function hello() { return 42; }</read-content>",
    );
  });

  test("formatStructuredToolResult FileRead with non-numeric startLine/endLine omits the <read-lines> tag (line range header) instead of emitting <read-lines>NaN-NaN</read-lines>", () => {
    const stringLines = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result: {
        path: "x",
        startLine: "five",
        endLine: "ten",
        content: "body",
      },
    });
    expect(stringLines.some((b) => b.text.includes("<read-lines>"))).toBe(false);
    const oneNumeric = formatStructuredToolResult("FileRead", "tool_call_completed", {
      result: {
        path: "x",
        startLine: 1,
        endLine: "ten",
        content: "body",
      },
    });
    expect(oneNumeric.some((b) => b.text.includes("<read-lines>"))).toBe(false);
  });

  test("formatStructuredToolResult Write singular form: bytesWritten=1 produces 'Wrote 1 byte' (not 'Wrote 1 bytes')", () => {
    const blocks = formatStructuredToolResult("Write", "tool_call_completed", {
      result: { path: "x", bytesWritten: 1 },
    });
    const summary = blocks.find((b) => b.text.startsWith("<write-summary>"));
    expect(summary?.text).toBe("<write-summary>Wrote 1 byte to x</write-summary>");
  });

  test("formatStructuredToolResult Write bytesWritten takes precedence over content.length when both are present", () => {
    const blocks = formatStructuredToolResult("Write", "tool_call_completed", {
      result: { path: "x", content: "1234567890", bytesWritten: 999 },
    });
    const summary = blocks.find((b) => b.text.startsWith("<write-summary>"));
    expect(summary?.text).toContain("999 bytes");
    expect(summary?.text).not.toContain("10 bytes");
  });

  test("formatStructuredToolResult Write with no bytesWritten and no content falls back to 'Wrote file' summary (no byte count)", () => {
    const blocks = formatStructuredToolResult("Write", "tool_call_completed", {
      result: { path: "x" },
    });
    const summary = blocks.find((b) => b.text.startsWith("<write-summary>"));
    expect(summary?.text).toBe("<write-summary>Wrote file x</write-summary>");
  });

  test("formatStructuredToolResult Grep walks result.results alternate field name (not just result.matches)", () => {
    const blocks = formatStructuredToolResult("Grep", "tool_call_completed", {
      result: {
        pattern: "X",
        results: [{ file: "a.ts", line: 1, content: "foo" }],
      },
    });
    const matches = blocks.find((b) => b.text.startsWith("<grep-matches>"));
    expect(matches?.text).toContain("a.ts:1:foo");
  });

  test("formatStructuredToolResult Grep accepts pre-formatted string matches verbatim", () => {
    const blocks = formatStructuredToolResult("Grep", "tool_call_completed", {
      result: {
        pattern: "X",
        matches: ["preformatted line 1", "preformatted line 2"],
      },
    });
    const matches = blocks.find((b) => b.text.startsWith("<grep-matches>"));
    expect(matches?.text).toBe(
      "<grep-matches>preformatted line 1\npreformatted line 2</grep-matches>",
    );
  });

  test("formatStructuredToolResult Grep with `text` field on matches (alternate to `content`) still resolves the line content", () => {
    const blocks = formatStructuredToolResult("Grep", "tool_call_completed", {
      result: {
        matches: [{ file: "a.ts", line: 1, text: "via text field" }],
      },
    });
    const matches = blocks.find((b) => b.text.startsWith("<grep-matches>"));
    expect(matches?.text).toContain("via text field");
  });

  test("formatStructuredToolResult Glob walks result.files alternate field name", () => {
    const blocks = formatStructuredToolResult("Glob", "tool_call_completed", {
      result: { files: ["a", "b"] },
    });
    const paths = blocks.find((b) => b.text.startsWith("<glob-paths>"));
    expect(paths?.text).toBe("<glob-paths>a\nb</glob-paths>");
  });

  test("formatStructuredToolResult Write produces a <write-summary> with byte count when bytesWritten or content is present", () => {
    const withBytes = formatStructuredToolResult("Write", "tool_call_completed", {
      result: { path: "src/out.ts", bytesWritten: 256 },
    });
    expect(withBytes.length).toBe(2);
    expect(withBytes[0]?.text).toBe("<write-file>src/out.ts</write-file>");
    expect(withBytes[1]?.text).toBe(
      "<write-summary>Wrote 256 bytes to src/out.ts</write-summary>",
    );

    const withContent = formatStructuredToolResult(
      "Write",
      "tool_call_completed",
      { result: { path: "x", content: "hi" } },
    );
    expect(withContent[1]?.text).toBe(
      "<write-summary>Wrote 2 bytes to x</write-summary>",
    );
  });

  test("formatStructuredToolResult Grep wraps a matches array as line-per-match in <grep-matches> envelope", () => {
    const blocks = formatStructuredToolResult("Grep", "tool_call_completed", {
      result: {
        pattern: "TODO",
        matches: [
          { file: "a.ts", line: 5, content: "// TODO: refactor" },
          { file: "b.ts", line: 12, content: "// TODO: test" },
        ],
      },
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toBe("<grep-pattern>TODO</grep-pattern>");
    expect(blocks[1]?.text).toBe(
      "<grep-matches>a.ts:5:// TODO: refactor\nb.ts:12:// TODO: test</grep-matches>",
    );
  });

  test("formatStructuredToolResult Glob wraps a paths array in <glob-paths> envelope", () => {
    const blocks = formatStructuredToolResult("Glob", "tool_call_completed", {
      result: {
        pattern: "src/**/*.ts",
        paths: ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
      },
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toBe("<glob-pattern>src/**/*.ts</glob-pattern>");
    expect(blocks[1]?.text).toBe(
      "<glob-paths>src/foo.ts\nsrc/bar.ts\nsrc/baz.ts</glob-paths>",
    );
  });

  test("formatStructuredToolResult Glob accepts a bare array result (no paths/files key)", () => {
    const blocks = formatStructuredToolResult("Glob", "tool_call_completed", {
      result: ["a", "b"],
    });
    expect(blocks[blocks.length - 1]?.text).toBe(
      "<glob-paths>a\nb</glob-paths>",
    );
  });

  test("formatStructuredToolResult Glob envelopes plain runtime path text for TUI dispatch", () => {
    const blocks = formatStructuredToolResult("Glob", "tool_call_completed", {
      result:
        "src/foo.ts\nsrc/bar.ts\n(Results are truncated. Consider using a more specific path or pattern.)",
      metadata: { pattern: "src/**/*.ts" },
    });
    const joined = blocks.map((block) => block.text).join("\n");

    expect(blocks[0]?.text).toBe("<glob-pattern>src/**/*.ts</glob-pattern>");
    expect(blocks[1]?.text).toBe("<glob-paths>src/foo.ts\nsrc/bar.ts</glob-paths>");
    expect(blocks[2]?.text).toBe("<glob-truncated>true</glob-truncated>");
    expect(pickToolResultDispatch("Glob", joined)).toBe("glob-paths-view");
  });

  test("formatStructuredToolResult Glob preserves exact whitespace in plain path text", () => {
    const blocks = formatStructuredToolResult("Glob", "tool_call_completed", {
      result: " leading.ts\ntrailing.ts ",
      metadata: { pattern: "*.ts" },
    });

    expect(blocks[1]?.text).toBe("<glob-paths> leading.ts\ntrailing.ts </glob-paths>");
  });

  test("adaptTranscriptEvents maps completed truncated plain Glob results into structured content blocks", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "glob-start",
        msg: {
          type: "tool_call_started",
          payload: {
            callId: "glob-1",
            toolName: "Glob",
            args: JSON.stringify({ pattern: "*.ts" }),
          },
        },
      },
      {
        id: "glob-end",
        msg: {
          type: "tool_call_completed",
          payload: {
            callId: "glob-1",
            result:
              "a.ts\nb.ts\n(Results are truncated. Consider using a more specific path or pattern.)",
            metadata: { pattern: "*.ts", truncated: true },
          },
        },
      },
    ]);
    const resultMessage = transcript.messages.at(-1);
    const content = resultMessage?.message.content[0]?.content;

    expect(Array.isArray(content)).toBe(true);
    expect(content).toContainEqual({
      type: "text",
      text: "<glob-pattern>*.ts</glob-pattern>",
    });
    expect(content).toContainEqual({
      type: "text",
      text: "<glob-paths>a.ts\nb.ts</glob-paths>",
    });
    expect(content).toContainEqual({
      type: "text",
      text: "<glob-truncated>true</glob-truncated>",
    });
  });

  test("formatStructuredToolResult Edit envelope omits <edit-file> when path is non-string (number/null/object), still emits <edit-diff>", () => {
    const numericPath = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: { path: 123, diff: "minimal" },
    });
    expect(numericPath.length).toBe(1);
    expect(numericPath[0]?.text).toBe("<edit-diff>minimal</edit-diff>");
    const nullPath = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: { path: null, diff: "x" },
    });
    expect(nullPath.length).toBe(1);
    expect(nullPath[0]?.text).toBe("<edit-diff>x</edit-diff>");
    const objectPath = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: { path: { nested: "obj" }, diff: "y" },
    });
    expect(objectPath.length).toBe(1);
    expect(objectPath[0]?.text).toBe("<edit-diff>y</edit-diff>");
  });

  test("formatStructuredToolResult Edit falls back to stringResult when the result has no diff field (e.g. error-path payload)", () => {
    const blocks = formatStructuredToolResult("Edit", "tool_call_completed", {
      result: { error: "permission denied" },
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.text).not.toContain("<edit-diff>");
    expect(blocks[0]?.text).toContain("permission denied");
  });

  test("formatStructuredToolError wraps a tool name + message in <tool-error-name>/<tool-error> envelope (cross-cutting error channel)", () => {
    const blocks = formatStructuredToolError("FileRead", "ENOENT: no such file");
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toBe(
      "<tool-error-name>FileRead</tool-error-name>",
    );
    expect(blocks[1]?.text).toBe(
      "<tool-error>ENOENT: no such file</tool-error>",
    );
  });

  test("formatStructuredToolError omits <tool-error-name> when toolName is empty", () => {
    const blocks = formatStructuredToolError("", "boom");
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.text).toBe("<tool-error>boom</tool-error>");
  });

  test("formatStructuredToolError with an empty message string still produces a well-formed envelope (the <tool-error> tag is always emitted)", () => {
    const blocks = formatStructuredToolError("Bash", "");
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.text).toBe("<tool-error-name>Bash</tool-error-name>");
    expect(blocks[1]?.text).toBe("<tool-error></tool-error>");
  });

  test("formatStructuredToolResult falls back to a single text block for unknown tools", () => {
    const blocks = formatStructuredToolResult("WeirdTool", "tool_call_completed", {
      result: { foo: 1, bar: "baz" },
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.text).toContain("foo");
    expect(blocks[0]?.text).toContain("baz");
  });

  describe("slash-command echo (Task F event-shape contract)", () => {
    test("renders the slash-command echo emitted by the App.tsx interceptor as a user message", () => {
      // The App.tsx slash interceptor emits this exact event shape
      // before dispatching. The transcript hook must turn it into a
      // user-row visible to the operator. Pin the shape so a future
      // refactor of the emit cannot silently break the audit trail.
      const transcript = adaptTranscriptEvents([
        {
          id: "slash-echo-12345",
          msg: {
            type: "user_message",
            payload: {
              displayText: "/agents",
              message: "/agents",
            },
          },
        },
      ]);
      expect(transcript.messages).toHaveLength(1);
      expect(transcript.messages[0]).toMatchObject({
        type: "user",
        message: { content: "/agents" },
      });
    });

    test("preserves the raw user input verbatim — aliases display as typed, not canonicalized", () => {
      // The interceptor passes the raw `text` (not parsed.name) so the
      // transcript shows what the user actually typed. /bashes (alias
      // for /tasks) must echo as /bashes.
      const transcript = adaptTranscriptEvents([
        {
          id: "slash-echo-alias",
          msg: {
            type: "user_message",
            payload: {
              displayText: "/bashes",
              message: "/bashes",
            },
          },
        },
      ]);
      expect(transcript.messages[0]).toMatchObject({
        type: "user",
        message: { content: "/bashes" },
      });
    });
  });

  describe("background-agent transcript leak filters", () => {
    test("suppresses warning events whose cause is background_agent_status", () => {
      const transcript = adaptTranscriptEvents([
        {
          id: "user",
          msg: { type: "user_message", payload: { message: "hi" } },
        },
        {
          id: "bg-status",
          msg: {
            type: "warning",
            payload: {
              cause: "background_agent_status",
              message: "Subagent is still working...",
            },
          },
        },
      ]);
      // The user message must remain, but the daemon's background-agent
      // progress tick must NOT show up as a yellow system warning.
      expect(transcript.messages).toHaveLength(1);
      expect(transcript.messages[0]).toMatchObject({ type: "user" });
      const allText = JSON.stringify(transcript.messages);
      expect(allText).not.toContain("Subagent is still working");
    });

    test("renders normal warnings (no background_agent_status cause) as system messages", () => {
      const transcript = adaptTranscriptEvents([
        {
          id: "warn",
          msg: {
            type: "warning",
            payload: {
              cause: "user_prompt_submit_hook_threw",
              message: "Hook threw an error",
            },
          },
        },
      ]);
      expect(transcript.messages).toHaveLength(1);
      const allText = JSON.stringify(transcript.messages);
      expect(allText).toContain("Hook threw an error");
    });

    test("renders warnings with no cause field at all", () => {
      const transcript = adaptTranscriptEvents([
        {
          id: "warn",
          msg: {
            type: "warning",
            payload: { message: "Plain warning" },
          },
        },
      ]);
      expect(transcript.messages).toHaveLength(1);
    });
  });
});
