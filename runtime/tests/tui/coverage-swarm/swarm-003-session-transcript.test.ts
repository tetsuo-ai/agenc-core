import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot, type Root } from "../ink/root.js";
import {
  adaptTranscriptEvents,
  formatStructuredToolResult,
  useSessionTranscript,
  type AdaptedTranscript,
  type SessionTranscriptEvent,
} from "../session-transcript.js";

function evt(
  id: string,
  type: string,
  payload: Record<string, unknown> = {},
): SessionTranscriptEvent {
  return { id, msg: { type, payload } } as SessionTranscriptEvent;
}

function systemContents(transcript: AdaptedTranscript): string[] {
  return transcript.messages
    .filter((message) => message.type === "system")
    .map((message) => String(message.content));
}

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, { columns: 120, rows: 24, isTTY: true });
  stdout.resume();

  return { stdin, stdout };
}

function flushEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function renderTranscriptHookHarness(): Promise<{
  readonly dispose: () => Promise<void>;
  readonly latest: () => AdaptedTranscript;
  readonly render: (session: Record<string, unknown>) => Promise<void>;
}> {
  const { stdin, stdout } = createStreams();
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  let latestTranscript: AdaptedTranscript | undefined;

  function Probe({ session }: { readonly session: Record<string, unknown> }): null {
    latestTranscript = useSessionTranscript(session as never, [
      { role: "user", content: "startup prompt" },
    ]);
    return null;
  }

  return {
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await flushEffects();
    },
    latest: () => {
      if (latestTranscript === undefined) {
        throw new Error("transcript hook did not render");
      }
      return latestTranscript;
    },
    render: async (session) => {
      root.render(React.createElement(Probe, { session }));
      await flushEffects();
    },
  };
}

describe("session transcript coverage swarm row 003", () => {
  test("covers legacy tool JSON fallbacks and orphan structured result recovery rows", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "legacy-empty-args",
        type: "tool_call",
        toolCall: { name: "EmptyArgs", arguments: "" },
      } as SessionTranscriptEvent,
      {
        id: "legacy-bad-args",
        type: "tool_call",
        toolCall: { id: "legacy-bad", name: "BadArgs", arguments: "{bad" },
      } as SessionTranscriptEvent,
      evt("orphan-structured-ok", "tool_call_completed", {
        callId: "orphan-ok",
        result: [{ type: "text", text: "ok" }],
        isError: false,
      }),
      evt("orphan-structured-error", "tool_call_completed", {
        callId: "orphan-error",
        result: [{ type: "text", text: "failed" }],
        isError: true,
      }),
      evt("orphan-empty-array", "tool_call_completed", {
        callId: "orphan-empty-array",
        result: [],
        isError: false,
      }),
    ]);

    const toolUseBlocks = transcript.messages
      .filter((message) => message.type === "assistant")
      .map((message) => message.message.content[0]);

    expect(toolUseBlocks).toEqual([
      expect.objectContaining({ name: "EmptyArgs", input: {} }),
      expect.objectContaining({
        id: "legacy-bad",
        name: "BadArgs",
        input: { input: "{bad" },
      }),
    ]);
    // Recovered out-of-order tool results no longer leak the raw internal
    // callId (call_…) or the framework-internal "without matching start"
    // phrasing into the user-facing transcript prose; the recovered RESULT
    // payload (here empty for the empty array) is still kept visible.
    expect(systemContents(transcript)).toEqual([
      "A tool result arrived before its start event and was recovered.",
      "A tool failed and its result arrived before its start event; recovered.",
      "A tool result arrived out of order and was recovered: ",
    ]);
    // None of these operator-facing lines carry the opaque callId.
    for (const text of systemContents(transcript)) {
      expect(text).not.toMatch(/orphan-/);
    }
  });

  test("formats structured tool result edge cases for MCP, Glob, and circular fallback data", () => {
    const mcp = formatStructuredToolResult("MCP", "mcp_tool_call_end", {
      result: { content: "mcp text" },
    });
    const globNoFiles = formatStructuredToolResult("Glob", "tool_call_completed", {
      result: "No files found",
      metadata: { pattern: "*.missing" },
    });
    const globBlankAndTruncated = formatStructuredToolResult(
      "Glob",
      "tool_call_completed",
      {
        result:
          "\na.ts\n\n(Results are truncated. Consider using a more specific path or pattern.)",
        metadata: { pattern: "*.ts" },
      },
    );
    const globObjectTruncated = formatStructuredToolResult(
      "Glob",
      "tool_call_completed",
      {
        result: { paths: ["a.ts", 7], pattern: "*.ts" },
        metadata: { truncated: true },
      },
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fallback = formatStructuredToolResult("Other", "tool_call_completed", {
      result: circular,
    });

    expect(mcp).toEqual([{ type: "text", text: "mcp text" }]);
    expect(globNoFiles).toEqual([
      { type: "text", text: "<glob-pattern>*.missing</glob-pattern>" },
      { type: "text", text: "<glob-paths></glob-paths>" },
    ]);
    expect(globBlankAndTruncated).toContainEqual({
      type: "text",
      text: "<glob-paths>a.ts</glob-paths>",
    });
    expect(globBlankAndTruncated).toContainEqual({
      type: "text",
      text: "<glob-truncated>true</glob-truncated>",
    });
    expect(globObjectTruncated).toContainEqual({
      type: "text",
      text: "<glob-paths>a.ts</glob-paths>",
    });
    expect(globObjectTruncated).toContainEqual({
      type: "text",
      text: "<glob-truncated>true</glob-truncated>",
    });
    expect(fallback).toEqual([{ type: "text", text: "[object Object]" }]);
  });

  test("filters protocol payload facts while preserving valid derived facts", () => {
    const transcript = adaptTranscriptEvents([
      evt("claim", "protocol_claim", {
        message: "claim accepted",
        escrowLamports: 20_000_000_000,
        stakeLamports: Number.POSITIVE_INFINITY,
        facts: [
          null,
          { label: "", value: "missing label" },
          { label: "ok", value: true },
          { label: "bad", value: { nested: true } },
        ],
      }),
    ]);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]).toMatchObject({
      type: "system",
      subtype: "protocol_event",
      protocolKind: "claim",
      content: "claim accepted",
      badgeVariant: "worker",
      state: "info",
    });
    expect(transcript.messages[0]?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "escrow", value: expect.stringMatching(/^20/) }),
        { label: "ok", value: "true" },
      ]),
    );
    expect(
      transcript.messages[0]?.facts.map(
        (fact: { readonly label: string }) => fact.label,
      ),
    ).not.toContain("bad");
  });

  test("normalizes sparse token counts and background-agent status variants", () => {
    const longMessage = Array.from({ length: 80 }, (_, index) => `word${index}`).join(
      "   ",
    );
    const transcript = adaptTranscriptEvents([
      evt("tokens", "token_count", {
        promptTokens: -4.8,
        completionTokens: 2.9,
        totalTokens: 0,
        cachedInputTokens: "not numeric",
        model: " ",
        provider: " ",
      }),
      evt("running", "background_agent_status", {
        status: "running",
        message: longMessage,
      }),
      evt("complete", "background_agent_status", {
        status: "COMPLETE",
      }),
      evt("cancelled", "background_agent_status", {
        status: "killed",
      }),
      evt("custom", "background_agent_status", {
        status: "custom_status",
      }),
      evt("idle-non-string", "background_agent_status", {
        status: null,
        message: "should not render",
      }),
    ]);

    const contents = systemContents(transcript);

    expect(contents[0]).toContain("0 in");
    expect(contents[0]).toContain("2 out");
    expect(contents[0]).toContain("2 total");
    expect(contents[0]).toContain("est.");
    expect(contents[0]).not.toContain("unknown");
    expect(contents[1]).toContain("Background agent running: word0 word1");
    expect(contents[1]!.length).toBeLessThan(210);
    expect(contents).toContain("Background agent completed");
    expect(contents).toContain("Background agent cancelled");
    expect(contents).toContain("Background agent custom-status");
    expect(contents.join("\n")).not.toContain("should not render");
  });

  test("handles realtime defaults and event-key fallback paths", () => {
    const circularEvent = {
      type: "error",
      payload: {},
    } as SessionTranscriptEvent & { payload: { message?: unknown } };
    circularEvent.payload.message = circularEvent;

    const transcript = adaptTranscriptEvents([
      { type: "context_compacted" } as SessionTranscriptEvent,
      { type: "realtime_started", payload: {} } as SessionTranscriptEvent,
      {
        type: "realtime_transcript_delta",
        payload: { role: "assistant", delta: "voice preview" },
      } as SessionTranscriptEvent,
      {
        type: "realtime_transcript_delta",
        payload: { role: "user", delta: "ignored" },
      } as SessionTranscriptEvent,
      { type: "realtime_error", payload: {} } as SessionTranscriptEvent,
      {
        type: "realtime_closed",
        payload: { reason: "   " },
      } as SessionTranscriptEvent,
      circularEvent,
    ]);

    expect(systemContents(transcript)).toEqual([
      "Context compacted",
      "Realtime voice started",
      "Realtime error",
      "Realtime closed",
      "[object Object]",
    ]);
    expect(transcript.streamingText).toBeNull();
  });

  test("maps slash result variants without leaking silent control results", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "slash-text",
        type: "slash_result",
        result: { kind: "text", text: "plain text" },
      } as SessionTranscriptEvent,
      {
        id: "slash-compact",
        type: "slash_result",
        result: { kind: "compact", text: "compact text" },
      } as SessionTranscriptEvent,
      {
        id: "slash-empty-error",
        type: "slash_result",
        result: { kind: "error", message: "" },
      } as SessionTranscriptEvent,
      {
        id: "slash-content-error",
        type: "slash_result",
        payload: { kind: "error", message: { content: "content error" } },
      } as SessionTranscriptEvent,
      {
        id: "slash-text-non-string",
        type: "slash_result",
        result: { kind: "text", text: 7 },
      } as SessionTranscriptEvent,
      {
        id: "slash-skip",
        type: "slash_result",
        result: { kind: "skip" },
      } as SessionTranscriptEvent,
      {
        id: "slash-exit",
        type: "slash_result",
        result: { kind: "exit" },
      } as SessionTranscriptEvent,
      {
        id: "slash-prompt",
        type: "slash_result",
        result: { kind: "prompt" },
      } as SessionTranscriptEvent,
      {
        id: "slash-weird",
        type: "slash_result",
        payload: { kind: "weird", value: 9 },
      } as SessionTranscriptEvent,
    ]);

    expect(systemContents(transcript)).toEqual([
      "plain text",
      "compact text",
      "Error: slash command failed",
      "Error: content error",
      '{\n  "kind": "weird",\n  "value": 9\n}',
    ]);
  });

  test("parses subagent notifications across status encodings and falls back to assistant text", () => {
    const transcript = adaptTranscriptEvents([
      evt("subagent-running", "agent_message", {
        message:
          '<subagent_notification>{"agent_path":"worker-thread-123456","status":"running"}</subagent_notification>',
      }),
      evt("subagent-completed", "agent_message", {
        message:
          '<subagent_notification>{"agent_path":"worker-thread-2","status":{"completed":"done"}} </subagent_notification>',
      }),
      evt("subagent-errored", "agent_message", {
        message:
          '<subagent_notification>{"agent_path":"worker-thread-3","status":{"errored":""}}</subagent_notification>',
      }),
      evt("subagent-unknown", "agent_message", {
        message:
          '<subagent_notification>{"agent_path":"worker-thread-4","status":{}}</subagent_notification>',
      }),
      evt("subagent-invalid", "agent_message", {
        message: "<subagent_notification>{not json}</subagent_notification>",
      }),
    ]);

    const collabRows = transcript.messages.filter(
      (message) => message.subtype === "collab_agent",
    );
    const assistantRows = transcript.messages.filter(
      (message) => message.type === "assistant",
    );

    expect(collabRows).toMatchObject([
      { state: "running", details: ["status: Running"] },
      { state: "success", details: ["done"] },
      { state: "error", details: ["error"] },
    ]);
    expect(assistantRows).toHaveLength(2);
    expect(JSON.stringify(assistantRows)).toContain("worker-thread-4");
    expect(JSON.stringify(assistantRows)).toContain("{not json}");
  });

  test("synthesizes streamed tool input on completion and ignores malformed stream events", () => {
    const transcript = adaptTranscriptEvents([
      evt("block-no-call", "tool_input_block_start", { index: 0 }),
      evt("block-no-index", "tool_input_block_start", { callId: "missing-index" }),
      evt("delta-no-index", "tool_input_delta", { partialJson: "{}" }),
      evt("delta-non-string", "tool_input_delta", {
        index: 1,
        partialJson: 7,
      }),
      evt("stream-start", "tool_input_block_start", {
        callId: "stream-1",
        index: 1,
        contentBlock: {
          type: "tool_use",
          id: "stream-1",
          name: "FileRead",
          input: { path: "src/a.ts" },
        },
      }),
      evt("stream-start-duplicate", "tool_input_block_start", {
        callId: "stream-1",
        index: 1,
        contentBlock: {
          type: "tool_use",
          id: "stream-1",
          name: "FileRead",
          input: { path: "src/a.ts" },
        },
      }),
      evt("stream-complete", "tool_call_completed", {
        callId: "stream-1",
        result: { content: "done" },
      }),
    ]);

    expect(transcript.streamingToolUses).toEqual([]);
    expect(transcript.inProgressToolUseIDs.size).toBe(0);
    expect(transcript.toolNames.has("FileRead")).toBe(true);
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]?.message.content[0]).toMatchObject({
      type: "tool_use",
      id: "stream-1",
      name: "FileRead",
      input: { path: "src/a.ts" },
    });
    expect(transcript.messages[1]?.message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "stream-1",
    });
  });

  test("renders collab lifecycle edge states and fallback status details", () => {
    const transcript = adaptTranscriptEvents([
      evt("settled-spawn-begin", "collab_agent_spawn_begin", {
        callId: "settled-spawn",
        prompt: "this begin row is stale",
      }),
      evt("settled-spawn-end", "collab_agent_spawn_end", {
        callId: "settled-spawn",
        newThreadId: "thread-settled",
        newAgentRole: "reviewer",
        prompt: "review the changes",
        newAgentPath: "/tmp/reviewer",
        status: { status: "interrupted", reason: "operator paused the worker" },
      }),
      evt("spawn-running", "collab_agent_spawn_begin", {
        callId: "spawn-running",
        prompt: "draft a plan",
        taskName: "plan-draft",
        model: "local-model",
        reasoningEffort: "high",
      }),
      evt("interaction-begin", "collab_agent_interaction_begin", {
        callId: "interaction-1",
        receiverThreadId: "shortid",
        prompt: "send status",
      }),
      evt("interaction-end", "collab_agent_interaction_end", {
        callId: "interaction-1",
        receiverThreadId: "shortid",
        status: null,
      }),
      evt("wait-begin-empty", "collab_waiting_begin", {
        callId: "wait-empty",
      }),
      evt("wait-end-statuses", "collab_waiting_end", {
        callId: "wait-empty",
        statuses: {
          "agent-a": { status: "errored", error: "failed check" },
          "agent-b": { status: "shutdown" },
        },
      }),
    ]);

    expect(transcript.inProgressToolUseIDs).toEqual(new Set(["spawn-running"]));
    expect(transcript.messages).toMatchObject([
      {
        subtype: "collab_agent",
        title: "Spawned reviewer",
        state: "running",
        details: expect.arrayContaining([
          "review the changes",
          "status: Interrupted - operator paused the worker",
          "manage: wait_agent, send_message, or close_agent /tmp/reviewer",
        ]),
      },
      {
        subtype: "collab_agent",
        title: "Spawning agent",
        state: "running",
        details: ["draft a plan", "task plan-draft", "model local-model, effort high"],
      },
      {
        subtype: "collab_agent",
        title: "Sending input to shortid",
        state: "running",
        details: ["send status"],
      },
      {
        subtype: "collab_agent",
        title: "Sent input to shortid",
        state: "info",
        details: ["status: unavailable"],
      },
      {
        subtype: "collab_agent",
        title: "Waiting for agents",
        state: "running",
        details: [],
      },
      {
        subtype: "collab_agent",
        title: "Finished waiting",
        state: "error",
        details: ["agent-a: Error - failed check", "agent-b: Shutdown"],
      },
    ]);
  });

  test("useSessionTranscript consumes initial events, subscriptions, phase events, and cleanup", async () => {
    let eventLogCallback: ((event: SessionTranscriptEvent) => void) | undefined;
    let phaseCallback: ((event: unknown) => void) | undefined;
    let unsubscribedLog = false;
    let unsubscribedPhase = false;
    const getterSession = {
      initialTranscriptEvents: [
        evt("ignored-property", "user_message", { message: "ignored property" }),
      ],
      getInitialTranscriptEvents: () => [
        evt("getter-initial", "user_message", { message: "from getter" }),
      ],
      eventLog: {
        subscribe: (callback: (event: SessionTranscriptEvent) => void) => {
          eventLogCallback = callback;
          return () => {
            unsubscribedLog = true;
          };
        },
      },
      subscribeToEvents: (callback: (event: unknown) => void) => {
        phaseCallback = callback;
        return () => {
          unsubscribedPhase = true;
        };
      },
    };
    const propertySession = {
      initialTranscriptEvents: [
        evt("property-initial", "user_message", { message: "from property" }),
      ],
    };
    const harness = await renderTranscriptHookHarness();

    try {
      await harness.render(getterSession);
      expect(JSON.stringify(harness.latest().messages)).toContain("startup prompt");
      expect(JSON.stringify(harness.latest().messages)).toContain("from getter");
      expect(JSON.stringify(harness.latest().messages)).not.toContain("ignored property");

      eventLogCallback?.(evt("log-event", "user_message", { message: "from log" }));
      phaseCallback?.({ type: "context_compacted" });
      phaseCallback?.(evt("phase-msg-event", "user_message", {
        message: "from msg envelope",
      }));
      phaseCallback?.(null);
      await flushEffects();

      expect(JSON.stringify(harness.latest().messages)).toContain("from log");
      expect(JSON.stringify(harness.latest().messages)).toContain("Context compacted");
      expect(JSON.stringify(harness.latest().messages)).toContain("from msg envelope");

      await harness.render(propertySession);

      expect(unsubscribedLog).toBe(true);
      expect(unsubscribedPhase).toBe(true);
      expect(JSON.stringify(harness.latest().messages)).toContain("from property");
      expect(JSON.stringify(harness.latest().messages)).not.toContain("from getter");
    } finally {
      await harness.dispose();
    }
  });
});
