/**
 * GOAL #4b Stage 1 — reconstruction surfaces resume descriptors.
 *
 * I-48 reconstruction must, for an orphaned `turn_started` carrying a
 * durable `turn_checkpoint`, surface a `ResumableTurn` with build-pin +
 * prefix-hash validation — WITHOUT changing the existing process_killed
 * synthesis (backward compat). Covers: checkpoint detection, prefix-hash
 * mismatch refusal, build-pin refusal, no-checkpoint byte-identical
 * fallback, and dangling-tool surfacing.
 */

import { afterEach, describe, expect, test } from "vitest";
import { reconstructFromRollout } from "./rollout-reconstruction.js";
import type { RolloutItem, ResponseItem } from "./rollout-item.js";
import { resetBuildIdForTestingOnly } from "./durable-turns.js";
import { computeCheckpointPrefixHashV2 } from "./durable-checkpoint-reader.js";
import type {
  ToolPairIntegrityFailure,
  ToolPairOperationalDeferral,
  ToolPairProjection,
  ToolPairProjectionRecord,
  ToolPairProjectionSummary,
} from "./tool-pair-validator.js";

class TestToolPairProjection implements ToolPairProjection {
  private records = new Map<string, ToolPairProjectionRecord>();
  runAtomically<T>(operation: () => T): T { return operation(); }
  reset(): void { this.records.clear(); }
  find(_projectionId: string, callId: string): ToolPairProjectionRecord | undefined {
    return this.records.get(callId);
  }
  insertCall(_projectionId: string, record: ToolPairProjectionRecord): boolean {
    if (this.records.has(record.callId)) return false;
    this.records.set(record.callId, record);
    return true;
  }
  resolveCall(params: {
    readonly callId: string;
    readonly resultIndex: number;
    readonly resultId?: string;
    readonly originalResultDigest?: string;
  }): "resolved" | "already_resolved" | "missing" {
    const record = this.records.get(params.callId);
    if (record === undefined) return "missing";
    if (record.resultIndex !== undefined) return "already_resolved";
    this.records.set(params.callId, { ...record, ...params });
    return "resolved";
  }
  complete(): void {}
  completeDangling(): void {}
  fail(
    _projectionId: string,
    _summary: ToolPairProjectionSummary,
    _failure: ToolPairIntegrityFailure | ToolPairOperationalDeferral,
  ): void {}
}

let projectionOrdinal = 0;

function reconstruct(items: ReadonlyArray<RolloutItem>) {
  projectionOrdinal += 1;
  return reconstructFromRollout(items, {
    checkpointProjection: {
      projection: new TestToolPairProjection(),
      projectionId: `test-projection-${projectionOrdinal}`,
      sourceKey: `test-rollout-${projectionOrdinal}`,
      expectedRunId: "test-run",
    },
  });
}

afterEach(() => {
  delete process.env.AGENC_BUILD_ID;
  resetBuildIdForTestingOnly();
});

function pinBuild(id: string): string {
  process.env.AGENC_BUILD_ID = id;
  resetBuildIdForTestingOnly();
  return id;
}

interface CheckpointArgs {
  readonly turnId: string;
  readonly buildId?: string;
  readonly prefix: ResponseItem[];
  readonly prefixHash?: string; // override to force a mismatch
  readonly iterationIndex?: number;
  readonly checkpointSeq?: number;
  readonly boundary?: "iteration" | "postAssistant";
}

/** Build a started-but-not-terminated turn with a trailing checkpoint. */
function orphanWithCheckpoint(args: CheckpointArgs): RolloutItem[] {
  const items: RolloutItem[] = [
    {
      type: "event_msg",
      payload: {
        id: "ts",
        seq: 1,
        msg: {
          type: "turn_started",
          payload: {
            turnId: args.turnId,
            ...(args.buildId !== undefined ? { buildId: args.buildId } : {}),
          },
        },
      },
    },
  ];
  for (const item of args.prefix) {
    items.push({ type: "response_item", payload: item });
  }
  items.push({
    type: "event_msg",
    payload: {
      id: "cp",
      seq: 2,
      msg: {
        type: "turn_checkpoint",
        payload: {
          turnId: args.turnId,
          iterationIndex: args.iterationIndex ?? 1,
          boundary: args.boundary ?? "iteration",
          checkpointSeq: args.checkpointSeq ?? 1,
          persistedMessageCount: args.prefix.length,
          prefixHash:
            args.prefixHash ??
            computeCheckpointPrefixHashV2(args.prefix, args.prefix.length),
          checkpointVersion: 2,
          toolResultIntegrityVersion: 1,
          resumableState: {
            turnCount: 2,
            recoveryReentryCount: 1,
            maxOutputTokensRecoveryCount: 0,
            continuationNudgeCount: 0,
            stopHookBlockingCount: 0,
            taskBudgetRemaining: 4242,
          },
        },
      },
    },
  });
  return items;
}

describe("reconstruction durable resume descriptors", () => {
  test("orphan + valid checkpoint + matching build → resumable, gates pass", () => {
    const buildId = pinBuild("build-A");
    const prefix: ResponseItem[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "on it" },
    ];
    const r = reconstruct(
      orphanWithCheckpoint({ turnId: "t1", buildId, prefix }),
    );
    expect(r.orphanedTurnIds).toContain("t1");
    expect(r.resumableTurns).toHaveLength(1);
    const rt = r.resumableTurns[0]!;
    expect(rt.turnId).toBe("t1");
    expect(rt.buildMatches).toBe(true);
    expect(rt.historyPrefixValid).toBe(true);
    expect(rt.lastCheckpoint.resumableState.recoveryReentryCount).toBe(1);
    expect(rt.lastCheckpoint.resumableState.taskBudgetRemaining).toBe(4242);
    // Backward compat: the process_killed synthesis is STILL emitted.
    const synthTypes = r.synthesizedEvents.map((ev) =>
      ev.type === "event_msg" ? ev.payload.msg.type : ev.type,
    );
    expect(synthTypes).toContain("turn_aborted");
  });

  test("prefix-hash mismatch → historyPrefixValid=false (refuses silent resume)", () => {
    const buildId = pinBuild("build-A");
    const prefix: ResponseItem[] = [{ role: "user", content: "original" }];
    const r = reconstruct(
      orphanWithCheckpoint({
        turnId: "t1",
        buildId,
        prefix,
        prefixHash: "d".repeat(64),
      }),
    );
    expect(r.resumableTurns).toHaveLength(1);
    expect(r.resumableTurns[0]!.historyPrefixValid).toBe(false);
  });

  test("build-pin mismatch → buildMatches=false (refuses cross-build resume)", () => {
    pinBuild("build-CURRENT");
    const prefix: ResponseItem[] = [{ role: "user", content: "x" }];
    const r = reconstruct(
      orphanWithCheckpoint({ turnId: "t1", buildId: "build-OLD", prefix }),
    );
    expect(r.resumableTurns).toHaveLength(1);
    expect(r.resumableTurns[0]!.buildMatches).toBe(false);
    expect(r.resumableTurns[0]!.buildId).toBe("build-OLD");
  });

  test("no-checkpoint orphan → byte-identical to today (no descriptor, still process_killed)", () => {
    pinBuild("build-A");
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "ts",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t-orphan" } },
        },
      },
      { type: "response_item", payload: { role: "user", content: "mid-turn" } },
    ];
    const r = reconstruct(items);
    expect(r.orphanedTurnIds).toContain("t-orphan");
    expect(r.resumableTurns).toHaveLength(0);
    const synthTypes = r.synthesizedEvents.map((ev) =>
      ev.type === "event_msg" ? ev.payload.msg.type : ev.type,
    );
    expect(synthTypes).toContain("turn_aborted");
    expect(synthTypes).toContain("warning");
  });

  test("dangling tool_use in the checkpoint prefix is surfaced", () => {
    const buildId = pinBuild("build-A");
    const prefix: ResponseItem[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "danger-1", name: "send", arguments: "{}" }],
      },
    ];
    const r = reconstruct(
      orphanWithCheckpoint({
        turnId: "t1",
        buildId,
        prefix,
        boundary: "postAssistant",
      }),
    );
    expect(r.resumableTurns[0]!.danglingToolUses).toEqual([
      { callId: "danger-1", toolName: "send" },
    ]);
  });

  test("highest checkpointSeq wins when a turn has multiple checkpoints", () => {
    const buildId = pinBuild("build-A");
    const prefix1: ResponseItem[] = [{ role: "user", content: "a" }];
    const prefix2: ResponseItem[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "ts",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t1", buildId } },
        },
      },
      { type: "response_item", payload: prefix1[0]! },
      {
        type: "event_msg",
        payload: {
          id: "cp1",
          seq: 2,
          msg: {
            type: "turn_checkpoint",
            payload: {
              turnId: "t1",
              iterationIndex: 1,
              boundary: "iteration",
              checkpointSeq: 1,
              persistedMessageCount: 1,
              prefixHash: computeCheckpointPrefixHashV2(prefix1, 1),
              checkpointVersion: 2,
              toolResultIntegrityVersion: 1,
              resumableState: {
                turnCount: 2,
                recoveryReentryCount: 0,
                maxOutputTokensRecoveryCount: 0,
                continuationNudgeCount: 0,
                stopHookBlockingCount: 0,
              },
            },
          },
        },
      },
      { type: "response_item", payload: prefix2[1]! },
      {
        type: "event_msg",
        payload: {
          id: "cp2",
          seq: 3,
          msg: {
            type: "turn_checkpoint",
            payload: {
              turnId: "t1",
              iterationIndex: 2,
              boundary: "iteration",
              checkpointSeq: 2,
              persistedMessageCount: 2,
              prefixHash: computeCheckpointPrefixHashV2(prefix2, 2),
              checkpointVersion: 2,
              toolResultIntegrityVersion: 1,
              resumableState: {
                turnCount: 3,
                recoveryReentryCount: 0,
                maxOutputTokensRecoveryCount: 0,
                continuationNudgeCount: 0,
                stopHookBlockingCount: 0,
              },
            },
          },
        },
      },
    ];
    const r = reconstruct(items);
    expect(r.resumableTurns).toHaveLength(1);
    expect(r.resumableTurns[0]!.lastCheckpoint.checkpointSeq).toBe(2);
    expect(r.resumableTurns[0]!.lastCheckpoint.iterationIndex).toBe(2);
    expect(r.resumableTurns[0]!.historyPrefixValid).toBe(true);
  });
});
