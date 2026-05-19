import { describe, expect, it } from "vitest";
import type { RolloutItem } from "../session/rollout-item.js";
import {
  forkSnapshotRollout,
  forkTurnPositionsInRollout,
  truncateRolloutBeforeNthUserMessageFromStart,
  truncateRolloutToLastNForkTurns,
  userMessagePositionsInRollout,
} from "./thread-rollout-truncation.js";

const response = (
  role: "system" | "developer" | "user" | "assistant" | "tool",
  content: string,
  extra: Record<string, unknown> = {},
): RolloutItem => ({
  type: "response_item",
  payload: {
    role,
    content,
    ...extra,
  },
});

const turnStarted = (turnId: string): RolloutItem => ({
  type: "event_msg",
  payload: {
    id: `started-${turnId}`,
    msg: {
      type: "turn_started",
      payload: { turnId },
    },
  },
});

const turnComplete = (turnId: string): RolloutItem => ({
  type: "event_msg",
  payload: {
    id: `complete-${turnId}`,
    msg: {
      type: "turn_complete",
      payload: { turnId },
    },
  },
});

const rollback = (numTurns: number): RolloutItem => ({
  type: "event_msg",
  payload: {
    id: `rollback-${numTurns}`,
    msg: {
      type: "thread_rolled_back",
      payload: { numTurns },
    },
  },
});

describe("thread rollout truncation", () => {
  it("counts real user messages and trigger-turn assistant messages as fork turns", () => {
    const items: RolloutItem[] = [
      response("system", "system"),
      response("user", "turn one"),
      response("assistant", '{"triggerTurn":true}'),
      response("assistant", "final", { phase: "final_answer" }),
      response("user", "<environment_context>ctx</environment_context>"),
      response("user", "turn two"),
    ];

    expect(userMessagePositionsInRollout(items)).toEqual([1, 2, 5]);
    expect(forkTurnPositionsInRollout(items)).toEqual([1, 2, 5]);

    const truncated = truncateRolloutToLastNForkTurns(items, 2);
    expect(
      truncated.map((item) =>
        item.type === "response_item" ? item.payload.content : item.type,
      ),
    ).toEqual([
      '{"triggerTurn":true}',
      "final",
      "<environment_context>ctx</environment_context>",
      "turn two",
    ]);
  });

  it("honors thread rollback events when finding fork turn positions", () => {
    const items: RolloutItem[] = [
      response("user", "turn one"),
      response("assistant", "one", { phase: "final_answer" }),
      response("user", "turn two"),
      response("assistant", "two", { phase: "final_answer" }),
      rollback(1),
      response("user", "replacement two"),
    ];

    expect(userMessagePositionsInRollout(items)).toEqual([0, 5]);
    expect(forkTurnPositionsInRollout(items)).toEqual([0, 5]);
    expect(truncateRolloutBeforeNthUserMessageFromStart(items, 1).at(0))
      .toEqual(items[0]);
  });

  it("appends an interrupted boundary when a snapshot ends mid-turn", () => {
    const items: RolloutItem[] = [
      response("user", "start"),
      turnStarted("turn-1"),
      response("assistant", "working", { phase: "commentary" }),
    ];

    const forked = forkSnapshotRollout(items, { kind: "interrupted" });

    expect(forked.map((item) => item.type)).toEqual([
      "response_item",
      "event_msg",
      "response_item",
      "event_msg",
    ]);
    expect(forked.at(-2)).toMatchObject({
      type: "response_item",
      payload: {
        role: "user",
        content: expect.stringContaining("previous turn was interrupted"),
      },
    });
    expect(forked.at(-1)).toMatchObject({
      type: "event_msg",
      payload: {
        msg: {
          type: "turn_aborted",
          payload: {
            turnId: "turn-1",
            reason: "interrupted",
          },
        },
      },
    });
  });

  it("does not append interrupted metadata after a completed turn", () => {
    const items: RolloutItem[] = [
      response("user", "start"),
      turnStarted("turn-1"),
      response("assistant", "done", { phase: "final_answer" }),
      turnComplete("turn-1"),
    ];

    const forked = forkSnapshotRollout(items, { kind: "interrupted" });

    expect(forked.at(-1)).toEqual(items.at(-1));
    expect(
      forked.some(
        (item) =>
          item.type === "response_item" &&
          String(item.payload.content).includes("previous turn was interrupted"),
      ),
    ).toBe(false);
  });
});
