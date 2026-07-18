/**
 * AgentControl — subagent lifecycle + control plane.
 *
 * Port of reference runtime `core/src/agent/control.rs` (1,214 LOC). Covers: full
 * lifecycle (spawn/interrupt/shutdown/resume), parent→child message
 * routing (assign_task / send_message / inter-agent communication),
 * metadata + subtree queries (list_agents / subtree descendants /
 * token totals / environment context), completion watcher, fork-mode
 * spawn helpers, and subtree genealogy bookkeeping.
 *
 * Architecture notes:
 *   - Rollout-driven rehydrate (`resumeAgentFromRollout`) restores
 *     live handles + descendant tree shape from the rollout-store-
 *     owned spawn-edge snapshot.
 *   - Spawn-edge tracking is owned by `RolloutStore` (durable edge
 *     snapshot). AgentControl writes/reads through that API and does
 *     not keep a second persistence owner in memory.
 *
 * Invariants wired:
 *   I-1  (MAX_AGENT_DEPTH=1) — spawn rejects `childDepth > cap`.
 *        Matches reference runtime's `DEFAULT_AGENT_MAX_DEPTH=1`.
 *   I-5  (bidirectional mailbox) — routing methods (assign_task /
 *        append_message / IAC / interrupt) go through the child's
 *        `downInbox` with `direction: 'down'`.
 *   I-32 (parent-interrupt race) — cancellation token from the
 *        reservation; `spawn()` validates `parent.token.aborted`
 *        before finalizing; on cancellation, undo slot + send
 *        synthetic interrupt.
 *   I-37 (path collision) — registry.reserveAgentPath throws on dup.
 *   I-63 (atomic slot acquisition) — registry.reserveSpawnSlot.
 *
 * @module
 */

import { emitError, emitWarning } from "../session/event-log.js";
import type { LLMMessage, LLMUsage } from "../llm/types.js";
import type { ThreadSpawnEdgeStatus } from "../session/rollout-store.js";
import type { Session } from "../session/session.js";
import { Mailbox, MailboxClosedError } from "./mailbox.js";
import {
  AgentIdExistsError,
  AgentPathExistsError,
  InvalidAgentMetadataError,
  ROOT_AGENT_PATH,
  type AgentPath,
  type AgentRegistry,
  type AgentMetadata,
  type ThreadId,
  buildChildMetadata,
  depthOfAgentPath,
  joinAgentPath,
  normalizeAgentMetadata,
  normalizeAgentNameForPath,
  normalizeAgentRoleMetadata,
  resolveAgentPath,
} from "./registry.js";
import {
  agentRoleFingerprint,
  allocateNickname,
  applyRoleToConfig,
  assertAgentRoleWorkspaceMatches,
  createAgentRoleWorkspace,
  getAgentRoleByExactName,
  releaseNickname,
  requireAgentRole,
  normalizeAgentRoleWorkspace,
  resolveAgentRole,
  type AgentRole,
  type AgentRoleWorkspace,
  type RoleShapedConfig,
} from "./role.js";
import { canonicalAgentRoleName } from "./role-presentation.js";
import { AdmissionDeniedError } from "../budget/admission-client.js";

/**
 * Resolve the role for a RESUMED agent fail-closed. A named-but-unknown
 * persisted role (renamed/removed role, or a workspace override that fell
 * through to a built-in with the same name) must NOT silently resume with a
 * different prompt or tool policy.
 */
function resolveResumedAgentRole(
  workspace: AgentRoleWorkspace,
  metadata: Pick<
    AgentMetadata,
    "agentRole" | "agentRoleWorkspaceId" | "agentRoleFingerprint"
  >,
): AgentRole {
  const normalized = normalizeAgentRoleMetadata(metadata);
  const roleName = normalized.agentRole;
  if (roleName === undefined) return resolveAgentRole(workspace, roleName);
  assertAgentRoleWorkspaceMatches(workspace, normalized.agentRoleWorkspaceId);
  const known = getAgentRoleByExactName(workspace, roleName);
  if (!known) {
    throw new InvalidAgentMetadataError(
      `cannot resume unknown agent role: ${roleName}`,
    );
  }
  const expectedFingerprint = normalized.agentRoleFingerprint;
  const actualFingerprint = agentRoleFingerprint(known);
  if (
    expectedFingerprint === undefined ||
    expectedFingerprint !== actualFingerprint
  ) {
    throw new InvalidAgentMetadataError(
      `cannot resume changed agent role: ${roleName}`,
    );
  }
  return known;
}
import {
  AgentStatusTracker,
  formatSubagentNotification,
  isFinal,
  type AgentStatus,
} from "./status.js";
import type { ThreadManager } from "./thread-manager.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * I-1 default cap. Overrideable via `config.agent_max_depth` or the
 * `AGENC_AGENT_MAX_DEPTH` env var (test/ops escape hatch).
 *
 * Semantics: `spawn` rejects when `childDepth > cap`, so the cap value is the
 * deepest allowed child depth. Cap=1 means root (depth 0) may spawn one
 * subagent layer; depth 2 is rejected.
 */
const DEFAULT_MAX_AGENT_DEPTH = 1;

function asPositiveIntegerDepth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function parseDepthOverride(raw: string | undefined): number | undefined {
  if (!raw) return DEFAULT_MAX_AGENT_DEPTH;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function resolveDefaultMaxDepth(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parseDepthOverride(env.AGENC_AGENT_MAX_DEPTH) ?? DEFAULT_MAX_AGENT_DEPTH
  );
}

export const MAX_AGENT_DEPTH: number = resolveDefaultMaxDepth();

function resolveSessionMaxDepth(session: Session): number | undefined {
  const configDepth = asPositiveIntegerDepth(
    (session.config as { agent_max_depth?: unknown } | undefined)
      ?.agent_max_depth,
  );
  if (configDepth !== undefined) return configDepth;

  const originalDepth = asPositiveIntegerDepth(
    (
      session.sessionConfiguration?.originalConfigDoNotUse as
        { agent_max_depth?: unknown } | undefined
    )?.agent_max_depth,
  );
  if (originalDepth !== undefined) return originalDepth;

  return undefined;
}

function getChildBaseConfig(session: Session): RoleShapedConfig | undefined {
  return session.config as unknown as RoleShapedConfig;
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

export class MaxDepthExceededError extends Error {
  constructor(
    public readonly depth: number,
    public readonly cap: number,
  ) {
    super(`subagent depth ${depth} exceeds cap ${cap}`);
    this.name = "MaxDepthExceededError";
  }
}

class SpawnRaceAbortedError extends Error {
  constructor(public readonly parentPath: AgentPath) {
    super(`spawn aborted — parent ${parentPath} interrupted mid-spawn`);
    this.name = "SpawnRaceAbortedError";
  }
}

export class ThreadNotFoundError extends Error {
  constructor(public readonly threadId: ThreadId) {
    super(`thread ${threadId} not found`);
    this.name = "ThreadNotFoundError";
  }
}

export class AgentReferenceUnresolvedError extends Error {
  constructor(public readonly reference: string) {
    super(`agent reference cannot be resolved: ${reference}`);
    this.name = "AgentReferenceUnresolvedError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// Fork-mode + spawn option types (reference runtime `SpawnAgentForkMode` /
// `SpawnAgentOptions`; `control.rs:46-55`).
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of reference runtime `SpawnAgentForkMode` (`control.rs:46`). AgenC's
 * fork-context module owns the richer `ForkMode` used by delegate.ts;
 * this enum matches the narrower reference runtime spawn-entry shape.
 */
export type SpawnAgentForkMode =
  | { readonly kind: "full_history" }
  | { readonly kind: "last_n_turns"; readonly n: number };

/**
 * Port of reference runtime `SpawnAgentOptions` (`control.rs:52`).
 */
export interface SpawnAgentOptions {
  readonly threadId?: ThreadId;
  readonly roleName?: string;
  readonly agentName?: string;
  readonly agentPath?: AgentPath;
  readonly preferredNickname?: string;
  readonly depthCap?: number;
  /** Caller-supplied metadata fields to merge into the allocated
   *  record (e.g. inherited `agentRole` from a resume payload). */
  readonly metadata?: {
    readonly [K in keyof AgentMetadata]?: AgentMetadata[K];
  };
  readonly forkParentSpawnCallId?: string;
  readonly forkMode?: SpawnAgentForkMode;
}

/**
 * Port of reference runtime `ListedAgent` (`control.rs:64`).
 */
export interface ListedAgent {
  readonly agentName: string;
  readonly agentStatus: AgentStatus;
  readonly lastTaskMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Live handle an AgentControl returns on spawn
// ─────────────────────────────────────────────────────────────────────

export interface LiveAgent {
  readonly agentId: ThreadId;
  readonly agentPath: AgentPath;
  readonly role: AgentRole;
  readonly depth: number;
  readonly nickname: string;
  readonly status: AgentStatusTracker;
  /** Mailbox for child→parent messages (up direction). */
  readonly upInbox: Mailbox;
  /** Mailbox for parent→child messages (down direction). */
  readonly downInbox: Mailbox;
  /** Per-agent AbortController — triggered by `interrupt()`. */
  readonly abortController: AbortController;
  /** Cached metadata snapshot at spawn time (reference runtime `LiveAgent.metadata`). */
  readonly metadata: AgentMetadata;
  /** Live child transcript, updated by the child run loop. */
  readonly messages: LLMMessage[];
  /** Scratch memory entries associated with this child. */
  readonly memoryEntries: AgentMemoryEntry[];
  /** Cumulative child token usage. */
  readonly tokenUsage: AgentTokenUsage;
  /** Effective child configuration snapshot once the child session is built. */
  configSnapshot?: Record<string, unknown>;
  /** Local rollout path for the live child session once initialized. */
  rolloutPath?: string;
}

export interface AgentMemoryEntry {
  readonly key: string;
  readonly value: unknown;
  readonly at: number;
}

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ─────────────────────────────────────────────────────────────────────
// AgentControl
// ─────────────────────────────────────────────────────────────────────

export interface AgentControlOpts {
  readonly session: Session;
  readonly registry: AgentRegistry;
  /** Override MAX_AGENT_DEPTH for this session (tests/config). */
  readonly maxDepth?: number;
  readonly threadManager?: ThreadManager;
}

export class AgentControl {
  private readonly session: Session;
  private readonly registry: AgentRegistry;
  private readonly maxDepth: number;
  /** Immutable role trust domain; execution cwd may move independently. */
  readonly roleWorkspace: AgentRoleWorkspace;
  private readonly live = new Map<ThreadId, LiveAgent>();
  /** Cancellation tokens scoped to parents — I-32. */
  private readonly parentTokens = new Map<AgentPath, AbortController>();
  /** Registered session-root thread id (reference runtime `register_session_root`). */
  private rootThreadId: ThreadId | undefined;
  /** Parent linkage: childId → parentId (for open_thread_spawn_children
   *  and subtree cascade, since we have no state-db in-tree yet). */
  private readonly parentOf = new Map<ThreadId, ThreadId>();
  private threadManager: ThreadManager | undefined;

  constructor(opts: AgentControlOpts) {
    this.session = opts.session;
    this.registry = opts.registry;
    const sessionRoleWorkspace = (
      opts.session as Session & { readonly roleWorkspace?: AgentRoleWorkspace }
    ).roleWorkspace;
    this.roleWorkspace = sessionRoleWorkspace
      ? normalizeAgentRoleWorkspace(sessionRoleWorkspace)
      : createAgentRoleWorkspace(opts.session.sessionConfiguration.cwd);
    this.maxDepth =
      opts.maxDepth ?? resolveSessionMaxDepth(opts.session) ?? MAX_AGENT_DEPTH;
    this.threadManager = opts.threadManager;
  }

  bindThreadManager(threadManager: ThreadManager): void {
    this.threadManager = threadManager;
    threadManager.bindAgentControl(this);
  }

  assertRoleWorkspace(workspace: AgentRoleWorkspace): void {
    assertAgentRoleWorkspaceMatches(this.roleWorkspace, workspace.id);
  }

  /**
   * Validate the complete persisted role identity before lifecycle mutation.
   * Exact-name lookup deliberately excludes public alias fallback.
   */
  assertAgentMetadataRoleWorkspace(
    metadata: Pick<
      AgentMetadata,
      "agentRole" | "agentRoleWorkspaceId" | "agentRoleFingerprint"
    >,
  ): string {
    const normalized = normalizeAgentRoleMetadata(metadata);
    if (normalized.agentRole === undefined) {
      throw new InvalidAgentMetadataError("agent role provenance is missing");
    }
    return resolveResumedAgentRole(this.roleWorkspace, normalized).name;
  }

  // ─────────────────────────────────────────────────────────────────
  // Spawn
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime `spawn_agent_internal` (control.rs:~310).
   *
   * Lifecycle:
   *   1. I-1 depth check.
   *   2. Reserve slot (I-63) — atomic under registry.slotLock.
   *   3. Build child metadata + allocate nickname.
   *   4. I-37 path collision check.
   *   5. I-32 cancellation race check — parent may have been
   *      interrupted mid-spawn; if so, release slot + throw.
   *   6. Wire up mailboxes + status tracker + abortController.
   *   7. Finalize reservation (registers metadata).
   *   8. Persist the spawn edge; roll back the finalized reservation on error.
   *   9. Publish the live handle and mailboxes.
   *
   * Returns a `LiveAgent` handle the caller (run-agent.ts) uses to
   * drive the child session.
   */
  async spawn(opts: {
    readonly parentPath: AgentPath;
    readonly roleName?: string;
    readonly threadId?: ThreadId;
    readonly agentName?: string;
    readonly agentPath?: AgentPath;
    readonly preferredNickname?: string;
    readonly depthCap?: number;
    /** Fail-closed role identity for restart/rehydration spawns. */
    readonly expectedRoleProvenance?: Pick<
      AgentMetadata,
      "agentRole" | "agentRoleWorkspaceId" | "agentRoleFingerprint"
    >;
  }): Promise<LiveAgent> {
    if (this.threadManager) {
      return this.threadManager.spawnLiveAgent(opts);
    }
    return this.spawnLiveAgentForThreadManager(opts);
  }

  async spawnLiveAgentForThreadManager(opts: {
    readonly parentPath: AgentPath;
    readonly roleName?: string;
    readonly threadId?: ThreadId;
    readonly agentName?: string;
    readonly agentPath?: AgentPath;
    readonly preferredNickname?: string;
    readonly depthCap?: number;
    readonly expectedRoleProvenance?: Pick<
      AgentMetadata,
      "agentRole" | "agentRoleWorkspaceId" | "agentRoleFingerprint"
    >;
  }): Promise<LiveAgent> {
    const parentDepth = depthOfAgentPath(opts.parentPath);
    const childDepth = parentDepth + 1;
    const depthCap = opts.depthCap ?? this.maxDepth;
    const expectedRoleProvenance =
      opts.expectedRoleProvenance !== undefined
        ? normalizeAgentRoleMetadata(opts.expectedRoleProvenance)
        : undefined;
    if (
      expectedRoleProvenance !== undefined &&
      expectedRoleProvenance.agentRole === undefined
    ) {
      throw new InvalidAgentMetadataError("agent role provenance is missing");
    }
    const role =
      expectedRoleProvenance !== undefined
        ? resolveResumedAgentRole(this.roleWorkspace, expectedRoleProvenance)
        : requireAgentRole(this.roleWorkspace, opts.roleName);
    if (
      opts.roleName !== undefined &&
      expectedRoleProvenance !== undefined &&
      role.name !== opts.roleName
    ) {
      throw new InvalidAgentMetadataError(
        `expected agent role ${role.name} does not match requested role ${opts.roleName}`,
      );
    }
    const baseChildConfig = getChildBaseConfig(this.session) ?? {};
    void applyRoleToConfig(role, baseChildConfig);
    const roleFingerprint = agentRoleFingerprint(role);
    if (
      expectedRoleProvenance !== undefined &&
      roleFingerprint !== expectedRoleProvenance.agentRoleFingerprint
    ) {
      throw new InvalidAgentMetadataError(
        `cannot resume changed agent role: ${role.name}`,
      );
    }
    const explicitAgentPath =
      opts.agentPath ??
      (opts.agentName !== undefined
        ? joinAgentPath(opts.parentPath, opts.agentName)
        : undefined);
    const threadId = opts.threadId ?? crypto.randomUUID();

    if (childDepth > depthCap) {
      emitError(this.session.eventLog, this.session.nextInternalSubId(), {
        cause: "max_depth_exceeded",
        message: `subagent depth ${childDepth} exceeds cap ${depthCap}`,
      });
      throw new MaxDepthExceededError(childDepth, depthCap);
    }

    // An explicit id is part of the durable edge identity, not merely an
    // in-process registry key. Preflight gives a deterministic error; the
    // create-only SQLite insert remains the race-proof commit check.
    if (
      opts.threadId !== undefined &&
      this.session.rolloutStore?.getThreadSpawnEdge(opts.threadId) !== undefined
    ) {
      throw new AgentIdExistsError(opts.threadId);
    }

    const admission = this.session.services?.executionAdmission;
    if (
      admission === undefined &&
      this.session.services?.admissionRequired !== false
    ) {
      throw new AdmissionDeniedError("admission_kernel_unavailable");
    }
    const parentToken = this.parentTokens.get(opts.parentPath);
    const spawnLease =
      admission === undefined
        ? undefined
        : await admission.acquire(
            {
              stepId: `spawn:${threadId}`,
              kind: "spawn",
              sessionId: this.session.conversationId,
              parentScopeId: opts.parentPath,
              maxInputTokens: 0,
              maxOutputTokens: 0,
              maxCostUsd: 0,
            },
            parentToken?.signal,
          );
    const finishSpawnAdmission = (
      stage: string,
      settle: (reservationId: string) => void,
      recoverSettlement?: (reservationId: string) => void,
    ): void => {
      if (spawnLease === undefined) return;
      const reservationId = spawnLease.reservation.reservationId;
      const failures: unknown[] = [];
      try {
        settle(reservationId);
      } catch (error) {
        failures.push(error);
        if (recoverSettlement !== undefined) {
          try {
            recoverSettlement(reservationId);
          } catch (recoveryError) {
            failures.push(recoveryError);
          }
        }
      } finally {
        try {
          admission?.acknowledgeCompletion(reservationId);
        } catch (acknowledgementError) {
          failures.push(acknowledgementError);
        }
      }
      if (failures.length > 0) {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "spawn_admission_settlement_failed",
          `spawn ${threadId} admission settlement failed at ${stage}: ${failures
            .map((error) =>
              error instanceof Error ? error.message : String(error),
            )
            .join("; ")}`,
        );
      }
    };

    // I-63: atomic local slot acquisition. If the in-memory guard rejects the
    // spawn, release the still-pre-dispatch durable reservation immediately.
    let reservation: Awaited<ReturnType<AgentRegistry["reserveSpawnSlot"]>>;
    try {
      reservation = await this.registry.reserveSpawnSlot();
    } catch (error) {
      finishSpawnAdmission("local_slot_reservation", (reservationId) => {
        admission?.void(reservationId, "session_concurrency_limit");
      });
      throw error;
    }

    let nickname!: string;
    let releaseNicknameOnRollback = false;
    let metadata!: AgentMetadata;
    try {
      if (explicitAgentPath !== undefined) {
        reservation.reserveAgentPath(explicitAgentPath);
      }
      if (opts.preferredNickname !== undefined) {
        nickname = opts.preferredNickname;
        releaseNicknameOnRollback = !this.registry.hasNickname(nickname);
      } else {
        nickname = allocateNickname(role, this.registry);
        releaseNicknameOnRollback = true;
      }
      metadata = buildChildMetadata({
        agentId: threadId,
        parentPath: opts.parentPath,
        role,
        roleWorkspaceId: this.roleWorkspace.id,
        roleFingerprint,
        nickname,
        depth: childDepth,
        ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
        ...(explicitAgentPath !== undefined
          ? { agentPath: explicitAgentPath }
          : {}),
      });
      if (explicitAgentPath === undefined && metadata.agentPath !== undefined) {
        reservation.reserveAgentPath(metadata.agentPath);
      }

      // I-32: check cancellation before finalize. If the parent was
      // interrupted while we were allocating, roll back + throw.
      const parentToken = this.parentTokens.get(opts.parentPath);
      if (parentToken?.signal.aborted || spawnLease?.signal.aborted) {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "spawn_race_aborted",
          `parent ${opts.parentPath} interrupted mid-spawn`,
        );
        throw new SpawnRaceAbortedError(opts.parentPath);
      }

      // I-37: reserved path ownership check + finalize. finalize() throws
      // AgentPathExistsError on a path owned by another live/reserved agent.
      reservation.finalize(metadata);
    } catch (err) {
      try {
        reservation.release();
        // gaphunt3 #46: reservation.release() rolls back the slot + reserved
        // path but NOT the nickname. A nickname freshly allocated here (no
        // preferredNickname) leaks into the registry's usedNicknames pool on
        // any rollback (I-32 abort, path collision). Release it on the failure
        // path so it returns to the pool.
        if (releaseNicknameOnRollback && nickname) {
          releaseNickname(this.registry, nickname);
        }
      } finally {
        finishSpawnAdmission("metadata_precommit", (reservationId) => {
          admission?.void(reservationId, "spawn_failed_before_commit");
        });
      }
      if (err instanceof AgentPathExistsError) {
        emitError(this.session.eventLog, this.session.nextInternalSubId(), {
          cause: "agent_path_collision",
          message: err.message,
        });
      }
      throw err;
    }

    const upInbox = new Mailbox({
      threadId,
      onBackpressureStreak: (count) => {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "mailbox_backpressure",
          `child→parent mailbox dropped ${count} messages (thread=${threadId})`,
        );
      },
    });
    const downInbox = new Mailbox({
      threadId: `${threadId}-down`,
      onBackpressureStreak: (count) => {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "mailbox_backpressure",
          `parent→child mailbox dropped ${count} messages (thread=${threadId})`,
        );
      },
    });

    const agent: LiveAgent = {
      agentId: threadId,
      agentPath: metadata.agentPath!,
      role,
      depth: childDepth,
      nickname,
      status: new AgentStatusTracker(),
      upInbox,
      downInbox,
      abortController: new AbortController(),
      metadata,
      messages: [],
      memoryEntries: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };

    const publishAgent = (): void => {
      this.session.childInboxes.set(threadId, upInbox as unknown as never);
      this.live.set(threadId, agent);
      const parentId = this.agentIdForPath(opts.parentPath);
      if (parentId) {
        this.parentOf.set(threadId, parentId);
      }
      if (!this.parentTokens.has(agent.agentPath)) {
        this.parentTokens.set(agent.agentPath, agent.abortController);
      }
    };

    // Durability is the commit point. Do not publish any live maps until the
    // edge is safely stored; a rejected provenance rebind or SQLite failure
    // must leave the registry and control plane exactly as they were.
    let spawnDispatched = false;
    try {
      if (spawnLease !== undefined) {
        admission?.markDispatched(spawnLease.reservation.reservationId, {
          boundary: "spawn_commit",
          details: {
            childThreadId: threadId,
            parentPath: opts.parentPath,
          },
        });
        spawnDispatched = true;
      }
      await this.persistThreadSpawnEdgeForSource(
        opts.parentPath,
        threadId,
        metadata,
      );
    } catch (error) {
      try {
        upInbox.close("spawn_persistence_failed");
        downInbox.close("spawn_persistence_failed");
        await this.registry.releaseSpawnedThread(threadId);
        if (releaseNicknameOnRollback) {
          releaseNickname(this.registry, nickname);
        }
      } finally {
        finishSpawnAdmission("durable_edge_commit", (reservationId) => {
          if (spawnDispatched) {
            admission?.holdUnknown(
              reservationId,
              "spawn_commit_outcome_unknown",
            );
          } else {
            admission?.void(reservationId, "spawn_cancelled_before_commit");
          }
        });
      }
      throw error;
    }

    // Persistence may yield to an interrupt. A child must never become live
    // after its parent was cancelled while the durable edge was committing.
    const parentTokenAfterPersistence = this.parentTokens.get(opts.parentPath);
    if (
      parentTokenAfterPersistence?.signal.aborted ||
      spawnLease?.signal.aborted
    ) {
      let closeError: unknown;
      try {
        await this.setThreadSpawnEdgeStatus(threadId, "closed");
      } catch (error) {
        closeError = error;
      }
      if (closeError !== undefined) {
        agent.abortController.abort("spawn_rollback_failed");
        agent.status.markInterrupted(threadId, "spawn_rollback_failed");
        publishAgent();
        const parentThreadId = this.agentIdForPath(opts.parentPath);
        this.threadManager?.registerLiveAgent(agent, {
          ...(parentThreadId !== undefined ? { parentThreadId } : {}),
        });
        finishSpawnAdmission("durable_edge_rollback", (reservationId) => {
          admission?.holdUnknown(
            reservationId,
            "spawn_rollback_outcome_unknown",
          );
        });
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "spawn_rollback_failed",
          `cancelled child ${threadId} remains registered because its durable edge could not be closed`,
        );
        throw closeError;
      }
      try {
        upInbox.close("spawn_race_aborted");
        downInbox.close("spawn_race_aborted");
        await this.registry.releaseSpawnedThread(threadId);
        if (releaseNicknameOnRollback) {
          releaseNickname(this.registry, nickname);
        }
      } finally {
        finishSpawnAdmission(
          "cancelled_durable_edge_rollback",
          (reservationId) => {
            admission?.reconcile(reservationId, {
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            });
          },
          (reservationId) => {
            admission?.holdUnknown(
              reservationId,
              "spawn_reconciliation_failed_after_rollback",
            );
          },
        );
      }
      emitWarning(
        this.session.eventLog,
        this.session.nextInternalSubId(),
        "spawn_race_aborted",
        `parent ${opts.parentPath} interrupted while spawn provenance was persisted`,
      );
      throw new SpawnRaceAbortedError(opts.parentPath);
    }

    // I-5: publish only after the durable commit and post-commit cancellation
    // check have both completed.
    publishAgent();

    if (spawnLease !== undefined) {
      const reservationId = spawnLease.reservation.reservationId;
      const settlementFailures: unknown[] = [];
      try {
        admission?.reconcile(reservationId, {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
      } catch (error) {
        settlementFailures.push(error);
        // The spawn edge is already durable and the live child is published.
        // Never report this as a clean pre-commit failure: callers could retry
        // and create a second child. Conservatively hold the zero-cost spawn
        // reservation unknown while returning the committed child handle.
        try {
          admission?.holdUnknown(
            reservationId,
            "spawn_reconciliation_failed_after_commit",
          );
        } catch (holdError) {
          settlementFailures.push(holdError);
        }
      } finally {
        // Even a repository/journal failure must not strand the daemon's live
        // concurrency slot. Durable recovery can repair a dispatched record;
        // physical spawn work has completed at this point.
        try {
          admission?.acknowledgeCompletion(reservationId);
        } catch (acknowledgementError) {
          settlementFailures.push(acknowledgementError);
        }
      }
      if (settlementFailures.length > 0) {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "spawn_admission_reconciliation_failed",
          `spawn ${threadId} committed, but admission settlement needs recovery: ${settlementFailures
            .map((error) =>
              error instanceof Error ? error.message : String(error),
            )
            .join("; ")}`,
        );
      }
    }

    return agent;
  }

  // ─────────────────────────────────────────────────────────────────
  // Additional spawn entry points (AgenC behavior)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime `spawn_agent_with_metadata` (control.rs:170).
   * Delegates to `spawn()` but accepts the richer `SpawnAgentOptions`
   * surface (preset threadId / role / metadata / fork mode).
   */
  async spawnAgentWithMetadata(
    parentPath: AgentPath,
    options: SpawnAgentOptions,
  ): Promise<LiveAgent> {
    const spawnOpts: Parameters<AgentControl["spawn"]>[0] = { parentPath };
    const metadataRole = options.metadata
      ? this.assertAgentMetadataRoleWorkspace(options.metadata)
      : undefined;
    if (options.roleName !== undefined) {
      (spawnOpts as { roleName?: string }).roleName = options.roleName;
    } else if (metadataRole !== undefined) {
      (spawnOpts as { roleName?: string }).roleName = metadataRole;
    }
    if (options.threadId !== undefined) {
      (spawnOpts as { threadId?: ThreadId }).threadId = options.threadId;
    }
    if (options.agentName !== undefined) {
      (spawnOpts as { agentName?: string }).agentName = options.agentName;
    } else if (options.metadata?.agentPath) {
      (spawnOpts as { agentPath?: AgentPath }).agentPath =
        options.metadata.agentPath;
    }
    if (options.agentPath !== undefined) {
      (spawnOpts as { agentPath?: AgentPath }).agentPath = options.agentPath;
    }
    if (options.preferredNickname !== undefined) {
      (spawnOpts as { preferredNickname?: string }).preferredNickname =
        options.preferredNickname;
    } else if (options.metadata?.agentNickname) {
      (spawnOpts as { preferredNickname?: string }).preferredNickname =
        options.metadata.agentNickname;
    }
    if (options.depthCap !== undefined) {
      (spawnOpts as { depthCap?: number }).depthCap = options.depthCap;
    }
    if (options.metadata !== undefined) {
      (
        spawnOpts as {
          expectedRoleProvenance?: Pick<
            AgentMetadata,
            "agentRole" | "agentRoleWorkspaceId" | "agentRoleFingerprint"
          >;
        }
      ).expectedRoleProvenance = options.metadata;
    }
    const live = await this.spawn(spawnOpts);
    // Fork annotation: the live handle is already wired; the parent-
    // side fork history build lives in `fork-context.ts`.
    void options.forkMode;
    void options.forkParentSpawnCallId;
    return live;
  }

  /**
   * Port of reference runtime `spawn_forked_thread` (control.rs:328). Thin wrapper
   * that requires a fork mode + parent-spawn-call id (matches the reference
   * fatal guards at `control.rs:337` and `control.rs:342`).
   * The actual rollout-truncation body lives in `fork-context.ts`.
   */
  async spawnForkedThread(
    parentPath: AgentPath,
    forkMode: SpawnAgentForkMode,
    options: Omit<SpawnAgentOptions, "forkMode"> = {},
  ): Promise<LiveAgent> {
    if (!options.forkParentSpawnCallId) {
      throw new Error("spawn_agent fork requires a parent spawn call id");
    }
    return this.spawnAgentWithMetadata(parentPath, {
      ...options,
      forkMode,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Parent → child routing (reference runtime control.rs:582/605/619)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime child-input routing (`control.rs:582`). Routes a user-input
   * message to a live child via its `downInbox` with triggerTurn=true,
   * and records the preview for `ListedAgent.lastTaskMessage`.
   */
  async sendInput(threadId: ThreadId, input: string): Promise<void> {
    if (this.threadManager?.hasThread(threadId)) {
      await this.threadManager.sendOp(threadId, {
        type: "user_input",
        input,
      });
      this.registry.updateLastTaskMessage(threadId, renderInputPreview(input));
      return;
    }
    const agent = this.requireLive(threadId);
    try {
      agent.downInbox.send({
        author: agent.agentPath,
        recipient: agent.agentPath,
        content: input,
        triggerTurn: true,
        direction: "down",
        metadata: { kind: "user_input" },
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) {
        throw new ThreadNotFoundError(threadId);
      }
      throw err;
    }
    this.registry.updateLastTaskMessage(threadId, renderInputPreview(input));
  }

  async clearConversationHistory(threadId: ThreadId): Promise<void> {
    if (this.threadManager?.hasThread(threadId)) {
      await this.threadManager.sendOp(threadId, {
        type: "clear_conversation_history",
      });
      return;
    }
    const agent = this.requireLive(threadId);
    agent.messages.length = 0;
    try {
      agent.downInbox.send({
        author: agent.agentPath,
        recipient: agent.agentPath,
        content: "",
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "history_clear" },
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) {
        throw new ThreadNotFoundError(threadId);
      }
      throw err;
    }
  }

  /**
   * Port of reference runtime `append_message` (`control.rs:605`). Non-turn-
   * triggering message append.
   */
  async appendMessage(threadId: ThreadId, message: string): Promise<void> {
    if (this.threadManager?.hasThread(threadId)) {
      await this.threadManager.appendMessage(threadId, message);
      return;
    }
    const agent = this.requireLive(threadId);
    try {
      agent.downInbox.send({
        author: agent.agentPath,
        recipient: agent.agentPath,
        content: message,
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "append_message" },
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) {
        throw new ThreadNotFoundError(threadId);
      }
      throw err;
    }
  }

  /**
   * Port of reference runtime `send_inter_agent_communication`
   * (`control.rs:619`). Generic parent→child IAC routing. Updates
   * `lastTaskMessage` on success (matches reference runtime's registry update).
   */
  async sendInterAgentCommunication(
    threadId: ThreadId,
    communication: {
      readonly author: string;
      readonly recipient: string;
      readonly content: string;
      readonly triggerTurn: boolean;
    },
  ): Promise<void> {
    if (this.threadManager?.hasThread(threadId)) {
      await this.threadManager.sendOp(threadId, {
        type: "inter_agent_communication",
        communication,
      });
      this.registry.updateLastTaskMessage(threadId, communication.content);
      return;
    }
    if (this.rootThreadId !== undefined && threadId === this.rootThreadId) {
      this.session.mailbox.send({
        author: communication.author,
        recipient: communication.recipient,
        content: communication.content,
        triggerTurn: communication.triggerTurn,
        direction: "up",
        metadata: { kind: "inter_agent_communication" },
      });
      if (communication.triggerTurn) {
        this.requestRootFollowupTurn(communication.author);
      }
      return;
    }
    const agent = this.requireLive(threadId);
    try {
      agent.downInbox.send({
        author: communication.author,
        recipient: communication.recipient,
        content: communication.content,
        triggerTurn: communication.triggerTurn,
        direction: "down",
        metadata: { kind: "inter_agent_communication" },
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) {
        throw new ThreadNotFoundError(threadId);
      }
      throw err;
    }
    this.registry.updateLastTaskMessage(threadId, communication.content);
  }

  // ─────────────────────────────────────────────────────────────────
  // Interrupt
  // ─────────────────────────────────────────────────────────────────

  /**
   * Send an Interrupt to a running child. I-5: uses the downInbox
   * with `direction: 'down'` so the child's turn machine picks it
   * up + aborts. Cascades to descendants.
   */
  interrupt(threadId: ThreadId, reason: string): void {
    if (this.threadManager?.hasThread(threadId)) {
      void this.threadManager.sendOp(threadId, {
        type: "interrupt",
        reason,
      });
    }
    const agent = this.live.get(threadId);
    if (!agent) return;

    // Send Interrupt on the downInbox.
    try {
      agent.downInbox.send({
        author: agent.agentPath,
        recipient: agent.agentPath,
        content: `interrupt: ${reason}`,
        triggerTurn: true,
        direction: "down",
        metadata: { kind: "interrupt", reason },
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) {
        // Already shut down — no-op.
        return;
      }
      throw err;
    }

    // Fire the agent's AbortController so the run-turn loop observes
    // `signal.aborted` at its top-of-loop check.
    if (!agent.abortController.signal.aborted) {
      agent.abortController.abort(reason);
    }
    agent.status.markInterrupted(agent.agentId, reason);

    // Cascade to descendants.
    for (const descendant of this.descendantsOf(agent.agentPath)) {
      this.interrupt(descendant.agentId, `cascade: ${reason}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Shutdown
  // ─────────────────────────────────────────────────────────────────

  /**
   * Terminal shutdown. Closes both inboxes, releases the slot,
   * marks status=shutdown. Cascades to descendants.
   */
  async shutdown(threadId: ThreadId, reason = "shutdown"): Promise<void> {
    const agent = this.live.get(threadId);
    if (!agent) return;
    const edgeStatus = edgeStatusForShutdownReason(reason);

    // Cascade first — shutdown descendants before parent so their
    // status transitions are visible in the event log.
    for (const descendant of this.descendantsOf(agent.agentPath)) {
      await this.shutdown(descendant.agentId, `cascade: ${reason}`);
    }

    // Durable state is the commit point. If closing the edge fails, keep this
    // live handle, its registry slot, and its mailboxes intact so callers can
    // retry instead of leaving an open durable edge backed by torn-down state.
    if (edgeStatus !== null) {
      await this.setThreadSpawnEdgeStatus(threadId, edgeStatus);
    }

    agent.upInbox.close(reason);
    agent.downInbox.close(reason);
    agent.status.markShutdown();
    agent.status.complete();
    if (!agent.abortController.signal.aborted) {
      agent.abortController.abort(reason);
    }

    // `releaseSpawnedThread` mirrors reference registry behavior: it frees
    // the live slot and path, but leaves the nickname reserved so the
    // next sibling does not immediately reuse the same display name.
    await this.registry.releaseSpawnedThread(threadId);
    this.parentTokens.delete(agent.agentPath);
    this.session.childInboxes.delete(threadId);
    this.parentOf.delete(threadId);
    this.live.delete(threadId);
    this.threadManager?.removeThread(threadId);
  }

  async closeAgent(threadId: ThreadId): Promise<void> {
    await this.shutdown(threadId, "closed_by_tool");
  }

  async markThreadSpawnEdgeClosed(threadId: ThreadId): Promise<void> {
    await this.setThreadSpawnEdgeStatus(threadId, "closed");
  }

  interruptAgent(threadId: ThreadId): void {
    this.interrupt(threadId, "interrupt");
  }

  /**
   * Cascade-shutdown every live agent under this control plane.
   * Called by `shutdownSessionLifecycle` at session teardown so no
   * subagent stays alive across sessions. Runs descendant-first via
   * `shutdown()`, so the per-path cascade pattern is preserved.
   */
  async shutdownAll(reason = "session_shutdown"): Promise<void> {
    // Snapshot the thread list since shutdown() mutates `this.live`.
    const threadIds = Array.from(this.live.keys());
    for (const threadId of threadIds) {
      await this.shutdown(threadId, reason).catch((err) => {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "agent_shutdown_failed",
          `thread=${threadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Resume (T6 rollout integration slot)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime `resume_agent_from_rollout`. T9 provides an
   * in-memory rehydrate: given metadata for a previously known
   * subagent path, rebuild a fresh `LiveAgent` handle with new
   * mailboxes/status/abort so a caller can reconnect.
   *
   * NOTE: T10 will extend this with full rollout-backed turn/tool
   * state rehydration. currently we rebuild the live handle and rely on
   * durable spawn-edge snapshots for subtree recovery.
   */
  async resume(opts: {
    readonly parentPath: AgentPath;
    readonly metadata: AgentMetadata;
  }): Promise<LiveAgent | null> {
    const metadata = normalizeAgentMetadata(opts.metadata);
    const { parentPath } = opts;
    const threadId = metadata.agentId;
    const agentPath = metadata.agentPath;
    if (!threadId || !agentPath) return null;
    if (threadId === this.rootThreadId || agentPath === ROOT_AGENT_PATH) {
      throw new InvalidAgentMetadataError(
        "cannot resume the session root as a child agent",
      );
    }

    const pathDepth = depthOfAgentPath(agentPath);
    if (metadata.depth !== pathDepth) {
      throw new InvalidAgentMetadataError(
        `agent resume depth ${metadata.depth} does not match path depth ${pathDepth}`,
      );
    }
    const expectedParentPath = parentAgentPathFor(agentPath);
    if (expectedParentPath === undefined || expectedParentPath !== parentPath) {
      throw new InvalidAgentMetadataError(
        `agent resume parent ${parentPath} does not match path parent ${expectedParentPath ?? "missing"}`,
      );
    }
    // I-1: the validated path depth is the sole depth-cap authority.
    const depth = pathDepth;
    if (depth > this.maxDepth) {
      emitError(this.session.eventLog, this.session.nextInternalSubId(), {
        cause: "max_depth_exceeded",
        message: `resume depth ${depth} exceeds cap ${this.maxDepth}`,
      });
      throw new MaxDepthExceededError(depth, this.maxDepth);
    }

    const role = resolveResumedAgentRole(this.roleWorkspace, metadata);

    // Idempotency is exact identity, never merely a matching id or path. A
    // partial match would let resume overwrite one live map while leaving the
    // registry indexed under another identity.
    const liveById = this.live.get(threadId);
    const liveByPath = this.getLiveByPath(agentPath);
    if (liveById !== undefined || liveByPath !== undefined) {
      if (
        liveById === undefined ||
        liveByPath === undefined ||
        liveById !== liveByPath
      ) {
        throw new InvalidAgentMetadataError(
          "agent resume identity conflicts with a live agent",
        );
      }
      assertSameAgentIdentity(metadata, liveById.metadata);
      return liveById;
    }

    const registeredById = this.registry.agentMetadataForThread(threadId);
    const registeredIdAtPath = this.registry.agentIdForPath(agentPath);
    if (registeredById !== undefined) {
      assertSameAgentIdentity(metadata, registeredById);
      if (registeredIdAtPath !== threadId) {
        throw new InvalidAgentMetadataError(
          "agent resume registry indexes disagree",
        );
      }
    } else {
      if (registeredIdAtPath !== undefined) {
        throw new AgentPathExistsError(agentPath);
      }
      const reservation = await this.registry.reserveSpawnSlot();
      try {
        reservation.finalize(metadata);
      } catch (err) {
        reservation.release();
        throw err;
      }
    }

    const nickname = metadata.agentNickname ?? `resumed-${threadId}`;
    const upInbox = new Mailbox({
      threadId,
      onBackpressureStreak: (count) => {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "mailbox_backpressure",
          `child→parent mailbox dropped ${count} messages (thread=${threadId})`,
        );
      },
    });
    const downInbox = new Mailbox({
      threadId: `${threadId}-down`,
      onBackpressureStreak: (count) => {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "mailbox_backpressure",
          `parent→child mailbox dropped ${count} messages (thread=${threadId})`,
        );
      },
    });

    const agent: LiveAgent = {
      agentId: threadId,
      agentPath,
      role,
      depth,
      nickname,
      status: new AgentStatusTracker(),
      upInbox,
      downInbox,
      abortController: new AbortController(),
      metadata,
      messages: [],
      memoryEntries: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };

    this.session.childInboxes.set(threadId, upInbox as unknown as never);
    this.live.set(threadId, agent);
    const parentId = this.agentIdForPath(parentPath);
    if (parentId) {
      this.parentOf.set(threadId, parentId);
    }
    this.threadManager?.registerLiveAgent(agent, {
      ...(parentId !== undefined ? { parentThreadId: parentId } : {}),
    });
    if (!this.parentTokens.has(agent.agentPath)) {
      this.parentTokens.set(agent.agentPath, agent.abortController);
    }

    emitWarning(
      this.session.eventLog,
      this.session.nextInternalSubId(),
      "agent_resumed",
      `resumed ${agent.agentPath} (${nickname})`,
    );

    return agent;
  }

  // ─────────────────────────────────────────────────────────────────
  // Rollout-driven resume (reference runtime `resume_agent_from_rollout`)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime `resume_agent_from_rollout` (control.rs:406).
   *
   * Rebuilds the root handle, then breadth-first reopens every tracked
   * open descendant below it from the rollout-store-owned edge index.
   * Parent failures short-circuit their subtree, matching reference runtime's
   * resume queue semantics.
   */
  async resumeAgentFromRollout(opts: {
    readonly rootThreadId: ThreadId;
    readonly parentPath: AgentPath;
    readonly metadata: AgentMetadata;
  }): Promise<{
    readonly resumedCount: number;
    readonly rootLive: LiveAgent | null;
  }> {
    if (opts.metadata.agentId !== opts.rootThreadId) {
      throw new InvalidAgentMetadataError(
        "rollout root thread id does not match agent metadata",
      );
    }
    const rootLive = await this.resumeSingleAgentFromRollout({
      parentPath: opts.parentPath,
      metadata: opts.metadata,
    });
    if (!rootLive) {
      return { resumedCount: 0, rootLive: null };
    }

    const rolloutStore = this.session.rolloutStore;
    if (!rolloutStore) {
      emitWarning(
        this.session.eventLog,
        this.session.nextInternalSubId(),
        "rollout_resume_unavailable",
        "resumeAgentFromRollout could not restore descendants because no rollout store is mounted",
      );
      return { resumedCount: 1, rootLive };
    }

    let resumedCount = 1;
    const seen = new Set<ThreadId>([opts.rootThreadId]);
    const resumeQueue: ThreadId[] = [opts.rootThreadId];

    while (resumeQueue.length > 0) {
      const parentThreadId = resumeQueue.shift()!;
      const children = rolloutStore.listThreadSpawnChildrenWithStatus(
        parentThreadId,
        "open",
      );
      for (const edge of children) {
        if (seen.has(edge.childThreadId)) continue;
        seen.add(edge.childThreadId);
        try {
          if (this.agentIdForPath(edge.parentPath) !== parentThreadId) {
            throw new InvalidAgentMetadataError(
              `spawn edge parent thread ${parentThreadId} does not match live parent path ${edge.parentPath}`,
            );
          }
          const childLive = await this.resumeSingleAgentFromRollout({
            parentPath: edge.parentPath,
            metadata: edge.metadata,
          });
          if (!childLive) {
            continue;
          }
          resumedCount += 1;
          resumeQueue.push(childLive.agentId);
        } catch (err) {
          emitWarning(
            this.session.eventLog,
            this.session.nextInternalSubId(),
            "descendant_resume_failed",
            `thread=${edge.childThreadId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return { resumedCount, rootLive };
  }

  /**
   * Port of reference runtime `resume_single_agent_from_rollout` public surface
   * (control.rs:479). Alias of `resume()` — present so ports tracking
   * the reference runtime name don't need to rename.
   */
  async resumeSingleAgentFromRollout(opts: {
    readonly parentPath: AgentPath;
    readonly metadata: AgentMetadata;
  }): Promise<LiveAgent | null> {
    return this.resume(opts);
  }

  // ─────────────────────────────────────────────────────────────────
  // Metadata + subtree queries (Priority 2)
  // ─────────────────────────────────────────────────────────────────

  /** Port of reference runtime `register_session_root` (`control.rs:721`). */
  registerSessionRoot(threadId: ThreadId): void {
    this.rootThreadId = threadId;
    this.registry.registerRootThread(threadId);
  }

  /** Port of reference runtime `get_agent_metadata` (`control.rs:731`). */
  getAgentMetadata(threadId: ThreadId): AgentMetadata | undefined {
    return this.registry.agentMetadataForThread(threadId);
  }

  /**
   * Port of reference runtime `list_live_agent_subtree_thread_ids`
   * (`control.rs:735`). Returns `[root, ...descendants]`.
   */
  listLiveAgentSubtreeThreadIds(
    rootThreadId: ThreadId,
  ): ReadonlyArray<ThreadId> {
    const agent = this.live.get(rootThreadId);
    if (!agent) return [rootThreadId];
    return [rootThreadId, ...this.liveThreadSpawnDescendants(rootThreadId)];
  }

  /** Port of reference runtime `get_agent_config_snapshot` (`control.rs:744`). */
  getAgentConfigSnapshot(
    threadId: ThreadId,
  ): Record<string, unknown> | undefined {
    const agent = this.live.get(threadId);
    if (!agent) return undefined;
    if (agent.configSnapshot) return { ...agent.configSnapshot };
    return {
      threadId: agent.agentId,
      agentPath: agent.agentPath,
      agentNickname: agent.nickname,
      agentRole: agent.role.name,
      depth: agent.depth,
      roleConfig: agent.role.config,
    };
  }

  async getStatus(threadId: ThreadId): Promise<AgentStatus> {
    if (this.threadManager?.hasThread(threadId)) {
      return this.threadManager.getThread(threadId).status();
    }
    return this.live.get(threadId)?.status.value ?? { status: "not_found" };
  }

  async subscribeStatus(threadId: ThreadId): Promise<{
    readonly value: AgentStatus;
    readonly unsubscribe: () => void;
  }> {
    if (this.threadManager?.hasThread(threadId)) {
      const thread = this.threadManager.getThread(threadId);
      let value = thread.status();
      const unsubscribe = thread.subscribeStatus((next) => {
        value = next;
      });
      return {
        get value() {
          return value;
        },
        unsubscribe,
      };
    }
    const agent = this.requireLive(threadId);
    let value = agent.status.value;
    const unsubscribe = agent.status.subscribe((next) => {
      value = next;
    });
    return {
      get value() {
        return value;
      },
      unsubscribe,
    };
  }

  /**
   * Port of reference runtime `resolve_agent_reference` (`control.rs:757`).
   * Supports `@nickname`, `@/absolute/path`, and `@relative/path`.
   */
  resolveAgentReference(opts: {
    readonly currentAgentPath?: AgentPath;
    readonly reference: string;
  }): ThreadId {
    const ref = opts.reference.startsWith("@")
      ? opts.reference.slice(1)
      : opts.reference;
    if (!ref) {
      throw new AgentReferenceUnresolvedError(opts.reference);
    }

    if (ref.startsWith("/")) {
      const id = this.agentIdForPath(ref);
      if (id) return id;
      throw new AgentReferenceUnresolvedError(opts.reference);
    }

    for (const agent of this.live.values()) {
      if (agent.nickname === ref) return agent.agentId;
    }

    const base = opts.currentAgentPath ?? "/root";
    const resolved = resolveAgentPath(base, ref);
    const resolvedId = this.agentIdForPath(resolved);
    if (resolvedId) return resolvedId;

    throw new AgentReferenceUnresolvedError(opts.reference);
  }

  /**
   * Port of reference runtime `get_total_token_usage` (`control.rs:788`).
   */
  getTotalTokenUsage(): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  } {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const agent of this.live.values()) {
      inputTokens += agent.tokenUsage.inputTokens;
      outputTokens += agent.tokenUsage.outputTokens;
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  async getTotalTokenUsageForAgent(threadId: ThreadId): Promise<unknown> {
    if (this.threadManager?.hasThread(threadId)) {
      return this.threadManager.getThread(threadId).totalTokenUsage?.();
    }
    return this.live.get(threadId)?.tokenUsage;
  }

  /**
   * Port of reference runtime `format_environment_context_subagents`
   * (`control.rs:798`). Produces a textual subagent tree for
   * injection into the parent's prompt.
   */
  formatEnvironmentContextSubagents(parentThreadId: ThreadId): string {
    const children = this.openThreadSpawnChildren(parentThreadId);
    if (children.length === 0) return "";
    const lines = children.map(([threadId, metadata]) => {
      const reference =
        metadata.agentPath ?? metadata.agentNickname ?? threadId;
      const nickname = metadata.agentNickname;
      return nickname ? `- ${reference} (${nickname})` : `- ${reference}`;
    });
    return lines.join("\n");
  }

  /**
   * Port of reference runtime `list_agents` (`control.rs:820`). Optional role +
   * path-prefix filter. Includes root when no prefix is supplied or
   * the prefix matches the root.
   */
  listAgents(
    opts: {
      readonly roleName?: string;
      readonly pathPrefix?: AgentPath;
    } = {},
  ): ReadonlyArray<ListedAgent> {
    const prefix = opts.pathPrefix;
    const roleName = opts.roleName
      ? canonicalAgentRoleName(opts.roleName)
      : undefined;
    const result: ListedAgent[] = [];

    const rootMatches = !prefix || agentMatchesPrefix("/root", prefix);
    if (rootMatches && this.rootThreadId) {
      result.push({
        agentName: "/root",
        agentStatus: { status: "pending_init" },
        lastTaskMessage: "Main thread",
      });
    }

    const metadatas = Array.from(this.registry.liveAgents())
      .slice()
      .sort((l, r) => (l.agentPath ?? "").localeCompare(r.agentPath ?? ""));

    for (const metadata of metadatas) {
      if (roleName && metadata.agentRole !== roleName) continue;
      if (
        prefix !== undefined &&
        !agentMatchesPrefix(metadata.agentPath, prefix)
      )
        continue;
      const agent = metadata.agentId
        ? this.live.get(metadata.agentId)
        : undefined;
      if (!agent) continue;
      result.push({
        agentName: metadata.agentPath ?? agent.agentId,
        agentStatus: agent.status.value,
        ...(metadata.lastTaskMessage !== undefined
          ? { lastTaskMessage: metadata.lastTaskMessage }
          : {}),
      });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // Completion watcher (Priority 3)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime `maybe_start_completion_watcher` (`control.rs:899`).
   * Starts a detached watcher that waits for the child to reach a
   * terminal status, then fires an IAC back to the parent announcing
   * the completion. No-op when the parent is unknown.
   */
  maybeStartCompletionWatcher(opts: {
    readonly childThreadId: ThreadId;
    readonly parentThreadId?: ThreadId;
  }): void {
    const parentId =
      opts.parentThreadId ?? this.parentOf.get(opts.childThreadId);
    if (!parentId) return;
    const child = this.live.get(opts.childThreadId);
    if (!child) {
      void this.notifyMissingChildCompletion(parentId, opts.childThreadId);
      return;
    }

    void this.awaitCompletion(child, parentId);
  }

  private async awaitCompletion(
    child: LiveAgent,
    parentId: ThreadId,
  ): Promise<void> {
    let lastNotifiedStatusKey: string | undefined;
    for await (const status of child.status.changes()) {
      if (!isFinal(status)) continue;
      const statusKey = completionStatusKey(status);
      if (statusKey === lastNotifiedStatusKey) continue;
      lastNotifiedStatusKey = statusKey;
      await this.sendCompletionNotification(child, parentId, status);
      if (status.status !== "completed") return;
    }
  }

  private async sendCompletionNotification(
    child: LiveAgent,
    parentId: ThreadId,
    final: AgentStatus,
  ): Promise<void> {
    const message = formatSubagentNotification({
      agentPath: child.agentPath,
      status: final,
    });

    const parentAgentPath = parentAgentPathFor(child.agentPath);
    if (!parentAgentPath) return;
    try {
      await this.sendInterAgentCommunication(parentId, {
        author: child.agentPath,
        recipient: parentAgentPath,
        content: message,
        triggerTurn: true,
      });
    } catch (err) {
      if (
        err instanceof ThreadNotFoundError ||
        err instanceof MailboxClosedError
      ) {
        return;
      }
      this.emitCompletionWatcherSendFailed(parentId, err);
    }
  }

  private async notifyMissingChildCompletion(
    parentId: ThreadId,
    childReference: ThreadId,
  ): Promise<void> {
    const final: AgentStatus = { status: "not_found" };
    const message = formatSubagentNotification({
      agentPath: childReference,
      status: final,
    });
    try {
      await this.sendSubagentNotificationWithoutTurn(parentId, {
        author: childReference,
        content: message,
        finalStatus: final.status,
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) return;
      this.emitCompletionWatcherSendFailed(parentId, err);
    }
  }

  private async sendSubagentNotificationWithoutTurn(
    parentId: ThreadId,
    notification: {
      readonly author: string;
      readonly content: string;
      readonly finalStatus: AgentStatus["status"];
    },
  ): Promise<void> {
    if (this.threadManager?.hasThread(parentId)) {
      await this.threadManager.appendMessage(parentId, notification.content);
      return;
    }

    if (this.rootThreadId !== undefined && parentId === this.rootThreadId) {
      this.session.mailbox.send({
        author: notification.author,
        recipient: "/root",
        content: notification.content,
        triggerTurn: false,
        direction: "up",
        metadata: {
          kind: "subagent_notification",
          finalStatus: notification.finalStatus,
        },
      });
      return;
    }

    const parent = this.live.get(parentId);
    if (!parent) return;
    parent.downInbox.send({
      author: notification.author,
      recipient: parent.agentPath,
      content: notification.content,
      triggerTurn: false,
      direction: "down",
      metadata: {
        kind: "subagent_notification",
        finalStatus: notification.finalStatus,
      },
    });
  }

  private requestRootFollowupTurn(author: string): void {
    const submit = (
      this.session as unknown as {
        readonly submit?: Session["submit"];
      }
    ).submit;
    if (typeof submit !== "function") return;
    void submit
      .call(this.session, "", { displayUserMessage: null })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "Session submit hook is not installed") return;
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "subagent_followup_turn_failed",
          `subagent ${author} could not start root follow-up turn: ${message}`,
        );
      });
  }

  private emitCompletionWatcherSendFailed(
    parentId: ThreadId,
    err: unknown,
  ): void {
    emitWarning(
      this.session.eventLog,
      this.session.nextInternalSubId(),
      "completion_watcher_send_failed",
      `parent=${parentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Subtree genealogy helpers (Priority 5)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of reference runtime `prepare_thread_spawn` (`control.rs:975`). Reserves
   * the nickname and composes the child metadata without actually
   * spawning. Callers that want to preflight a spawn use this to see
   * the allocated path/nickname.
   */
  prepareThreadSpawn(opts: {
    readonly parentPath: AgentPath;
    readonly roleName?: string;
    readonly preferredNickname?: string;
  }): { readonly metadata: AgentMetadata; readonly role: AgentRole } {
    const role = requireAgentRole(this.roleWorkspace, opts.roleName);
    const nickname =
      opts.preferredNickname ?? allocateNickname(role, this.registry);
    const depth = depthOfAgentPath(opts.parentPath) + 1;
    const metadata = buildChildMetadata({
      agentId: "pending",
      parentPath: opts.parentPath,
      role,
      roleWorkspaceId: this.roleWorkspace.id,
      roleFingerprint: agentRoleFingerprint(role),
      nickname,
      depth,
    });
    return { metadata, role };
  }

  inheritedShellSnapshotForSource(
    _parentThreadId: ThreadId | undefined,
  ): unknown | undefined {
    void _parentThreadId;
    const services = this.session.services as unknown as Record<
      string,
      unknown
    >;
    return (
      services.shellSnapshot ??
      services.shell_snapshot ??
      (services.shell as { shellSnapshot?: unknown } | undefined)?.shellSnapshot
    );
  }

  inheritedExecPolicyForSource(
    _parentThreadId: ThreadId | undefined,
  ): unknown | undefined {
    void _parentThreadId;
    const services = this.session.services as unknown as Record<
      string,
      unknown
    >;
    return (
      services.execPolicy ?? services.exec_policy ?? services.execPolicyManager
    );
  }

  /**
   * Port of reference runtime `open_thread_spawn_children` (`control.rs:1060`).
   * Returns live children of the given parent thread, sorted by path.
   */
  openThreadSpawnChildren(
    parentThreadId: ThreadId,
  ): ReadonlyArray<[ThreadId, AgentMetadata]> {
    const children: [ThreadId, AgentMetadata][] = [];
    for (const [childId, parentId] of this.parentOf.entries()) {
      if (parentId !== parentThreadId) continue;
      const metadata = this.registry.agentMetadataForThread(childId);
      if (!metadata) continue;
      children.push([childId, metadata]);
    }
    children.sort((l, r) =>
      (l[1].agentPath ?? "").localeCompare(r[1].agentPath ?? ""),
    );
    return children;
  }

  /**
   * Port of reference runtime `live_thread_spawn_children` (`control.rs:1070`).
   * Parent→children map for every live child.
   */
  liveThreadSpawnChildren(): ReadonlyMap<
    ThreadId,
    ReadonlyArray<[ThreadId, AgentMetadata]>
  > {
    const map = new Map<ThreadId, [ThreadId, AgentMetadata][]>();
    for (const [childId, parentId] of this.parentOf.entries()) {
      const metadata = this.registry.agentMetadataForThread(childId);
      if (!metadata) continue;
      const bucket = map.get(parentId) ?? [];
      bucket.push([childId, metadata]);
      map.set(parentId, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((l, r) =>
        (l[1].agentPath ?? "").localeCompare(r[1].agentPath ?? ""),
      );
    }
    return map;
  }

  /**
   * Port of reference runtime `live_thread_spawn_descendants` (`control.rs:1137`).
   * Depth-first walk over the in-memory spawn tree rooted at
   * `rootThreadId`.
   */
  liveThreadSpawnDescendants(rootThreadId: ThreadId): ReadonlyArray<ThreadId> {
    const children = this.liveThreadSpawnChildren();
    const descendants: ThreadId[] = [];
    const firstBucket = children.get(rootThreadId) ?? [];
    const stack: ThreadId[] = firstBucket
      .map(([id]) => id)
      .slice()
      .reverse();
    while (stack.length > 0) {
      const next = stack.pop()!;
      descendants.push(next);
      const nextChildren = children.get(next) ?? [];
      for (let i = nextChildren.length - 1; i >= 0; i -= 1) {
        const entry = nextChildren[i];
        if (entry) stack.push(entry[0]);
      }
    }
    return descendants;
  }

  /**
   * Port of reference runtime `persist_thread_spawn_edge_for_source`
   * (`control.rs:1113`). Stores an open edge snapshot in the
   * rollout-store-owned durable index for later resume/tree recovery.
   */
  private async persistThreadSpawnEdgeForSource(
    parentPath: AgentPath,
    childThreadId: ThreadId,
    metadata?: AgentMetadata,
  ): Promise<void> {
    const parentThreadId = this.agentIdForPath(parentPath);
    if (!parentThreadId) return;
    const rolloutStore = this.session.rolloutStore;
    if (!rolloutStore) return;
    const storedMetadata =
      metadata ?? this.registry.agentMetadataForThread(childThreadId);
    if (!storedMetadata) return;
    rolloutStore.createThreadSpawnEdge({
      childThreadId,
      parentThreadId,
      parentPath,
      metadata: cloneAgentMetadata(storedMetadata),
      status: "open",
    });
  }

  private async setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void> {
    this.session.rolloutStore?.setThreadSpawnEdgeStatus(childThreadId, status);
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────

  private requireLive(threadId: ThreadId): LiveAgent {
    const agent = this.live.get(threadId);
    if (!agent) throw new ThreadNotFoundError(threadId);
    return agent;
  }

  private agentIdForPath(path: AgentPath): ThreadId | undefined {
    for (const agent of this.live.values()) {
      if (agent.agentPath === path) return agent.agentId;
    }
    return this.registry.agentIdForPath(path);
  }

  // ─────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────

  getLive(threadId: ThreadId): LiveAgent | undefined {
    return this.live.get(threadId);
  }

  getLiveByPath(path: AgentPath): LiveAgent | undefined {
    for (const agent of this.live.values()) {
      if (agent.agentPath === path) return agent;
    }
    return undefined;
  }

  listLive(): ReadonlyArray<LiveAgent> {
    return Array.from(this.live.values());
  }

  /** Return all descendants of the given agentPath. */
  descendantsOf(parentPath: AgentPath): ReadonlyArray<LiveAgent> {
    const prefix = parentPath === "/root" ? "/root/" : `${parentPath}/`;
    return Array.from(this.live.values()).filter((a) =>
      a.agentPath.startsWith(prefix),
    );
  }

  /** Join a new child path onto an existing parent path. */
  pathFor(parentPath: AgentPath, nickname: string): AgentPath {
    return joinAgentPath(parentPath, normalizeAgentNameForPath(nickname));
  }

  recordAgentMessages(
    threadId: ThreadId,
    messages: ReadonlyArray<LLMMessage>,
  ): void {
    const agent = this.live.get(threadId);
    if (!agent || messages.length === 0) return;
    agent.messages.push(...messages.map((message) => ({ ...message })));
  }

  recordAgentUsage(threadId: ThreadId, usage: LLMUsage | undefined): void {
    const agent = this.live.get(threadId);
    if (!agent || usage === undefined) return;
    agent.tokenUsage.inputTokens += usage.promptTokens ?? 0;
    agent.tokenUsage.outputTokens += usage.completionTokens ?? 0;
    agent.tokenUsage.totalTokens +=
      usage.totalTokens ??
      (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  }

  setAgentConfigSnapshot(
    threadId: ThreadId,
    snapshot: Record<string, unknown>,
  ): void {
    const agent = this.live.get(threadId);
    if (!agent) return;
    agent.configSnapshot = { ...snapshot };
  }

  writeAgentMemory(threadId: ThreadId, entry: AgentMemoryEntry): void {
    const agent = this.live.get(threadId);
    if (!agent) return;
    agent.memoryEntries.push(entry);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Free helpers (AgenC behavior)
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of reference runtime `render_input_preview` (`control.rs:1187`). The reference form
 * form walks over `Op::UserInput` items; AgenC inputs are plain
 * strings at this boundary, so we preview the first line and truncate
 * to fit a registry `lastTaskMessage` cell.
 */
export function renderInputPreview(input: string): string {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

function cloneAgentMetadata(
  metadata: AgentMetadata | undefined,
): AgentMetadata {
  return normalizeAgentMetadata(metadata ?? { depth: 0 });
}

function assertSameAgentIdentity(
  expected: AgentMetadata,
  actual: AgentMetadata,
): void {
  const normalizedExpected = normalizeAgentMetadata(expected);
  const normalizedActual = normalizeAgentMetadata(actual);
  if (
    normalizedExpected.agentId !== normalizedActual.agentId ||
    normalizedExpected.agentPath !== normalizedActual.agentPath ||
    normalizedExpected.agentRole !== normalizedActual.agentRole ||
    normalizedExpected.agentRoleWorkspaceId !==
      normalizedActual.agentRoleWorkspaceId ||
    normalizedExpected.agentRoleFingerprint !==
      normalizedActual.agentRoleFingerprint ||
    normalizedExpected.depth !== normalizedActual.depth
  ) {
    throw new InvalidAgentMetadataError(
      "agent resume identity does not match registered metadata",
    );
  }
}

function edgeStatusForShutdownReason(
  reason: string,
): ThreadSpawnEdgeStatus | null {
  if (
    reason.includes("closed_by_tool") ||
    reason.includes("close_agent") ||
    reason.includes("delegate_restart") ||
    reason.includes("delegate_teardown")
  ) {
    return "closed";
  }
  return null;
}

function parentAgentPathFor(agentPath: AgentPath): AgentPath | undefined {
  const index = agentPath.lastIndexOf("/");
  if (index <= 0) return undefined;
  const parentPath = agentPath.slice(0, index);
  return parentPath.length > 0 ? (parentPath as AgentPath) : undefined;
}

function completionStatusKey(status: AgentStatus): string {
  switch (status.status) {
    case "completed":
    case "errored":
    case "interrupted":
    case "running":
      return `${status.status}:${status.turnId}`;
    case "shutdown":
      return `${status.status}:${status.endedAtMs}`;
    case "pending_init":
    case "not_found":
      return status.status;
  }
}

/** Port of reference runtime `agent_matches_prefix` (`control.rs:1173`). */
function agentMatchesPrefix(
  agentPath: AgentPath | undefined,
  prefix: AgentPath,
): boolean {
  if (prefix === "/root") return true;
  if (!agentPath) return false;
  if (agentPath === prefix) return true;
  const suffix = agentPath.startsWith(prefix)
    ? agentPath.slice(prefix.length)
    : undefined;
  return suffix !== undefined && suffix.startsWith("/");
}
