/**
 * AgentControl — spawn/resume/interrupt/shutdown control plane.
 *
 * Hand-port of codex `core/src/agent/control.rs` (1,214 LOC) — the
 * main subagent lifecycle driver. Codex's implementation threads
 * through the full thread-spawn runtime + state-db rollout
 * integration; AgenC's T9 surface focuses on:
 *
 *   1. `spawn()` — reserve slot (I-63) + depth check (I-1) +
 *      cancellation-token (I-32) + register metadata (I-37)
 *   2. `interrupt()` — signal abort to a running child (I-5
 *      parent→child direction); cascades to descendants
 *   3. `shutdown()` — terminal shutdown with descendant cascade
 *   4. `resume()` — rehydrate from rollout (T6 integration slot)
 *
 * The heavy lifting — actually launching a subagent session and
 * wiring up its run-turn loop — lives in `run-agent.ts`. Control
 * is the single-point-of-truth for lifecycle state transitions.
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
 *   I-5  (bidirectional mailbox) — interrupt routes via the child's
 *        `downInbox` with `direction: 'down'`
 *   I-32 (parent-interrupt race) — cancellation token from the
 *        reservation; `spawn()` validates `parent.token.aborted`
 *        before finalizing; on cancellation, undo slot + send
 *        synthetic interrupt
 *   I-37 (path collision) — registry.reserveAgentPath throws on dup
 *   I-63 (atomic slot acquisition) — registry.reserveSpawnSlot
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
  releaseNickname,
  resolveAgentRole,
  type AgentRole,
} from "./role.js";
import { AgentStatusTracker } from "./status.js";

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
    };

    // I-5: wire the child's upInbox into the session's childInboxes
    // Map so parent-side consumers (TUI, commit phase) can drain.
    this.session.childInboxes.set(threadId, upInbox as unknown as never);
    this.live.set(threadId, agent);

    // Register a per-agent parent cancellation token so nested
    // spawns (grandchildren) observe the parent's token.
    if (!this.parentTokens.has(agent.agentPath)) {
      this.parentTokens.set(agent.agentPath, agent.abortController);
    }

    return agent;
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
    };

    this.session.childInboxes.set(threadId, upInbox as unknown as never);
    this.live.set(threadId, agent);
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
