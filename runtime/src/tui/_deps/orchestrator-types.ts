/**
 * Per-dir orchestrator type stubs for `runtime/src/tui/**`.
 *
 * The TUI consumes `ApprovalResolver` to wire the approval-overlay
 * back into the runtime. Mirrored as a permissive structural shape so
 * the gut TUI tree stays resolvable after the openclaude
 * `tools/orchestrator.ts` is removed. Real wiring lives in the lean
 * rebuild's orchestrator port.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ApprovalCtx {
  readonly invocation?: any;
  readonly callId: string;
  readonly toolName: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly guardianReviewId?: string;
  readonly retryReason?: string;
}

export type ReviewDecisionLike = any;

export interface ApprovalResolver {
  request(ctx: ApprovalCtx): Promise<ReviewDecisionLike>;
}
