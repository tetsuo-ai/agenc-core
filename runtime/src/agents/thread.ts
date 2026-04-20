/**
 * AgentThread — high-level wrapper for a live subagent.
 *
 * Bundles the LiveAgent handle (mailboxes, status, abort) with its
 * fork metadata + worktree handle so callers (delegate.ts +
 * TUI transcript) have a single object to subscribe to.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { LiveAgent } from "./control.js";
import type { WorktreeHandle } from "./worktree.js";
import type { ForkMode } from "./fork-context.js";

export interface AgentThreadOpts {
  readonly live: LiveAgent;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly forkMode: ForkMode;
  readonly worktree?: WorktreeHandle;
  readonly parentSessionId?: string;
  readonly taskPrompt: string;
}

export class AgentThread {
  readonly live: LiveAgent;
  readonly initialMessages: ReadonlyArray<LLMMessage>;
  readonly forkMode: ForkMode;
  readonly worktree?: WorktreeHandle;
  readonly parentSessionId?: string;
  readonly taskPrompt: string;
  readonly createdAtMs: number;

  constructor(opts: AgentThreadOpts) {
    this.live = opts.live;
    this.initialMessages = opts.initialMessages;
    this.forkMode = opts.forkMode;
    if (opts.worktree !== undefined) this.worktree = opts.worktree;
    if (opts.parentSessionId !== undefined)
      this.parentSessionId = opts.parentSessionId;
    this.taskPrompt = opts.taskPrompt;
    this.createdAtMs = Date.now();
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

  get isInterrupted(): boolean {
    return this.live.abortController.signal.aborted;
  }

  get currentStatus() {
    return this.live.status.value;
  }

  /** Subscribe to status transitions. */
  onStatusChange(
    listener: (status: ReturnType<() => typeof this.live.status.value>) => void,
  ): () => void {
    return this.live.status.subscribe(listener);
  }
}
