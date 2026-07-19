/**
 * Rollout-store — the publicly-consumed handle on the session rollout.
 *
 * SessionStore owns the on-disk state (flock, file handle, index);
 * RolloutStore is the event-log-facing facade that phases, sidecars,
 * and session.ts call into. Keeping them separate lets us swap
 * backends (file → S3-for-remote-agents) without touching callers.
 *
 * Also owns the 100ms batch flush scheduler. I-25 (snapshot is
 * best-effort, rollout is source of truth) is honored by treating
 * every snapshot write as advisory: if it fails, the rollout itself
 * still contains the truth.
 *
 * @module
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import {
  AtomicArtifactOperationUnsupportedError,
  type AtomicArtifactObservation,
  withAtomicArtifactObservationSync,
} from "../durability/atomic-artifact.js";
import { withPinnedOfflineRolloutLease } from "../durability/offline-rollout.js";
import {
  AgentIdExistsError,
  InvalidAgentMetadataError,
  normalizeAgentMetadata,
  type AgentMetadata,
  type AgentPath,
  type ThreadId,
} from "../agents/registry.js";
import type { Event, EventMsg } from "./event-log.js";
import { parseRolloutLine, type RolloutItem } from "./rollout-item.js";
import {
  getProjectDir,
  SessionStore,
  SessionStoreFlushScheduler,
  type AppendOptions,
  type CompactionIndexSnapshot,
  type SessionStoreOpts,
} from "./session-store.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import {
  checkUnknownOutcomeMutationGate,
  UnknownOutcomeMutationBlockedError,
} from "../state/unknown-outcome-gate.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { ThreadSpawnEdgeRepository } from "../state/spawn-edges.js";
import { StateRunDurabilityRepository } from "../state/run-durability.js";
import { recordInFlightToolCallUnknownOutcome } from "../state/tool-output-rotation.js";
import { resolveUnknownOutcomeEffect } from "../state/unknown-outcome-gate.js";
import { getAgenCConfigHomeDir } from "../utils/envUtils.js";
import { sanitizePath } from "../utils/path.js";
import { isRecord } from "../utils/record.js";

export interface RolloutStoreOpts extends SessionStoreOpts {
  /** Flush interval in ms. Default 100. */
  readonly flushIntervalMs?: number;
  /** Whether to auto-start the background flush scheduler. Default true. */
  readonly autoStartScheduler?: boolean;
}

export class TerminalRunEpochOpenError extends Error {
  constructor(
    readonly runId: string,
    readonly epoch: number,
  ) {
    super(
      `refusing to open terminal run ${runId} epoch ${epoch}; explicit reopen is required`,
    );
    this.name = "TerminalRunEpochOpenError";
  }
}

export type ThreadSpawnEdgeStatus = "open" | "closed";

export interface ThreadSpawnEdgeRecord {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly parentPath: AgentPath;
  readonly metadata: AgentMetadata;
  readonly status: ThreadSpawnEdgeStatus;
}

const THREAD_SPAWN_EDGE_SNAPSHOT_VERSION = 1;

function rolloutItemsContainTerminal(
  items: readonly RolloutItem[],
  runId: string,
  epoch: number,
): boolean {
  return items.some(
    (item) =>
      item.type === "event_msg" &&
      item.payload.msg.type === "run_terminal" &&
      item.payload.msg.payload.runId === runId &&
      item.payload.msg.payload.epoch === epoch,
  );
}

function rolloutContentContainsTerminal(
  content: string,
  runId: string,
  epoch: number,
): boolean {
  const items: RolloutItem[] = [];
  for (const line of content.split("\n")) {
    const item = parseRolloutLine(line);
    if (item !== null) items.push(item);
  }
  return rolloutItemsContainTerminal(items, runId, epoch);
}

export class RolloutStore {
  readonly store: SessionStore;
  private readonly scheduler: SessionStoreFlushScheduler;
  private readonly startScheduler: boolean;
  private readonly resumed: boolean;
  readonly projectRootMarkers?: readonly string[];
  private readonly threadSpawnEdgePath: string;
  private readonly stateDriver: StateSqliteDriver;
  private readonly threadSpawnEdgeRepo: ThreadSpawnEdgeRepository;
  private readonly runDurabilityRepo: StateRunDurabilityRepository;
  private openedAt: string | undefined;
  private openedEpoch: number | undefined;

  constructor(opts: RolloutStoreOpts) {
    this.store = new SessionStore(opts);
    this.scheduler = new SessionStoreFlushScheduler(
      this.store,
      opts.flushIntervalMs ?? 100,
    );
    this.startScheduler = opts.autoStartScheduler !== false;
    this.resumed = opts.resume === true;
    this.projectRootMarkers = opts.projectRootMarkers;
    this.threadSpawnEdgePath = join(
      this.store.sessionDir,
      "thread-spawn-edges.json",
    );
    this.stateDriver = openStateDatabases({
      cwd: opts.cwd,
      projectRootMarkers: opts.projectRootMarkers,
    });
    this.threadSpawnEdgeRepo = new ThreadSpawnEdgeRepository(this.stateDriver);
    this.runDurabilityRepo = new StateRunDurabilityRepository(this.stateDriver);
    this.loadThreadSpawnEdges();
  }

  open(meta: Parameters<SessionStore["open"]>[0]): void {
    try {
      this.assertJournalSourceWritable();
      const existingEpoch = this.runDurabilityRepo.currentEpoch(meta.sessionId);
      if (
        existingEpoch !== undefined &&
        this.currentEpochIsTerminal(meta.sessionId, existingEpoch.epoch)
      ) {
        throw new TerminalRunEpochOpenError(
          meta.sessionId,
          existingEpoch.epoch,
        );
      }

      this.store.open(meta);
      // Re-check under the canonical rollout lease. Retention can retire the
      // binding between the optimistic check above and lock acquisition; a
      // source carrying an inactive binding is historical and must never be
      // revived as a writer merely because its directory rename failed.
      this.assertJournalSourceWritable();
      const current = this.runDurabilityRepo.currentEpoch(meta.sessionId);
      const epoch =
        current ??
        this.runDurabilityRepo.ensureInitialEpoch({
          runId: meta.sessionId,
          openedAt: meta.timestamp,
        }).value;
      this.openedAt = epoch.openedAt;
      this.openedEpoch = epoch.epoch;
      if (this.currentEpochIsTerminal(meta.sessionId, epoch.epoch)) {
        throw new TerminalRunEpochOpenError(meta.sessionId, epoch.epoch);
      }
      if (
        this.runDurabilityRepo.getJournalBinding(this.rolloutPath) === undefined
      ) {
        this.runDurabilityRepo.bindJournalSource({
          runId: meta.sessionId,
          epoch: epoch.epoch,
          childRunId: meta.sessionId,
          sessionId: meta.sessionId,
          sourcePath: this.rolloutPath,
          boundAt: epoch.openedAt,
        });
      }
      if (this.resumed) this.recoverEffectProjectionOnOpen();
      if (this.startScheduler) this.scheduler.start();
    } catch (error) {
      this.scheduler.stop();
      this.store.close();
      this.stateDriver.close();
      throw error;
    }
  }

  append(event: Event, opts: AppendOptions = {}): boolean {
    return this.store.append(event, opts);
  }

  /** Lifecycle epoch owned by this canonical rollout writer. */
  get runEpoch(): number {
    if (this.openedEpoch === undefined) {
      throw new Error(`rollout store for ${this.sessionId} is not open`);
    }
    return this.openedEpoch;
  }

  /** Project a fsync-committed effect event into rebuildable M4 state. */
  recordEffectEvent(event: Event): void {
    const sequence = event.seq;
    if (!Number.isSafeInteger(sequence) || (sequence ?? 0) <= 0) {
      throw new Error("effect projection requires a positive event sequence");
    }
    const eventId = canonicalRolloutEventId(event);
    const message = event.msg;
    if (message.type === "effect_intent") {
      const payload = message.payload;
      const epoch = this.requireRunEpoch(payload.runId);
      this.runDurabilityRepo.beginEffect({
        runId: payload.runId,
        epoch: epoch.epoch,
        stepId: payload.stepId,
        ...(this.sessionId !== payload.runId
          ? { childRunId: this.sessionId }
          : {}),
        sessionId: this.sessionId,
        callId: payload.callId,
        toolName: payload.toolName,
        recoveryCategory: payload.recoveryCategory,
        ...(payload.idempotencyKey !== undefined
          ? { idempotencyKey: payload.idempotencyKey }
          : {}),
        intentDigest: payload.intentDigest,
        eventId,
        eventSequence: sequence!,
        intentAt: payload.recordedAt,
      });
      return;
    }
    if (message.type === "effect_result") {
      const payload = message.payload;
      this.runDurabilityRepo.completeEffect({
        runId: payload.runId,
        stepId: payload.stepId,
        outcome: payload.outcome,
        eventId,
        eventSequence: sequence!,
        ...(payload.resultDigest !== undefined
          ? { resultDigest: payload.resultDigest }
          : {}),
        ...(payload.evidence !== undefined
          ? { evidence: payload.evidence }
          : {}),
        completedAt: payload.recordedAt,
      });
      return;
    }
    if (message.type === "effect_unknown_outcome") {
      const payload = message.payload;
      if (payload.recoveryCategory === "idempotent") {
        throw new Error("idempotent effects cannot have unknown outcome");
      }
      this.runDurabilityRepo.markEffectUnknown({
        runId: payload.runId,
        stepId: payload.stepId,
        eventId,
        eventSequence: sequence!,
        reason: payload.reason,
        evidence: { requiresReview: payload.requiresReview },
        observedAt: payload.recordedAt,
      });
      recordInFlightToolCallUnknownOutcome(this.stateDriver, {
        sessionId: this.sessionId,
        agentId: payload.runId,
        toolCallId: payload.callId,
        toolName: payload.toolName,
        observedAt: payload.recordedAt,
        recoveryCategory: payload.recoveryCategory,
      });
      return;
    }
    if (message.type === "effect_review_resolved") {
      const payload = message.payload;
      const effect = this.runDurabilityRepo.getEffect(
        payload.runId,
        payload.stepId,
      );
      if (effect === undefined || effect.callId !== payload.callId) {
        throw new Error(
          `effect review ${eventId} has no matching durable unknown outcome`,
        );
      }
      this.runDurabilityRepo.resolveEffectReview({
        runId: payload.runId,
        stepId: payload.stepId,
        reviewedAt: payload.reviewedAt,
        reviewedBy: payload.reviewedBy,
        resolution: payload.resolution,
        eventId,
        evidence: {
          callId: payload.callId,
          sequence,
          source: "canonical_run_journal",
        },
      });
      resolveUnknownOutcomeEffect(this.stateDriver, {
        sessionId: effect.sessionId,
        toolCallId: effect.callId,
      });
    }
  }

  appendRollout(item: RolloutItem, opts: AppendOptions = {}): void {
    this.store.appendRollout(item, opts);
  }

  readAll(): RolloutItem[] {
    return this.store.readAll();
  }

  get rolloutPath(): string {
    return this.store.rolloutPath;
  }

  get sessionId(): string {
    return this.store.sessionId;
  }

  /** M3 pre-dispatch gate backed by the same project state database. */
  assertToolAdmissionAllowed(recoveryCategory: ToolRecoveryCategory): void {
    const decision = checkUnknownOutcomeMutationGate(this.stateDriver, {
      sessionId: this.sessionId,
      recoveryCategory,
    });
    if (!decision.allowed) {
      throw new UnknownOutcomeMutationBlockedError(
        this.sessionId,
        decision.blocking,
      );
    }
  }

  get isDegraded(): boolean {
    return this.store.isDegraded;
  }

  /** I-88 — read the per-turn tool-result-bytes index. */
  getToolResultBytes(turnId: string): number {
    return this.store.getToolResultBytes(turnId);
  }

  /** I-88 — snapshot the full index (used by compaction). */
  getToolResultBytesIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getToolResultBytesIndexSnapshot();
  }

  getTokenEstimate(turnId: string): number {
    return this.store.getTokenEstimate(turnId);
  }

  getTokenEstimateIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getTokenEstimateIndexSnapshot();
  }

  getToolCallTurnIdSnapshot(): ReadonlyMap<string, string> {
    return this.store.getToolCallTurnIdSnapshot();
  }

  getCompactionIndexSnapshot(): CompactionIndexSnapshot {
    return this.store.getCompactionIndexSnapshot();
  }

  createThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    const normalized = normalizeThreadSpawnEdge(edge);
    this.threadSpawnEdgeRepo.create(normalized);
  }

  /** @deprecated Spawn-edge identity is create-only; use createThreadSpawnEdge. */
  upsertThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    this.createThreadSpawnEdge(edge);
  }

  setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): void {
    // Never decide from a constructor-time snapshot. Multiple daemon/session
    // handles can share this project database, so the repository performs the
    // authoritative monotonic transition (or idempotent acknowledgement).
    this.threadSpawnEdgeRepo.setStatus(childThreadId, status);
  }

  getThreadSpawnEdge(
    childThreadId: ThreadId,
  ): ThreadSpawnEdgeRecord | undefined {
    const edge = this.threadSpawnEdgeRepo.get(childThreadId);
    return edge ? cloneThreadSpawnEdge(edge) : undefined;
  }

  listThreadSpawnChildrenWithStatus(
    parentThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnChildrenMatching(parentThreadId, status);
  }

  listThreadSpawnChildren(
    parentThreadId: ThreadId,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnChildrenMatching(parentThreadId);
  }

  listThreadSpawnDescendants(
    rootThreadId: ThreadId,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnDescendantsMatching(rootThreadId);
  }

  listThreadSpawnDescendantsWithStatus(
    rootThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnDescendantsMatching(rootThreadId, status);
  }

  findThreadSpawnChildByPath(
    parentThreadId: ThreadId,
    agentPath: AgentPath,
  ): ThreadId | undefined {
    const matches = this.listThreadSpawnChildren(parentThreadId)
      .filter((edge) => edge.metadata.agentPath === agentPath)
      .map((edge) => edge.childThreadId)
      .sort();
    return oneThreadIdFromPathMatches(matches, agentPath);
  }

  findThreadSpawnDescendantByPath(
    rootThreadId: ThreadId,
    agentPath: AgentPath,
  ): ThreadId | undefined {
    const matches = this.listThreadSpawnDescendants(rootThreadId)
      .filter((edge) => edge.metadata.agentPath === agentPath)
      .map((edge) => edge.childThreadId)
      .sort();
    return oneThreadIdFromPathMatches(matches, agentPath);
  }

  private listThreadSpawnChildrenMatching(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.threadSpawnEdgeRepo
      .list()
      .filter((edge) => edge.parentThreadId === parentThreadId)
      .filter((edge) => status === undefined || edge.status === status)
      .sort(compareThreadSpawnEdges)
      .map((edge) => cloneThreadSpawnEdge(edge));
  }

  private listThreadSpawnDescendantsMatching(
    rootThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    const childrenByParent = new Map<ThreadId, ThreadSpawnEdgeRecord[]>();
    for (const edge of this.threadSpawnEdgeRepo.list()) {
      if (status !== undefined && edge.status !== status) continue;
      const bucket = childrenByParent.get(edge.parentThreadId) ?? [];
      bucket.push(edge);
      childrenByParent.set(edge.parentThreadId, bucket);
    }
    for (const bucket of childrenByParent.values()) {
      bucket.sort(compareThreadSpawnEdges);
    }

    const descendants: ThreadSpawnEdgeRecord[] = [];
    const seen = new Set<ThreadId>([rootThreadId]);
    let level = [...(childrenByParent.get(rootThreadId) ?? [])];
    while (level.length > 0) {
      level.sort(compareThreadSpawnEdges);
      const nextLevel: ThreadSpawnEdgeRecord[] = [];
      for (const next of level) {
        if (seen.has(next.childThreadId)) continue;
        seen.add(next.childThreadId);
        descendants.push(cloneThreadSpawnEdge(next));
        nextLevel.push(...(childrenByParent.get(next.childThreadId) ?? []));
      }
      level = nextLevel;
    }
    return descendants;
  }

  /** Force an immediate flush (durable=true). */
  flushDurable(): void {
    if (!this.store.flushBatch(true)) {
      throw new Error("rollout flush was not fsync-committed");
    }
  }

  /** Fsync the existing canonical tail even when no batch is pending. */
  syncCanonicalTail(): void {
    this.store.syncCanonicalTail();
  }

  close(): void {
    this.scheduler.stop();
    this.stateDriver.close();
    this.store.close();
  }

  private requireRunEpoch(runId: string) {
    const epoch = this.runDurabilityRepo.currentEpoch(runId);
    if (epoch !== undefined) return epoch;
    if (runId !== this.sessionId || this.openedAt === undefined) {
      throw new Error(`run ${runId} has no durable lifecycle epoch`);
    }
    return this.runDurabilityRepo.ensureInitialEpoch({
      runId,
      openedAt: this.openedAt,
    }).value;
  }

  private assertJournalSourceWritable(): void {
    const binding = this.runDurabilityRepo.getJournalBinding(this.rolloutPath);
    if (binding !== undefined && !binding.active) {
      throw new Error(
        `refusing to reopen inactive canonical journal source ${this.rolloutPath}`,
      );
    }
  }

  private currentEpochIsTerminal(runId: string, epoch: number): boolean {
    if (this.runDurabilityRepo.getTerminalResult(runId, epoch) !== undefined) {
      return true;
    }
    if (rolloutItemsContainTerminal(this.store.readAll(), runId, epoch)) {
      return true;
    }

    const projectDir = getProjectDir(this.store.cwd, this.projectRootMarkers);
    for (const binding of this.runDurabilityRepo.listJournalBindings(
      runId,
      epoch,
    )) {
      if (binding.sourcePath === this.rolloutPath) continue;
      const terminal = withPinnedOfflineRolloutLease(
        {
          projectDir,
          sessionId: binding.sessionId,
          sourcePath: binding.sourcePath,
        },
        (rollout) =>
          rolloutContentContainsTerminal(rollout.readUtf8(), runId, epoch),
      );
      if (terminal) return true;
    }
    return false;
  }

  private recoverEffectProjectionOnOpen(): void {
    const events = this.store
      .readAll()
      .filter(
        (item): item is Extract<RolloutItem, { readonly type: "event_msg" }> =>
          item.type === "event_msg",
      )
      .map((item) => item.payload)
      .filter(isSequencedEvent)
      .sort((left, right) => left.seq - right.seq);
    const effectEvents = events.filter(isEffectLifecycleEvent);
    for (const event of effectEvents) this.recordEffectEvent(event);

    // Artifact and effect recovery share one canonical sequence cursor. Each
    // recovery append must advance from the tail written by the previous
    // recovery family; otherwise SessionStore can reject the duplicate
    // sequence while SQLite still projects it, splitting the authorities.
    let nextSequence = this.recoverArtifactJournalOnOpen(events);

    const settledSteps = new Set(
      effectEvents
        .filter((event) => event.msg.type !== "effect_intent")
        .map((event) => event.msg.payload.stepId),
    );
    const existingEventIds = new Set(events.map(canonicalRolloutEventId));
    const existingEffectRecoveryEvidence = new Set(
      events.flatMap((event) => {
        if (
          event.msg.type !== "recovery_decision" ||
          typeof event.msg.payload.stepId !== "string" ||
          typeof event.msg.payload.evidenceEventId !== "string" ||
          !Number.isSafeInteger(event.msg.payload.evidenceEventSeq) ||
          event.msg.payload.evidenceEventSeq <= 0
        ) {
          return [];
        }
        return [
          recoveryEvidenceKey(
            event.msg.payload.evidenceEventId,
            event.msg.payload.evidenceEventSeq,
          ),
        ];
      }),
    );
    for (const intent of effectEvents) {
      if (intent.msg.type !== "effect_intent") continue;
      const payload = intent.msg.payload;
      if (settledSteps.has(payload.stepId)) continue;
      const admissionStatus = this.effectAdmissionStatus(
        payload.runId,
        payload.stepId,
      );
      const cancelledBeforeDispatch =
        admissionStatus === "reserved" || admissionStatus === "voided";
      const intentEventId = canonicalRolloutEventId(intent);
      if (
        payload.recoveryCategory === "idempotent" &&
        existingEffectRecoveryEvidence.has(
          recoveryEvidenceKey(intentEventId, intent.seq),
        )
      ) {
        continue;
      }
      const preferredEventId =
        payload.recoveryCategory === "idempotent"
          ? `recovery-decision:${intentEventId}`
          : cancelledBeforeDispatch
            ? `effect-cancelled-recovery:${intentEventId}`
            : `effect-unknown-recovery:${intentEventId}`;
      const eventId = uniqueRecoveryEventId(preferredEventId, existingEventIds);
      nextSequence += 1;
      const recordedAt = new Date().toISOString();
      const recovery: Event =
        payload.recoveryCategory === "idempotent"
          ? {
              eventId,
              id: eventId,
              seq: nextSequence,
              msg: {
                type: "recovery_decision",
                payload: {
                  runId: payload.runId,
                  stepId: payload.stepId,
                  decision: "retry_safe_deferred",
                  reason:
                    "durable idempotency key proves retry safety; automatic replay is deferred to an explicit caller",
                  evidenceEventId: intentEventId,
                  evidenceEventSeq: intent.seq,
                  recordedAt,
                },
              },
            }
          : cancelledBeforeDispatch
            ? {
                eventId,
                id: eventId,
                seq: nextSequence,
                msg: {
                  type: "effect_result",
                  payload: {
                    runId: payload.runId,
                    stepId: payload.stepId,
                    callId: payload.callId,
                    toolName: payload.toolName,
                    recoveryCategory: payload.recoveryCategory,
                    intentEventSeq: intent.seq,
                    outcome: "cancelled",
                    evidence: {
                      reason: "daemon_recovered_before_effect_dispatch",
                      admissionStatus,
                    },
                    recordedAt,
                  },
                },
              }
            : {
                eventId,
                id: eventId,
                seq: nextSequence,
                msg: {
                  type: "effect_unknown_outcome",
                  payload: {
                    runId: payload.runId,
                    stepId: payload.stepId,
                    callId: payload.callId,
                    toolName: payload.toolName,
                    recoveryCategory: payload.recoveryCategory,
                    intentEventSeq: intent.seq,
                    outcome: "unknown_outcome",
                    reason: "daemon_recovered_without_effect_acknowledgement",
                    requiresReview: true,
                    recordedAt,
                  },
                },
              };
      if (!this.store.append(recovery, { durable: true })) {
        throw new Error(`failed to commit recovery event ${eventId}`);
      }
      existingEventIds.add(eventId);
      if (
        recovery.msg.type === "effect_unknown_outcome" ||
        recovery.msg.type === "effect_result"
      ) {
        this.recordEffectEvent(recovery);
        settledSteps.add(payload.stepId);
      }
    }
  }

  private effectAdmissionStatus(
    runId: string,
    stepId: string,
  ): string | undefined {
    return this.stateDriver
      .prepareState<[string, string], { readonly status: string }>(
        `SELECT status
         FROM execution_admission_reservations
         WHERE run_id = ? AND step_id = ?
         ORDER BY attempt DESC
         LIMIT 1`,
      )
      .get(runId, stepId)?.status;
  }

  private recoverArtifactJournalOnOpen(
    events: readonly SequencedEvent[],
  ): number {
    const committedIntentSequences = new Set(
      events
        .filter(
          (event): event is ArtifactCommittedLifecycleEvent =>
            event.msg.type === "artifact_committed",
        )
        .map((event) => event.msg.payload.intentEventSeq),
    );
    const existingRecoveryEvidence = new Set(
      events
        .filter(
          (event): event is RecoveryDecisionLifecycleEvent =>
            event.msg.type === "recovery_decision",
        )
        .map((event) => event.msg.payload.evidenceEventSeq),
    );
    const existingEventIds = new Set(
      events.flatMap((event) => [canonicalRolloutEventId(event), event.id]),
    );
    let nextSequence = events.at(-1)?.seq ?? 0;

    for (const intent of events) {
      if (intent.msg.type !== "artifact_intent") continue;
      const payload = intent.msg.payload;
      const artifactRoot = trustedArtifactRoot(payload.targetPath, [
        resolve(this.store.sessionDir, "tool-results"),
        resolve(
          getAgenCConfigHomeDir(),
          "projects",
          sanitizePath(this.store.cwd),
          this.sessionId,
          "tool-results",
        ),
      ]);
      const consumeObservation = (
        observation: AtomicArtifactObservation,
      ): void => {
        if (
          committedIntentSequences.has(intent.seq) ||
          (existingRecoveryEvidence.has(intent.seq) && observation !== "match")
        ) {
          return;
        }
        nextSequence += 1;
        const recordedAt = new Date().toISOString();
        const recoveryEventId = uniqueRecoveryEventId(
          observation === "match"
            ? `artifact-committed-recovery:${intent.id}`
            : `artifact-recovery-decision:${intent.id}`,
          existingEventIds,
        );
        const recovery: Event =
          observation === "match"
            ? {
                eventId: recoveryEventId,
                id: recoveryEventId,
                seq: nextSequence,
                msg: {
                  type: "artifact_committed",
                  payload: {
                    ...payload,
                    intentEventSeq: intent.seq,
                    outcome: "recovered",
                    committedAt: recordedAt,
                  },
                },
              }
            : {
                eventId: recoveryEventId,
                id: recoveryEventId,
                seq: nextSequence,
                msg: {
                  type: "recovery_decision",
                  payload: {
                    runId: payload.runId,
                    decision:
                      observation === "missing"
                        ? "artifact_retry_safe_deferred"
                        : "artifact_conflict_review_required",
                    reason:
                      observation === "missing"
                        ? "artifact target was not published; immutable retry is safe but deferred to an explicit caller"
                        : "artifact target contains bytes that do not match the durable intent; automatic overwrite is forbidden",
                    evidenceEventId: canonicalRolloutEventId(intent),
                    evidenceEventSeq: intent.seq,
                    recordedAt,
                  },
                },
              };
        if (!this.store.append(recovery, { durable: true })) {
          throw new Error(
            `failed to commit artifact recovery event ${recovery.id}`,
          );
        }
        existingEventIds.add(recoveryEventId);
      };

      if (artifactRoot === undefined) {
        consumeObservation("conflict");
        continue;
      }
      try {
        withAtomicArtifactObservationSync(
          payload.targetPath,
          payload.contentSha256,
          payload.byteLength,
          {
            trustedRoot: artifactRoot,
            // The resumed session owns the journal lease. A stranded private
            // temp is swept through the same pinned root used for proof; it is
            // never promoted and cannot redirect cleanup outside this run.
            cleanupOrphanedTemps: true,
          },
          consumeObservation,
        );
      } catch (error) {
        if (!(error instanceof AtomicArtifactOperationUnsupportedError)) {
          throw error;
        }
        // Without descriptor-relative child operations there is no safe proof
        // of a match. Continue conservatively as a review-required conflict;
        // never acknowledge bytes observed only through a racy pathname.
        consumeObservation("conflict");
      }
    }
    return nextSequence;
  }

  private loadThreadSpawnEdges(): void {
    const persistedChildIds = new Set(
      this.threadSpawnEdgeRepo.list().map((edge) => edge.childThreadId),
    );

    for (const edge of this.readLegacyThreadSpawnEdges()) {
      if (persistedChildIds.has(edge.childThreadId)) continue;
      try {
        // Historical topology, not a new admission — bypass the gate.
        this.threadSpawnEdgeRepo.create(edge, { admissionGate: "import" });
        persistedChildIds.add(edge.childThreadId);
      } catch (error) {
        // Another process can win the create between list() and legacy import.
        // Accept only its durable row; never rewrite it from the legacy file.
        if (!(error instanceof AgentIdExistsError)) throw error;
        const persisted = this.threadSpawnEdgeRepo.get(edge.childThreadId);
        if (!persisted) throw error;
        persistedChildIds.add(persisted.childThreadId);
      }
    }
  }

  private readLegacyThreadSpawnEdges(): ReadonlyArray<ThreadSpawnEdgeRecord> {
    if (!existsSync(this.threadSpawnEdgePath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.threadSpawnEdgePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeThreadSpawnEdgesSnapshot(parsed);
    } catch {
      this.copyCorruptLegacyThreadSpawnEdges();
      return [];
    }
  }

  private copyCorruptLegacyThreadSpawnEdges(): void {
    const raw = readFileSync(this.threadSpawnEdgePath);
    const hash = createHash("sha256").update(raw).digest("hex");
    const corruptDir = join(this.stateDriver.projectDir, "state-corrupt");
    const target = join(corruptDir, `thread-spawn-edges-${hash}.json`);
    if (existsSync(target)) return;
    mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
    copyFileSync(this.threadSpawnEdgePath, target);
  }
}

type SequencedEvent = Event & { readonly seq: number };
type EffectLifecycleEvent = SequencedEvent & {
  readonly msg: Extract<
    EventMsg,
    {
      readonly type:
        | "effect_intent"
        | "effect_result"
        | "effect_unknown_outcome"
        | "effect_review_resolved";
    }
  >;
};
type ArtifactCommittedLifecycleEvent = SequencedEvent & {
  readonly msg: Extract<EventMsg, { readonly type: "artifact_committed" }>;
};
type RecoveryDecisionLifecycleEvent = SequencedEvent & {
  readonly msg: Extract<EventMsg, { readonly type: "recovery_decision" }>;
};

function isSequencedEvent(event: Event): event is SequencedEvent {
  return (
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
  );
}

function canonicalRolloutEventId(event: SequencedEvent | Event): string {
  if (typeof event.eventId === "string" && event.eventId.length > 0) {
    return event.eventId;
  }
  if (
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
  ) {
    return `legacy-event:${event.seq}:${event.id}`;
  }
  throw new Error(
    "canonical rollout event identity requires eventId or sequence",
  );
}

function isEffectLifecycleEvent(
  event: SequencedEvent,
): event is EffectLifecycleEvent {
  return (
    event.msg.type === "effect_intent" ||
    event.msg.type === "effect_result" ||
    event.msg.type === "effect_unknown_outcome" ||
    event.msg.type === "effect_review_resolved"
  );
}

function trustedArtifactRoot(
  targetPath: string,
  allowedArtifactRoots: readonly string[],
): string | undefined {
  const targetDirectory = dirname(resolve(targetPath));
  return allowedArtifactRoots.find(
    (artifactRoot) => relative(resolve(artifactRoot), targetDirectory) === "",
  );
}

function uniqueRecoveryEventId(
  base: string,
  existing: ReadonlySet<string>,
): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

function recoveryEvidenceKey(eventId: string, sequence: number): string {
  return `${sequence}\0${eventId}`;
}

function normalizeThreadSpawnEdgesSnapshot(
  parsed: unknown,
): ReadonlyArray<ThreadSpawnEdgeRecord> {
  if (Array.isArray(parsed)) {
    return parsed.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (!isRecord(parsed)) {
    throw new Error("invalid thread-spawn edge snapshot");
  }

  if ("version" in parsed || "edges" in parsed) {
    if (
      parsed.version !== THREAD_SPAWN_EDGE_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.edges)
    ) {
      throw new Error("invalid thread-spawn edge snapshot");
    }
    return parsed.edges.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (Array.isArray(parsed.threadSpawnEdges)) {
    return parsed.threadSpawnEdges.map((edge) =>
      normalizeThreadSpawnEdge(edge),
    );
  }

  if (isRecord(parsed.threadSpawnEdges)) {
    return Object.entries(parsed.threadSpawnEdges).map(
      ([childThreadId, edge]) => normalizeThreadSpawnEdge(edge, childThreadId),
    );
  }

  const entries = Object.entries(parsed);
  if (entries.length > 0 && entries.every(([, edge]) => isRecord(edge))) {
    return entries.map(([childThreadId, edge]) =>
      normalizeThreadSpawnEdge(edge, childThreadId),
    );
  }

  throw new Error("invalid thread-spawn edge snapshot");
}

function oneThreadIdFromPathMatches(
  matches: readonly ThreadId[],
  agentPath: AgentPath,
): ThreadId | undefined {
  if (matches.length > 1) {
    throw new Error(
      `multiple spawned threads matched agent path ${agentPath}: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

function compareThreadSpawnEdges(
  left: ThreadSpawnEdgeRecord,
  right: ThreadSpawnEdgeRecord,
): number {
  return left.childThreadId.localeCompare(right.childThreadId);
}

function cloneThreadSpawnEdge(
  edge: ThreadSpawnEdgeRecord,
): ThreadSpawnEdgeRecord {
  return {
    ...edge,
    metadata: cloneAgentMetadata(edge.metadata),
  };
}

function cloneAgentMetadata(metadata: AgentMetadata): AgentMetadata {
  return normalizeAgentMetadata(metadata);
}

function normalizeThreadSpawnEdge(
  edge: unknown,
  fallbackChildThreadId?: string,
): ThreadSpawnEdgeRecord {
  if (!isRecord(edge)) {
    throw new Error("invalid thread-spawn edge record");
  }

  const childThreadId =
    typeof edge.childThreadId === "string"
      ? edge.childThreadId
      : fallbackChildThreadId;
  const status = edge.status === undefined ? "open" : edge.status;

  const metadata = normalizeAgentMetadata(edge.metadata);
  if (
    typeof childThreadId !== "string" ||
    typeof edge.parentThreadId !== "string" ||
    typeof edge.parentPath !== "string" ||
    (status !== "open" && status !== "closed") ||
    metadata.agentId !== childThreadId
  ) {
    throw new InvalidAgentMetadataError(
      "invalid thread-spawn edge record or child identity",
    );
  }

  return {
    childThreadId,
    parentThreadId: edge.parentThreadId,
    parentPath: edge.parentPath,
    metadata,
    status,
  };
}
