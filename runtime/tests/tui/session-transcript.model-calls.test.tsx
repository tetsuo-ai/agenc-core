import { PassThrough } from "node:stream";
import React from "react";
import { expect, test } from "vitest";
import { Text } from "../../src/tui/ink.js";
import { createRoot } from "../../src/tui/ink/root.js";
import {
  appendSessionTranscriptBatchForTesting,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  useSessionTranscript,
} from "../../src/tui/session-transcript.js";
import type { AgenCBridgeSession } from "../../src/tui/session-types.js";

// The store keeps only its newest 4,000 events. The "done in ... · N model
// calls" line under a finished turn counted the dispatched model calls among
// the events still kept, so a long turn reported far fewer calls than it made
// (186 of 331 in a two-and-a-half-hour run).

let seq = 0;
function event(type: string, payload: Record<string, unknown>) {
  seq += 1;
  return { id: `event-${seq}`, seq, msg: { type, payload } };
}

function dispatched(turnId: string, call: number) {
  return event("execution_admission", {
    sequence: seq + 1, eventId: `admission-${seq + 1}`, runId: "conv-calls",
    stepId: `model:${turnId}:${call}:0:primary`, kind: "model_turn", event: "dispatched",
  });
}

/** One model call and the tool round after it: 26 stored events. */
function callWithToolRound(turnId: string, call: number) {
  return [
    dispatched(turnId, call),
    event("token_count", { promptTokens: 1000, completionTokens: 10, model: "deepseek-flash", provider: "deepseek" }),
    ...Array.from({ length: 12 }, (_, index) => event("tool_call_started", {
      callId: `call-${call}-${index}`, toolName: "exec_command", args: "{\"cmd\":\"true\"}",
    })),
    ...Array.from({ length: 12 }, (_, index) => event("tool_call_completed", {
      callId: `call-${call}-${index}`, toolName: "exec_command", result: "ok",
    })),
  ];
}

function longTurn(turnId: string, calls: number) {
  return [
    event("turn_started", { turnId, startedAt: 1_000 }),
    ...Array.from({ length: calls }, (_, call) => callWithToolRound(turnId, call + 1)).flat(),
    event("turn_complete", { turnId, lastAgentMessage: "done", completedAt: 2_000, durationMs: 1_000 }),
  ];
}

function doneLineCalls(messages: readonly any[]): (number | undefined)[] {
  return messages.filter((message) => message?.subtype === "turn_duration").map((message) => message.modelCalls);
}

test("a turn longer than the event window reports every model call it made", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 40 });
  stdout.resume();
  let emit: ((event: unknown) => void) | undefined;
  const session = { initialTranscriptEvents: [], subscribeToEvents(callback: (event: unknown) => void) {
    emit = callback;
    return () => { emit = undefined; };
  } } as unknown as AgenCBridgeSession;
  let latest: readonly any[] = [];
  function Probe() {
    const transcript = useSessionTranscript(session);
    latest = transcript.messages;
    return <Text>{String(transcript.messages.length)}</Text>;
  }
  const root = await createRoot({ stdin: stdin as never, stdout: stdout as never, patchConsole: false });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  try {
    root.render(<Probe />);
    await settle();
    // 331 calls of 26 events each: more than twice the events the store keeps.
    const turn = longTurn("turn-long", 331);
    expect(turn.length).toBeGreaterThan(8_000);
    for (const item of turn) emit!(item);
    await settle();
    expect(doneLineCalls(latest)).toEqual([331]);

    // The next, short turn counts only its own calls.
    for (const item of longTurn("turn-short", 3)) emit!(item);
    await settle();
    expect(doneLineCalls(latest).at(-1)).toBe(3);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
  }
});

test("replayed and late events do not count a call twice, and a clear keeps the turn's count", () => {
  const turnId = "turn-replay";
  const start = event("turn_started", { turnId, startedAt: 1_000 });
  const calls = Array.from({ length: 200 }, (_, call) => callWithToolRound(turnId, call + 1)).flat();
  let state = createSessionTranscriptStateForTesting([start]);
  for (let index = 0; index < calls.length; index += 100) {
    state = appendSessionTranscriptBatchForTesting(state, calls.slice(index, index + 100) as never);
  }
  // The daemon's replay buffer sends recent events again: none counts twice.
  state = appendSessionTranscriptBatchForTesting(state, calls.slice(-1000) as never);
  // A late, out-of-order event rebuilds the stored window; the count stays.
  state = appendSessionTranscriptEventForTesting(state, { id: "late-warning", seq: 2.5, msg: { type: "warning",
    payload: { message: "late" } } } as never);
  seq += 1;
  const clear = { id: "clear", seq, type: "history_cleared", payload: {} };
  state = appendSessionTranscriptBatchForTesting(state, [
    clear,
    dispatched(turnId, 201),
    event("turn_complete", { turnId, lastAgentMessage: "done", completedAt: 2_000, durationMs: 1_000 }),
  ] as never);
  expect(state.events.length).toBeLessThanOrEqual(4_000);
  expect(state.modelCalls.byTurn.get(turnId)).toBe(201);
});
