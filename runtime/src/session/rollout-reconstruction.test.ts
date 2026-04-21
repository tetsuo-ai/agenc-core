import { describe, expect, test } from "vitest";
import {
  buildCompactedHistory,
  reconstructFromRollout,
} from "./rollout-reconstruction.js";
import { DEFAULT_MAX_TOOL_RESULT_BYTES } from "../tools/execution.js";
import {
  parseRolloutLine,
  type RolloutItem,
} from "./rollout-item.js";
import type { IndexSnapshot } from "./session-store.js";

describe("rollout-reconstruction", () => {
  test("replays response_items into history", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "1",
          seq: 1,
          msg: {
            type: "turn_started",
            payload: { turnId: "t1" },
          },
        },
      },
      { type: "response_item", payload: { role: "user", content: "hello" } },
      { type: "response_item", payload: { role: "assistant", content: "hi" } },
      {
        type: "event_msg",
        payload: {
          id: "2",
          seq: 2,
          msg: {
            type: "turn_complete",
            payload: { turnId: "t1" },
          },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.history).toHaveLength(2);
    expect(r.orphanedTurnIds).toHaveLength(0);
  });

  test("compacted.replacementHistory becomes baseline", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "old" } },
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [{ role: "user", content: "boundary" }],
        },
      },
      { type: "response_item", payload: { role: "assistant", content: "new" } },
    ];
    const r = reconstructFromRollout(items);
    expect(r.history[0]?.content).toBe("boundary");
    expect(r.history[1]?.content).toBe("new");
  });

  test("replays the full persisted compacted replacement history, including boundary and preserved tail", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "discard me" } },
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [
            { role: "system", content: "boundary" },
            { role: "assistant", content: "summary text" },
            { role: "user", content: "kept tail" },
          ],
        },
      },
      { type: "response_item", payload: { role: "assistant", content: "after compact" } },
    ];

    const r = reconstructFromRollout(items);
    expect(r.history).toEqual([
      { role: "system", content: "boundary" },
      { role: "assistant", content: "summary text" },
      { role: "user", content: "kept tail" },
      { role: "assistant", content: "after compact" },
    ]);
  });

  test("newest surviving replacementHistory wins and only the suffix replays", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "discard me" } },
      {
        type: "compacted",
        payload: {
          message: "old summary",
          replacementHistory: [{ role: "user", content: "old baseline" }],
        },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "discard after old compact" },
      },
      {
        type: "compacted",
        payload: {
          message: "new summary",
          replacementHistory: [{ role: "user", content: "new baseline" }],
        },
      },
      { type: "response_item", payload: { role: "assistant", content: "kept tail" } },
    ];

    const r = reconstructFromRollout(items);
    expect(r.history).toEqual([
      { role: "user", content: "new baseline" },
      { role: "assistant", content: "kept tail" },
    ]);
  });

  test("I-48 orphan TurnStarted synthesizes process_killed abort", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t-orphan" } },
        },
      },
      { type: "response_item", payload: { role: "user", content: "mid-turn" } },
      // No TurnComplete/Aborted for t-orphan.
    ];
    const r = reconstructFromRollout(items);
    expect(r.orphanedTurnIds).toContain("t-orphan");
    const synthTypes = r.synthesizedEvents.map((ev) =>
      ev.type === "event_msg" ? ev.payload.msg.type : ev.type,
    );
    expect(synthTypes).toContain("turn_aborted");
    expect(synthTypes).toContain("warning");
  });

  test("I-25: snapshot.seq < rollout.lastSeq → snapshotBehindRollout + warning", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
      {
        type: "event_msg",
        payload: {
          id: "b",
          seq: 5,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
    ];
    const staleSnapshot: IndexSnapshot = {
      snapshotSequenceNumber: 2, // behind
      fileSize: 100,
      rolloutPath: "x",
      toolResultBytesByTurn: {},
      offsetsBySeq: {},
      writtenAtMs: Date.now(),
      agencVersion: "0.2.0",
      schemaVersion: 1,
    };
    const r = reconstructFromRollout(items, { indexSnapshot: staleSnapshot });
    expect(r.snapshotBehindRollout).toBe(true);
    expect(r.consumedSnapshot).toBeUndefined();
    const hasWarning = r.synthesizedEvents.some(
      (ev) =>
        ev.type === "event_msg" &&
        ev.payload.msg.type === "warning" &&
        (ev.payload.msg.payload as { cause?: string }).cause ===
          "snapshot_behind_rollout",
    );
    expect(hasWarning).toBe(true);
  });

  test("I-25: snapshot.seq ≥ rollout.lastSeq is accepted", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
    ];
    const freshSnapshot: IndexSnapshot = {
      snapshotSequenceNumber: 1,
      fileSize: 100,
      rolloutPath: "x",
      toolResultBytesByTurn: {},
      offsetsBySeq: {},
      writtenAtMs: Date.now(),
      agencVersion: "0.2.0",
      schemaVersion: 1,
    };
    const r = reconstructFromRollout(items, { indexSnapshot: freshSnapshot });
    expect(r.snapshotBehindRollout).toBe(false);
    expect(r.consumedSnapshot).toBe(freshSnapshot);
  });

  test("isUserTurnBoundary excludes tool-result response_items", () => {
    // Codex parity: a role='user' response_item carrying a
    // function_call_output / tool_use_result must NOT count as a
    // user-turn boundary during reverse-scan. We verify this via
    // the thread_rolled_back drop logic, which counts boundaries
    // the same way.
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "real-u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
      // Tool-role (function_call_output analogue): NOT a boundary.
      {
        type: "response_item",
        payload: {
          role: "tool",
          content: "tool result blob",
          toolCallId: "call-1",
          toolName: "shell",
        },
      },
      // Contextual user injection: NOT a boundary.
      {
        type: "response_item",
        payload: {
          role: "user",
          content: "<environment_context>cwd=/tmp</environment_context>",
        },
      },
      { type: "response_item", payload: { role: "user", content: "real-u2" } },
      { type: "response_item", payload: { role: "assistant", content: "a2" } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    // Rollback=1 must drop the real-u2 user turn + everything after
    // it, leaving the two contextual/tool items and real-u1+a1. If
    // isUserTurnBoundary incorrectly counted the contextual message
    // as a boundary, it would have been dropped instead of real-u2.
    const userTexts = r.history
      .filter((h) => h.role === "user")
      .map((h) => h.content);
    expect(userTexts).toContain("real-u1");
    expect(userTexts).not.toContain("real-u2");
    // Contextual injection survives the rollback (proves it wasn't
    // treated as the user-turn boundary target).
    expect(userTexts).toContain(
      "<environment_context>cwd=/tmp</environment_context>",
    );
  });

  test("realtimeActive flows from turn_context into previousTurnSettings", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "1",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t1" } },
        },
      },
      {
        type: "turn_context",
        payload: {
          turnId: "t1",
          cwd: "/tmp",
          approvalPolicy: "never",
          sandboxPolicy: "workspace-write",
          model: "grok-4",
          realtimeActive: true,
        } as unknown as import("./event-log.js").TurnContextItem,
      },
      { type: "response_item", payload: { role: "user", content: "hi" } },
      {
        type: "event_msg",
        payload: {
          id: "2",
          seq: 2,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.previousTurnSettings).toBeDefined();
    expect(r.previousTurnSettings?.model).toBe("grok-4");
    expect(r.previousTurnSettings?.realtimeActive).toBe(true);
  });

  test("legacy compacted (no replacementHistory) rebuilds history via buildCompactedHistory", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "first ask" } },
      {
        type: "response_item",
        payload: { role: "assistant", content: "first answer" },
      },
      { type: "response_item", payload: { role: "user", content: "second ask" } },
      // Legacy compaction: message only, no replacementHistory.
      { type: "compacted", payload: { message: "summary blob" } },
    ];
    const r = reconstructFromRollout(items);
    // buildCompactedHistory must preserve real user messages + a
    // final user-role summary message. The assistant message is
    // dropped because the rebuild seeds only user-message context.
    expect(r.history.every((h) => h.role === "user")).toBe(true);
    const texts = r.history.map((h) => h.content);
    expect(texts).toContain("first ask");
    expect(texts).toContain("second ask");
    expect(texts[texts.length - 1]).toBe("summary blob");
    // Reference context cleared per codex legacy-compaction branch.
    expect(r.referenceContextItem).toBeUndefined();
  });

  test("parseRolloutLine normalizes legacy task_* event aliases before replay", () => {
    const started = parseRolloutLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          id: "legacy-start",
          msg: { type: "task_started", payload: { turnId: "turn-1" } },
        },
      }),
    );
    const completed = parseRolloutLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          id: "legacy-complete",
          msg: { type: "task_complete", payload: { turnId: "turn-1" } },
        },
      }),
    );

    expect(started?.type).toBe("event_msg");
    expect(completed?.type).toBe("event_msg");
    if (started?.type === "event_msg" && completed?.type === "event_msg") {
      expect(started.payload.msg.type).toBe("turn_started");
      expect(completed.payload.msg.type).toBe("turn_complete");
    }
  });

  test("replay truncation caps oversized response_item text", () => {
    const big = "x".repeat(DEFAULT_MAX_TOOL_RESULT_BYTES + 10_000);
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "assistant", content: big } },
    ];
    const r = reconstructFromRollout(items);
    expect(r.history).toHaveLength(1);
    const kept = r.history[0]?.content;
    expect(typeof kept).toBe("string");
    expect((kept as string).length).toBeLessThanOrEqual(
      DEFAULT_MAX_TOOL_RESULT_BYTES,
    );
    expect(kept as string).toContain("[truncated:");
  });

  test("reductionReport surfaces processed count + propagates to result", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
    ];
    const r = reconstructFromRollout(items);
    expect(r.reductionReport).toBeDefined();
    expect(r.reductionReport?.processed).toBe(2);
    expect(r.reductionReport?.unknownVariantCount).toBe(0);
    expect(r.reductionReport?.seqGapCount).toBe(0);
  });

  test("buildCompactedHistory: summary always last, user messages preserved", () => {
    const rebuilt = buildCompactedHistory(["a", "b", "c"], "summary");
    expect(rebuilt).toHaveLength(4);
    expect(rebuilt.map((h) => h.content)).toEqual(["a", "b", "c", "summary"]);
    expect(rebuilt.every((h) => h.role === "user")).toBe(true);
  });

  test("thread_rolled_back drops user turns in forward replay", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
      { type: "response_item", payload: { role: "user", content: "u2" } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 3,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.state.history.length).toBeLessThanOrEqual(2);
  });
});
