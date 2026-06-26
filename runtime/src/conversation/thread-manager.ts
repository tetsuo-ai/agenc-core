/**
 * Ports donor runtime thread/conversation orchestration onto AgenC's
 * TypeScript session, agent, and rollout primitives.
 *
 * Source anchors:
 *   - `core/src/thread_manager.rs`
 *   - `core/src/codex_thread.rs` // branding-scan: allow upstream source filename
 *   - `core/src/thread_rollout_truncation.rs`
 *   - `core/src/session_startup_prewarm.rs`
 *   - `core/src/session/rollout_reconstruction.rs`
 *
 * Shape difference from upstream:
 *   - The lower-level thread handle, rollout truncation, replay, and
 *     bootstrap prewarm pieces already live in `runtime/src/agents/` and
 *     `runtime/src/session/`. This module is the checklist-owned
 *     conversation surface that composes those pieces for the live CLI path.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Provider websocket prewarm is exposed through an optional provider
 *     startup hook; current adapters that do not implement it are skipped.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ManagedThread,
  NewManagedThread,
  SpawnManagedLiveAgentOptions,
  ThreadManagerOp,
} from "../agents/thread-manager.js";
import { readRolloutHistory, ThreadManager } from "../agents/thread-manager.js";
import type { ThreadId } from "../agents/registry.js";
import type { LiveAgent } from "../agents/control.js";
import type { AgentStatus } from "../agents/status.js";
import { forkSnapshotRollout } from "../agents/thread-rollout-truncation.js";
import { maybePrewarmAgentTaskRegistration } from "../session/agent-task-lifecycle.js";
import { scheduleProviderStartupPrewarm } from "../session/startup-prewarm.js";
import type { IndexSnapshot } from "../session/session-store.js";
import { SessionLock } from "../session/session-store.js";
import type { ResponseItem, RolloutItem } from "../session/rollout-item.js";
import type { LLMContentPart } from "../llm/types.js";
import { responseItemToLlmMessage } from "../session/message-history-conversion.js";
import { AsyncLock } from "../utils/async-lock.js";
import {
  reconstructFromRollout,
  type RolloutReconstruction,
} from "../session/rollout-reconstruction.js";
import {
  classifyDanglingToolUses,
  resolveDurableTurnsConfig,
  type ResumableTurn,
} from "../session/durable-turns.js";
import { isResumeReplaySafe } from "../tool-registry.js";
import type { Session, SessionState } from "../session/session.js";

export type ConversationPrewarmState =
  | "not_started"
  | "skipped"
  | "running"
  | "ready"
  | "failed";

export interface ConversationStartupPrewarmParams {
  readonly session: Session;
  readonly threadId: ThreadId;
}

export type ConversationStartupPrewarm = (
  params: ConversationStartupPrewarmParams,
) => Promise<void> | void;

export interface ConversationThreadManagerOptions {
  readonly threadManager?: ThreadManager;
  readonly prewarm?: ConversationStartupPrewarm;
  readonly now?: () => number;
}

export interface ConversationReplayOptions {
  readonly indexSnapshot?: IndexSnapshot;
  readonly emitSynthesized?: boolean;
  readonly appendSynthesizedRollout?: (item: RolloutItem) => void;
}

export interface RegisterConversationOptions extends ConversationReplayOptions {
  readonly rolloutItems?: ReadonlyArray<RolloutItem>;
  readonly prewarm?: boolean;
}

export interface ConversationReplayResult {
  readonly reconstruction: RolloutReconstruction;
  readonly appliedState: SessionState;
}

export interface ConversationThreadSnapshot {
  readonly threadId: ThreadId;
  readonly kind: ManagedThread["kind"];
  readonly status: AgentStatus;
  readonly agentPath?: ManagedThread["agentPath"];
  readonly parentThreadId?: ThreadId;
  readonly historyLength: number;
  readonly rolloutItemCount: number;
  readonly synthesizedEventCount: number;
  readonly orphanedTurnIds: ReadonlyArray<string>;
  readonly prewarm: ConversationPrewarmState;
  readonly prewarmError?: string;
  readonly replayError?: string;
  readonly lastReplayAtMs?: number;
  readonly lastSubmittedAtMs?: number;
}

interface MutableConversationThreadRecord {
  threadId: ThreadId;
  thread: ManagedThread;
  historyLength: number;
  rolloutItemCount: number;
  synthesizedEventCount: number;
  orphanedTurnIds: string[];
  prewarm: ConversationPrewarmState;
  prewarmError?: string;
  replayError?: string;
  lastReplayAtMs?: number;
  lastSubmittedAtMs?: number;
}

export class ConversationThreadManager extends ThreadManager {
  readonly threadManager: ThreadManager;
  private readonly prewarm: ConversationStartupPrewarm;
  private readonly now: () => number;
  private readonly sessionTurnLocks = new WeakMap<Session, AsyncLock<void>>();
  private forkSequence = 0;
  private readonly records = new Map<
    ThreadId,
    MutableConversationThreadRecord
  >();

  constructor(opts: ConversationThreadManagerOptions = {}) {
    super();
    this.threadManager = opts.threadManager ?? new ThreadManager();
    Object.defineProperty(this, "state", {
      value: this.threadManager.state,
      configurable: true,
    });
    this.prewarm = opts.prewarm ?? defaultStartupPrewarm;
    this.now = opts.now ?? (() => Date.now());
    this.threadManager.subscribeThreadCreated((threadId) => {
      this.refreshRecordFromThreadId(threadId);
    });
    this.refreshManagedThreadRecords();
  }

  override bindAgentControl(
    control: Parameters<ThreadManager["bindAgentControl"]>[0],
  ): void {
    this.threadManager.bindAgentControl(control);
  }

  override bindRegistry(
    registry: Parameters<ThreadManager["bindRegistry"]>[0],
  ): void {
    this.threadManager.bindRegistry(registry);
  }

  override registerRootSession(session: Session): ManagedThread {
    const thread = this.threadManager.hasThread(session.conversationId)
      ? this.threadManager.getThread(session.conversationId)
      : this.threadManager.registerRootSession(session);
    this.refreshRecordFromThread(thread);
    return thread;
  }

  async registerConversationRootSession(
    session: Session,
    opts: RegisterConversationOptions = {},
  ): Promise<ConversationThreadSnapshot> {
    const thread = this.registerRootSession(session);
    const record = this.upsertRecord(thread);

    if (opts.rolloutItems !== undefined) {
      await this.replayRolloutIntoSession(session, opts.rolloutItems, opts);
    }

    if (opts.prewarm === false) {
      record.prewarm = "skipped";
    } else {
      await this.runStartupPrewarm(session);
    }

    return this.snapshot(thread.threadId);
  }

  override async startThread(session: Session): Promise<NewManagedThread> {
    const started = await this.threadManager.startThread(session);
    this.upsertRecord(started.thread);
    return started;
  }

  override async startThreadWithTools(
    session: Session,
  ): Promise<NewManagedThread> {
    return this.startThread(session);
  }

  override async startThreadWithToolsAndServiceName(
    session: Session,
  ): Promise<NewManagedThread> {
    return this.startThread(session);
  }

  override async spawnLiveAgent(
    opts: SpawnManagedLiveAgentOptions,
  ): Promise<LiveAgent> {
    const live = await this.threadManager.spawnLiveAgent(opts);
    this.refreshRecordFromThreadId(live.agentId);
    return live;
  }

  override registerLiveAgent(
    live: LiveAgent,
    opts: { readonly parentThreadId?: ThreadId } = {},
  ): ManagedThread {
    const thread = this.threadManager.registerLiveAgent(live, opts);
    this.refreshRecordFromThread(thread);
    return thread;
  }

  override hasThread(threadId: ThreadId): boolean {
    return this.threadManager.hasThread(threadId);
  }

  override getThread(threadId: ThreadId): ManagedThread {
    return this.threadManager.getThread(threadId);
  }

  override async resumeThreadWithHistory(
    session: Session,
  ): Promise<NewManagedThread> {
    const started = await this.threadManager.resumeThreadWithHistory(session);
    this.upsertRecord(started.thread);
    return started;
  }

  override async resumeThreadFromRollout(
    session: Session,
  ): Promise<NewManagedThread> {
    return this.resumeThreadWithHistory(session);
  }

  override async resumeThreadFromRolloutWithSource(
    session: Session,
  ): Promise<NewManagedThread> {
    return this.resumeThreadWithHistory(session);
  }

  override async forkThread(
    ...args: Parameters<ThreadManager["forkThread"]>
  ): ReturnType<ThreadManager["forkThread"]> {
    const [session, snapshot] = args;
    const sourceRollout = session.rolloutStore?.readAll() ?? [];
    const forkedRollout = forkSnapshotRollout(
      sourceRollout,
      snapshot ?? { kind: "interrupted" },
    );
    const reconstruction = reconstructFromRollout(forkedRollout);
    const threadId = this.nextForkThreadId(session.conversationId);
    const thread = new ForkedConversationThread({
      threadId,
      sourceSession: session,
      turnLock: this.sessionTurnLock(session),
      history: reconstruction.history,
    });
    const started = await this.threadManager.finalizeThreadSpawn(thread);
    const record = this.upsertRecord(started.thread);
    record.historyLength = reconstruction.history.length;
    record.rolloutItemCount = forkedRollout.length;
    record.synthesizedEventCount = reconstruction.synthesizedEvents.length;
    record.orphanedTurnIds = [...reconstruction.orphanedTurnIds];
    delete record.replayError;
    record.lastReplayAtMs = this.now();
    return started;
  }

  override async forkThreadWithSource(
    ...args: Parameters<ThreadManager["forkThreadWithSource"]>
  ): ReturnType<ThreadManager["forkThreadWithSource"]> {
    return this.forkThread(...args);
  }

  override async spawnNewThreadWithSource(
    ...args: Parameters<ThreadManager["spawnNewThreadWithSource"]>
  ): ReturnType<ThreadManager["spawnNewThreadWithSource"]> {
    const started = await this.threadManager.spawnNewThreadWithSource(...args);
    this.upsertRecord(started.thread);
    return started;
  }

  override async spawnThreadWithSource(
    ...args: Parameters<ThreadManager["spawnThreadWithSource"]>
  ): ReturnType<ThreadManager["spawnThreadWithSource"]> {
    const started = await this.threadManager.spawnThreadWithSource(...args);
    this.upsertRecord(started.thread);
    return started;
  }

  override async finalizeThreadSpawn(
    ...args: Parameters<ThreadManager["finalizeThreadSpawn"]>
  ): ReturnType<ThreadManager["finalizeThreadSpawn"]> {
    const started = await this.threadManager.finalizeThreadSpawn(...args);
    this.refreshRecordFromThread(started.thread);
    return started;
  }

  async resumeConversationWithHistory(
    session: Session,
    rolloutItems: ReadonlyArray<RolloutItem>,
    opts: ConversationReplayOptions = {},
  ): Promise<NewManagedThread & { readonly replay: ConversationReplayResult }> {
    const started = await this.resumeThreadWithHistory(session);
    const replay = await this.replayRolloutIntoSession(
      session,
      rolloutItems,
      opts,
    );
    return { ...started, replay };
  }

  async replayRolloutIntoSession(
    session: Session,
    rolloutItems: ReadonlyArray<RolloutItem>,
    opts: ConversationReplayOptions = {},
  ): Promise<ConversationReplayResult> {
    const reconstruction = reconstructFromRollout(rolloutItems, {
      ...(opts.indexSnapshot !== undefined
        ? { indexSnapshot: opts.indexSnapshot }
        : {}),
    });
    const appliedState = await applyRolloutReconstructionToSession(
      session,
      reconstruction,
    );

    // GOAL #4b Stage 1 — stash the reconstruction so the prewarm hook can
    // consult its `resumableTurns` and resume-continue an orphaned in-flight
    // turn instead of discarding it.
    lastReconstructionBySession.set(session, reconstruction);

    if (opts.emitSynthesized === true) {
      emitSynthesizedEvents(session, reconstruction.synthesizedEvents, opts);
    }

    const thread = this.threadManager.hasThread(session.conversationId)
      ? this.threadManager.getThread(session.conversationId)
      : this.registerRootSession(session);
    const record = this.upsertRecord(thread);
    record.historyLength = appliedState.history.length;
    record.rolloutItemCount = rolloutItems.length;
    record.synthesizedEventCount = reconstruction.synthesizedEvents.length;
    record.orphanedTurnIds = [...reconstruction.orphanedTurnIds];
    delete record.replayError;
    record.lastReplayAtMs = this.now();

    return { reconstruction, appliedState };
  }

  async replayManagedThreadRollout(
    threadId: ThreadId,
    rolloutItems: ReadonlyArray<RolloutItem>,
    opts: ConversationReplayOptions = {},
  ): Promise<RolloutReconstruction> {
    const thread = this.threadManager.getThread(threadId);
    if (thread.kind === "root") {
      throw new Error(
        "managed thread rollout replay is for agent threads; use replayRolloutIntoSession for the root session",
      );
    }
    if (thread.replaceConversationHistory === undefined) {
      throw new Error(`managed thread ${threadId} does not support replay`);
    }

    const reconstruction = reconstructFromRollout(rolloutItems, {
      ...(opts.indexSnapshot !== undefined
        ? { indexSnapshot: opts.indexSnapshot }
        : {}),
    });
    thread.replaceConversationHistory(reconstruction.history);
    if (opts.emitSynthesized === true) {
      for (const item of reconstruction.synthesizedEvents) {
        opts.appendSynthesizedRollout?.(item);
      }
    }

    const record = this.upsertRecord(thread);
    record.historyLength = reconstruction.history.length;
    record.rolloutItemCount = rolloutItems.length;
    record.synthesizedEventCount = reconstruction.synthesizedEvents.length;
    record.orphanedTurnIds = [...reconstruction.orphanedTurnIds];
    delete record.replayError;
    record.lastReplayAtMs = this.now();
    return reconstruction;
  }

  async replayManagedThreadRolloutFromPath(
    threadId: ThreadId,
    opts: ConversationReplayOptions = {},
  ): Promise<RolloutReconstruction> {
    const thread = this.threadManager.getThread(threadId);
    const rolloutPath = thread.rolloutPath?.();
    if (rolloutPath === undefined) {
      throw new Error(`managed thread ${threadId} has no rollout path`);
    }
    return this.replayManagedThreadRollout(
      threadId,
      readRolloutHistory(rolloutPath),
      opts,
    );
  }

  async submitTurn(threadId: ThreadId, op: ThreadManagerOp): Promise<string> {
    const submit = async (): Promise<string> => {
      const result = await this.threadManager.sendOp(threadId, op);
      const record = this.refreshRecordFromThreadId(threadId);
      if (record) record.lastSubmittedAtMs = this.now();
      return result;
    };
    const thread = this.threadManager.getThread(threadId);
    if (thread instanceof ForkedConversationThread) return submit();
    const sourceSession = sourceSessionForManagedThread(thread);
    if (sourceSession === undefined) return submit();
    return this.sessionTurnLock(sourceSession).with(submit);
  }

  override async sendOp(
    threadId: ThreadId,
    op: ThreadManagerOp,
  ): Promise<string> {
    return this.submitTurn(threadId, op);
  }

  override async appendMessage(
    threadId: ThreadId,
    message: string,
  ): Promise<string> {
    return this.submitTurn(threadId, { type: "append_message", message });
  }

  override async refreshMcpServers(config: unknown): Promise<void> {
    await this.threadManager.refreshMcpServers(config);
  }

  override async shutdownAllThreadsBounded(
    timeoutMs: number,
  ): ReturnType<ThreadManager["shutdownAllThreadsBounded"]> {
    const report = await this.threadManager.shutdownAllThreadsBounded(timeoutMs);
    this.refreshManagedThreadRecords();
    return report;
  }

  async runStartupPrewarm(session: Session): Promise<ConversationPrewarmState> {
    const thread = this.threadManager.hasThread(session.conversationId)
      ? this.threadManager.getThread(session.conversationId)
      : this.registerRootSession(session);
    const record = this.upsertRecord(thread);
    record.prewarm = "running";
    delete record.prewarmError;
    try {
      await this.prewarm({ session, threadId: thread.threadId });
      record.prewarm = "ready";
    } catch (error) {
      record.prewarm = "failed";
      record.prewarmError =
        error instanceof Error ? error.message : String(error);
    }
    return record.prewarm;
  }

  snapshot(threadId: ThreadId): ConversationThreadSnapshot {
    this.refreshManagedThreadRecords();
    const record = this.records.get(threadId);
    if (!record) {
      const thread = this.threadManager.getThread(threadId);
      return snapshotFromRecord(this.refreshRecordFromThread(thread));
    }
    return snapshotFromRecord(record);
  }

  listSnapshots(): ReadonlyArray<ConversationThreadSnapshot> {
    this.refreshManagedThreadRecords();
    return Array.from(this.records.values()).map((record) =>
      snapshotFromRecord(record),
    );
  }

  override removeThread(threadId: ThreadId): ManagedThread | undefined {
    const removed = this.threadManager.removeThread(threadId);
    this.records.delete(threadId);
    return removed;
  }

  override listThreadIds(): readonly ThreadId[] {
    return this.threadManager.listThreadIds();
  }

  override subscribeThreadCreated(
    listener: Parameters<ThreadManager["subscribeThreadCreated"]>[0],
  ): ReturnType<ThreadManager["subscribeThreadCreated"]> {
    return this.threadManager.subscribeThreadCreated(listener);
  }

  override listAgentSubtreeThreadIds(rootThreadId: ThreadId): readonly ThreadId[] {
    return this.threadManager.listAgentSubtreeThreadIds(rootThreadId);
  }

  private upsertRecord(thread: ManagedThread): MutableConversationThreadRecord {
    const existing = this.records.get(thread.threadId);
    if (existing) {
      existing.thread = thread;
      return existing;
    }
    const record: MutableConversationThreadRecord = {
      threadId: thread.threadId,
      thread,
      historyLength: 0,
      rolloutItemCount: 0,
      synthesizedEventCount: 0,
      orphanedTurnIds: [],
      prewarm: "not_started",
    };
    this.records.set(thread.threadId, record);
    return record;
  }

  private refreshManagedThreadRecords(): void {
    const liveThreadIds = new Set(this.threadManager.listThreadIds());
    for (const threadId of liveThreadIds) {
      this.refreshRecordFromThreadId(threadId);
    }
    for (const threadId of this.records.keys()) {
      if (!liveThreadIds.has(threadId)) {
        this.records.delete(threadId);
      }
    }
  }

  private refreshRecordFromThreadId(
    threadId: ThreadId,
  ): MutableConversationThreadRecord | undefined {
    if (!this.threadManager.hasThread(threadId)) {
      this.records.delete(threadId);
      return undefined;
    }
    return this.refreshRecordFromThread(this.threadManager.getThread(threadId));
  }

  private refreshRecordFromThread(
    thread: ManagedThread,
  ): MutableConversationThreadRecord {
    this.maybeReplayManagedThreadFromRollout(thread);
    const record = this.upsertRecord(thread);
    const historyLength = thread.conversationHistoryLength?.();
    if (historyLength !== undefined) {
      record.historyLength = historyLength;
    }
    return record;
  }

  private maybeReplayManagedThreadFromRollout(thread: ManagedThread): void {
    if (thread.kind !== "agent") return;
    if ((thread.conversationHistoryLength?.() ?? 0) > 0) return;
    const rolloutPath =
      thread.rolloutPath?.() ?? this.findSiblingRolloutPath(thread.threadId);
    if (rolloutPath === undefined) return;
    let rolloutItems: RolloutItem[];
    try {
      rolloutItems = readRolloutHistory(rolloutPath);
    } catch (error) {
      this.recordReplayFailure(thread, error);
      return;
    }
    void this.replayManagedThreadRollout(thread.threadId, rolloutItems).catch(
      (error) => {
        this.recordReplayFailure(thread, error);
      },
    );
  }

  private recordReplayFailure(thread: ManagedThread, error: unknown): void {
    const record = this.upsertRecord(thread);
    record.replayError = error instanceof Error ? error.message : String(error);
    record.lastReplayAtMs = this.now();
  }

  private sessionTurnLock(session: Session): AsyncLock<void> {
    const existing = this.sessionTurnLocks.get(session);
    if (existing !== undefined) return existing;
    const lock = new AsyncLock<void>(undefined);
    this.sessionTurnLocks.set(session, lock);
    return lock;
  }

  private nextForkThreadId(conversationId: ThreadId): ThreadId {
    for (;;) {
      this.forkSequence += 1;
      const candidate =
        `${conversationId}-fork-${this.now()}-${this.forkSequence}` as ThreadId;
      if (!this.threadManager.hasThread(candidate)) return candidate;
    }
  }

  private findSiblingRolloutPath(threadId: ThreadId): string | undefined {
    for (const rootThreadId of this.threadManager.listThreadIds()) {
      const root = this.threadManager.getThread(rootThreadId);
      if (root.kind !== "root") continue;
      const rootRolloutPath = root.rolloutPath?.();
      if (rootRolloutPath === undefined) continue;
      const sessionsDir = dirname(dirname(rootRolloutPath));
      const childDir = join(sessionsDir, threadId);
      if (!existsSync(childDir)) continue;
      const rolloutFile = readdirSync(childDir)
        .filter((entry) => entry.startsWith("rollout-") && entry.endsWith(".jsonl"))
        .sort()
        .at(-1);
      if (rolloutFile !== undefined) return join(childDir, rolloutFile);
    }
    return undefined;
  }
}

async function applyRolloutReconstructionToSession(
  session: Session,
  reconstruction: RolloutReconstruction,
): Promise<SessionState> {
  return session.state.update((current) => {
    const next: SessionState = {
      ...current,
      history: [...reconstruction.history],
    };
    delete next.previousTurnSettings;
    delete next.referenceContextItem;
    if (reconstruction.previousTurnSettings !== undefined) {
      next.previousTurnSettings = reconstruction.previousTurnSettings;
    }
    if (reconstruction.referenceContextItem !== undefined) {
      next.referenceContextItem = reconstruction.referenceContextItem;
    }
    return { next, result: next };
  });
}

function emitSynthesizedEvents(
  session: Session,
  events: ReadonlyArray<RolloutItem>,
  opts: ConversationReplayOptions,
): void {
  for (const event of events) {
    if (event.type === "event_msg") {
      session.emit(event.payload);
    } else {
      opts.appendSynthesizedRollout?.(event);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// GOAL #4b Stage 1 — durable-turn resume.
//
// The reconstruction surfaces `ResumableTurn` descriptors; the live session
// they belong to is matched here. We stash the reconstruction per-session so
// the lightweight prewarm hook can consult it without changing its public
// signature.
// ─────────────────────────────────────────────────────────────────────

const lastReconstructionBySession = new WeakMap<Session, RolloutReconstruction>();

export interface DurableResumeAttempt {
  /** True when the turn was resumed-continued (vs left for a fresh turn). */
  readonly resumed: boolean;
  /** When not resumed, why — for telemetry / tests. */
  readonly reason?:
    | "disabled"
    | "no-checkpoint"
    | "build-mismatch"
    | "prefix-mismatch"
    | "lease-unavailable";
  /** Tool names the safe policy halted on (surfaced, not retried). */
  readonly halted?: ReadonlyArray<string>;
}

/**
 * Pick the orphaned turn (if any) that is eligible to resume-continue.
 * Stage 1 resumes at most ONE turn (the orphaned in-flight one). Returns
 * the descriptor plus the gating outcome.
 */
function selectResumableTurn(
  reconstruction: RolloutReconstruction,
  cfg: ReturnType<typeof resolveDurableTurnsConfig>,
): { turn?: ResumableTurn; reason?: DurableResumeAttempt["reason"] } {
  if (!cfg.resumeOnRestart) return { reason: "disabled" };
  const candidates = reconstruction.resumableTurns;
  if (candidates.length === 0) return { reason: "no-checkpoint" };
  // The orphaned in-flight turn is the highest-checkpointSeq descriptor.
  const turn = candidates.reduce((a, b) =>
    b.lastCheckpoint.checkpointSeq > a.lastCheckpoint.checkpointSeq ? b : a,
  );
  if (cfg.buildPinning && !turn.buildMatches) {
    return { turn, reason: "build-mismatch" };
  }
  if (!turn.historyPrefixValid) {
    return { turn, reason: "prefix-mismatch" };
  }
  return { turn };
}

/**
 * Attempt to resume-CONTINUE an interrupted turn from its last durable
 * checkpoint instead of discarding it and starting fresh.
 *
 * Safety gates (ALL must hold; any failure → caller falls back to today's
 * fresh turn): config enables resume, the build pin matches (§3.6), the
 * content prefix hash matches (§5), and the single-writer resume lease is
 * acquired (§3.5). Dangling `tool_use` blocks are classified by the
 * EXISTING `recoveryCategory` via `isResumeReplaySafe`: side-effecting /
 * interactive dangling tools HALT and surface (never auto-re-dispatch) —
 * the on-chain-safety property — while read-only ones re-run on the fresh
 * sampling request.
 *
 * Drives the resumed turn to completion. Returns the attempt outcome.
 */
export async function resumeTurnFromCheckpoint(
  session: Session,
  reconstruction: RolloutReconstruction,
): Promise<DurableResumeAttempt> {
  const cfg = resolveDurableTurnsConfig(
    (session as { readonly config?: unknown }).config,
  );
  const { turn, reason } = selectResumableTurn(reconstruction, cfg);
  if (turn === undefined || reason !== undefined) {
    return reason !== undefined ? { resumed: false, reason } : { resumed: false };
  }

  // Single-writer resume lease — reuse the SessionLock flock keyed per
  // turnId so two concurrent resumers cannot both re-drive the turn. The
  // lease path is distinct from the session-store rollout lock and from the
  // /resume cold-rollout handoff (a session-id slot), so it composes with
  // both rather than fighting them.
  let lease: SessionLock | undefined;
  if (cfg.requireLease) {
    const rolloutPath = session.rolloutStore?.rolloutPath;
    if (rolloutPath !== undefined) {
      lease = new SessionLock(`${rolloutPath}.resume-${turn.turnId}.lock`);
      try {
        lease.acquire();
      } catch {
        return { resumed: false, reason: "lease-unavailable" };
      }
    }
  }

  try {
    // Classify dangling tool_use blocks (no persisted result) under the
    // safe-by-default policy. Over-halt is acceptable; under-halt is NOT.
    const toolByName = new Map(
      session.services.registry.tools.map((t) => [t.name, t] as const),
    );
    const { replaySafe, mustHalt } = classifyDanglingToolUses(
      turn.danglingToolUses,
      (toolName) => {
        const tool = toolByName.get(toolName);
        if (tool === undefined) return false; // unknown → side-effecting → halt
        return isResumeReplaySafe(tool as Parameters<typeof isResumeReplaySafe>[0]);
      },
    );
    const haltedSideEffectingTools = [
      ...new Set(mustHalt.map((d) => d.toolName)),
    ];
    const danglingPairings = [
      ...mustHalt.map((d) => ({
        callId: d.callId,
        toolName: d.toolName,
        halt: true,
      })),
      ...replaySafe.map((d) => ({
        callId: d.callId,
        toolName: d.toolName,
        halt: false,
      })),
    ];

    const reconstructedPrefix = reconstruction.history.slice(
      0,
      turn.lastCheckpoint.persistedMessageCount,
    );
    const history = reconstructedPrefix.map((item) =>
      responseItemToLlmMessage(item),
    );

    const iter = session.runTurn("", {
      subId: turn.turnId,
      history,
      displayUserMessage: null,
      resume: {
        turnId: turn.turnId,
        fromIteration: turn.lastCheckpoint.iterationIndex,
        fromCheckpointSeq: turn.lastCheckpoint.checkpointSeq,
        persistedMessageCount: turn.lastCheckpoint.persistedMessageCount,
        restoreSlice: turn.lastCheckpoint
          .resumableState as unknown as import("../session/turn-state.js").TurnCheckpointSlice,
        ...(haltedSideEffectingTools.length > 0
          ? { haltedSideEffectingTools }
          : {}),
        ...(danglingPairings.length > 0 ? { danglingPairings } : {}),
      },
    });
    // Drive the resumed turn to completion.
    while (true) {
      const next = await iter.next();
      if (next.done) break;
    }
    return {
      resumed: true,
      ...(haltedSideEffectingTools.length > 0
        ? { halted: haltedSideEffectingTools }
        : {}),
    };
  } finally {
    lease?.release();
  }
}

async function defaultStartupPrewarm({
  session,
  threadId,
}: ConversationStartupPrewarmParams): Promise<void> {
  // GOAL #4b Stage 1 — if reconstruction surfaced an orphaned in-flight turn
  // with a valid durable checkpoint (and the build/prefix/lease gates pass),
  // resume-CONTINUE it instead of discarding it for a fresh default turn.
  // Any failure or absence falls through to EXACTLY today's behavior —
  // byte-identical for sessions with no checkpoint (backward compat).
  const reconstruction = lastReconstructionBySession.get(session);
  if (reconstruction !== undefined) {
    try {
      const attempt = await resumeTurnFromCheckpoint(session, reconstruction);
      if (attempt.resumed) {
        await scheduleProviderStartupPrewarm(session, threadId);
        return;
      }
    } catch {
      // Resume is strictly best-effort; never let it block boot. Fall
      // through to the legacy fresh-turn prewarm.
    }
  }
  session.newDefaultTurn();
  await scheduleProviderStartupPrewarm(session, threadId);
  try {
    await maybePrewarmAgentTaskRegistration(session);
  } catch {
    /* startup prewarm is best-effort; the first real turn retries */
  }
}

function snapshotFromRecord(
  record: MutableConversationThreadRecord,
): ConversationThreadSnapshot {
  const thread = record.thread;
  return {
    threadId: record.threadId,
    kind: thread.kind,
    status: thread.status(),
    ...(thread.agentPath !== undefined ? { agentPath: thread.agentPath } : {}),
    ...(thread.parentThreadId !== undefined
      ? { parentThreadId: thread.parentThreadId }
      : {}),
    historyLength: record.historyLength,
    rolloutItemCount: record.rolloutItemCount,
    synthesizedEventCount: record.synthesizedEventCount,
    orphanedTurnIds: [...record.orphanedTurnIds],
    prewarm: record.prewarm,
    ...(record.prewarmError !== undefined
      ? { prewarmError: record.prewarmError }
      : {}),
    ...(record.replayError !== undefined ? { replayError: record.replayError } : {}),
    ...(record.lastReplayAtMs !== undefined
      ? { lastReplayAtMs: record.lastReplayAtMs }
      : {}),
    ...(record.lastSubmittedAtMs !== undefined
      ? { lastSubmittedAtMs: record.lastSubmittedAtMs }
      : {}),
  };
}

class ForkedConversationThread implements ManagedThread {
  readonly threadId: ThreadId;
  readonly agentPath = "/root" as ManagedThread["agentPath"];
  readonly kind = "root" as const;
  private readonly sourceSessionRef: Session;
  private readonly turnLock: AsyncLock<void>;
  private history: ResponseItem[];
  private statusValue: AgentStatus;
  private readonly listeners = new Set<(status: AgentStatus) => void>();
  private submitQueue: Promise<void> = Promise.resolve();

  constructor(opts: {
    readonly threadId: ThreadId;
    readonly sourceSession: Session;
    readonly turnLock: AsyncLock<void>;
    readonly history: ReadonlyArray<ResponseItem>;
  }) {
    this.threadId = opts.threadId;
    this.sourceSessionRef = opts.sourceSession;
    this.turnLock = opts.turnLock;
    this.history = cloneResponseHistory(opts.history);
    this.statusValue = {
      status: "completed",
      turnId: this.threadId,
      endedAtMs: Date.now(),
    };
  }

  sourceSession(): Session {
    return this.sourceSessionRef;
  }

  status(): AgentStatus {
    return this.statusValue;
  }

  subscribeStatus(listener: (status: AgentStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.statusValue);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submit(op: ThreadManagerOp): Promise<string> {
    const run = this.submitQueue.then(() =>
      this.turnLock.with(() => this.submitLocked(op)),
    );
    this.submitQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async appendMessage(message: string): Promise<string> {
    return this.submit({ type: "append_message", message });
  }

  async shutdown(): Promise<void> {
    this.setStatus({ status: "shutdown", endedAtMs: Date.now() });
    return;
  }

  conversationHistoryLength(): number {
    return this.history.length;
  }

  replaceConversationHistory(
    history: ReadonlyArray<ResponseItem>,
  ): void {
    this.history = cloneResponseHistory(history);
  }

  private async submitLocked(op: ThreadManagerOp): Promise<string> {
    switch (op.type) {
      case "user_input":
        await this.runForkTurn(op.input);
        return this.threadId;
      case "append_message":
        this.history = [
          ...this.history,
          { role: "user", content: op.message },
        ];
        return this.threadId;
      case "clear_conversation_history":
        this.history = [];
        this.sourceSessionRef.clearProviderResponseId();
        return this.threadId;
      case "inter_agent_communication":
        this.history = [
          ...this.history,
          { role: "user", content: op.communication.content },
        ];
        if (op.communication.triggerTurn) {
          await this.runForkTurn("");
        }
        return this.threadId;
      case "interrupt":
        this.sourceSessionRef.abortTerminal("user_interrupt");
        this.setStatus({
          status: "interrupted",
          turnId: this.threadId,
          endedAtMs: Date.now(),
          reason: op.reason ?? "interrupted",
        });
        return this.threadId;
      case "shutdown":
        await this.shutdown();
        return this.threadId;
      case "refresh_mcp_servers":
        await this.sourceSessionRef.services.mcpManager.refreshFromConfig?.(
          op.config,
        );
        return this.threadId;
    }
  }

  private async runForkTurn(
    input: string | readonly LLMContentPart[],
  ): Promise<void> {
    const turnId = this.sourceSessionRef.nextInternalSubId();
    this.setStatus({
      status: "running",
      turnId,
      startedAtMs: Date.now(),
    });
    const originalState = cloneSessionState(
      this.sourceSessionRef.state.unsafePeek(),
    );
    try {
      await this.sourceSessionRef.withRolloutPersistenceSuspended(async () => {
        const ctx = this.sourceSessionRef.newDefaultTurnWithSubId(turnId);
        for await (const event of this.sourceSessionRef.runTurn(input, {
          ctx,
          history: cloneLlmHistory(this.history),
        })) {
          this.sourceSessionRef.emitPhaseEvent(event);
        }
      });
      const forkState = this.sourceSessionRef.state.unsafePeek();
      this.history = cloneResponseHistory(forkState.history as ResponseItem[]);
      this.setStatus({
        status: "completed",
        turnId,
        endedAtMs: Date.now(),
      });
    } catch (error) {
      this.setStatus({
        status: "errored",
        turnId,
        endedAtMs: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await this.sourceSessionRef.state.swap(originalState);
    }
  }

  private setStatus(status: AgentStatus): void {
    this.statusValue = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }
}

function sourceSessionForManagedThread(thread: ManagedThread): Session | undefined {
  const sourceSession = (thread as { sourceSession?: unknown }).sourceSession;
  if (typeof sourceSession !== "function") return undefined;
  const session = sourceSession.call(thread);
  return isSessionLike(session) ? session : undefined;
}

function isSessionLike(value: unknown): value is Session {
  return (
    typeof value === "object" &&
    value !== null &&
    "conversationId" in value &&
    "state" in value &&
    "runTurn" in value
  );
}

function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    history: cloneResponseHistory(state.history as ResponseItem[]),
    ...(state.previousTurnSettings !== undefined
      ? { previousTurnSettings: { ...state.previousTurnSettings } }
      : {}),
    ...(state.initialTokenUsage !== undefined
      ? { initialTokenUsage: { ...state.initialTokenUsage } }
      : {}),
    ...(state.totalTokenUsage !== undefined
      ? { totalTokenUsage: { ...state.totalTokenUsage } }
      : {}),
  };
}

function cloneResponseHistory(
  history: ReadonlyArray<ResponseItem>,
): ResponseItem[] {
  return history.map((message) => ({
    ...message,
    ...(Array.isArray(message.content)
      ? { content: message.content.map((part) => ({ ...part })) }
      : {}),
  }));
}

function cloneLlmHistory(history: ReadonlyArray<ResponseItem>) {
  return history.map(responseItemToLlmMessage);
}
