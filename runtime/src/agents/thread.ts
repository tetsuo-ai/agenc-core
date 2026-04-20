/**
 * AgentThread — high-level wrapper for a live subagent.
 *
 * Bundles the LiveAgent handle (mailboxes, status, abort) with its
 * fork metadata + worktree handle so callers (delegate.ts +
 * TUI transcript) have a single object to subscribe to.
 *
 * The class also exposes an openclaude-compatible surface (`threadName`,
 * `messages`, `memory`, `worktreePath`, `fork()`, `spawn()`, `join()`)
 * so callers that expect the literal openclaude `AgentTool` shape can
 * interoperate with AgenC's subagent runtime without reaching into the
 * underlying `LiveAgent` / `delegate()` surface directly.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { LiveAgent } from "./control.js";
import type { WorktreeHandle } from "./worktree.js";
import type { ForkMode } from "./fork-context.js";
import type { AgentStatus } from "./status.js";
import { isFinal } from "./status.js";
import {
  delegate as defaultDelegate,
  type DelegateOpts,
  type DelegateOutcome,
} from "./delegate.js";
import type { RunAgentResult } from "./run-agent.js";

/**
 * Minimal memory entry shape. Full memory wiring lands in T10; the
 * stub here keeps the getter surface live so openclaude-parity
 * callers can iterate without branching on capability.
 */
export interface MemoryEntry {
  readonly key: string;
  readonly value: unknown;
  readonly at: number;
}

export interface AgentThreadOpts {
  readonly live: LiveAgent;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly forkMode: ForkMode;
  readonly worktree?: WorktreeHandle;
  readonly parentSessionId?: string;
  readonly taskPrompt: string;
}

/**
 * Arguments accepted by `AgentThread.fork()` / `AgentThread.spawn()`.
 * Mirrors the openclaude `AgentTool` spawn surface: a task prompt, an
 * optional role, and optional isolation/worktree info. The only
 * difference between `fork` and `spawn` is the default fork mode —
 * see the method docs.
 */
export interface AgentThreadSpawnOpts {
  readonly taskPrompt: string;
  readonly role?: string;
  readonly isolation?: DelegateOpts["isolation"];
  readonly worktreeSlug?: string;
  readonly runInBackground?: boolean;
  readonly toolAllowlist?: ReadonlyArray<string>;
  /**
   * Override the fork mode. Defaults differ per entry point:
   *   - `fork()`  → `{ kind: 'full_history' }`
   *   - `spawn()` → `{ kind: 'new' }`
   */
  readonly forkMode?: ForkMode;
}

/**
 * Internal wiring hooks. The orchestration harness
 * (`delegate.ts`) injects these when building an `AgentThread` so
 * the wrapper methods can reach back into the session/control-plane
 * surface without `AgentThread` growing a hard dependency on them.
 */
export interface AgentThreadWiring {
  readonly delegate?: typeof defaultDelegate;
  readonly parent?: import("../session/session.js").Session;
  readonly control?: import("./control.js").AgentControl;
  readonly registry?: import("./registry.js").AgentRegistry;
  readonly parentPath?: import("./registry.js").AgentPath;
  /**
   * Sync-mode delegate already returned the completed `RunAgentResult`.
   * `join()` returns it verbatim when set. For async-mode threads the
   * wiring may supply a `joinPromise` that resolves once the
   * background runner finishes; if neither is provided, `join()`
   * polls the live agent's status until it reaches a final state.
   */
  readonly initialResult?: RunAgentResult;
  readonly joinPromise?: Promise<RunAgentResult>;
}

export class AgentThread {
  readonly live: LiveAgent;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly forkMode: ForkMode;
  readonly worktree?: WorktreeHandle;
  readonly parentSessionId?: string;
  readonly taskPrompt: string;
  readonly createdAtMs: number;

  /** Mutable stub for memory — T10 replaces with real persisted store. */
  private readonly memoryEntries: MemoryEntry[] = [];
  private readonly wiring: AgentThreadWiring;

  constructor(opts: AgentThreadOpts, wiring: AgentThreadWiring = {}) {
    this.live = opts.live;
    this.initialMessages = opts.initialMessages;
    this.forkMode = opts.forkMode;
    if (opts.worktree !== undefined) this.worktree = opts.worktree;
    if (opts.parentSessionId !== undefined)
      this.parentSessionId = opts.parentSessionId;
    this.taskPrompt = opts.taskPrompt;
    this.createdAtMs = Date.now();
    this.wiring = wiring;
  }

  get threadId(): string {
    return this.live.agentId;
  }

  get agentPath(): string {
    return this.live.agentPath;
  }

  get nickname(): string {
    return this.live.nickname;
  }

  /**
   * Openclaude-parity alias for `nickname`. Falls back to the thread
   * id when the role allocator could not mint a nickname (e.g. role
   * pool exhausted).
   */
  get threadName(): string {
    return this.live.nickname || this.live.agentId;
  }

  /**
   * The messages that seeded this thread — the fork context result.
   * Today this mirrors `initialMessages` because the subagent runtime
   * does not expose a live message log through `LiveAgent`. T10 will
   * thread the live message store (per-subagent rollout) through
   * here, keeping the getter name stable.
   */
  get messages(): ReadonlyArray<LLMMessage> {
    return this.initialMessages;
  }

  /**
   * Memory scratch for the subagent. Returns the current entries;
   * the underlying array is not mutated by callers. T10 wires the
   * real memory store; today this returns `[]` so openclaude-parity
   * callers can iterate unconditionally.
   */
  get memory(): ReadonlyArray<MemoryEntry> {
    return this.memoryEntries;
  }

  /** Openclaude-parity alias for `worktree?.path`. */
  get worktreePath(): string | undefined {
    return this.worktree?.path;
  }

  get isInterrupted(): boolean {
    return this.live.abortController.signal.aborted;
  }

  get currentStatus(): AgentStatus {
    return this.live.status.value;
  }

  /** Subscribe to status transitions. */
  onStatusChange(
    listener: (status: AgentStatus) => void,
  ): () => void {
    return this.live.status.subscribe(listener);
  }

  // ─────────────────────────────────────────────────────────────────
  // Openclaude-parity spawn methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Spawn a child that inherits the parent's history. Defaults to
   * `forkMode = { kind: 'full_history' }`. Resolves to the new
   * `AgentThread`. Requires that the thread was constructed with
   * wiring (parent/control/registry) so the dispatcher knows where
   * to route the spawn; otherwise throws.
   */
  async fork(opts: AgentThreadSpawnOpts): Promise<AgentThread> {
    const forkMode: ForkMode = opts.forkMode ?? { kind: "full_history" };
    return this.dispatchSpawn({ ...opts, forkMode });
  }

  /**
   * Spawn a child WITHOUT inheriting parent history. Defaults to
   * `forkMode = { kind: 'new' }`. Same wiring requirement as
   * `fork()`.
   */
  async spawn(opts: AgentThreadSpawnOpts): Promise<AgentThread> {
    const forkMode: ForkMode = opts.forkMode ?? { kind: "new" };
    return this.dispatchSpawn({ ...opts, forkMode });
  }

  private async dispatchSpawn(
    opts: AgentThreadSpawnOpts & { forkMode: ForkMode },
  ): Promise<AgentThread> {
    const dispatch = this.wiring.delegate ?? defaultDelegate;
    const parent = this.wiring.parent;
    const control = this.wiring.control;
    const registry = this.wiring.registry;
    if (!parent || !control || !registry) {
      throw new Error(
        "AgentThread.fork/spawn requires wiring with parent + control + registry",
      );
    }
    const parentPath = this.wiring.parentPath ?? (this.live.agentPath as import("./registry.js").AgentPath);
    const outcome: DelegateOutcome = await dispatch({
      parent,
      parentPath,
      control,
      registry,
      taskPrompt: opts.taskPrompt,
      forkMode: opts.forkMode,
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.isolation !== undefined ? { isolation: opts.isolation } : {}),
      ...(opts.worktreeSlug !== undefined
        ? { worktreeSlug: opts.worktreeSlug }
        : {}),
      ...(opts.runInBackground !== undefined
        ? { runInBackground: opts.runInBackground }
        : {}),
      ...(opts.toolAllowlist !== undefined
        ? { toolAllowlist: opts.toolAllowlist }
        : {}),
    });
    switch (outcome.kind) {
      case "sync_completed":
      case "async_launched":
        return outcome.thread;
      case "rejected":
        throw new Error(
          `AgentThread.${opts.forkMode.kind === "full_history" ? "fork" : "spawn"} rejected: ${outcome.reason}`,
        );
    }
  }

  /**
   * Await the thread's terminal status. Returns the already-captured
   * `RunAgentResult` when the dispatcher ran in sync mode (the
   * wiring.initialResult slot), awaits the `joinPromise` when async
   * mode supplied one, or polls `live.status` for a terminal state
   * and synthesizes a minimal `RunAgentResult` otherwise.
   */
  async join(): Promise<RunAgentResult> {
    if (this.wiring.initialResult) {
      return this.wiring.initialResult;
    }
    if (this.wiring.joinPromise) {
      return this.wiring.joinPromise;
    }
    if (isFinal(this.live.status.value)) {
      return this.synthesizeResult(this.live.status.value);
    }
    return new Promise<RunAgentResult>((resolve) => {
      const unsubscribe = this.live.status.subscribe((status) => {
        if (isFinal(status)) {
          unsubscribe();
          resolve(this.synthesizeResult(status));
        }
      });
    });
  }

  private synthesizeResult(status: AgentStatus): RunAgentResult {
    const durationMs = Math.max(0, Date.now() - this.createdAtMs);
    switch (status.status) {
      case "completed":
        return {
          threadId: this.live.agentId,
          durationMs,
          outcome: "completed",
          ...(status.lastMessage !== undefined
            ? { finalMessage: status.lastMessage }
            : {}),
        };
      case "errored":
        return {
          threadId: this.live.agentId,
          durationMs,
          outcome: "errored",
          error: status.error,
        };
      case "shutdown":
        return {
          threadId: this.live.agentId,
          durationMs,
          outcome: "aborted",
        };
      default:
        return {
          threadId: this.live.agentId,
          durationMs,
          outcome: "aborted",
        };
    }
  }
}
