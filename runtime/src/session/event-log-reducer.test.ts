import { describe, expect, test } from "vitest";
import {
  emptyReducedState,
  reduce,
  reduceAll,
  reduceAllWithEmit,
} from "./event-log-reducer.js";
import { EventLog } from "./event-log.js";
import type { RolloutItem } from "./rollout-item.js";

describe("event-log-reducer (I-26 + I-27)", () => {
  test("reduces response_item into history", () => {
    const { state } = reduceAll([
      {
        type: "response_item",
        payload: { role: "user", content: "hello" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "hi!" },
      },
    ]);
    expect(state.history).toHaveLength(2);
    expect(state.history[0]?.role).toBe("user");
  });

  test("compacted.replacementHistory becomes new base", () => {
    const { state } = reduceAll([
      {
        type: "response_item",
        payload: { role: "user", content: "old" },
      },
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [{ role: "user", content: "summary-turn" }],
        },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "new" },
      },
    ]);
    expect(state.history[0]?.content).toBe("summary-turn");
    expect(state.history[1]?.content).toBe("new");
  });

  test("I-26: unknown rollout type emits warning count, not throw", () => {
    const { state, report } = reduce(emptyReducedState(), {
      type: "future_variant",
      payload: { anything: true },
    } as unknown as RolloutItem);
    expect(state).toEqual(emptyReducedState());
    expect(report.unknownVariantCount).toBe(1);
    expect(report.unknownVariantSamples?.[0]).toBe("future_variant");
  });

  test("I-27: monotonic seq gap detected", () => {
    const { report } = reduceAll([
      {
        type: "event_msg",
        payload: {
          id: "1",
          seq: 1,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
      {
        type: "event_msg",
        payload: {
          id: "2",
          seq: 5,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
    ]);
    expect(report.seqGapCount).toBe(1);
    expect(report.firstSeqGap).toEqual({ expected: 2, actual: 5 });
  });

  test("I-26 unknown shim variant is tolerated + reported", () => {
    const { state, report } = reduceAll([
      {
        type: "unknown",
        payload: { raw: '{"type":"future"}', originalType: "future" },
      } as RolloutItem,
      { type: "response_item", payload: { role: "user", content: "ok" } },
    ]);
    expect(state.history).toHaveLength(1);
    expect(report.unknownVariantCount).toBe(1);
    expect(report.unknownVariantSamples).toContain("future");
  });

  test("reduceAllWithEmit emits I-26 warning + I-27 error events", () => {
    const log = new EventLog();
    const seen: string[] = [];
    log.subscribe((e) => seen.push(`${e.msg.type}:${(e.msg.payload as { cause?: string }).cause}`));
    reduceAllWithEmit(
      [
        {
          type: "unknown",
          payload: { raw: '{"type":"X"}', originalType: "X" },
        } as RolloutItem,
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
            seq: 7, // gap — expected 2
            msg: { type: "warning", payload: { cause: "x", message: "y" } },
          },
        },
      ],
      log,
    );
    expect(seen).toContain("warning:unknown_event_variant");
    expect(seen).toContain("error:event_reordering_detected");
  });

  test("thread_rolled_back drops N user turns from history", () => {
    const { state } = reduceAll([
      {
        type: "response_item",
        payload: { role: "user", content: "u1" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "a1" },
      },
      {
        type: "response_item",
        payload: { role: "user", content: "u2" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "a2" },
      },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ]);
    // u2 + a2 dropped; u1 + a1 remain.
    expect(state.history).toHaveLength(2);
    expect(state.history[0]?.content).toBe("u1");
  });
});
