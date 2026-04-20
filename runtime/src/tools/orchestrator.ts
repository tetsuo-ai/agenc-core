/**
 * Tool orchestrator — approval → sandbox → attempt → retry decision
 * pipeline.
 *
 * Hand-port of codex `core/src/tools/orchestrator.rs` (447 LOC).
 * Ports the core lifecycle:
 *
 *   1. `defaultExecApprovalRequirement(policy, fs_policy)` — the
 *      codex decision table (sandboxing.rs:185-221): read current
 *      approval policy + filesystem sandbox kind to decide
 *      skip / needs_approval / forbidden.
 *   2. **Two-pass sandbox escalation** — first attempt under the
 *      selected sandbox; on a `SandboxDeniedError`, request approval
 *      and retry with sandbox disabled (codex orchestrator.rs:188-373).
 *   3. **`requestApproval()`** — consult the registered
 *      `permission-request` hooks first, then fall back to the
 *      session's approval resolver. If neither is wired, default
 *      deny with `cause: "no_approval_resolver"`.
 *   4. **`defaultToolRetryPolicy`** — classify errors into
 *      transient-retryable (one retry after 500ms), sandbox-denied
 *      (escalate via approval), hard (bubble).
 *
 * Invariants:
 *   I-21 (approval modal ⊥ abort race) — `requestApproval` accepts an
 *        optional `AbortSignal` so the caller can race with the turn
 *        abort controller.
 *   I-44 (stale modal decision) — `ApprovalDecision.decisionAtTurnId`
 *        is the turn stamp callers validate against the current turn.
 *
 * Explicitly deferred vs codex:
 *   - OTEL `tool_decision` emission: T7 has no otel bridge yet; we
 *     emit a session event via the caller-supplied hook instead of
 *     spawning a SessionTelemetry call at this layer.
 *   - Guardian review ID + rejection reasons: the guardian subsystem
 *     lands in T11; this port ignores the `routes_approval_to_guardian`
 *     branch and uses plain "rejected by user" reasons.
 *   - Deferred network approval workflow (`DeferredNetworkApproval`)
 *     is out of scope — covered by the network-approval tranche.
 *
 * @module
 */

import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";

// ─────────────────────────────────────────────────────────────────────
// Policy + mode enums (mirror of codex protocol)
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

/**
 * Port of codex `FileSystemSandboxKind` (protocol/src/permissions.rs:131).
 * This is the narrower shape `defaultExecApprovalRequirement` actually
 * reads — the full `FileSystemSandboxPolicy` is still modeled in
 * `session/turn-context.ts`, we just extract `.kind` here.
 */
export type FileSystemSandboxKind =
  | "restricted"
  | "unrestricted"
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
  readonly toolName: string;
  readonly turnId: string;
  readonly guardianReviewId?: string;
  readonly retryReason?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Sandbox-denied error (ports codex `SandboxErr::Denied`).
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by a tool's inner dispatch when the active sandbox refuses
 * the operation. The orchestrator lifecycle intercepts this, requests
 * approval, and retries with sandbox disabled.
 */
export class SandboxDeniedError extends Error {
  readonly kind = "sandbox_denied" as const;
  readonly output?: string;
  constructor(message: string, output?: string) {
    super(message);
    this.name = "SandboxDeniedError";
    this.output = output;
  }
}

/** Classifier used by the retry policy. */
export function isSandboxDeniedError(err: unknown): err is SandboxDeniedError {
  return (
    err instanceof SandboxDeniedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { kind?: string }).kind === "sandbox_denied")
  );
}

// ─────────────────────────────────────────────────────────────────────
// Classifier: does this tool call need approval?
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
// Default approval requirement table (codex sandboxing.rs:185-221)
// ─────────────────────────────────────────────────────────────────────

/**
 * Map codex `SandboxMode` → `FileSystemSandboxKind`. This matches the
 * kind assignments in protocol/permissions.rs (restricted =
 * `workspace_write` / `read_only`, unrestricted = `danger_full_access`,
 * external_sandbox = `external_sandbox`).
 */
export function sandboxKindFromMode(mode: SandboxMode): FileSystemSandboxKind {
  switch (mode) {
    case "danger_full_access":
      return "unrestricted";
    case "external_sandbox":
      return "external_sandbox";
    case "read_only":
    case "workspace_write":
      return "restricted";
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return "restricted";
    }
  }
}

/**
 * Port of codex `default_exec_approval_requirement`
 * (sandboxing.rs:185-221). Given the current approval policy + the
 * filesystem sandbox kind, return the skip/needs-approval/forbidden
 * decision the orchestrator will apply when a tool did not override
 * the requirement itself.
 *
 * Codex table:
 *
 *   | policy          | fs kind       | decision       |
 *   |-----------------|---------------|----------------|
 *   | never           | any           | skip           |
 *   | on_failure      | any           | skip           |
 *   | on_request      | restricted    | needs_approval |
 *   | on_request      | !restricted   | skip           |
 *   | granular        | restricted    | needs_approval |
 *   | granular        | !restricted   | skip           |
 *   | untrusted       | any           | needs_approval |
 */
export function defaultExecApprovalRequirement(
  policy: ApprovalPolicy,
  fsKind: FileSystemSandboxKind,
): ExecApprovalRequirement {
  let needsApproval = false;
  switch (policy) {
    case "never":
    case "on_failure":
      needsApproval = false;
      break;
    case "on_request":
    case "granular":
      needsApproval = fsKind === "restricted";
      break;
    case "untrusted":
      needsApproval = true;
      break;
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
    }
  }
  if (needsApproval) {
    return { kind: "needs_approval" };
  }
  return { kind: "skip", bypassSandbox: false };
}

// ─────────────────────────────────────────────────────────────────────
// Approval resolver interface + request pipeline
// ─────────────────────────────────────────────────────────────────────

/**
 * Session-level approval UI. A concrete implementation is installed on
 * `session.services.approvalResolver`. When absent, `requestApproval`
 * defaults to `denied` with `cause: "no_approval_resolver"`.
 */
export interface ApprovalResolver {
  request(ctx: ApprovalCtx): Promise<ReviewDecision>;
}

/**
 * Permission-request hook. First-match wins: the first hook to return
 * a decision other than `undefined` short-circuits the resolver path.
 * Ports the precedence of `run_permission_request_hooks` in codex
 * `orchestrator.rs:394-425`.
 */
export type PermissionRequestHook = (
  ctx: ApprovalCtx,
) => Promise<ReviewDecision | undefined> | ReviewDecision | undefined;

export interface RequestApprovalOpts {
  readonly ctx: ApprovalCtx;
  readonly hooks?: ReadonlyArray<PermissionRequestHook>;
  readonly resolver?: ApprovalResolver;
  /** Logger for "no resolver" default-deny event. Optional. */
  readonly onNoResolver?: (ctx: ApprovalCtx) => void;
}

export interface RequestApprovalResult {
  readonly decision: ReviewDecision;
  readonly source: "hook" | "resolver" | "default_deny";
}

/**
 * Run the permission-request pipeline. Codex order:
 *
 *   1. For each registered `permission-request` hook: await; the
 *      first `Allow | Deny` answer wins. `undefined` means "pass".
 *   2. If every hook passed, delegate to the session approval resolver
 *      (the in-band UI modal).
 *   3. If no resolver is wired, return `denied` with source
 *      `default_deny` so the caller can surface
 *      `cause: "no_approval_resolver"`.
 */
export async function requestApproval(
  opts: RequestApprovalOpts,
): Promise<RequestApprovalResult> {
  for (const hook of opts.hooks ?? []) {
    const result = await hook(opts.ctx);
    if (result !== undefined) {
      return { decision: result, source: "hook" };
    }
  }
  if (opts.resolver) {
    const decision = await opts.resolver.request(opts.ctx);
    return { decision, source: "resolver" };
  }
  opts.onNoResolver?.(opts.ctx);
  return { decision: "denied", source: "default_deny" };
}

/**
 * Translate a `ReviewDecision` into the control-flow intent the
 * orchestrator needs: proceed vs reject vs timeout. Mirrors the
 * match tree at codex `orchestrator.rs:160-183`.
 */
export function isApprovalAccepted(decision: ReviewDecision): boolean {
  return (
    decision === "approved" ||
    decision === "approved_for_session" ||
    decision === "approved_exec_policy_amendment"
  );
}

// ─────────────────────────────────────────────────────────────────────
// Retry decision + default policy (codex `orchestrator.rs::RetryDecision`)
// ─────────────────────────────────────────────────────────────────────

export type RetryDecision =
  | { readonly kind: "bubble" }
  | { readonly kind: "retry"; readonly args?: Record<string, unknown>; readonly reason: string; readonly delayMs?: number }
  | { readonly kind: "escalate_sandbox"; readonly reason: string };

/** Heuristic: transient errors we retry once after a short backoff. */
function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("eai_again") ||
    lower.includes("transient")
  );
}

/**
 * Port of codex `orchestrator::default_retry_policy`. Replaces the
 * previous `{kind: "bubble"}` stub with a real classifier:
 *
 *   - `SandboxDeniedError` → `escalate_sandbox` (the lifecycle
 *     promotes this to an approval prompt + retry with sandbox off).
 *   - transient markers (timeout / econnreset / etimedout) → `retry`
 *     with a 500ms backoff, max one extra attempt.
 *   - anything else → `bubble` (no retry).
 */
export function defaultToolRetryPolicy(err: unknown): RetryDecision {
  if (isSandboxDeniedError(err)) {
    return { kind: "escalate_sandbox", reason: "sandbox denied operation" };
  }
  if (isTransientError(err)) {
    return { kind: "retry", reason: "transient error", delayMs: 500 };
  }
  return { kind: "bubble" };
}

/** Back-compat wrapper (old signature took no args, always bubbled). */
export function defaultRetryPolicy(): RetryDecision {
  return { kind: "bubble" };
}

// ─────────────────────────────────────────────────────────────────────
// Attempt loop — codex `orchestrator::attempt_tool_call`
// ─────────────────────────────────────────────────────────────────────

export interface AttemptOpts<T> {
  readonly dispatch: () => Promise<T>;
  readonly onFailure?: (err: unknown) => RetryDecision | Promise<RetryDecision>;
  readonly maxAttempts?: number;
  /** Optional: override the backoff timer hook (tests wire a fast path). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a tool call with bounded retry. Codex pattern: attempt once; on
 * failure consult `onFailure`; if it returns `retry` sleep optionally
 * then dispatch again; `escalate_sandbox` bubbles to the caller (the
 * orchestrate-tool-call lifecycle catches it); else bubble the error.
 * Capped at `maxAttempts` (default 2 — one initial + one retry).
 */
export async function attemptWithRetry<T>(opts: AttemptOpts<T>): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    try {
      return await opts.dispatch();
    } catch (err) {
      if (attempts >= maxAttempts) throw err;
      const decision = await (opts.onFailure?.(err) ?? defaultRetryPolicy());
      if (decision.kind === "bubble") throw err;
      if (decision.kind === "escalate_sandbox") throw err;
      if (decision.kind === "retry" && decision.delayMs && decision.delayMs > 0) {
        await sleep(decision.delayMs);
      }
      // retry continues the loop
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle — approval → sandbox → attempt → retry-after-approval
// ─────────────────────────────────────────────────────────────────────

export interface OrchestrateToolCallOpts<T> {
  readonly tool: Tool;
  readonly approvalCtx: ApprovalCtx;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  /** Per-tool overrides (denylist/allowlist). */
  readonly toolAllowlist?: ReadonlySet<string>;
  readonly toolDenylist?: ReadonlySet<string>;
  /** Attempt executor — receives the selected sandbox mode. The caller
   *  may gate the actual FS/network constraints internally. Should
   *  throw `SandboxDeniedError` on sandbox denial. */
  readonly dispatch: (sandbox: SandboxMode) => Promise<T>;
  /** Approval pipeline plumbing. */
  readonly permissionHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly approvalResolver?: ApprovalResolver;
  /** Emitted when approval falls through to default-deny. */
  readonly onNoApprovalResolver?: (ctx: ApprovalCtx) => void;
  /** Transient retry budget (defaults to 2 = one retry). */
  readonly maxAttempts?: number;
  /** Testing hook. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class ApprovalRejectedError extends Error {
  readonly kind = "approval_rejected" as const;
  readonly decision: ReviewDecision;
  constructor(message: string, decision: ReviewDecision) {
    super(message);
    this.name = "ApprovalRejectedError";
    this.decision = decision;
  }
}

/**
 * Port of codex `ToolOrchestrator::run` (orchestrator.rs:105-377).
 *
 * Flow:
 *
 *   1. Compute the `ExecApprovalRequirement`. A tool may override via
 *      `requiresApproval` / `isReadOnly`; if not, we fall back to
 *      `defaultExecApprovalRequirement(policy, fs_kind)`.
 *   2. If `forbidden` → throw `ApprovalRejectedError("forbidden")`.
 *      If `needs_approval` → run the approval pipeline; non-accept
 *      answers throw `ApprovalRejectedError`.
 *   3. Select the initial sandbox (`bypass` from `skip.bypassSandbox`
 *      or the session mode). Dispatch inside `attemptWithRetry` so
 *      transient errors get one bounded retry.
 *   4. If the first attempt (or its retry) throws
 *      `SandboxDeniedError`: request approval, then retry the tool
 *      with `sandbox = "danger_full_access"` (the TS parity for
 *      codex's `SandboxType::None`).
 */
export async function orchestrateToolCall<T>(
  opts: OrchestrateToolCallOpts<T>,
): Promise<T> {
  // Step 1 — approval classification.
  const toolOverride = classifyToolApproval(opts.tool, {
    approvalPolicy: opts.approvalPolicy,
    sandboxMode: opts.sandboxMode,
    ...(opts.toolAllowlist !== undefined ? { toolAllowlist: opts.toolAllowlist } : {}),
    ...(opts.toolDenylist !== undefined ? { toolDenylist: opts.toolDenylist } : {}),
  });

  let requirement = toolOverride;
  // If the tool classifier returned `skip` without a sandbox bypass and
  // the approval policy does not explicitly opt the tool in/out, fall
  // through to the fs-policy-aware default (codex parity).
  if (
    toolOverride.kind === "skip" &&
    !toolOverride.bypassSandbox &&
    opts.toolAllowlist?.has(opts.tool.name) !== true
  ) {
    const fsKind = sandboxKindFromMode(opts.sandboxMode);
    requirement = defaultExecApprovalRequirement(opts.approvalPolicy, fsKind);
  }

  if (requirement.kind === "forbidden") {
    throw new ApprovalRejectedError(requirement.reason, "denied");
  }

  let alreadyApproved = false;
  let bypassSandbox =
    toolOverride.kind === "skip" ? toolOverride.bypassSandbox : false;

  if (requirement.kind === "needs_approval") {
    const approvalCtx: ApprovalCtx = {
      ...opts.approvalCtx,
      ...(requirement.reason !== undefined
        ? { retryReason: requirement.reason }
        : {}),
    };
    const approval = await requestApproval({
      ctx: approvalCtx,
      ...(opts.permissionHooks !== undefined ? { hooks: opts.permissionHooks } : {}),
      ...(opts.approvalResolver !== undefined ? { resolver: opts.approvalResolver } : {}),
      ...(opts.onNoApprovalResolver !== undefined
        ? { onNoResolver: opts.onNoApprovalResolver }
        : {}),
    });
    if (!isApprovalAccepted(approval.decision)) {
      throw new ApprovalRejectedError(
        approval.source === "default_deny"
          ? "no_approval_resolver"
          : approval.decision === "timed_out"
            ? "approval timed out"
            : "rejected by user",
        approval.decision,
      );
    }
    alreadyApproved = true;
  }

  // Step 2 — first attempt with bounded transient retry.
  const firstSandbox: SandboxMode = bypassSandbox
    ? "danger_full_access"
    : opts.sandboxMode;

  try {
    return await attemptWithRetry({
      dispatch: () => opts.dispatch(firstSandbox),
      onFailure: defaultToolRetryPolicy,
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
    });
  } catch (err) {
    if (!isSandboxDeniedError(err)) throw err;

    // Step 3 — approval-gated escalation to sandbox=off.
    if (!alreadyApproved) {
      const escalationCtx: ApprovalCtx = {
        ...opts.approvalCtx,
        retryReason:
          err.message || "command failed; retry without sandbox?",
      };
      const approval = await requestApproval({
        ctx: escalationCtx,
        ...(opts.permissionHooks !== undefined ? { hooks: opts.permissionHooks } : {}),
        ...(opts.approvalResolver !== undefined ? { resolver: opts.approvalResolver } : {}),
        ...(opts.onNoApprovalResolver !== undefined
          ? { onNoResolver: opts.onNoApprovalResolver }
          : {}),
      });
      if (!isApprovalAccepted(approval.decision)) {
        throw new ApprovalRejectedError(
          approval.source === "default_deny"
            ? "no_approval_resolver"
            : approval.decision === "timed_out"
              ? "approval timed out"
              : "rejected by user",
          approval.decision,
        );
      }
    }

    // Retry with sandbox disabled (codex `SandboxType::None`).
    return await opts.dispatch("danger_full_access");
  }
}
