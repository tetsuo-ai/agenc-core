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

import { afterEach, describe, expect, test, vi } from "vitest";
import { reconstructFromRollout } from "./rollout-reconstruction.js";
import { ConversationThreadManager, interruptedToolCallResultContent, resumeTurnFromCheckpoint } from "../conversation/thread-manager.js";
import type { Session, SessionState } from "./session.js";
import { AsyncLock } from "../utils/async-lock.js";
import type { RolloutItem, ResponseItem } from "./rollout-item.js";
import { createToolResultIntegrity } from "./tool-result-integrity.js";
import { resetBuildIdForTestingOnly } from "./durable-turns.js";
import { createOperatorEffectReviewResolution } from "../state/effect-review.js";
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

function checkpointWithEffectEvents(args: {
  readonly turnId: string;
  readonly buildId: string;
  readonly userContent: string;
  readonly callId: string;
  readonly toolName: string;
  readonly stepId: string;
  readonly intentId: string;
  readonly outcomeId: string;
  readonly outcome: "succeeded" | "unknown_outcome";
}): RolloutItem[] {
  const prefix: ResponseItem[] = [
    { role: "user", content: args.userContent },
    { role: "assistant", content: "", toolCalls: [
      { id: args.callId, name: args.toolName, arguments: "{}" },
    ] },
  ];
  const items = orphanWithCheckpoint({ turnId: args.turnId, buildId: args.buildId, prefix,
    checkpointVersion: 4, boundary: "postAssistant" });
  items.push({ type: "event_msg", payload: { id: args.intentId, seq: 3, msg: {
    type: "effect_intent", payload: { formatVersion: 2, minimumReaderRuntime: "0.14.0",
      runId: "test-run", stepId: args.stepId, callId: args.callId,
      toolName: args.toolName, recoveryCategory: "side-effecting", intentDigest: "intent",
      attempt: 1, recordedAt: "2026-09-01T00:00:00.000Z" },
  } } });
  if (args.outcome === "succeeded") {
    items.push({ type: "event_msg", payload: { id: args.outcomeId, seq: 4, msg: {
      type: "effect_result", payload: { formatVersion: 2, minimumReaderRuntime: "0.14.0",
        runId: "test-run", stepId: args.stepId, callId: args.callId,
        toolName: args.toolName, recoveryCategory: "side-effecting", intentEventSeq: 3,
        outcome: "succeeded", effectBoundary: "crossed", recordedAt: "2026-09-01T00:00:01.000Z" },
    } } });
  } else {
    items.push({ type: "event_msg", payload: { id: args.outcomeId, seq: 4, msg: {
      type: "effect_unknown_outcome", payload: { formatVersion: 2, minimumReaderRuntime: "0.14.0",
        runId: "test-run", stepId: args.stepId, callId: args.callId,
        toolName: args.toolName, recoveryCategory: "side-effecting", intentEventSeq: 3,
        outcome: "unknown_outcome", reason: "acknowledgement_lost", requiresReview: true,
        recordedAt: "2026-09-01T00:00:01.000Z" },
    } } });
  }
  return items;
}

describe("reconstruction durable resume descriptors", () => {
  test("a placeholder persisted by an older bootstrap never settles a checkpointed effect", async () => {
    const runId = "legacy-placeholder-run";
    const buildId = pinBuild("legacy-placeholder-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Write" },
      { role: "assistant", content: "", toolCalls: [
        { id: "legacy-write", name: "Write", arguments: "{}" },
      ] },
    ];
    const items = orphanWithCheckpoint({ turnId: "legacy-placeholder", buildId,
      prefix, checkpointVersion: 4, boundary: "postAssistant" });
    const content = interruptedToolCallResultContent({ id: "legacy-write", name: "Write" });
    items.push({ type: "response_item", payload: { role: "tool", content,
      toolCallId: "legacy-write", toolName: "Write",
      toolResultIntegrity: createToolResultIntegrity({ runId,
        toolCallId: "legacy-write", content }) } });
    items.push({ type: "event_msg", payload: { id: "process-killed", seq: 3,
      msg: { type: "turn_aborted", payload: {
        turnId: "legacy-placeholder", reason: "process_killed",
      } } } });
    const runTurn = vi.fn(async function* () {});
    const session = { conversationId: runId,
      config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Write", recoveryCategory: "side-effecting" }] } },
      rolloutStore: { rootHasOnlyTerminalDescendants: () => true, readAll: () => items, checkpointProjectionContext: (purpose: string) => ({
        projection: new TestToolPairProjection(), projectionId: purpose,
        sourceKey: "legacy-placeholder-rollout", expectedRunId: runId,
      }) },
      runTurn, emit: vi.fn(), nextInternalSubId: () => "legacy-placeholder-warning",
    } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, reconstruct(items)))
      .resolves.toMatchObject({ resumed: false, reason: "integrity-deferred" });
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("bootstrap reconciles acknowledged effects before pairing and preserves unknown calls", async () => {
    const runId = "bootstrap-effect-run";
    const buildId = pinBuild("bootstrap-effect-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Write two files" },
      { role: "assistant", content: "", toolCalls: [
        { id: "ack-write", name: "Write", arguments: "{}" },
        { id: "unknown-write", name: "Write", arguments: "{}" },
      ] },
    ];
    const items = orphanWithCheckpoint({ turnId: "bootstrap-effect", buildId, prefix,
      checkpointVersion: 4, boundary: "postAssistant" });
    items.push({ type: "event_msg", payload: { id: "intent", seq: 3, msg: {
      type: "effect_intent", payload: { formatVersion: 2, minimumReaderRuntime: "0.14.0",
        runId, stepId: "tool:bootstrap-effect:ack", callId: "ack-write", toolName: "Write",
        recoveryCategory: "side-effecting", intentDigest: "intent", attempt: 1,
        recordedAt: "2026-09-01T00:00:00.000Z" },
    } } });
    items.push({ type: "event_msg", payload: { id: "ack", seq: 4, msg: {
      type: "effect_result", payload: { formatVersion: 2, minimumReaderRuntime: "0.14.0",
        runId, stepId: "tool:bootstrap-effect:ack", callId: "ack-write", toolName: "Write",
        recoveryCategory: "side-effecting", intentEventSeq: 3, outcome: "succeeded",
        effectBoundary: "crossed", recordedAt: "2026-09-01T00:00:01.000Z" },
    } } });
    const state = new AsyncLock<SessionState>({
      sessionConfiguration: { cwd: "/tmp" } as SessionState["sessionConfiguration"], history: [],
    });
    const store = { rootHasOnlyTerminalDescendants: () => true, appendRollout: (item: RolloutItem) => { items.push(item); },
      checkpointProjectionContext: (purpose: string) => ({
        projection: new TestToolPairProjection(), projectionId: purpose,
        sourceKey: "bootstrap-effect-rollout", expectedRunId: runId,
      }),
      recordProjectionFailure: vi.fn(), acknowledgeCompactionReconstruction: vi.fn() };
    const session = { conversationId: runId, state, rolloutStore: store,
      restoreUserStopFromRollout: vi.fn(), seedInternalSubId: vi.fn(),
      nextInternalSubId: () => "bootstrap-warning", emit: vi.fn(),
      agentStatus: { value: { status: "pending_init" }, subscribe: () => vi.fn() },
    } as unknown as Session;
    // This is the same replay entry point used by bootstrapLocalRuntimeSession.
    const replay = await new ConversationThreadManager().replayRolloutIntoSession(session, items);
    const toolResults = replay.appliedState.history.filter((item) => item.role === "tool");
    expect(toolResults).toEqual([expect.objectContaining({
      toolCallId: "ack-write", content: expect.stringContaining("finished before restart"),
    })]);
    expect(JSON.stringify(items)).not.toContain("call it again");
    const current = reconstructFromRollout(items, { checkpointProjection: store.checkpointProjectionContext("after-bootstrap") });
    expect(current.resumableTurns[0]?.danglingToolUses).toEqual([
      expect.objectContaining({ callId: "unknown-write" }),
    ]);
  });
  test("two bootstrap replays keep a reviewed checkpoint's pairing free of retry placeholders", async () => {
    const runId = "two-bootstrap-review";
    const turnId = "two-bootstrap-turn";
    const buildId = pinBuild("two-bootstrap-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Write file" },
      { role: "assistant", content: "", toolCalls: [
        { id: "pending-write", name: "Write", arguments: "{}" },
      ] },
    ];
    const items = orphanWithCheckpoint({ turnId, buildId, prefix,
      checkpointVersion: 4, boundary: "postAssistant" });
    items.push({ type: "event_msg", payload: { id: "pending-intent", seq: 3,
      msg: { type: "effect_intent", payload: { formatVersion: 2,
        minimumReaderRuntime: "0.14.0", runId, stepId: "tool:two-bootstrap:write",
        callId: "pending-write", toolName: "Write", recoveryCategory: "side-effecting",
        intentDigest: "intent", attempt: 1, recordedAt: "2026-09-01T00:00:00.000Z" } } } });
    items.push({ type: "event_msg", payload: { id: "pending-unknown", seq: 4,
      msg: { type: "effect_unknown_outcome", payload: { formatVersion: 2,
        minimumReaderRuntime: "0.14.0", runId, stepId: "tool:two-bootstrap:write",
        callId: "pending-write", toolName: "Write", recoveryCategory: "side-effecting",
        intentEventSeq: 3, outcome: "unknown_outcome", reason: "acknowledgement_lost",
        requiresReview: true, recordedAt: "2026-09-01T00:00:01.000Z" } } } });
    const state = new AsyncLock<SessionState>({
      sessionConfiguration: { cwd: "/tmp" } as SessionState["sessionConfiguration"], history: [],
    });
    const store = { rootHasOnlyTerminalDescendants: () => true, readAll: () => items,
      appendRollout: (item: RolloutItem) => { items.push(item); },
      checkpointProjectionContext: (purpose: string) => ({
        projection: new TestToolPairProjection(), projectionId: purpose,
        sourceKey: "two-bootstrap-rollout", expectedRunId: runId,
      }),
      recordProjectionFailure: vi.fn(), acknowledgeCompactionReconstruction: vi.fn() };
    const runTurn = vi.fn(async function* () {});
    const session = { conversationId: runId, state, rolloutStore: store,
      config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Write", recoveryCategory: "side-effecting" }] } },
      runTurn, restoreUserStopFromRollout: vi.fn(), seedInternalSubId: vi.fn(),
      nextInternalSubId: () => "two-bootstrap-warning", emit: vi.fn(),
      agentStatus: { value: { status: "pending_init" }, subscribe: () => vi.fn() },
    } as unknown as Session;
    const manager = new ConversationThreadManager();
    await manager.replayRolloutIntoSession(session, items);
    items.push({ type: "event_msg", payload: { id: "synthetic-kill", seq: 5,
      msg: { type: "turn_aborted", payload: { turnId, reason: "process_killed" } } } });
    await manager.replayRolloutIntoSession(session, items);
    expect(JSON.stringify(items)).not.toContain("call it again");
    const resolution = createOperatorEffectReviewResolution({
      disposition: "confirmed_no_effect", actorId: "operator",
      evidenceRef: "test:checked", evidenceSha256: "a".repeat(64),
      reviewedAt: "2026-09-01T00:00:02.000Z",
    });
    items.push({ type: "event_msg", payload: { id: "reviewed", seq: 6,
      msg: { type: "effect_review_resolved", payload: { runId,
        stepId: "tool:two-bootstrap:write", callId: "pending-write", resolution,
        reviewedAt: "2026-09-01T00:00:02.000Z" } } } });
    const reconstruction = reconstructFromRollout(items.filter((item) =>
      !(item.type === "event_msg" && item.payload.msg.type === "turn_aborted" &&
        item.payload.msg.payload.reason === "process_killed")), {
      checkpointProjection: store.checkpointProjectionContext("after-review"),
    });
    expect(reconstruction.resumableTurns[0]?.reconciledToolResults).toEqual([
      expect.objectContaining({ toolCallId: "pending-write",
        content: expect.stringContaining("Operator review resolved") }),
    ]);
    expect(await resumeTurnFromCheckpoint(session, reconstruction)).toMatchObject({ resumed: true });
    expect(runTurn).toHaveBeenCalledOnce();
  });
  test("the same turn remains eligible after a second restart", () => {
    const buildId = pinBuild("two-restart-build");
    const items = orphanWithCheckpoint({ turnId: "same-turn", buildId,
      prefix: [{ role: "user", content: "Finish this" }], checkpointVersion: 4 });
    items.push({ type: "event_msg", payload: { id: "first-shutdown", msg: {
      type: "turn_aborted", payload: { turnId: "same-turn", reason: "daemon_shutdown" },
    } } });
    expect(reconstruct(items).resumableTurns.map((turn) => turn.turnId)).toEqual(["same-turn"]);
    items.push({ type: "event_msg", payload: { id: "continuation-start", msg: {
      type: "turn_started", payload: { turnId: "same-turn", buildId },
    } } });
    items.push({ type: "event_msg", payload: { id: "continuation-checkpoint", msg: {
      type: "turn_checkpoint", payload: {
        turnId: "same-turn", iterationIndex: 2, boundary: "iteration",
        checkpointSeq: 2, persistedMessageCount: 1,
        prefixHash: computeCheckpointPrefixHashV3([{ role: "user", content: "Finish this" }], 1),
        checkpointVersion: 4, toolResultIntegrityVersion: 1, prefixHashVersion: 3,
        resumableState: { turnCount: 2, recoveryReentryCount: 0,
          maxOutputTokensRecoveryCount: 0, continuationNudgeCount: 0,
          stopHookBlockingCount: 0, modelSampleOrdinal: 2 },
      },
    } } });
    items.push({ type: "event_msg", payload: { id: "second-shutdown", msg: {
      type: "turn_aborted", payload: { turnId: "same-turn", reason: "daemon_shutdown" },
    } } });
    expect(reconstruct(items).resumableTurns).toEqual([expect.objectContaining({
      turnId: "same-turn", lastCheckpoint: expect.objectContaining({ checkpointSeq: 2 }),
    })]);
  });

  test("durable effect completion pairs a checkpointed call without a response item", async () => {
    const buildId = pinBuild("effect-only-build");
    const items = checkpointWithEffectEvents({ turnId: "effect-only", buildId,
      userContent: "Write the file", callId: "write-effect", toolName: "Write",
      stepId: "tool:effect-only:write", intentId: "intent", outcomeId: "effect",
      outcome: "succeeded" });
    const reconstructed = reconstruct(items);
    expect(reconstructed.resumableTurns[0]?.danglingToolUses).toEqual([]);
    expect(reconstructed.resumableTurns[0]?.reconciledToolResults).toContainEqual(expect.objectContaining({
      role: "tool", toolCallId: "write-effect", toolName: "Write",
    }));
    const runTurn = vi.fn(async function* () {});
    const appendRollout = vi.fn();
    const session = { config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Write", recoveryCategory: "side-effecting" }] } },
      rolloutStore: { rootHasOnlyTerminalDescendants: () => true, appendRollout }, runTurn, emit: vi.fn(),
      nextInternalSubId: () => "warning-effect-only" } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, reconstructed)).resolves.toMatchObject({ resumed: true });
    expect(appendRollout).toHaveBeenCalledWith(expect.objectContaining({
      type: "response_item", payload: expect.objectContaining({ toolCallId: "write-effect" }),
    }), { durable: true });
    expect(runTurn).toHaveBeenCalledWith("", expect.objectContaining({
      history: expect.arrayContaining([expect.objectContaining({ toolCallId: "write-effect" })]),
    }));
  });

  test("a persisted recovery pairing survives a crash before the next checkpoint", async () => {
    const buildId = pinBuild("pairing-crash-build");
    const items = checkpointWithEffectEvents({ turnId: "pairing-crash", buildId,
      userContent: "Write the file", callId: "crash-write", toolName: "Write",
      stepId: "tool:pairing-crash:write", intentId: "intent", outcomeId: "effect",
      outcome: "succeeded" });
    items.push({ type: "event_msg", payload: { id: "shutdown", seq: 5, msg: {
      type: "turn_aborted", payload: { turnId: "pairing-crash", reason: "daemon_shutdown" },
    } } });
    const staleBeforePairing = reconstruct(items);
    const first = staleBeforePairing.resumableTurns[0]!;
    expect(first.reconciledToolResults).toHaveLength(1);
    const firstSession = { config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Write", recoveryCategory: "side-effecting" }] } },
      rolloutStore: { rootHasOnlyTerminalDescendants: () => true, readAll: () => items,
        checkpointProjectionContext: () => ({ projection: new TestToolPairProjection(),
          projectionId: "pairing-crash-first", sourceKey: "pairing-crash-source",
          expectedRunId: "test-run" }),
        liveToolCallResolved: () => false,
        appendRollout: (item: RolloutItem) => { items.push(item); } },
      runTurn: vi.fn(async function* () { throw new Error("crash after pairing fsync"); }),
      emit: vi.fn(), nextInternalSubId: () => "pairing-crash-warning" } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(firstSession, reconstruct(items)))
      .rejects.toThrow("crash after pairing fsync");
    expect(items.filter((item) => item.type === "response_item" &&
      item.payload.role === "tool" && item.payload.toolCallId === "crash-write"))
      .toHaveLength(1);
    const second = reconstruct(items);
    expect(second.resumableTurns[0]?.reconciledToolResults ?? []).toEqual([]);
    expect(second.resumableTurns[0]?.danglingToolUses).toEqual([]);
    const appendRollout = vi.fn();
    const session = { config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Write", recoveryCategory: "side-effecting" }] } },
      rolloutStore: { rootHasOnlyTerminalDescendants: () => true, readAll: () => items,
        checkpointProjectionContext: () => ({ projection: new TestToolPairProjection(),
          projectionId: "pairing-crash-current", sourceKey: "pairing-crash-source",
          expectedRunId: "test-run" }), appendRollout,
        liveToolCallResolved: (callId: string) => callId === "crash-write" },
      runTurn: vi.fn(async function* () {}), emit: vi.fn(),
      nextInternalSubId: () => "pairing-crash-warning" } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, second)).resolves.toMatchObject({ resumed: true });
    expect(appendRollout).not.toHaveBeenCalled();
    // Even a caller holding the pre-crash descriptor must consult the live
    // pairing projection before it writes the synthesized result again.
    const guardedAppend = vi.fn();
    const guardedRun = vi.fn(async function* () {});
    const guarded = { config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Write", recoveryCategory: "side-effecting" }] } },
      rolloutStore: { rootHasOnlyTerminalDescendants: () => true, appendRollout: guardedAppend,
        liveToolCallResolved: (callId: string) => callId === "crash-write" },
      runTurn: guardedRun, emit: vi.fn(), nextInternalSubId: () => "guarded-warning" } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(guarded, staleBeforePairing))
      .resolves.toMatchObject({ resumed: true });
    expect(guardedAppend).not.toHaveBeenCalled();
    expect(guardedRun).toHaveBeenCalledWith("", expect.objectContaining({
      history: expect.arrayContaining([expect.objectContaining({ toolCallId: "crash-write" })]),
    }));
  });

  test("operator resolution pairs an unknown checkpointed call without redispatch", () => {
    const buildId = pinBuild("reviewed-effect-build");
    const items = checkpointWithEffectEvents({ turnId: "reviewed-effect", buildId,
      userContent: "Publish", callId: "publish-reviewed", toolName: "Publish",
      stepId: "tool:reviewed-effect:publish", intentId: "review-intent",
      outcomeId: "review-unknown", outcome: "unknown_outcome" });
    items.push({ type: "event_msg", payload: { id: "review-resolved", seq: 5, msg: {
      type: "effect_review_resolved", payload: { runId: "test-run",
        stepId: "tool:reviewed-effect:publish", callId: "publish-reviewed",
        resolution: createOperatorEffectReviewResolution({ disposition: "confirmed_committed",
          actorId: "operator", evidenceRef: "test:published", evidenceSha256: "a".repeat(64),
          reviewedAt: "2026-09-01T00:00:02.000Z" }) },
    } } });
    const turn = reconstruct(items).resumableTurns[0];
    expect(turn?.danglingToolUses).toEqual([]);
    expect(turn?.reconciledToolResults).toContainEqual(expect.objectContaining({
      role: "tool", toolCallId: "publish-reviewed", toolName: "Publish",
    }));
  });

  test("a review recorded after reconstruction settles the call before continuation", async () => {
    const buildId = pinBuild("late-review-build");
    const items = checkpointWithEffectEvents({ turnId: "late-review", buildId,
      userContent: "Publish", callId: "late-call", toolName: "Publish",
      stepId: "tool:late-review:publish", intentId: "late-intent",
      outcomeId: "late-unknown", outcome: "unknown_outcome" });
    const beforeReview = reconstruct(items);
    expect(beforeReview.resumableTurns[0]?.danglingToolUses).toEqual([
      { callId: "late-call", toolName: "Publish" },
    ]);
    items.push({ type: "event_msg", payload: { id: "late-resolved", seq: 5, msg: {
      type: "effect_review_resolved", payload: { runId: "test-run",
        stepId: "tool:late-review:publish", callId: "late-call",
        resolution: createOperatorEffectReviewResolution({ disposition: "confirmed_committed",
          actorId: "operator", evidenceRef: "test:late-review", evidenceSha256: "b".repeat(64),
          reviewedAt: "2026-09-01T00:00:02.000Z" }) },
    } } });
    const runTurn = vi.fn(async function* () {});
    const session = { config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Publish", recoveryCategory: "side-effecting" }] } },
      rolloutStore: { rootHasOnlyTerminalDescendants: () => true, readAll: () => items,
        checkpointProjectionContext: () => ({ projection: new TestToolPairProjection(),
          projectionId: "late-review-projection", sourceKey: "late-review-source",
          expectedRunId: "test-run" }), appendRollout: vi.fn() },
      runTurn, emit: vi.fn(), nextInternalSubId: () => "late-review-warning" } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, beforeReview)).resolves.toMatchObject({ resumed: true });
    expect(runTurn).toHaveBeenCalledWith("", expect.objectContaining({
      history: expect.arrayContaining([expect.objectContaining({ toolCallId: "late-call" })]),
    }));
  });
  test("graceful daemon shutdown preserves a checkpoint and completed tool result for one resume", () => {
    const buildId = pinBuild("shutdown-resume-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Write the files" },
      { role: "assistant", content: "", toolCalls: [{ id: "write-1", name: "Write", arguments: "{}" }] },
      { role: "tool", content: "File written", toolCallId: "write-1", toolName: "Write",
        toolResultIntegrity: createToolResultIntegrity({ runId: "test-run", toolCallId: "write-1", content: "File written" }) },
    ];
    const items = orphanWithCheckpoint({ turnId: "turn-shutdown", buildId, prefix, checkpointVersion: 4 });
    items.push({ type: "event_msg", payload: { id: "shutdown", msg: {
      type: "turn_aborted", payload: { turnId: "turn-shutdown", reason: "daemon_shutdown" },
    } } });
    const result = reconstruct(items);
    expect(result.history).toEqual(prefix);
    expect(result.resumableTurns).toEqual([expect.objectContaining({
      turnId: "turn-shutdown", historyPrefixValid: true, danglingToolUses: [],
    })]);
    expect(result.synthesizedEvents.some(item => item.type === "event_msg" &&
      item.payload.msg.type === "turn_aborted" && item.payload.msg.payload.reason === "process_killed")).toBe(false);
  });

  test("completed and user-stopped turns never resume after shutdown", () => {
    const buildId = pinBuild("shutdown-terminal-build");
    for (const terminal of [
      { type: "turn_complete", payload: { turnId: "turn-1", lastAgentMessage: "done", completedAt: 1, durationMs: 1 } },
      { type: "turn_aborted", payload: { turnId: "turn-1", reason: "interrupted" } },
    ] as const) {
      const items = orphanWithCheckpoint({ turnId: "turn-1", buildId, prefix: [{ role: "user", content: "Work" }] });
      items.push({ type: "event_msg", payload: { id: "terminal", msg: terminal } });
      expect(reconstruct(items).resumableTurns).toEqual([]);
    }
  });

  test("shutdown keeps an unsettled side-effecting call dangling for the effect gate", () => {
    const buildId = pinBuild("shutdown-effect-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Publish the release" },
      { role: "assistant", content: "", toolCalls: [{ id: "publish-1", name: "Publish", arguments: "{}" }] },
    ];
    const items = orphanWithCheckpoint({ turnId: "turn-effect", buildId, prefix, boundary: "postAssistant" });
    items.push({ type: "event_msg", payload: { id: "shutdown", msg: {
      type: "turn_aborted", payload: { turnId: "turn-effect", reason: "daemon_shutdown" },
    } } });
    expect(reconstruct(items).resumableTurns[0]).toMatchObject({
      historyPrefixValid: true,
      danglingToolUses: [{ callId: "publish-1", toolName: "Publish" }],
    });
  });

  test("a dangling side effect waits for the user's continuation", async () => {
    const buildId = pinBuild("shutdown-manual-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Publish the release" },
      { role: "assistant", content: "", toolCalls: [{ id: "publish-1", name: "Publish", arguments: "{}" }] },
    ];
    const items = orphanWithCheckpoint({ turnId: "turn-manual", buildId, prefix, boundary: "postAssistant" });
    items.push({ type: "event_msg", payload: { id: "shutdown", msg: {
      type: "turn_aborted", payload: { turnId: "turn-manual", reason: "daemon_shutdown" },
    } } });
    const runTurn = vi.fn();
    const session = {
      config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [{ name: "Publish", recoveryCategory: "side-effecting" }] } },
      runTurn, emit: vi.fn(), nextInternalSubId: () => "warning-g3",
    } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, reconstruct(items))).resolves.toEqual({
      resumed: false, reason: "side-effect-review-required", halted: ["Publish"],
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("a result persisted after the post-assistant checkpoint settles only its own call", async () => {
    const buildId = pinBuild("post-checkpoint-result-build");
    const prefix: ResponseItem[] = [
      { role: "user", content: "Write and inspect" },
      { role: "assistant", content: "", toolCalls: [
        { id: "write-done", name: "Write", arguments: "{}" },
        { id: "read-cancelled", name: "Read", arguments: "{}" },
      ] },
    ];
    const items = orphanWithCheckpoint({ turnId: "post-checkpoint", buildId, prefix,
      checkpointVersion: 4, boundary: "postAssistant" });
    const result: ResponseItem = { role: "tool", content: "File written",
      toolCallId: "write-done", toolName: "Write",
      toolResultIntegrity: createToolResultIntegrity({ runId: "test-run", toolCallId: "write-done", content: "File written" }) };
    items.push({ type: "response_item", payload: result });
    items.push({ type: "event_msg", payload: { id: "shutdown-post-result", msg: {
      type: "turn_aborted", payload: { turnId: "post-checkpoint", reason: "daemon_shutdown" },
    } } });
    const reconstructed = reconstruct(items);
    expect(reconstructed.resumableTurns[0]?.danglingToolUses).toEqual([
      { callId: "read-cancelled", toolName: "Read" },
    ]);
    const runTurn = vi.fn(async function* () {});
    const session = {
      config: { durableTurns: { resume: { requireLease: false } } },
      services: { registry: { tools: [
        { name: "Write", recoveryCategory: "side-effecting" },
        { name: "Read", recoveryCategory: "idempotent", isReadOnly: true },
      ] } },
      runTurn, emit: vi.fn(), nextInternalSubId: () => "warning-post-result",
    } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, reconstructed)).resolves.toMatchObject({ resumed: true });
    expect(runTurn).toHaveBeenCalledWith("", expect.objectContaining({
      history: expect.arrayContaining([expect.objectContaining({ toolCallId: "write-done", content: "File written" })]),
      resume: expect.objectContaining({ danglingPairings: [
        { callId: "read-cancelled", toolName: "Read", halt: false },
      ] }),
    }));
  });

  test("a finished replacement turn retires an older shutdown checkpoint", () => {
    const buildId = pinBuild("superseded-shutdown-build");
    const items = orphanWithCheckpoint({ turnId: "old-shutdown", buildId,
      prefix: [{ role: "user", content: "old request" }], checkpointVersion: 4 });
    items.push({ type: "event_msg", payload: { id: "old-shutdown-event", msg: {
      type: "turn_aborted", payload: { turnId: "old-shutdown", reason: "daemon_shutdown" },
    } } });
    items.push({ type: "event_msg", payload: { id: "replacement-start", msg: {
      type: "turn_started", payload: { turnId: "replacement", buildId },
    } } });
    items.push({ type: "response_item", payload: { role: "user", content: "new request" } });
    items.push({ type: "response_item", payload: { role: "assistant", content: "new answer" } });
    items.push({ type: "event_msg", payload: { id: "replacement-complete", msg: {
      type: "turn_complete", payload: { turnId: "replacement", lastAgentMessage: "new answer", completedAt: 2, durationMs: 1 },
    } } });
    expect(reconstruct(items).resumableTurns).toEqual([]);
  });

  test("durable acceptance of a replacement prompt retires the shutdown turn before it starts", () => {
    const buildId = pinBuild("accepted-replacement-build");
    const items = orphanWithCheckpoint({ turnId: "old-shutdown", buildId,
      prefix: [{ role: "user", content: "old request" }], checkpointVersion: 4 });
    items.push({ type: "event_msg", payload: { id: "shutdown-old", msg: {
      type: "turn_aborted", payload: { turnId: "old-shutdown", reason: "daemon_shutdown" },
    } } });
    items.push({ type: "event_msg", payload: { id: "replacement-accepted", msg: {
      type: "user_message", payload: { message: "new request", displayText: "new request" },
    } } });
    expect(reconstruct(items).resumableTurns).toEqual([]);
  });

  test.each([false, true])("clear prevents old history and checkpoints from resuming (new turn=%s)", (newTurn) => {
    const buildId = pinBuild("clear-history-build");
    const oldHistory: ResponseItem[] = [{ role: "user", content: "old request" }];
    const newHistory: ResponseItem[] = [
      { role: "user", content: "new request" },
      { role: "assistant", content: "new answer" },
    ];
    const items: RolloutItem[] = [
      { type: "session_state", payload: { agentTask: { taskId: "retained-task" } } },
      ...orphanWithCheckpoint({ turnId: "old-turn", buildId, prefix: oldHistory, checkpointVersion: 4 }),
      { type: "compacted", payload: { message: "old summary", replacementHistory: oldHistory } },
      { type: "turn_context", payload: {
        turnId: "old-turn", model: "old-model", cwd: "/workspace",
        approvalPolicy: "on-request", sandboxPolicy: "workspace-write",
      } },
      { type: "event_msg", payload: {
        id: "clear", msg: { type: "history_cleared", payload: { timestamp: 1 } },
      } },
      ...(newTurn ? orphanWithCheckpoint({
        turnId: "new-turn", buildId, prefix: newHistory, checkpointVersion: 4,
      }) : []),
    ];
    const result = reconstruct(items);
    expect(result.history).toEqual(newTurn ? newHistory : []);
    expect(result.state.agentTask).toEqual({ taskId: "retained-task" });
    expect(result.previousTurnSettings).toBeUndefined();
    expect(result.referenceContextItem).toBeUndefined();
    expect(result.state.lastCompaction).toBeUndefined();
    expect(result.state.lastTurnContext).toBeUndefined();
    expect(result.orphanedTurnIds).toEqual(newTurn ? ["new-turn"] : []);
    expect(result.resumableTurns).toEqual(newTurn ? [expect.objectContaining({
      turnId: "new-turn", historyPrefixValid: true, checkpointIntegrityStatus: "valid",
    })] : []);
  });

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
