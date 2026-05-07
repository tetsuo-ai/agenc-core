/**
 * AgentControl — subagent lifecycle + control plane.
 *
 * Port of reference runtime `core/src/agent/control.rs` (1,214 LOC). Covers: full
 * lifecycle (spawn/interrupt/shutdown/resume), parent→child message
 * routing (followup_task / send_message / inter-agent communication),
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
 *   I-5  (bidirectional mailbox) — routing methods (followup_task /
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
import type {
  ThreadSpawnEdgeStatus,
} from "../session/rollout-store.js";
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
  normalizeAgentNameForPath,
  resolveAgentPath,
} from "./registry.js";
import {
  allocateNickname,
  applyRoleToConfig,
  requireAgentRole,
  resolveAgentRole,
  type AgentRole,
  type RoleShapedConfig,
} from "./role.js";
import { canonicalAgentRoleName } from "./role-presentation.js";
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
  return parseDepthOverride(env.AGENC_AGENT_MAX_DEPTH) ?? DEFAULT_MAX_AGENT_DEPTH;
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
        | { agent_max_depth?: unknown }
        | undefined
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
  /** Caller-supplied metadata fields to merge into the allocated
   *  record (e.g. inherited `agentRole` from a resume payload). */
  readonly metadata?: { readonly [K in keyof AgentMetadata]?: AgentMetadata[K] };
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
    this.maxDepth =
      opts.maxDepth ?? resolveSessionMaxDepth(opts.session) ?? MAX_AGENT_DEPTH;
    this.threadManager = opts.threadManager;
  }

  bindThreadManager(threadManager: ThreadManager): void {
    this.threadManager = threadManager;
    threadManager.bindAgentControl(this);
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
  }): Promise<LiveAgent> {
    const parentDepth = depthOfAgentPath(opts.parentPath);
    const childDepth = parentDepth + 1;
    const role = requireAgentRole(opts.roleName);
    const baseChildConfig = getChildBaseConfig(this.session) ?? {};
    void applyRoleToConfig(role, baseChildConfig);
    const explicitAgentPath =
      opts.agentPath ??
      (opts.agentName !== undefined
        ? joinAgentPath(opts.parentPath, opts.agentName)
        : undefined);

    if (childDepth > this.maxDepth) {
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

    let nickname!: string;
    let threadId!: ThreadId;
    let metadata!: AgentMetadata;
    try {
      if (explicitAgentPath !== undefined) {
        reservation.reserveAgentPath(explicitAgentPath);
      }
      nickname = opts.preferredNickname ?? allocateNickname(role, this.registry);
      threadId = opts.threadId ?? crypto.randomUUID();
      metadata = buildChildMetadata({
        agentId: threadId,
        parentPath: opts.parentPath,
        role,
        nickname,
        depth: childDepth,
        ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
        ...(explicitAgentPath !== undefined ? { agentPath: explicitAgentPath } : {}),
      });
      if (explicitAgentPath === undefined && metadata.agentPath !== undefined) {
        reservation.reserveAgentPath(metadata.agentPath);
      }

      // I-32: check cancellation before finalize. If the parent was
      // interrupted while we were allocating, roll back + throw.
      const parentToken = this.parentTokens.get(opts.parentPath);
      if (parentToken?.signal.aborted) {
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
      reservation.release();
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

    // Persist the spawn edge through the rollout-store-owned snapshot
    // so a fresh control plane can restore descendants later.
    await this.persistThreadSpawnEdgeForSource(
      opts.parentPath,
      threadId,
      metadata,
    );

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
    if (options.roleName !== undefined) {
      (spawnOpts as { roleName?: string }).roleName = options.roleName;
    } else if (options.metadata?.agentRole) {
      (spawnOpts as { roleName?: string }).roleName =
        options.metadata.agentRole;
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
    if (edgeStatus !== null) {
      await this.setThreadSpawnEdgeStatus(threadId, edgeStatus);
    }
  }

  async closeAgent(threadId: ThreadId): Promise<void> {
    await this.shutdown(threadId, "closed_by_tool");
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
    const { metadata, parentPath } = opts;
    const threadId = metadata.agentId;
    const agentPath = metadata.agentPath;
    if (!threadId || !agentPath) return null;

    // I-1: depth cap. Use metadata.depth as authority, fall back to
    // parent-path-derived depth + 1 if metadata is missing depth.
    // Matches reference runtime `>=` comparison (`multi_agents_common.rs:283`).
    const depth =
      metadata.depth ?? depthOfAgentPath(parentPath) + 1;
    if (depth > this.maxDepth) {
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
        const existing = this.live.get(edge.childThreadId);
        if (existing) {
          resumeQueue.push(existing.agentId);
          continue;
        }

        try {
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

  async subscribeStatus(
    threadId: ThreadId,
  ): Promise<{ readonly value: AgentStatus; readonly unsubscribe: () => void }> {
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
      .sort((l, r) =>
        (l.agentPath ?? "").localeCompare(r.agentPath ?? ""),
      );

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
    const message = formatSubagentNotification({
      agentPath: child.agentPath,
      status: final,
    });

    if (!parent) return;
    try {
      parent.downInbox.send({
        author: child.agentPath,
        recipient: parent.agentPath,
        content: message,
        triggerTurn: false,
        direction: "down",
        metadata: { kind: "subagent_notification", finalStatus: final.status },
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
    const role = requireAgentRole(opts.roleName);
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

  inheritedShellSnapshotForSource(
    _parentThreadId: ThreadId | undefined,
  ): unknown | undefined {
    void _parentThreadId;
    const services = this.session.services as unknown as Record<string, unknown>;
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
    const services = this.session.services as unknown as Record<string, unknown>;
    return (
      services.execPolicy ??
      services.exec_policy ??
      services.execPolicyManager
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
    const storedMetadata = metadata ?? this.registry.agentMetadataForThread(childThreadId);
    if (!storedMetadata) return;
    rolloutStore.upsertThreadSpawnEdge({
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
  return {
    ...(metadata?.agentId !== undefined ? { agentId: metadata.agentId } : {}),
    ...(metadata?.agentPath !== undefined ? { agentPath: metadata.agentPath } : {}),
    ...(metadata?.agentNickname !== undefined
      ? { agentNickname: metadata.agentNickname }
      : {}),
    ...(metadata?.agentRole !== undefined ? { agentRole: metadata.agentRole } : {}),
    ...(metadata?.lastTaskMessage !== undefined
      ? { lastTaskMessage: metadata.lastTaskMessage }
      : {}),
    depth: metadata?.depth ?? 0,
  };
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
