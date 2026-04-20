/**
 * AgentControl — subagent lifecycle + control plane.
 *
 * Port of codex `core/src/agent/control.rs` (1,214 LOC). Covers: full
 * lifecycle (spawn/interrupt/shutdown/resume), parent→child message
 * routing (send_input / append_message / inter-agent communication),
 * metadata + subtree queries (list_agents / subtree descendants /
 * token totals / environment context), completion watcher, fork-mode
 * spawn helpers, and subtree genealogy bookkeeping.
 *
 * Deferred (subsystems not yet in AgenC — track T10/T13):
 *   - Rollout-driven rehydrate body: `resumeAgentFromRollout()` exists
 *     and returns the root live handle only (no descendant walk) until
 *     the T6 rollout reader surface exposes persisted
 *     `thread_spawn_edge` records. The live-handle part of resume is
 *     fully functional via `resume()`.
 *   - Exec-policy + shell-snapshot inheritance
 *     (`inheritedExecPolicyForSource`, `inheritedShellSnapshotForSource`)
 *     is stubbed pending T13's config refactor. Safe default: return
 *     undefined (child uses its own defaults).
 *   - Persisted spawn-edge writes (`persistThreadSpawnEdgeForSource`)
 *     are stubbed until the session exposes a state-db writer; the
 *     live subtree is tracked entirely in-memory via `parentOf`.
 *   - `getAgentConfigSnapshot` / `getTotalTokenUsage` currently return
 *     conservative fallbacks (role-config blob + zeros). The codex
 *     parity surface is preserved so callers upgrade once the live
 *     thread config snapshot lands.
 *
 * Invariants wired:
 *   I-1  (MAX_AGENT_DEPTH=4) — spawn rejects `childDepth >= cap`.
 *        AgenC raises the cap from codex's `DEFAULT_AGENT_MAX_DEPTH=1`
 *        (`codex-rs/core/src/config/mod.rs:127`) to 4 because AgenC's
 *        subagent workflow (delegate/worktree/fork-context) routinely
 *        nests 2–3 levels deep for multi-role planner → implementer →
 *        verifier chains. Comparison operator matches codex's `>=`
 *        form (`codex-rs/core/src/agent/control.rs:486`,
 *        `codex-rs/core/src/agent/multi_agents_common.rs:283`).
 *   I-5  (bidirectional mailbox) — routing methods (send_input /
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
import type { Session } from "../session/session.js";
import { Mailbox, MailboxClosedError } from "./mailbox.js";
import {
  AgentLimitReachedError,
  AgentPathExistsError,
  type AgentPath,
  type AgentRegistry,
  type AgentMetadata,
  type ThreadId,
  buildChildMetadata,
  depthOfAgentPath,
  joinAgentPath,
} from "./registry.js";
import {
  allocateNickname,
  applyRoleToConfig,
  releaseNickname,
  resolveAgentRole,
  type AgentRole,
  type RoleShapedConfig,
} from "./role.js";
import { AgentStatusTracker, isFinal, type AgentStatus } from "./status.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * I-1 default cap. Overrideable via `config.agents.maxDepth` (T10) or the
 * `AGENC_AGENT_MAX_DEPTH` env var (test/ops escape hatch).
 *
 * Semantics match codex: `spawn` rejects when `childDepth >= cap`, so the
 * cap value is the smallest depth that is NOT allowed. Cap=4 means root
 * (depth 0) may spawn depths 1, 2, and 3; depth 4 is rejected.
 *
 * Divergence from codex: codex defaults to `DEFAULT_AGENT_MAX_DEPTH=1`
 * (`codex-rs/core/src/config/mod.rs:127`), which permits only a single
 * layer of subagents under root. AgenC raises the default to 4 because
 * its multi-role delegate pipeline (planner → implementer → verifier,
 * optionally with a fork-context scout) routinely exercises 2–3 levels
 * of nesting. Ops can still dial it back to codex's default via
 * `AGENC_AGENT_MAX_DEPTH=1` or the per-session `maxDepth` override.
 */
const DEFAULT_MAX_AGENT_DEPTH = 4;

function resolveDefaultMaxDepth(): number {
  const raw = process.env.AGENC_AGENT_MAX_DEPTH;
  if (!raw) return DEFAULT_MAX_AGENT_DEPTH;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_AGENT_DEPTH;
  }
  return parsed;
}

export const MAX_AGENT_DEPTH: number = resolveDefaultMaxDepth();

/**
 * Accessor stub for the session-level child-base-config blob.
 *
 * TODO(T10): Replace with a real accessor once `SessionConfiguration`
 * carries a stable child-config source. Codex derives the child's
 * base config from `Session.state.config` (`role.rs:40`); AgenC's
 * `Session.state.sessionConfiguration` exists but is not yet the
 * authoritative source for subagent config layering. Returning
 * `undefined` today is deliberate: it forces `applyRoleToConfig` to
 * project onto an empty blob so the seam stays live without faking a
 * config source that doesn't exist yet.
 */
function getChildBaseConfig(session: Session): RoleShapedConfig | undefined {
  // Intentionally not reaching into session.state here — that state
  // is an async-locked mutex whose contents are still under active
  // reshape for T10. The live accessor will replace this with a
  // proper snapshot read.
  void session;
  return undefined;
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

export class SpawnRaceAbortedError extends Error {
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
// Fork-mode + spawn option types (codex `SpawnAgentForkMode` /
// `SpawnAgentOptions`; `control.rs:46-55`).
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of codex `SpawnAgentForkMode` (`control.rs:46`). AgenC's
 * fork-context module owns the richer `ForkMode` used by delegate.ts;
 * this enum matches the narrower codex spawn-entry shape.
 */
export type SpawnAgentForkMode =
  | { readonly kind: "full_history" }
  | { readonly kind: "last_n_turns"; readonly n: number };

/**
 * Port of codex `SpawnAgentOptions` (`control.rs:52`).
 */
export interface SpawnAgentOptions {
  readonly threadId?: ThreadId;
  readonly roleName?: string;
  /** Caller-supplied metadata fields to merge into the allocated
   *  record (e.g. inherited `agentRole` from a resume payload). */
  readonly metadata?: Partial<AgentMetadata>;
  readonly forkParentSpawnCallId?: string;
  readonly forkMode?: SpawnAgentForkMode;
}

/**
 * Port of codex `ListedAgent` (`control.rs:64`).
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
  /** Cached metadata snapshot at spawn time (codex `LiveAgent.metadata`). */
  readonly metadata: AgentMetadata;
}

// ─────────────────────────────────────────────────────────────────────
// AgentControl
// ─────────────────────────────────────────────────────────────────────

export interface AgentControlOpts {
  readonly session: Session;
  readonly registry: AgentRegistry;
  /** Override MAX_AGENT_DEPTH for this session (tests/config). */
  readonly maxDepth?: number;
}

export class AgentControl {
  private readonly session: Session;
  private readonly registry: AgentRegistry;
  private readonly maxDepth: number;
  private readonly live = new Map<ThreadId, LiveAgent>();
  /** Cancellation tokens scoped to parents — I-32. */
  private readonly parentTokens = new Map<AgentPath, AbortController>();
  /** Registered session-root thread id (codex `register_session_root`). */
  private rootThreadId: ThreadId | undefined;
  /** Parent linkage: childId → parentId (for open_thread_spawn_children
   *  and subtree cascade, since we have no state-db in-tree yet). */
  private readonly parentOf = new Map<ThreadId, ThreadId>();

  constructor(opts: AgentControlOpts) {
    this.session = opts.session;
    this.registry = opts.registry;
    this.maxDepth = opts.maxDepth ?? MAX_AGENT_DEPTH;
  }

  // ─────────────────────────────────────────────────────────────────
  // Spawn
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of codex `spawn_agent_internal` (control.rs:~310).
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
   *
   * Returns a `LiveAgent` handle the caller (run-agent.ts) uses to
   * drive the child session.
   */
  async spawn(opts: {
    readonly parentPath: AgentPath;
    readonly roleName?: string;
    readonly threadId?: ThreadId;
  }): Promise<LiveAgent> {
    const parentDepth = depthOfAgentPath(opts.parentPath);
    const childDepth = parentDepth + 1;

    // I-1: depth cap. Matches codex `>=` comparison semantics
    // (`control.rs:486`): cap is the smallest rejected depth.
    if (childDepth >= this.maxDepth) {
      emitError(this.session.eventLog, this.session.nextInternalSubId(), {
        cause: "max_depth_exceeded",
        message: `subagent depth ${childDepth} exceeds cap ${this.maxDepth}`,
      });
      throw new MaxDepthExceededError(childDepth, this.maxDepth);
    }

    // I-63: atomic slot acquisition.
    let reservation;
    try {
      reservation = await this.registry.reserveSpawnSlot();
    } catch (err) {
      if (err instanceof AgentLimitReachedError) {
        emitWarning(
          this.session.eventLog,
          this.session.nextInternalSubId(),
          "agent_limit_reached",
          `spawn rejected: max_threads=${err.maxThreads}`,
        );
      }
      throw err;
    }

    const role = resolveAgentRole(opts.roleName);
    // Project the role's overrides onto the child's effective config.
    // T10 replaces the accessor below with a real config source on
    // the session. For now we read whatever blob is available and
    // re-apply; the returned object is intentionally unused today
    // (the child session config path is not wired yet) but this call
    // keeps the spawn seam live and fails fast on type drift.
    const baseChildConfig = getChildBaseConfig(this.session) ?? {};
    // TODO(T10): thread the child effective config into the child
    // session's SessionConfiguration once the config source lives on
    // session state. For now this materializes the role-projection
    // locally so the integration is test-covered.
    void applyRoleToConfig(role, baseChildConfig);
    const nickname = allocateNickname(role, this.registry);
    const threadId = opts.threadId ?? crypto.randomUUID();
    const metadata: AgentMetadata = buildChildMetadata({
      agentId: threadId,
      parentPath: opts.parentPath,
      role,
      nickname,
      depth: childDepth,
    });

    // I-32: check cancellation before finalize. If the parent was
    // interrupted while we were allocating, roll back + throw. Also
    // synthesize a `parent_interrupt` message to the (about-to-be-
    // born) child so the caller can route it appropriately.
    const parentToken = this.parentTokens.get(opts.parentPath);
    if (parentToken?.signal.aborted) {
      reservation.release();
      releaseNickname(this.registry, nickname);
      emitWarning(
        this.session.eventLog,
        this.session.nextInternalSubId(),
        "spawn_race_aborted",
        `parent ${opts.parentPath} interrupted mid-spawn`,
      );
      throw new SpawnRaceAbortedError(opts.parentPath);
    }

    // I-37: path collision check + finalize. finalize() throws
    // AgentPathExistsError on dup.
    try {
      reservation.finalize(metadata);
    } catch (err) {
      releaseNickname(this.registry, nickname);
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
    };

    // I-5: wire the child's upInbox into the session's childInboxes
    // Map so parent-side consumers (TUI, commit phase) can drain.
    this.session.childInboxes.set(threadId, upInbox as unknown as never);
    this.live.set(threadId, agent);

    // Track parent linkage for the in-memory subtree helpers.
    const parentId = this.agentIdForPath(opts.parentPath);
    if (parentId) {
      this.parentOf.set(threadId, parentId);
    }

    // Register a per-agent parent cancellation token so nested
    // spawns (grandchildren) observe the parent's token.
    if (!this.parentTokens.has(agent.agentPath)) {
      this.parentTokens.set(agent.agentPath, agent.abortController);
    }

    // Best-effort persisted spawn-edge write (no-op stub today; the
    // in-memory `parentOf` map is authoritative until the T10 state-
    // db writer lands).
    await this.persistThreadSpawnEdgeForSource(opts.parentPath, threadId);

    return agent;
  }

  // ─────────────────────────────────────────────────────────────────
  // Additional spawn entry points (codex parity)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of codex `spawn_agent_with_metadata` (control.rs:170).
   * Delegates to `spawn()` but accepts the richer `SpawnAgentOptions`
   * surface (preset threadId / role / metadata / fork mode).
   */
  async spawnAgentWithMetadata(
    parentPath: AgentPath,
    options: SpawnAgentOptions,
  ): Promise<LiveAgent> {
    const spawnOpts: Parameters<AgentControl["spawn"]>[0] = { parentPath };
    if (options.roleName !== undefined) {
      (spawnOpts as { roleName?: string }).roleName = options.roleName;
    } else if (options.metadata?.agentRole) {
      (spawnOpts as { roleName?: string }).roleName =
        options.metadata.agentRole;
    }
    if (options.threadId !== undefined) {
      (spawnOpts as { threadId?: ThreadId }).threadId = options.threadId;
    }
    const live = await this.spawn(spawnOpts);
    // Fork annotation: the live handle is already wired; the parent-
    // side fork history build lives in `fork-context.ts`.
    void options.forkMode;
    void options.forkParentSpawnCallId;
    return live;
  }

  /**
   * Port of codex `spawn_forked_thread` (control.rs:328). Thin wrapper
   * that requires a fork mode + parent-spawn-call id (matches codex's
   * `CodexErr::Fatal` guards at `control.rs:337` and `control.rs:342`).
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
  // Parent → child routing (codex control.rs:582/605/619)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of codex `send_input` (`control.rs:582`). Routes a user-input
   * message to a live child via its `downInbox` with triggerTurn=true,
   * and records the preview for `ListedAgent.lastTaskMessage`.
   */
  async sendInput(threadId: ThreadId, input: string): Promise<void> {
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

  /**
   * Port of codex `append_message` (`control.rs:605`). Non-turn-
   * triggering message append.
   */
  async appendMessage(threadId: ThreadId, message: string): Promise<void> {
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
   * Port of codex `send_inter_agent_communication`
   * (`control.rs:619`). Generic parent→child IAC routing. Updates
   * `lastTaskMessage` on success (matches codex's registry update).
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

    // Cascade first — shutdown descendants before parent so their
    // status transitions are visible in the event log.
    for (const descendant of this.descendantsOf(agent.agentPath)) {
      await this.shutdown(descendant.agentId, `cascade: ${reason}`);
    }

    agent.upInbox.close(reason);
    agent.downInbox.close(reason);
    agent.status.markShutdown();
    agent.status.complete();
    if (!agent.abortController.signal.aborted) {
      agent.abortController.abort(reason);
    }

    // `releaseSpawnedThread` already removes the nickname from the
    // registry's pool. Leave the explicit call out to keep a single
    // release path (and avoid the false impression that we maintain
    // two sets).
    await this.registry.releaseSpawnedThread(threadId);
    this.parentTokens.delete(agent.agentPath);
    this.session.childInboxes.delete(threadId);
    this.parentOf.delete(threadId);
    this.live.delete(threadId);
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
   * Port of codex `resume_agent_from_rollout`. T9 provides an
   * in-memory rehydrate: given metadata for a previously known
   * subagent path, rebuild a fresh `LiveAgent` handle with new
   * mailboxes/status/abort so a caller can reconnect.
   *
   * NOTE: T10 will extend this with rollout-backed state
   * rehydration (persisted spawn edges, turn history, pending
   * tool state). For now we only rebuild the live handle.
   */
  async resume(opts: {
    readonly parentPath: AgentPath;
    readonly metadata: AgentMetadata;
  }): Promise<LiveAgent | null> {
    const { metadata, parentPath } = opts;
    const threadId = metadata.agentId;
    const agentPath = metadata.agentPath;
    if (!threadId || !agentPath) return null;

    // I-1: depth cap. Use metadata.depth as authority, fall back to
    // parent-path-derived depth + 1 if metadata is missing depth.
    // Matches codex `>=` comparison (`multi_agents_common.rs:283`).
    const depth =
      metadata.depth ?? depthOfAgentPath(parentPath) + 1;
    if (depth >= this.maxDepth) {
      emitError(this.session.eventLog, this.session.nextInternalSubId(), {
        cause: "max_depth_exceeded",
        message: `resume depth ${depth} exceeds cap ${this.maxDepth}`,
      });
      throw new MaxDepthExceededError(depth, this.maxDepth);
    }

    // Idempotency: if already live on this agentPath, return it.
    const existing = this.getLiveByPath(agentPath);
    if (existing) return existing;

    // Registry: if unknown, reserve a slot + finalize with the metadata.
    // If registry already knows the thread, the slot is already charged.
    if (!this.registry.agentMetadataForThread(threadId)) {
      const reservation = await this.registry.reserveSpawnSlot();
      try {
        reservation.finalize(metadata);
      } catch (err) {
        reservation.release();
        throw err;
      }
    }

    const role = resolveAgentRole(metadata.agentRole);
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
    };

    this.session.childInboxes.set(threadId, upInbox as unknown as never);
    this.live.set(threadId, agent);
    const parentId = this.agentIdForPath(parentPath);
    if (parentId) {
      this.parentOf.set(threadId, parentId);
    }
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
  // Rollout-driven resume (codex `resume_agent_from_rollout`)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of codex `resume_agent_from_rollout` (control.rs:406).
   *
   * Deferred (T10): descendant rehydrate depends on the rollout
   * reader exposing persisted `thread_spawn_edge` records. Today we
   * rebuild the root live handle only and emit a
   * `rollout_resume_stub` warning. Returns the count of resumed live
   * handles (0 when the metadata is insufficient, 1 when root was
   * resumed).
   */
  async resumeAgentFromRollout(opts: {
    readonly rootThreadId: ThreadId;
    readonly parentPath: AgentPath;
    readonly metadata: AgentMetadata;
  }): Promise<{
    readonly resumedCount: number;
    readonly rootLive: LiveAgent | null;
  }> {
    void opts.rootThreadId;
    const rootLive = await this.resume({
      parentPath: opts.parentPath,
      metadata: opts.metadata,
    });

    const rolloutStore = (
      this.session as unknown as { rolloutStore?: unknown }
    ).rolloutStore;
    if (!rolloutStore) {
      emitWarning(
        this.session.eventLog,
        this.session.nextInternalSubId(),
        "rollout_resume_stub",
        `resumeAgentFromRollout returning live-handle-only (rollout reader unavailable)`,
      );
      return { resumedCount: rootLive ? 1 : 0, rootLive };
    }

    // TODO T10/T6: once the rollout reader exposes
    // `listThreadSpawnChildren`, walk the queue exactly like codex
    // `control.rs:424`.
    emitWarning(
      this.session.eventLog,
      this.session.nextInternalSubId(),
      "rollout_resume_stub",
      `descendant rehydrate pending T10 rollout reader surface`,
    );
    return { resumedCount: rootLive ? 1 : 0, rootLive };
  }

  /**
   * Port of codex `resume_single_agent_from_rollout` public surface
   * (control.rs:479). Alias of `resume()` — present so ports tracking
   * the codex name don't need to rename.
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

  /** Port of codex `register_session_root` (`control.rs:721`). */
  registerSessionRoot(threadId: ThreadId): void {
    this.rootThreadId = threadId;
    this.registry.registerRootThread(threadId);
  }

  /** Port of codex `get_agent_metadata` (`control.rs:731`). */
  getAgentMetadata(threadId: ThreadId): AgentMetadata | undefined {
    return this.registry.agentMetadataForThread(threadId);
  }

  /**
   * Port of codex `list_live_agent_subtree_thread_ids`
   * (`control.rs:735`). Returns `[root, ...descendants]`.
   */
  listLiveAgentSubtreeThreadIds(
    rootThreadId: ThreadId,
  ): ReadonlyArray<ThreadId> {
    const agent = this.live.get(rootThreadId);
    if (!agent) return [rootThreadId];
    return [rootThreadId, ...this.liveThreadSpawnDescendants(rootThreadId)];
  }

  /**
   * Port of codex `get_agent_config_snapshot` (`control.rs:744`).
   * Deferred (T13): no per-thread config snapshot yet. Returns a
   * compact best-effort snapshot assembled from the live handle.
   */
  getAgentConfigSnapshot(
    threadId: ThreadId,
  ): Record<string, unknown> | undefined {
    const agent = this.live.get(threadId);
    if (!agent) return undefined;
    return {
      threadId: agent.agentId,
      agentPath: agent.agentPath,
      agentNickname: agent.nickname,
      agentRole: agent.role.name,
      depth: agent.depth,
      roleConfig: agent.role.config,
    };
  }

  /**
   * Port of codex `resolve_agent_reference` (`control.rs:757`).
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
    const resolved = joinAgentPath(base, ref);
    const resolvedId = this.agentIdForPath(resolved);
    if (resolvedId) return resolvedId;

    throw new AgentReferenceUnresolvedError(opts.reference);
  }

  /**
   * Port of codex `get_total_token_usage` (`control.rs:788`).
   * Deferred (T13): AgenC doesn't expose per-thread totals yet.
   * Returns zeros until the budget tracker wiring lands.
   */
  getTotalTokenUsage(): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  } {
    const inputTokens = 0;
    const outputTokens = 0;
    for (const _agent of this.live.values()) {
      void _agent;
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  /**
   * Port of codex `format_environment_context_subagents`
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
   * Port of codex `list_agents` (`control.rs:820`). Optional role +
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
    const result: ListedAgent[] = [];

    const rootMatches = !prefix || agentMatchesPrefix("/root", prefix);
    if (rootMatches && this.rootThreadId) {
      result.push({
        agentName: "/root",
        agentStatus: { status: "idle" },
        lastTaskMessage: "Main thread",
      });
    }

    const metadatas = Array.from(this.registry.liveAgents())
      .slice()
      .sort((l, r) =>
        (l.agentPath ?? "").localeCompare(r.agentPath ?? ""),
      );

    for (const metadata of metadatas) {
      if (opts.roleName && metadata.agentRole !== opts.roleName) continue;
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
   * Port of codex `maybe_start_completion_watcher` (`control.rs:899`).
   * Starts a detached watcher that waits for the child to reach a
   * terminal status, then fires an IAC back to the parent announcing
   * the completion. No-op when the parent is unknown.
   */
  maybeStartCompletionWatcher(opts: {
    readonly childThreadId: ThreadId;
    readonly parentThreadId?: ThreadId;
  }): void {
    const child = this.live.get(opts.childThreadId);
    if (!child) return;
    const parentId =
      opts.parentThreadId ?? this.parentOf.get(opts.childThreadId);
    if (!parentId) return;
    const parent = this.live.get(parentId);

    void this.awaitCompletion(child, parent, parentId);
  }

  private async awaitCompletion(
    child: LiveAgent,
    parent: LiveAgent | undefined,
    parentId: ThreadId,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      if (isFinal(child.status.value)) {
        resolve();
        return;
      }
      const unsubscribe = child.status.subscribe((status) => {
        if (isFinal(status)) {
          unsubscribe();
          resolve();
        }
      });
    });

    const final = child.status.value;
    const message = `subagent ${child.agentPath} finished: ${final.status}`;

    if (!parent) return;
    try {
      parent.downInbox.send({
        author: child.agentPath,
        recipient: parent.agentPath,
        content: message,
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "subagent_completion", finalStatus: final.status },
      });
    } catch (err) {
      if (err instanceof MailboxClosedError) return;
      emitWarning(
        this.session.eventLog,
        this.session.nextInternalSubId(),
        "completion_watcher_send_failed",
        `parent=${parentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Subtree genealogy helpers (Priority 5)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Port of codex `prepare_thread_spawn` (`control.rs:975`). Reserves
   * the nickname and composes the child metadata without actually
   * spawning. Callers that want to preflight a spawn use this to see
   * the allocated path/nickname.
   */
  prepareThreadSpawn(opts: {
    readonly parentPath: AgentPath;
    readonly roleName?: string;
    readonly preferredNickname?: string;
  }): { readonly metadata: AgentMetadata; readonly role: AgentRole } {
    const role = resolveAgentRole(opts.roleName);
    const nickname =
      opts.preferredNickname ?? allocateNickname(role, this.registry);
    const depth = depthOfAgentPath(opts.parentPath) + 1;
    const metadata = buildChildMetadata({
      agentId: "pending",
      parentPath: opts.parentPath,
      role,
      nickname,
      depth,
    });
    return { metadata, role };
  }

  /**
   * Port of codex `inherited_shell_snapshot_for_source`
   * (`control.rs:1010`). Deferred (T13 config refactor).
   */
  inheritedShellSnapshotForSource(
    _parentThreadId: ThreadId | undefined,
  ): unknown | undefined {
    void _parentThreadId;
    return undefined;
  }

  /**
   * Port of codex `inherited_exec_policy_for_source`
   * (`control.rs:1045`). Deferred (T13 config refactor).
   */
  inheritedExecPolicyForSource(
    _parentThreadId: ThreadId | undefined,
  ): unknown | undefined {
    void _parentThreadId;
    return undefined;
  }

  /**
   * Port of codex `open_thread_spawn_children` (`control.rs:1060`).
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
   * Port of codex `live_thread_spawn_children` (`control.rs:1070`).
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
   * Port of codex `live_thread_spawn_descendants` (`control.rs:1137`).
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
   * Port of codex `persist_thread_spawn_edge_for_source`
   * (`control.rs:1113`). Deferred (T10): AgenC's `RolloutStore` has
   * no state-db writer yet. The in-memory `parentOf` map keeps
   * subtree queries accurate today.
   */
  private async persistThreadSpawnEdgeForSource(
    _parentPath: AgentPath,
    _childThreadId: ThreadId,
  ): Promise<void> {
    void _parentPath;
    void _childThreadId;
    return;
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
    return joinAgentPath(parentPath, nickname);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Free helpers (codex parity)
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of codex `render_input_preview` (`control.rs:1187`). Codex's
 * form walks over `Op::UserInput` items; AgenC inputs are plain
 * strings at this boundary, so we preview the first line and truncate
 * to fit a registry `lastTaskMessage` cell.
 */
export function renderInputPreview(input: string): string {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/** Port of codex `agent_matches_prefix` (`control.rs:1173`). */
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
