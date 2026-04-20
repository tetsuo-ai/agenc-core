import { describe, expect, test } from "vitest";
import { reconstructFromRollout } from "./rollout-reconstruction.js";
import type { RolloutItem } from "./rollout-item.js";
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
