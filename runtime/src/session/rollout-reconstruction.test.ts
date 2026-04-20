import { describe, expect, test } from "vitest";
import { reconstructFromRollout } from "./rollout-reconstruction.js";
import type { RolloutItem } from "./rollout-item.js";

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
