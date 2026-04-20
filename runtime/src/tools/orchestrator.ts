/**
 * Tool orchestrator — approval → sandbox → attempt → retry decision
 * pipeline.
 *
 * Hand-port of codex `core/src/tools/orchestrator.rs` (447 LOC). The
 * full codex implementation threads through Seatbelt/Landlock/seccomp
 * primitives and OAuth-bound guardian review. T7 ships the
 * **decision enums + callback surface** — T11 fills in the real
 * permissions/sandbox wiring.
 *
 * The orchestrator sits between the `ToolCallRuntime` (concurrency
 * gate) and the raw `tool.execute()` dispatch. It decides:
 *
 *   1. **ApprovalPolicy** — `never / on_failure / on_request /
 *      granular / untrusted` — whether a tool call needs user approval
 *      before it runs.
 *   2. **SandboxMode** — `danger_full_access / read_only /
 *      workspace_write / external_sandbox` — what filesystem +
 *      network limits the tool runs under.
 *   3. **Attempt** — run the tool once; on failure, decide
 *      **Retry** (re-dispatch with possibly amended args) or bubble.
 *
 * Invariants wired:
 *   I-21 (approval modal ⊥ abort race) — the decision surface
 *        exposes an `approvalRequest` callback that execution.ts
 *        wraps with `Promise.race([modal, signal])`.
 *   I-44 (stale modal decision) — `ApprovalDecision.decisionAtTurnId`
 *        is the turn-id stamp execution.ts validates against the
 *        current turn.
 *
 * @module
 */

import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";

// ─────────────────────────────────────────────────────────────────────
// Policy + mode enums (T11 wires real values)
// ─────────────────────────────────────────────────────────────────────

/** Port of codex `AskForApproval`. */
export type ApprovalPolicy =
  | "never"
  | "on_failure"
  | "on_request"
  | "granular"
  | "untrusted";

/** Port of codex `SandboxMode`. */
export type SandboxMode =
  | "danger_full_access"
  | "read_only"
  | "workspace_write"
  | "external_sandbox";

/** Port of codex `ExecApprovalRequirement` — per-tool-call. */
export type ExecApprovalRequirement =
  | { readonly kind: "skip"; readonly bypassSandbox: boolean }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "needs_approval"; readonly reason?: string };

/** Port of codex `ReviewDecision`. */
export type ReviewDecision =
  | "approved"
  | "approved_for_session"
  | "approved_exec_policy_amendment"
  | "network_policy_amendment"
  | "denied"
  | "abort"
  | "timed_out";

// ─────────────────────────────────────────────────────────────────────
// Approval decision envelope (I-21 + I-44)
// ─────────────────────────────────────────────────────────────────────

export interface ApprovalDecision {
  readonly decision: ReviewDecision;
  /** I-44 stamp. */
  readonly decisionAtTurnId: string;
  readonly reason?: string;
}

// ─────────────────────────────────────────────────────────────────────
// ApprovalCtx — the bundle every decision path receives
// ─────────────────────────────────────────────────────────────────────

/** Port of codex `ApprovalCtx`. */
export interface ApprovalCtx {
  readonly invocation: ToolInvocation;
  readonly callId: string;
  readonly guardianReviewId?: string;
  readonly retryReason?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator decision functions
// ─────────────────────────────────────────────────────────────────────

export interface ClassifyToolOptions {
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  /** Optional per-tool override: tools can be whitelisted/blocklisted
   *  regardless of the session-wide policy. */
  readonly toolAllowlist?: ReadonlySet<string>;
  readonly toolDenylist?: ReadonlySet<string>;
}

/**
 * Decide whether a tool call needs approval. Codex pattern
 * (orchestrator.rs:exec_approval_requirement):
 *
 *   - `never`        → always skip (no approval requested)
 *   - `on_failure`   → skip unless the last attempt failed
 *   - `on_request`   → approve only when the tool explicitly
 *                       marks `requiresApproval=true`
 *   - `granular`     → approve always except read-only tools
 *   - `untrusted`    → approve always
 *
 * Per-tool denylist/allowlist wins. Bash in sandbox `danger_full_access`
 * with `approvalPolicy: 'never'` still skips — user explicitly opted
 * into yolo mode.
 */
export function classifyToolApproval(
  tool: Tool,
  opts: ClassifyToolOptions,
): ExecApprovalRequirement {
  const { name } = tool;
  if (opts.toolDenylist?.has(name)) {
    return { kind: "forbidden", reason: "tool denylisted for this session" };
  }
  if (opts.toolAllowlist?.has(name)) {
    return { kind: "skip", bypassSandbox: false };
  }

  const sandboxBypass =
    opts.sandboxMode === "danger_full_access" && opts.approvalPolicy === "never";

  switch (opts.approvalPolicy) {
    case "never":
      return { kind: "skip", bypassSandbox: sandboxBypass };
    case "on_failure":
      // Orchestrator treats the "retry after failure" slot as the
      // approval trigger — first attempt skips.
      return { kind: "skip", bypassSandbox: false };
    case "on_request": {
      const needs = (tool as Tool & { requiresApproval?: boolean }).requiresApproval === true;
      return needs
        ? { kind: "needs_approval", reason: "tool requested approval" }
        : { kind: "skip", bypassSandbox: false };
    }
    case "granular": {
      const readOnly =
        (tool as Tool & { isReadOnly?: boolean }).isReadOnly === true;
      return readOnly
        ? { kind: "skip", bypassSandbox: false }
        : { kind: "needs_approval", reason: "granular policy: mutation requires approval" };
    }
    case "untrusted":
      return { kind: "needs_approval", reason: "untrusted policy: approve every call" };
    default: {
      const _exhaustive: never = opts.approvalPolicy;
      void _exhaustive;
      return { kind: "skip", bypassSandbox: false };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Retry decision (codex `orchestrator.rs::RetryDecision`)
// ─────────────────────────────────────────────────────────────────────

export type RetryDecision =
  | { readonly kind: "bubble" }
  | { readonly kind: "retry"; readonly args?: Record<string, unknown>; readonly reason: string };

/**
 * Default retry policy: never retry. T11 wires real policy
 * (e.g. retry bash on network-dep + one-shot, retry write on ENOSPC
 * after degraded-mode replay, etc.).
 */
export function defaultRetryPolicy(): RetryDecision {
  return { kind: "bubble" };
}

// ─────────────────────────────────────────────────────────────────────
// Attempt loop — codex `orchestrator::attempt_tool_call`
// ─────────────────────────────────────────────────────────────────────

export interface AttemptOpts<T> {
  readonly dispatch: () => Promise<T>;
  readonly onFailure?: (err: unknown) => RetryDecision;
  readonly maxAttempts?: number;
}

/**
 * Run a tool call with bounded retry. Codex pattern: attempt once;
 * on failure consult `onFailure`; if it returns `retry` update args
 * and dispatch again, else bubble the error. Capped at
 * `maxAttempts` (default 2 — one initial + one retry).
 */
export async function attemptWithRetry<T>(opts: AttemptOpts<T>): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    try {
      return await opts.dispatch();
    } catch (err) {
      if (attempts >= maxAttempts) throw err;
      const decision = opts.onFailure?.(err) ?? defaultRetryPolicy();
      if (decision.kind === "bubble") throw err;
      // retry continues the loop
    }
  }
}
