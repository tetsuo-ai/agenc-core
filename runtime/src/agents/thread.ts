/**
 * AgentThread — high-level wrapper for a live subagent.
 *
 * Bundles the LiveAgent handle (mailboxes, status, abort) with its
 * fork metadata + worktree handle so callers (delegate.ts +
 * TUI transcript) have a single object to subscribe to.
 *
 * The class also exposes an AgenC-compatible surface (`threadName`,
 * `messages`, `memory`, `metadata`, `worktreePath`, `worktreeBranch`,
 * `fork()`, `spawn()`, `join()`)
 * so callers can interoperate with AgenC's subagent runtime without
 * reaching into the underlying `LiveAgent` / `delegate()` surface directly.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { AgentMemoryEntry, LiveAgent } from "./control.js";
import type { WorktreeHandle } from "./worktree.js";
import type { ForkMode } from "./fork-context.js";
import type { AgentStatus } from "./status.js";
import { isFinal } from "./status.js";
import type { CacheSafeParams } from "../services/PromptSuggestion/runtime.js";
import type { Message } from "../types/message.js";
import {
  delegate as defaultDelegate,
  type DelegateOpts,
  type DelegateOutcome,
} from "./delegate.js";
import type { RunAgentProgressEvent, RunAgentResult } from "./run-agent.js";
import type { AgentPath } from "./registry.js";
import { runAgentProgressEventToAgentSummaryMessage } from "../services/AgentSummary/transcript.js";

export type MemoryEntry = AgentMemoryEntry;

export interface AgentThreadOpts {
  readonly live: LiveAgent;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly forkMode?: ForkMode;
  readonly worktree?: WorktreeHandle;
  readonly parentSessionId?: string;
  readonly taskPrompt: string;
}

/**
 * Arguments accepted by `AgentThread.fork()` / `AgentThread.spawn()`.
 * Mirrors the canonical spawn surface: a task prompt, an optional role,
 * and optional isolation/worktree info. The only difference between
 * `fork` and `spawn` is the default fork mode; see the method docs.
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
   *   - `spawn()` → undefined (no fork; child starts fresh)
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
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly forkMode?: ForkMode;
  readonly worktree?: WorktreeHandle;
  readonly parentSessionId?: string;
  readonly taskPrompt: string;
  readonly createdAtMs: number;

  private readonly wiring: AgentThreadWiring;
  private liveHandle: LiveAgent;
  private readonly statusListeners = new Set<(status: AgentStatus) => void>();
  private readonly summaryCacheSafeParamListeners = new Set<
    (params: CacheSafeParams) => void
  >();
  private readonly summaryTranscriptMessages: Message[] = [];
  private unsubscribeLiveStatus: (() => void) | null = null;
  private parentPathForChildren: AgentPath;
  private summaryCacheSafeParamsValue: CacheSafeParams | null = null;

  constructor(opts: AgentThreadOpts, wiring: AgentThreadWiring = {}) {
    this.liveHandle = opts.live;
    this.initialMessages = opts.initialMessages;
    if (opts.forkMode !== undefined) this.forkMode = opts.forkMode;
    if (opts.worktree !== undefined) this.worktree = opts.worktree;
    if (opts.parentSessionId !== undefined)
      this.parentSessionId = opts.parentSessionId;
    this.taskPrompt = opts.taskPrompt;
    this.createdAtMs = Date.now();
    this.wiring = wiring;
    this.parentPathForChildren =
      (wiring.parentPath as AgentPath | undefined) ??
      (opts.live.agentPath as AgentPath);
    this.bindLiveStatus();
  }

  get live(): LiveAgent {
    return this.liveHandle;
  }

  get threadId(): string {
    return this.liveHandle.agentId;
  }

  get agentPath(): string {
    return this.liveHandle.agentPath;
  }

  get nickname(): string {
    return this.liveHandle.nickname;
  }

  /**
   * AgenC-compatible alias for `nickname`. Falls back to the thread
   * id when the role allocator could not mint a nickname (e.g. role
   * pool exhausted).
   */
  get threadName(): string {
    return this.liveHandle.nickname || this.liveHandle.agentId;
  }

  get messages(): ReadonlyArray<LLMMessage> {
    const liveMessages = this.liveHandle.messages ?? [];
    return liveMessages.length > 0
      ? liveMessages
      : this.initialMessages;
  }

  get summaryMessages(): ReadonlyArray<Message> {
    return this.summaryTranscriptMessages;
  }

  get summaryCacheSafeParams(): CacheSafeParams | undefined {
    return this.summaryCacheSafeParamsValue ?? undefined;
  }

  setSummaryCacheSafeParams(params: CacheSafeParams): void {
    this.summaryCacheSafeParamsValue = params;
    for (const listener of this.summaryCacheSafeParamListeners) {
      listener(params);
    }
  }

  onSummaryCacheSafeParams(
    listener: (params: CacheSafeParams) => void,
  ): () => void {
    this.summaryCacheSafeParamListeners.add(listener);
    if (this.summaryCacheSafeParamsValue !== null) {
      listener(this.summaryCacheSafeParamsValue);
    }
    return () => {
      this.summaryCacheSafeParamListeners.delete(listener);
    };
  }

  /**
   * Record a progress event into this thread's agent-summary
   * transcript. Initial-replay messages (kind="message" with
   * isInitialReplay=true) ARE intentionally captured here — the
   * summary needs the full fork-context history for downstream
   * consumers to reconstruct what the agent saw at start. Do NOT add
   * an isInitialReplay filter here; that filter belongs in the
   * parent-TUI transport (background-agent-runner.ts), not the
   * summary recorder.
   */
  recordSummaryProgressEvent(event: RunAgentProgressEvent): void {
    const message = runAgentProgressEventToAgentSummaryMessage(
      event,
      this.summaryTranscriptMessages.length,
    );
    if (message !== null) {
      this.summaryTranscriptMessages.push(message);
    }
  }

  /** Resume metadata mirror from the current live handle. */
  get metadata(): LiveAgent["metadata"] {
    return this.liveHandle.metadata;
  }

  get memory(): ReadonlyArray<MemoryEntry> {
    return this.liveHandle.memoryEntries ?? [];
  }

  /** AgenC-compatible alias for `worktree?.path`. */
  get worktreePath(): string | undefined {
    return this.worktree?.path;
  }

  /** AgenC-compatible alias for `worktree?.branch`. */
  get worktreeBranch(): string | undefined {
    return this.worktree?.branch;
  }

  get isInterrupted(): boolean {
    return this.liveHandle.abortController.signal.aborted;
  }

  get currentStatus(): AgentStatus {
    return this.liveHandle.status.value;
  }

  /** Subscribe to status transitions. */
  onStatusChange(
    listener: (status: AgentStatus) => void,
  ): () => void {
    this.statusListeners.add(listener);
    listener(this.liveHandle.status.value);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // AgenC-compatible spawn methods
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
 * Spawn a child WITHOUT inheriting parent history. Equivalent to
   * no fork context for the spawn fork mode. Same wiring
 * requirement as `fork()`.
 */
  async spawn(opts: AgentThreadSpawnOpts): Promise<AgentThread> {
    return this.dispatchSpawn({ ...opts, forkMode: opts.forkMode });
  }

  private async dispatchSpawn(
    opts: AgentThreadSpawnOpts & { forkMode?: ForkMode },
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
    const parentPath = this.parentPathForChildren;
    const outcome: DelegateOutcome = await dispatch({
      parent,
      parentPath,
      control,
      registry,
      taskPrompt: opts.taskPrompt,
      ...(opts.forkMode !== undefined ? { forkMode: opts.forkMode } : {}),
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
          `AgentThread.${opts.forkMode?.kind === "full_history" ? "fork" : "spawn"} rejected: ${outcome.reason}`,
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
    if (isFinal(this.liveHandle.status.value)) {
      return this.synthesizeResult(this.liveHandle.status.value);
    }
    return new Promise<RunAgentResult>((resolve) => {
      const unsubscribe = this.onStatusChange((status) => {
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
          threadId: this.liveHandle.agentId,
          durationMs,
          outcome: "completed",
          ...(status.lastMessage !== undefined
            ? { finalMessage: status.lastMessage }
            : {}),
        };
      case "errored":
        return {
          threadId: this.liveHandle.agentId,
          durationMs,
          outcome: "errored",
          error: status.error,
        };
      case "shutdown":
        return {
          threadId: this.liveHandle.agentId,
          durationMs,
          outcome: "aborted",
        };
      default:
        return {
          threadId: this.liveHandle.agentId,
          durationMs,
          outcome: "aborted",
        };
    }
  }

  rebindLive(live: LiveAgent): void {
    if (this.parentPathForChildren === (this.liveHandle.agentPath as AgentPath)) {
      this.parentPathForChildren = live.agentPath as AgentPath;
    }
    this.liveHandle = live;
    this.bindLiveStatus();
  }

  private bindLiveStatus(): void {
    this.unsubscribeLiveStatus?.();
    this.unsubscribeLiveStatus = this.liveHandle.status.subscribe((status) => {
      for (const listener of this.statusListeners) {
        listener(status);
      }
    });
  }
}
