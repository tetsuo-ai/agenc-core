/**
 * ResumeManager — decides resume-vs-restart on subagent failure.
 *
 * Port of AgenC resume decision logic + codex runtime
 * `resume_agent_from_rollout` discrimination. When a subagent
 * fails, the parent asks: "can we resume from the last checkpoint,
 * or do we need a fresh thread?"
 *
 *   - **Network errors** (ECONNRESET, stream_idle, 503) → resume:
 *     re-issue the last turn against the same child thread. The
 *     child's history + worktree are intact.
 *   - **Hard errors** (unhandled throw, mode-race, depth-exceeded,
 *     schema-validation) → restart: discard the child thread +
 *     spawn a new one (if the caller still wants the work done).
 *
 * Callers (delegate.ts) dispatch the decision + act. ResumeManager
 * is the policy oracle.
 *
 * @module
 */

import { isTransientProviderError } from "../recovery/api-errors.js";

export type ResumeDecision =
  | { readonly kind: "resume"; readonly reason: string }
  | { readonly kind: "restart"; readonly reason: string }
  | { readonly kind: "abort"; readonly reason: string };

export interface ResumePolicyContext {
  readonly consecutiveFailures: number;
  readonly error: unknown;
  /** True when the parent-side signal fired (no point retrying). */
  readonly parentAborted: boolean;
}

export const RESUME_MAX_ATTEMPTS = 3;

/**
 * Default policy. Network-transient → resume up to RESUME_MAX_ATTEMPTS;
 * non-transient → restart; parent-aborted or over-cap → abort.
 */
export function decideResume(ctx: ResumePolicyContext): ResumeDecision {
  if (ctx.parentAborted) {
    return { kind: "abort", reason: "parent_aborted" };
  }
  if (ctx.consecutiveFailures >= RESUME_MAX_ATTEMPTS) {
    return {
      kind: "abort",
      reason: `resume_max_attempts (${RESUME_MAX_ATTEMPTS})`,
    };
  }
  if (isTransientProviderError(ctx.error)) {
    return { kind: "resume", reason: "transient_provider_error" };
  }
  return { kind: "restart", reason: "hard_error" };
}

/**
 * Stateful manager — tracks per-thread failure counts so a thread
 * that fails-retries-fails can't loop forever.
 */
export class ResumeManager {
  private readonly failuresByThread = new Map<string, number>();

  /** Record a failure + return the policy decision. */
  recordFailure(threadId: string, error: unknown, parentAborted: boolean): ResumeDecision {
    const prev = this.failuresByThread.get(threadId) ?? 0;
    const next = prev + 1;
    this.failuresByThread.set(threadId, next);
    return decideResume({
      consecutiveFailures: next,
      error,
      parentAborted,
    });
  }

  /** Reset on successful completion. */
  recordSuccess(threadId: string): void {
    this.failuresByThread.delete(threadId);
  }

  getFailureCount(threadId: string): number {
    return this.failuresByThread.get(threadId) ?? 0;
  }

  /** Clear all tracked threads (session reset). */
  clear(): void {
    this.failuresByThread.clear();
  }
}
