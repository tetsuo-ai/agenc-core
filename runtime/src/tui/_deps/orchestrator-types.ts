/**
 * Per-dir approval orchestrator types for `runtime/src/tui/**`.
 *
 * The TUI only needs the structural `ApprovalResolver` shape to wire the
 * approval overlay back into the runtime. Keeping the type here avoids a
 * dependency from the vendored Ink tree into the tool-orchestrator module.
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
