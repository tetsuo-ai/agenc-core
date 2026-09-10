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
import {
  computeCheckpointPrefixHashV2,
  computeCheckpointPrefixHashV3,
} from "./durable-checkpoint-reader.js";
import type {
  TurnCheckpointV2Event,
  TurnCheckpointV4Event,
} from "./event-log.js";
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
  readonly checkpointVersion?: 2 | 4;
  readonly iterationIndex?: number;
  readonly checkpointSeq?: number;
  readonly boundary?: "iteration" | "postAssistant";
}

/** Build a started-but-not-terminated turn with a trailing checkpoint. */
function orphanWithCheckpoint(args: CheckpointArgs): RolloutItem[] {
  const checkpointVersion = args.checkpointVersion ?? 2;
  const commonCheckpoint = {
    turnId: args.turnId,
    iterationIndex: args.iterationIndex ?? 1,
    boundary: args.boundary ?? "iteration",
    checkpointSeq: args.checkpointSeq ?? 1,
    persistedMessageCount: args.prefix.length,
    prefixHash:
      args.prefixHash ??
      (checkpointVersion === 4
        ? computeCheckpointPrefixHashV3(args.prefix, args.prefix.length)
        : computeCheckpointPrefixHashV2(args.prefix, args.prefix.length)),
    toolResultIntegrityVersion: 1,
    resumableState: {
      turnCount: 2,
      recoveryReentryCount: 1,
      maxOutputTokensRecoveryCount: 0,
      continuationNudgeCount: 0,
      stopHookBlockingCount: 0,
      taskBudgetRemaining: 4242,
    },
  } as const;
  const checkpoint: TurnCheckpointV2Event | TurnCheckpointV4Event =
    checkpointVersion === 4
      ? {
          ...commonCheckpoint,
          checkpointVersion: 4,
          prefixHashVersion: 3,
        }
      : {
          ...commonCheckpoint,
          checkpointVersion: 2,
        };
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
        payload: checkpoint,
      },
    },
  });
  return items;
}

describe("reconstruction durable resume descriptors", () => {
  const legacyStops: ReadonlyArray<{ readonly name: string; readonly item: RolloutItem }> = [
    {
      name: "interrupted turn",
      item: { type: "event_msg", payload: { id: "legacy-stop", msg: { type: "turn_aborted", payload: { turnId: "other-turn", reason: "interrupted" } } } },
    },
    {
      name: "unscoped interruption",
      item: { type: "event_msg", payload: { id: "legacy-stop", msg: { type: "turn_aborted", payload: { reason: "interrupted" } } } },
    },
    {
      name: "owner resolver denial",
      item: { type: "event_msg", payload: { id: "legacy-stop", msg: { type: "permission_decision", payload: {
        runId: "test-run", callId: "denied-call", toolName: "exec_command", turnId: "other-turn", requestEventId: "approval-request", requestEventSeq: 2,
        decision: "denied", source: "resolver", recordedAt: "2026-09-10T00:00:00.000Z",
      } } } },
    },
  ];

  test.each(legacyStops)("legacy $name invalidates an older orphan without a userStop slot", ({ item }) => {
    const buildId = pinBuild("build-legacy-stop");
    const items = orphanWithCheckpoint({ turnId: "older-orphan", buildId, prefix: [{ role: "user", content: "Old instructions" }] });
    items.push(item);
    expect(reconstruct(items).resumableTurns).toEqual([]);
  });

  test.each(legacyStops)("legacy $name blocks a later orphan until human admission", ({ item }) => {
    const buildId = pinBuild("build-legacy-stop");
    const items = [item, ...orphanWithCheckpoint({ turnId: "automatic-followup", buildId, prefix: [{ role: "user", content: "Child receipt" }] })];
    expect(reconstruct(items).resumableTurns).toEqual([]);
  });

  test.each(legacyStops)("legacy $name permits a new human turn without reviving earlier work", ({ item }) => {
    const buildId = pinBuild("build-legacy-stop");
    const items = orphanWithCheckpoint({ turnId: "older-orphan", buildId, prefix: [] });
    items.push(item, { type: "event_msg", payload: { id: "human-admission", msg: { type: "user_message", payload: {
      message: "New instructions", messageId: "human-message", acceptedAt: "2026-09-10T00:01:00.000Z",
    } } } });
    items.push(...orphanWithCheckpoint({ turnId: "new-human-turn", buildId, prefix: [{ role: "user", content: "New instructions" }] }));
    expect(reconstruct(items).resumableTurns.map(turn => turn.turnId)).toEqual(["new-human-turn"]);
  });

  test("an explicit stop blocks post-stop checkpoints until the durable clear", () => {
    const buildId = pinBuild("build-explicit-stop");
    const items: RolloutItem[] = [
      { type: "session_state", payload: { userStop: { stopped: true, generation: 1 } } },
      { type: "event_msg", payload: { id: "unadmitted-human", msg: { type: "user_message", payload: {
        message: "Unadmitted instructions", messageId: "failed-human-message", acceptedAt: "2026-09-10T00:01:00.000Z",
      } } } },
      ...orphanWithCheckpoint({ turnId: "unadmitted-turn", buildId, prefix: [] }),
    ];
    expect(reconstruct(items).resumableTurns).toEqual([]);
    items.push({ type: "session_state", payload: { userStop: { stopped: false, generation: 1 } } });
    items.push(...orphanWithCheckpoint({ turnId: "new-human-turn", buildId, prefix: [] }));
    expect(reconstruct(items).resumableTurns.map(turn => turn.turnId)).toEqual(["new-human-turn"]);
  });

  test("a foreign resolver denial does not hold this session's unrelated orphan", () => {
    const buildId = pinBuild("build-foreign-denial");
    const items = orphanWithCheckpoint({ turnId: "owner-orphan", buildId, prefix: [] });
    items.push({ type: "event_msg", payload: { id: "foreign-denial", msg: { type: "permission_decision", payload: {
      runId: "foreign-run", callId: "foreign-call", toolName: "exec_command", turnId: "foreign-turn", requestEventId: "approval-request", requestEventSeq: 2,
      decision: "denied", source: "resolver", recordedAt: "2026-09-10T00:00:00.000Z",
    } } } });
    expect(reconstruct(items).resumableTurns.map(turn => turn.turnId)).toEqual(["owner-orphan"]);
  });

  test("a human turn started before its durable release can resume a checkpoint written after release", () => {
    const buildId = pinBuild("build-human-release");
    const [started, ...admittedTurn] = orphanWithCheckpoint({ turnId: "human-turn", buildId, prefix: [{ role: "user", content: "New instructions" }] });
    const items: RolloutItem[] = [
      { type: "session_state", payload: { userStop: { stopped: true, generation: 1 } } },
      started!,
      { type: "session_state", payload: { userStop: { stopped: false, generation: 1 } } },
      ...admittedTurn,
    ];
    expect(reconstruct(items).resumableTurns).toEqual([expect.objectContaining({
      turnId: "human-turn", buildMatches: true, historyPrefixValid: true,
    })]);
  });

  test.each([false, true])("an owner stop invalidates its existing turn even after later human release (%s)", (clearStop) => {
    const buildId = pinBuild("build-owner-stop");
    const items = orphanWithCheckpoint({ turnId: "before-stop", buildId, prefix: [{ role: "user", content: "Inspect with a child" }] });
    items.push({ type: "session_state", payload: { userStop: { stopped: true, generation: 1 } } });
    if (clearStop) {
      items.push({ type: "session_state", payload: { userStop: { stopped: false, generation: 1 } } });
      const laterCheckpoint = orphanWithCheckpoint({ turnId: "before-stop", buildId, prefix: [{ role: "user", content: "Inspect with a child" }], checkpointSeq: 2 }).at(-1)!;
      items.push(laterCheckpoint);
    }
    const reconstruction = reconstruct(items);
    expect(reconstruction.resumableTurns).toEqual([]);
    expect(reconstruction.orphanedTurnIds).toEqual(["before-stop"]);
  });

  test("a distinct human turn after release can resume without reviving the denied turn", () => {
    const buildId = pinBuild("build-owner-stop");
    const items = orphanWithCheckpoint({ turnId: "before-stop", buildId, prefix: [{ role: "user", content: "Old instructions" }] });
    items.push({ type: "session_state", payload: { userStop: { stopped: true, generation: 1 } } });
    items.push({ type: "session_state", payload: { userStop: { stopped: false, generation: 1 } } });
    const resumedItems = orphanWithCheckpoint({ turnId: "after-stop", buildId, prefix: [
      { role: "user", content: "Old instructions" },
      { role: "user", content: "New instructions" },
    ] });
    items.push(...resumedItems.filter((item) => item.type !== "response_item" || item.payload.content !== "Old instructions"));
    const reconstruction = reconstruct(items);
    expect(reconstruction.resumableTurns.map((turn) => turn.turnId)).toEqual(["after-stop"]);
    expect(reconstruction.resumableTurns[0]).toMatchObject({ buildMatches: true, historyPrefixValid: true });
    expect(reconstruction.orphanedTurnIds).toEqual(expect.arrayContaining(["before-stop", "after-stop"]));
  });

  test("does not resume a checkpoint after a durable resolver denial without a terminal", () => {
    const buildId = pinBuild("build-denied");
    const items = orphanWithCheckpoint({ turnId: "denied-turn", buildId, prefix: [{ role: "user", content: "Run the command" }] });
    items.push({ type: "event_msg", payload: { id: "denied-decision", seq: 3, msg: { type: "permission_decision", payload: {
      runId: "test-run", callId: "denied-call", toolName: "exec_command", turnId: "denied-turn", requestEventId: "approval-request", requestEventSeq: 2,
      decision: "denied", source: "resolver", recordedAt: new Date().toISOString(),
    } } } });
    const reconstruction = reconstruct(items);
    expect(reconstruction.resumableTurns).toEqual([]);
    expect(reconstruction.orphanedTurnIds).toEqual(["denied-turn"]);
  });

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

  test("checkpoint v4 authenticates marker-bearing compaction history", () => {
    const buildId = pinBuild("build-A");
    const summarySha256 = "a".repeat(64);
    const prefix: ResponseItem[] = [
      {
        role: "developer",
        content: "compaction boundary",
        compactionHistory: {
          version: 1,
          kind: "boundary",
          attempt_id: "compact-attempt",
          summary_sha256: summarySha256,
        },
      },
      {
        role: "user",
        content: "compaction summary",
        compactionHistory: {
          version: 1,
          kind: "summary",
          attempt_id: "compact-attempt",
          summary_sha256: summarySha256,
        },
      },
      { role: "user", content: "continue after compaction" },
    ];

    const r = reconstruct(
      orphanWithCheckpoint({
        turnId: "t-v4",
        buildId,
        prefix,
        checkpointVersion: 4,
      }),
    );

    expect(r.resumableTurns).toHaveLength(1);
    expect(r.resumableTurns[0]).toMatchObject({
      turnId: "t-v4",
      buildMatches: true,
      historyPrefixValid: true,
      checkpointIntegrityStatus: "valid",
    });
  });

  test("checkpoint v4 rejects tampered compaction-history metadata", () => {
    const buildId = pinBuild("build-A");
    const summarySha256 = "b".repeat(64);
    const authenticatedPrefix: ResponseItem[] = [
      {
        role: "developer",
        content: "compaction boundary",
        compactionHistory: {
          version: 1,
          kind: "boundary",
          attempt_id: "compact-attempt",
          summary_sha256: summarySha256,
        },
      },
      {
        role: "user",
        content: "compaction summary",
        compactionHistory: {
          version: 1,
          kind: "summary",
          attempt_id: "compact-attempt",
          summary_sha256: summarySha256,
        },
      },
    ];
    const authenticatedHash = computeCheckpointPrefixHashV3(
      authenticatedPrefix,
      authenticatedPrefix.length,
    );
    const tamperedPrefix: ResponseItem[] = authenticatedPrefix.map(
      (message, index) =>
        index === 0 && message.compactionHistory !== undefined
          ? {
              ...message,
              compactionHistory: {
                ...message.compactionHistory,
                attempt_id: "tampered-attempt",
              },
            }
          : message,
    );

    const r = reconstruct(
      orphanWithCheckpoint({
        turnId: "t-v4-tampered",
        buildId,
        prefix: tamperedPrefix,
        prefixHash: authenticatedHash,
        checkpointVersion: 4,
      }),
    );

    expect(r.resumableTurns).toHaveLength(1);
    expect(r.resumableTurns[0]).toMatchObject({
      turnId: "t-v4-tampered",
      buildMatches: true,
      historyPrefixValid: false,
      checkpointIntegrityStatus: "invalid",
      checkpointIntegrityReason:
        "checkpoint prefix digest does not match persisted history",
      danglingToolUses: [],
    });
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

  test("failed turns are not recovered as process-killed orphans", () => {
    const items: RolloutItem[] = [
      { type: "event_msg", payload: { id: "start", seq: 1, msg: { type: "turn_started", payload: { turnId: "failed-turn" } } } },
      { type: "event_msg", payload: { id: "failure", seq: 2, msg: { type: "turn_failed", payload: { turnId: "failed-turn", code: "provider_error", message: "failed" } } } },
    ];
    const result = reconstruct(items);
    expect(result.orphanedTurnIds).toEqual([]);
    expect(result.resumableTurns).toEqual([]);
    expect(result.synthesizedEvents).toEqual([]);
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
