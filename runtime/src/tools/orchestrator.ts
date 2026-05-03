/**
 * Tool orchestrator — approval → sandbox → attempt → retry decision
 * pipeline.
 *
 * Hand-port of donor runtime `core/src/tools/orchestrator.rs` (447 LOC).
 * Ports the core lifecycle:
 *
 *   1. `defaultExecApprovalRequirement(policy, fs_policy)` — the
 *      donor runtime decision table (sandboxing.rs:185-221): read current
 *      approval policy + filesystem sandbox kind to decide
 *      skip / needs_approval / forbidden.
 *   2. **Two-pass sandbox escalation** — first attempt under the
 *      selected sandbox; on a `SandboxDeniedError`, request approval
 *      and retry with sandbox disabled (donor runtime orchestrator.rs:188-373).
 *   3. **`requestApproval()`** — consult the registered
 *      `permission-request` hooks first, route auto-reviewed
 *      approvals through the guardian reviewer when configured, then
 *      fall back to the session's approval resolver. If neither is
 *      wired, default deny with `cause: "no_approval_resolver"`.
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
 * Explicitly deferred vs donor runtime:
 *   - OTEL `tool_decision` emission: T7 has no otel bridge yet; we
 *     emit a session event via the caller-supplied hook instead of
 *     spawning a SessionTelemetry call at this layer.
 *   - Deferred network approval workflow (`DeferredNetworkApproval`)
 *     is out of scope — covered by the network-approval tranche.
 *
 * @module
 */

import type { Tool } from "./types.js";
import type { ToolInvocation, ToolPayload } from "./context.js";
import type { PermissionDefaultMode } from "../config/schema.js";
import {
  resolveHookPermissionDecision,
  type PermissionDecisionHook,
} from "./hooks.js";
import {
  defaultExecApprovalRequirement as defaultExecApprovalRequirementFromPermissions,
  type ApprovalPolicy as PermissionsApprovalPolicy,
  type ExecApprovalRequirement as PermissionsExecApprovalRequirement,
  type FileSystemSandboxKind as PermissionsFileSystemSandboxKind,
  type GranularApprovalConfig,
} from "../permissions/approval-policy.js";

export type { GranularApprovalConfig };
import {
  reviewDecisionIsAllow,
  type ReviewDecision as PermissionsReviewDecision,
} from "../permissions/review-decision.js";
import { SandboxDeniedError } from "../permissions/sandbox.js";
import {
  newGuardianReviewId,
  shouldRouteApprovalToGuardian,
  type GuardianApprovalReviewer,
} from "../session/guardian-approval-review.js";

export { SandboxDeniedError };

// ─────────────────────────────────────────────────────────────────────
// Policy + mode enums — re-exported from `permissions/` so this file
// remains the stable orchestrator surface while the canonical types
// live in the permissions layer (T11 Wave 1 Agent C).
// ─────────────────────────────────────────────────────────────────────

/** Port of donor runtime `AskForApproval`. */
export type ApprovalPolicy = PermissionsApprovalPolicy;

/**
 * Port of donor runtime `SandboxMode`. Includes `external_sandbox` as a fourth
 * value — the orchestrator receives this from `TurnContext`, but the
 * permissions `SandboxMode` enum is the 3-variant selector. The two
 * keep the overlapping names in sync.
 */
export type SandboxMode =
  | "danger_full_access"
  | "read_only"
  | "workspace_write"
  | "external_sandbox";

/**
 * Port of donor runtime `FileSystemSandboxKind`. The permissions layer uses
 * the 2-variant form (`full_access` / `restricted`). The orchestrator
 * keeps a compatibility layer that distinguishes `external_sandbox`
 * as a third kind for the older call sites. Callers that only need
 * the permission decision should import from `permissions/`.
 */
export type FileSystemSandboxKind =
  | "restricted"
  | "unrestricted"
  | "external_sandbox";

/** Port of donor runtime `ExecApprovalRequirement` — per-tool-call. */
export type ExecApprovalRequirement = PermissionsExecApprovalRequirement;

/** Port of donor runtime `ReviewDecision`. */
export type ReviewDecision = PermissionsReviewDecision;

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

/** Port of donor runtime `ApprovalCtx`. */
export interface ApprovalCtx {
  readonly invocation: ToolInvocation;
  readonly callId: string;
  readonly toolName: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly guardianReviewId?: string;
  readonly retryReason?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Sandbox-denied error (ports donor runtime `SandboxErr::Denied`).
// ─────────────────────────────────────────────────────────────────────

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
  /**
   * Full tool payload variant. Different payload kinds get different
   * classification rules — MCP calls defer to server-side trust, shell
   * payloads route through the fs-policy-aware default, tool_search is
   * always read-only, and `custom`/`function` share the legacy logic.
   * When omitted, the classifier falls back to the `function` branch
   * so legacy call sites keep working.
   */
  readonly payload?: ToolPayload;
  /**
   * Optional MCP trust resolver. When a payload is `{kind:"mcp"}` and
   * this returns `true`, the call is considered pre-approved at the
   * server level and skips approval. When `undefined` or `false`, the
   * MCP call falls through to the normal policy matrix.
   */
  readonly mcpServerTrusted?: (server: string) => boolean;
  /**
   * Optional `GranularApprovalConfig` that accompanies
   * `approvalPolicy === "granular"`. AgenC behavior — port of
   * `AskForApproval::Granular(GranularConfig)` inner payload
   * (protocol.rs:859-874). When the granular config disallows sandbox
   * approval prompts, classification of a restricted call returns
   * `forbidden` instead of `needs_approval`.
   */
  readonly granular?: GranularApprovalConfig;
}

/**
 * Decide whether a tool call needs approval. donor runtime pattern
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

  // Payload-variant routing. Every tool invocation carries a typed
  // `ToolPayload` describing its kind. Different kinds get different
  // approval rules — MCP server-side trust, `tool_search` is always
  // read-only, `local_shell` uses the fs-policy default, etc.
  const payload = opts.payload;
  if (payload) {
    switch (payload.kind) {
      case "tool_search":
        // Tool discovery is read-only metadata — always skip approval.
        return { kind: "skip", bypassSandbox: false };
      case "mcp": {
        if (opts.mcpServerTrusted?.(payload.server) === true) {
          return { kind: "skip", bypassSandbox: false };
        }
        // Fall through to the function-branch logic below — the MCP
        // server is not trusted so the normal policy matrix applies.
        break;
      }
      case "local_shell": {
        // Route shell calls through the fs-policy-aware default. Pipe
        // through the optional `granular` config so the permissions
        // layer can surface the `forbidden` branch when the user has
        // disabled sandbox approval prompts.
        const fsKind = sandboxKindFromMode(opts.sandboxMode);
        const fallback = defaultExecApprovalRequirement(
          opts.approvalPolicy,
          fsKind,
          opts.granular,
        );
        if (fallback.kind === "forbidden") {
          return fallback;
        }
        if (fallback.kind === "needs_approval") {
          return {
            kind: "needs_approval",
            reason: `local_shell under ${fsKind} sandbox requires approval`,
          };
        }
        // When policy skips, honor the danger-yolo bypass exactly like
        // the function branch below.
        return {
          kind: "skip",
          bypassSandbox:
            opts.sandboxMode === "danger_full_access" &&
            opts.approvalPolicy === "never",
        };
      }
      case "custom":
      case "function":
        // Falls through to the shared function-kind switch below.
        break;
    }
  }

  const sandboxBypass =
    opts.sandboxMode === "danger_full_access" && opts.approvalPolicy === "never";

  if (tool.requiresUserInteraction?.() === true) {
    return { kind: "needs_approval", reason: "tool requires user interaction" };
  }

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
// Default approval requirement table (donor runtime sandboxing.rs:185-221)
// ─────────────────────────────────────────────────────────────────────

/**
 * Map donor runtime `SandboxMode` → `FileSystemSandboxKind`. This matches the
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
 * Port of donor runtime `default_exec_approval_requirement`
 * (sandboxing.rs:185-221). Given the current approval policy + the
 * filesystem sandbox kind, return the skip/needs-approval/forbidden
 * decision the orchestrator will apply when a tool did not override
 * the requirement itself.
 *
 * donor runtime table:
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
  granular?: GranularApprovalConfig,
): ExecApprovalRequirement {
  // Narrow the 3-variant orchestrator-side kind to the 2-variant
  // permissions-layer kind: `external_sandbox` is treated as a
  // non-restricted context for approval-table purposes (AgenC behavior).
  const narrowed: PermissionsFileSystemSandboxKind =
    fsKind === "restricted" ? "restricted" : "full_access";
  return defaultExecApprovalRequirementFromPermissions(
    policy,
    narrowed,
    granular,
  );
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
 * Ports the precedence of `run_permission_request_hooks` in donor runtime
 * `orchestrator.rs:394-425`.
 */
export type PermissionRequestHook = (
  ctx: ApprovalCtx,
) => Promise<ReviewDecision | undefined> | ReviewDecision | undefined;

export interface RequestApprovalOpts {
  readonly ctx: ApprovalCtx;
  readonly hooks?: ReadonlyArray<PermissionRequestHook>;
  /**
   * Typed `PermissionDecisionHook` pipeline — walked AFTER `hooks` and
   * BEFORE the resolver / default-deny fallback so typed per-tool
   * policy hooks can approve or deny without synthesizing a raw
   * `ReviewDecision`. First non-`pass` decision wins:
   *   - `allow` → `approved`
   *   - `deny`  → `denied`
   *   - `ask`   → falls through to the resolver.
   */
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  /** Raw args fed to the decision hooks. Defaults to `{}` when absent. */
  readonly args?: Record<string, unknown>;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly resolver?: ApprovalResolver;
  readonly signal?: AbortSignal;
  /** Logger for "no resolver" default-deny event. Optional. */
  readonly onNoResolver?: (ctx: ApprovalCtx) => void;
}

export interface RequestApprovalResult {
  readonly decision: ReviewDecision;
  readonly source:
    | "hook"
    | "resolver"
    | "default_deny"
    | "permission_hook"
    | "guardian"
    | "aborted";
  readonly reason?: string;
}

function alreadyAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * AgenC behavior: detect the abort branch without relying on
 * `String(err).toLowerCase().includes("abort")` substring sniffing.
 * Mirrors the `tokio::select!` cancellation arm — we match:
 *   - `DOMException` / `AbortError` (browser/Node `AbortSignal` throws)
 *   - our in-tree `awaitWithAbort` reject (error whose message matches
 *     the signal's `reason` exactly)
 *   - direct `AbortSignal`-rooted errors (`err.name === "AbortError"`)
 * Never string-sniffs: an error message containing the word "abort"
 * from a legitimate tool failure will no longer be misclassified.
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (err === null || err === undefined) return false;
  // Signal-aborted path: synthesized rejection from awaitWithAbort
  // carries `signal.reason` as the message; match by identity where
  // possible, otherwise by the explicit AbortError `name` marker.
  if (signal?.aborted === true) {
    if (err instanceof Error) {
      const expected = String(signal.reason ?? "aborted");
      if (err.message === expected) return true;
    }
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  // Node's AbortController.abort(reason) propagates the reason directly
  // as the rejection value — check its shape when it isn't an Error.
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new Error(String(signal.reason ?? "aborted"));
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error(String(signal.reason ?? "aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Run the permission-request pipeline. donor runtime order:
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
  const signal = opts.signal ?? opts.ctx.signal;
  if (alreadyAborted(signal)) {
    return { decision: { kind: "abort" }, source: "aborted" };
  }

  for (const hook of opts.hooks ?? []) {
    let result: ReviewDecision | undefined;
    try {
      result = await awaitWithAbort(Promise.resolve(hook(opts.ctx)), signal);
    } catch (err) {
      if (alreadyAborted(signal) || isAbortError(err, signal)) {
        return { decision: { kind: "abort" }, source: "aborted" };
      }
      throw err;
    }
    if (result !== undefined) {
      return { decision: result, source: "hook" };
    }
  }
  // Typed permission decision hooks — walked BEFORE resolver / default_deny
  // so hook-driven allow/deny decisions bypass the raw-resolver modal.
  if (opts.permissionDecisionHooks && opts.permissionDecisionHooks.length > 0) {
    let decision;
    try {
      decision = await awaitWithAbort(
        resolveHookPermissionDecision(
          opts.ctx.toolName,
          opts.args ?? {},
          opts.permissionDecisionHooks,
        ),
        signal,
      );
    } catch (err) {
      if (alreadyAborted(signal) || isAbortError(err, signal)) {
        return { decision: { kind: "abort" }, source: "aborted" };
      }
      throw err;
    }
    if (decision.kind === "allow") {
      return { decision: { kind: "approved" }, source: "permission_hook" };
    }
    if (decision.kind === "deny") {
      return { decision: { kind: "denied" }, source: "permission_hook" };
    }
    // `ask` / `pass` → fall through to resolver.
  }
  if (
    opts.guardianApprovalReviewer !== undefined &&
    shouldRouteApprovalToGuardian(opts.ctx)
  ) {
    const reviewId = opts.ctx.guardianReviewId ?? newGuardianReviewId();
    const guardianCtx: ApprovalCtx = {
      ...opts.ctx,
      guardianReviewId: reviewId,
      ...(signal !== undefined ? { signal } : {}),
    };
    try {
      const result = await awaitWithAbort(
        opts.guardianApprovalReviewer.reviewApprovalRequest({
          ctx: guardianCtx,
          args: opts.args ?? {},
          ...(signal !== undefined ? { signal } : {}),
        }),
        signal,
      );
      return {
        decision: result.decision,
        source: "guardian",
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    } catch (err) {
      if (alreadyAborted(signal) || isAbortError(err, signal)) {
        return { decision: { kind: "abort" }, source: "aborted" };
      }
      throw err;
    }
  }
  if (opts.resolver) {
    try {
      const decision = await awaitWithAbort(
        opts.resolver.request({
          ...opts.ctx,
          ...(signal !== undefined ? { signal } : {}),
        }),
        signal,
      );
      return { decision, source: "resolver" };
    } catch (err) {
      if (alreadyAborted(signal) || isAbortError(err, signal)) {
        return { decision: { kind: "abort" }, source: "aborted" };
      }
      throw err;
    }
  }
  opts.onNoResolver?.(opts.ctx);
  return { decision: { kind: "denied" }, source: "default_deny" };
}

/**
 * Translate a `ReviewDecision` into the control-flow intent the
 * orchestrator needs: proceed vs reject vs timeout. Mirrors the
 * match tree at donor runtime `orchestrator.rs:160-183`.
 */
export function isApprovalAccepted(decision: ReviewDecision): boolean {
  return reviewDecisionIsAllow(decision);
}

// ─────────────────────────────────────────────────────────────────────
// Retry decision + default policy (donor runtime `orchestrator.rs::RetryDecision`)
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
 * Port of donor runtime `orchestrator::default_retry_policy`. Replaces the
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
// Attempt loop — donor runtime `orchestrator::attempt_tool_call`
// ─────────────────────────────────────────────────────────────────────

export interface AttemptOpts<T> {
  readonly dispatch: () => Promise<T>;
  readonly onFailure?: (err: unknown) => RetryDecision | Promise<RetryDecision>;
  readonly maxAttempts?: number;
  /** Optional: override the backoff timer hook (tests wire a fast path). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a tool call with bounded retry. donor runtime pattern: attempt once; on
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
  readonly signal?: AbortSignal;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  readonly payload?: ToolPayload;
  readonly mcpServerTrusted?: (server: string) => boolean;
  /** Per-tool overrides (denylist/allowlist). */
  readonly toolAllowlist?: ReadonlySet<string>;
  readonly toolDenylist?: ReadonlySet<string>;
  /**
   * Optional `GranularApprovalConfig` accompanying `"granular"` policy —
   * AgenC behavior (`AskForApproval::Granular(GranularConfig)`). Piped
   * into `classifyToolApproval` and the fs-policy fallback so
   * `allows_sandbox_approval == false` yields `forbidden` instead of
   * `needs_approval`, and into `wantsNoSandboxApproval` gating on
   * sandbox-denied escalation.
   */
  readonly granular?: GranularApprovalConfig;
  readonly approvalArgs?: Record<string, unknown>;
  /** Attempt executor — receives the selected sandbox mode. The caller
   *  may gate the actual FS/network constraints internally. Should
   *  throw `SandboxDeniedError` on sandbox denial. */
  readonly dispatch: (sandbox: SandboxMode) => Promise<T>;
  /** Approval pipeline plumbing. */
  readonly permissionHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly approvalResolver?: ApprovalResolver;
  /** Emitted when approval falls through to default-deny. */
  readonly onNoApprovalResolver?: (ctx: ApprovalCtx) => void;
  /** Transient retry budget (defaults to 2 = one retry). */
  readonly maxAttempts?: number;
  /** Testing hook. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Tool capability readers — donor runtime `Sandboxable::escalate_on_failure()`
// and `Approvable::wants_no_sandbox_approval(policy)`.
//
// Tool authors may opt into these via structural fields on the Tool
// object. Adding them as full methods on the shared `Tool` interface
// would ripple across Tool consumers outside this worker's scope, so
// we read them by structural cast — matching how the existing
// `requiresApproval` and `isReadOnly` hints are consumed.
// ─────────────────────────────────────────────────────────────────────

/**
 * Structural extension fields for sandbox-escalation behavior. A Tool
 * may expose either as a plain boolean or a function. Defaults mirror
 * donor runtime: `escalate_on_failure: true`, `wants_no_sandbox_approval` per
 * the policy table in `sandboxing.rs:290-298`.
 */
interface ToolSandboxCapabilities {
  readonly escalateOnFailure?: boolean | (() => boolean);
  readonly wantsNoSandboxApproval?:
    | boolean
    | ((policy: ApprovalPolicy, granular?: GranularApprovalConfig) => boolean);
}

/**
 * Port of donor runtime `Sandboxable::escalate_on_failure()` (sandboxing.rs:309-311).
 * Default `true`. A tool that returns `false` bails with the original
 * `SandboxDeniedError` instead of prompting for approval. Read-only
 * tools can opt out so a sandbox denial does not propose running them
 * unsandboxed.
 */
export function escalateOnFailure(tool: Tool): boolean {
  const v = (tool as Tool & ToolSandboxCapabilities).escalateOnFailure;
  if (v === undefined) return true;
  if (typeof v === "function") return v();
  return v;
}

/**
 * Port of donor runtime `Approvable::wants_no_sandbox_approval(policy)`
 * (sandboxing.rs:290-298). Decides whether the runtime should ASK for
 * approval to retry without the sandbox after a `SandboxDeniedError`.
 *
 * donor runtime table:
 *   - `OnFailure`                         → true
 *   - `UnlessTrusted` (= "untrusted")     → true
 *   - `Never`                             → false
 *   - `OnRequest`                         → false
 *   - `Granular(config)`                  → `config.sandbox_approval`
 *
 * A tool may override by exposing a `wantsNoSandboxApproval` field on
 * its object. When absent, the default table above applies.
 */
export function wantsNoSandboxApproval(
  tool: Tool,
  policy: ApprovalPolicy,
  granular?: GranularApprovalConfig,
): boolean {
  const override = (tool as Tool & ToolSandboxCapabilities).wantsNoSandboxApproval;
  if (override !== undefined) {
    if (typeof override === "function") return override(policy, granular);
    return override;
  }
  switch (policy) {
    case "on_failure":
    case "untrusted":
      return true;
    case "never":
    case "on_request":
      return false;
    case "granular":
      return granular?.sandbox_approval === true;
    default: {
      const _exhaustive: never = policy;
      void _exhaustive;
      return false;
    }
  }
}

function mapDefaultPermissionMode(mode: PermissionDefaultMode): ApprovalPolicy {
  switch (mode) {
    case "never":
      return "never";
    case "on-failure":
      return "on_failure";
    case "on-request":
      return "on_request";
    case "untrusted":
      return "untrusted";
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return "on_request";
    }
  }
}

function effectiveApprovalPolicyForTool(
  tool: Tool,
  fallback: ApprovalPolicy,
): ApprovalPolicy {
  return tool.defaultPermissionMode !== undefined
    ? mapDefaultPermissionMode(tool.defaultPermissionMode)
    : fallback;
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

function resolveApprovalSignal(
  opts: OrchestrateToolCallOpts<unknown>,
): AbortSignal | undefined {
  if (opts.signal) return opts.signal;
  if (opts.approvalCtx.signal) return opts.approvalCtx.signal;
  const sessionSignal =
    opts.approvalCtx.invocation.session?.abortController?.signal;
  if (sessionSignal) return sessionSignal;
  return undefined;
}

function approvalRejectionMessage(
  result: RequestApprovalResult,
): string {
  if (result.reason !== undefined && result.reason.trim().length > 0) {
    return result.reason;
  }
  if (result.source === "default_deny") {
    return "no_approval_resolver";
  }
  if (result.decision.kind === "timed_out") {
    return "approval timed out";
  }
  if (result.decision.kind === "abort") {
    return "approval aborted";
  }
  return "rejected by user";
}

/**
 * Port of donor runtime `ToolOrchestrator::run` (orchestrator.rs:105-377).
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
 *      donor runtime's `SandboxType::None`).
 */
export async function orchestrateToolCall<T>(
  opts: OrchestrateToolCallOpts<T>,
): Promise<T> {
  const approvalSignal = resolveApprovalSignal(opts);
  const effectiveApprovalPolicy = effectiveApprovalPolicyForTool(
    opts.tool,
    opts.approvalPolicy,
  );
  // Step 1 — approval classification.
  //
  // AgenC behavior (orchestrator.rs:124-127):
  //
  //   let requirement = tool.exec_approval_requirement(req)
  //     .unwrap_or_else(|| default_exec_approval_requirement(policy, fs));
  //
  // The tool-side classifier is the FALLBACK shape. When it returns a
  // concrete `Skip` or `Forbidden`, donor runtime never upgrades that into
  // `NeedsApproval` by re-running the default table. AgenC previously
  // did exactly that upgrade for `skip` with `bypassSandbox=false`,
  // which could promote a read-only tool under `granular + restricted`
  // to `needs_approval` even though `classifyToolApproval` had already
  // decided to skip. That upgrade is removed — `skip` is now final.
  const toolRequirement = classifyToolApproval(opts.tool, {
    approvalPolicy: effectiveApprovalPolicy,
    sandboxMode: opts.sandboxMode,
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.mcpServerTrusted !== undefined
      ? { mcpServerTrusted: opts.mcpServerTrusted }
      : {}),
    ...(opts.toolAllowlist !== undefined ? { toolAllowlist: opts.toolAllowlist } : {}),
    ...(opts.toolDenylist !== undefined ? { toolDenylist: opts.toolDenylist } : {}),
    ...(opts.granular !== undefined ? { granular: opts.granular } : {}),
  });

  const requirement = toolRequirement;

  if (requirement.kind === "forbidden") {
    throw new ApprovalRejectedError(requirement.reason, { kind: "denied" });
  }

  let alreadyApproved = false;
  const bypassSandbox =
    toolRequirement.kind === "skip" ? toolRequirement.bypassSandbox : false;

  if (requirement.kind === "needs_approval") {
    const approvalCtx: ApprovalCtx = {
      ...opts.approvalCtx,
      ...(requirement.reason !== undefined
        ? { retryReason: requirement.reason }
        : {}),
    };
    const approval = await requestApproval({
      ctx: approvalCtx,
      ...(approvalSignal !== undefined ? { signal: approvalSignal } : {}),
      ...(opts.permissionHooks !== undefined ? { hooks: opts.permissionHooks } : {}),
      ...(opts.permissionDecisionHooks !== undefined
        ? { permissionDecisionHooks: opts.permissionDecisionHooks }
        : {}),
      ...(opts.approvalArgs !== undefined ? { args: opts.approvalArgs } : {}),
      ...(opts.guardianApprovalReviewer !== undefined
        ? { guardianApprovalReviewer: opts.guardianApprovalReviewer }
        : {}),
      ...(opts.approvalResolver !== undefined ? { resolver: opts.approvalResolver } : {}),
      ...(opts.onNoApprovalResolver !== undefined
        ? { onNoResolver: opts.onNoApprovalResolver }
        : {}),
    });
    if (!isApprovalAccepted(approval.decision)) {
      throw new ApprovalRejectedError(
        approvalRejectionMessage(approval),
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

    // AgenC behavior (orchestrator.rs:253-258):
    //   if !tool.escalate_on_failure() {
    //     return Err(ToolError::Runtime(RuntimeErr::Sandbox(SandboxErr::Denied…)));
    //   }
    // Read-only or otherwise-opting-out tools bail with the original
    // sandbox denial instead of requesting approval to rerun unsandboxed.
    if (!escalateOnFailure(opts.tool)) {
      throw err;
    }

    // AgenC behavior (orchestrator.rs:259-279):
    //   if !tool.wants_no_sandbox_approval(approval_policy) { … }
    // For `AskForApproval::Never` / `AskForApproval::OnRequest` (without
    // network-approval context, which is not plumbed yet), donor runtime
    // surfaces the original `SandboxErr::Denied` and never prompts. Only
    // policies that want the approval path continue into the escalation
    // pipeline below.
    if (!wantsNoSandboxApproval(opts.tool, effectiveApprovalPolicy, opts.granular)) {
      throw err;
    }

    // Step 3 — approval-gated escalation to sandbox=off.
    if (!alreadyApproved) {
      const escalationCtx: ApprovalCtx = {
        ...opts.approvalCtx,
        retryReason:
          err.message || "command failed; retry without sandbox?",
      };
      const approval = await requestApproval({
        ctx: escalationCtx,
        ...(approvalSignal !== undefined ? { signal: approvalSignal } : {}),
        ...(opts.permissionHooks !== undefined ? { hooks: opts.permissionHooks } : {}),
        ...(opts.permissionDecisionHooks !== undefined
          ? { permissionDecisionHooks: opts.permissionDecisionHooks }
          : {}),
        ...(opts.approvalArgs !== undefined ? { args: opts.approvalArgs } : {}),
        ...(opts.guardianApprovalReviewer !== undefined
          ? { guardianApprovalReviewer: opts.guardianApprovalReviewer }
          : {}),
        ...(opts.approvalResolver !== undefined ? { resolver: opts.approvalResolver } : {}),
        ...(opts.onNoApprovalResolver !== undefined
          ? { onNoResolver: opts.onNoApprovalResolver }
          : {}),
      });
      if (!isApprovalAccepted(approval.decision)) {
        throw new ApprovalRejectedError(
          approvalRejectionMessage(approval),
          approval.decision,
        );
      }
    }

    // Retry with sandbox disabled (donor runtime `SandboxType::None`).
    return await opts.dispatch("danger_full_access");
  }
}
