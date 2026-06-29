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
 *   - Deferred network approval workflow (`DeferredNetworkApproval`)
 *     is out of scope — covered by the network-approval tranche.
 *
 * @module
 */

import type { Tool } from "./types.js";
import type { ToolInvocation, ToolPayload } from "./context.js";
import type { PermissionDefaultMode } from "../config/schema.js";
import type { PermissionDecisionHook } from "./hooks.js";
import {
  type ApprovalPolicy as PermissionsApprovalPolicy,
  type ExecApprovalRequirement as PermissionsExecApprovalRequirement,
  type GranularApprovalConfig,
} from "../permissions/approval-policy.js";

export type { GranularApprovalConfig };
import {
  reviewDecisionIsAllow,
  type ReviewDecision as PermissionsReviewDecision,
} from "../permissions/review-decision.js";
import {
  recordPermissionAuditEvent,
  type PermissionAuditDecision,
  type PermissionAuditErrorHandler,
  type PermissionAuditLogger,
} from "../permissions/permission-audit-log.js";
import { SandboxDeniedError } from "../permissions/sandbox.js";
import {
  classifyToolApproval as guardianClassifyToolApproval,
  defaultExecApprovalRequirement as guardianDefaultExecApprovalRequirement,
  requestApproval,
  sandboxKindFromMode as guardianSandboxKindFromMode,
  type ApprovalCtx,
  type ApprovalDecision,
  type ApprovalResolver,
  type GuardianClassifyToolOptions,
  type PermissionRequestHook,
  type RequestApprovalOpts,
  type RequestApprovalResult,
} from "../permissions/guardian/arbiter.js";
import {
  type GuardianApprovalReviewer,
} from "../permissions/guardian/reviewer.js";
import {
  hasAdditionalSandboxPermissions,
  normalizeSandboxPermissionsRequest,
  runtimeAdditionalPermissionsForSandboxRequest,
  sandboxOverrideForFirstAttempt,
  sandboxPermissionsFromArgs,
  selectFirstAttemptSandbox,
  toolEscalatesOnFailure,
  toolWantsNoSandboxApproval,
  type SandboxPermissionsInput,
  type SandboxPermissionsRequest,
} from "../sandbox/escalation/sandboxing.js";
import type { AdditionalPermissionProfile } from "../sandbox/engine/index.js";
import type { Policy } from "../sandbox/execpolicy/policy.js";
import {
  determineInterceptedExecAction,
  evaluateInterceptedExecPolicy,
  type InterceptedExecAction,
} from "../sandbox/escalation/unix-escalation.js";
import {
  defaultAvailableApprovalDecisions,
} from "../sandbox/escalation/approvals.js";
import { asRecord } from "../utils/record.js";

export { requestApproval };
export type {
  ApprovalCtx,
  ApprovalDecision,
  ApprovalResolver,
  PermissionRequestHook,
  RequestApprovalOpts,
  RequestApprovalResult,
};

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
// Sandbox-denied error (ports donor runtime `SandboxErr::Denied`).
// ─────────────────────────────────────────────────────────────────────

/** Classifier used by the retry policy. */
function isSandboxDeniedError(err: unknown): err is SandboxDeniedError {
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

export type ClassifyToolOptions = GuardianClassifyToolOptions;

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
  return guardianClassifyToolApproval(tool, opts);
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
  return guardianSandboxKindFromMode(mode);
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
  return guardianDefaultExecApprovalRequirement(policy, fsKind, granular);
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
  readonly sandboxPermissions?: SandboxPermissionsInput;
  readonly execPolicy?: Policy;
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
  readonly dispatch: (
    sandbox: SandboxMode,
    context: {
      readonly approvalResolved: boolean;
      readonly additionalPermissions?: AdditionalPermissionProfile;
    },
  ) => Promise<T>;
  /** Approval pipeline plumbing. */
  readonly permissionHooks?: ReadonlyArray<PermissionRequestHook>;
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly approvalResolver?: ApprovalResolver;
  readonly getActiveTurnId?: () => string | null;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
  /** Emitted when approval falls through to default-deny. */
  readonly onNoApprovalResolver?: (ctx: ApprovalCtx) => void;
  /** Transient retry budget (defaults to 2 = one retry). */
  readonly maxAttempts?: number;
  /** Testing hook. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Tool capability readers for sandbox-denial retry behavior. The live
// implementation lives in sandbox/escalation so the security-sensitive
// policy is testable at the sandbox destination and the orchestrator
// stays a thin lifecycle consumer.
// ─────────────────────────────────────────────────────────────────────

/**
 * Default `true`. A tool that returns `false` bails with the original
 * `SandboxDeniedError` instead of prompting for approval. Read-only
 * tools can opt out so a sandbox denial does not propose running them
 * unsandboxed.
 */
export function escalateOnFailure(tool: Tool): boolean {
  return toolEscalatesOnFailure(tool);
}

/**
 * Decides whether the runtime should ASK for approval to retry without
 * the sandbox after a `SandboxDeniedError`.
 *
 * Policy table:
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
  return toolWantsNoSandboxApproval(tool, policy, granular);
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

type SandboxPermissionApprovalAction =
  | { readonly kind: "none" }
  | { readonly kind: "prompt"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string };

function sandboxPermissionApprovalAction(opts: {
  readonly request: SandboxPermissionsRequest;
  readonly approvalPolicy: ApprovalPolicy;
  readonly granular?: GranularApprovalConfig;
}): SandboxPermissionApprovalAction {
  switch (opts.request.kind) {
    case "default":
      return { kind: "none" };
    case "require_escalated":
      if (opts.approvalPolicy === "never") {
        return {
          kind: "deny",
          reason:
            "sandbox escalation requires approval, but approval policy is never",
        };
      }
      if (
        opts.approvalPolicy === "granular" &&
        opts.granular?.sandbox_approval === false
      ) {
        return {
          kind: "deny",
          reason: "sandbox escalation is disabled by granular policy",
        };
      }
      return {
        kind: "prompt",
        reason: "sandbox escalation requested",
      };
    case "with_additional_permissions":
      if (!hasAdditionalSandboxPermissions(opts.request.additionalPermissions)) {
        return { kind: "none" };
      }
      if (opts.approvalPolicy === "never") {
        return {
          kind: "deny",
          reason:
            "additional sandbox permissions require approval, but approval policy is never",
        };
      }
      if (
        opts.approvalPolicy === "granular" &&
        opts.granular?.request_permissions === false
      ) {
        return {
          kind: "deny",
          reason:
            "additional sandbox permissions are disabled by granular policy",
        };
      }
      return {
        kind: "prompt",
        reason: "additional sandbox permissions requested",
      };
    default: {
      const _exhaustive: never = opts.request;
      return _exhaustive;
    }
  }
}

function approvalContextForSandboxPermissions(
  request: SandboxPermissionsRequest,
): Partial<ApprovalCtx> {
  switch (request.kind) {
    case "default":
      return {};
    case "require_escalated":
      return {
        availableDecisions: defaultAvailableApprovalDecisions({}),
      };
    case "with_additional_permissions":
      if (!hasAdditionalSandboxPermissions(request.additionalPermissions)) {
        return {};
      }
      return {
        additionalPermissions: request.additionalPermissions,
        availableDecisions: defaultAvailableApprovalDecisions({
          additionalPermissions: request.additionalPermissions,
        }),
      };
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
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
  const resolvedSandboxPermissions =
    opts.sandboxPermissions ??
    (opts.approvalArgs !== undefined
      ? sandboxPermissionsFromArgs(opts.approvalArgs)
      : { kind: "default" as const });
  const normalizedSandboxPermissions =
    normalizeSandboxPermissionsRequest(resolvedSandboxPermissions);
  // Extract the session-wide permission mode so the arbiter can short-
  // circuit under --yolo (mode === bypassPermissions). Without this the
  // arbiter ran a separate approvalPolicy gate that ignored mode and
  // surfaced "approve every call" overlays even after the user opted
  // out at the mode level. See GAP-PE-GUARDIAN-YOLO-LEAK.
  const sessionMode = (opts.approvalCtx.invocation as {
    session?: { permissionModeRegistry?: { current?: () => unknown } };
  }).session?.permissionModeRegistry?.current?.();
  const isBypassPermissionsMode =
    asRecord(sessionMode)?.mode === "bypassPermissions";
  const toolRequirement = classifyToolApproval(opts.tool, {
    approvalPolicy: effectiveApprovalPolicy,
    sandboxMode: opts.sandboxMode,
    ...(isBypassPermissionsMode ? { bypassPermissions: true } : {}),
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    ...(opts.mcpServerTrusted !== undefined
      ? { mcpServerTrusted: opts.mcpServerTrusted }
      : {}),
    ...(opts.toolAllowlist !== undefined ? { toolAllowlist: opts.toolAllowlist } : {}),
    ...(opts.toolDenylist !== undefined ? { toolDenylist: opts.toolDenylist } : {}),
    ...(opts.granular !== undefined ? { granular: opts.granular } : {}),
  });

  let requirement = toolRequirement;
  const sandboxPermissionApproval = sandboxPermissionApprovalAction({
    request: normalizedSandboxPermissions,
    approvalPolicy: effectiveApprovalPolicy,
    granular: opts.granular,
  });
  const execPolicyAction = evaluateLocalShellExecPolicyAction({
    policy: opts.execPolicy,
    payload: opts.payload,
    approvalPolicy: effectiveApprovalPolicy,
    sandboxMode: opts.sandboxMode,
    sandboxPermissions: resolvedSandboxPermissions,
    granular: opts.granular,
  });
  if (execPolicyAction?.kind === "deny") {
    await recordApprovalRequirementOutcome(
      opts,
      { kind: "forbidden", reason: execPolicyAction.reason },
      effectiveApprovalPolicy,
    );
    throw new ApprovalRejectedError(execPolicyAction.reason, { kind: "denied" });
  }
  if (sandboxPermissionApproval.kind === "deny") {
    await recordApprovalRequirementOutcome(
      opts,
      { kind: "forbidden", reason: sandboxPermissionApproval.reason },
      effectiveApprovalPolicy,
    );
    throw new ApprovalRejectedError(sandboxPermissionApproval.reason, {
      kind: "denied",
    });
  }
  if (
    execPolicyAction?.kind === "prompt" &&
    toolRequirement.kind !== "forbidden"
  ) {
    requirement = {
      kind: "needs_approval",
      reason: execPolicyAction.reason,
    };
  }
  if (
    sandboxPermissionApproval.kind === "prompt" &&
    toolRequirement.kind !== "forbidden"
  ) {
    requirement = {
      kind: "needs_approval",
      reason: sandboxPermissionApproval.reason,
    };
  }
  if (
    execPolicyAction?.kind === "run" &&
    toolRequirement.kind !== "forbidden" &&
    sandboxPermissionApproval.kind !== "prompt"
  ) {
    requirement = {
      kind: "skip",
      bypassSandbox: execPolicyAction.execution.kind === "unsandboxed",
    };
  }

  if (requirement.kind === "forbidden") {
    await recordApprovalRequirementOutcome(opts, requirement, effectiveApprovalPolicy);
    throw new ApprovalRejectedError(requirement.reason, { kind: "denied" });
  }

  let alreadyApproved = false;
  const policyBypass =
    (execPolicyAction?.kind === "run" ||
      execPolicyAction?.kind === "prompt") &&
    execPolicyAction.execution.kind === "unsandboxed";
  const sandboxOverride = policyBypass
    ? { kind: "bypass_sandbox" as const, reason: "approval_requirement" as const }
    : sandboxOverrideForFirstAttempt(resolvedSandboxPermissions, toolRequirement);
  const requestedAdditionalPermissions =
    runtimeAdditionalPermissionsForSandboxRequest(normalizedSandboxPermissions);

  if (requirement.kind === "skip") {
    await recordApprovalRequirementOutcome(opts, requirement, effectiveApprovalPolicy);
  }

  if (requirement.kind === "needs_approval") {
    const approvalCtx: ApprovalCtx = {
      ...opts.approvalCtx,
      ...(requirement.reason !== undefined
        ? { retryReason: requirement.reason }
        : {}),
      ...approvalContextForSandboxPermissions(normalizedSandboxPermissions),
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
      ...(opts.getActiveTurnId !== undefined ? { getActiveTurnId: opts.getActiveTurnId } : {}),
      ...(opts.onNoApprovalResolver !== undefined
        ? { onNoResolver: opts.onNoApprovalResolver }
        : {}),
    });
    await recordApprovalPolicyOutcome(opts, approvalCtx, approval, {
      stage: "initial_approval",
    });
    if (!isApprovalAccepted(approval.decision)) {
      throw new ApprovalRejectedError(
        approvalRejectionMessage(approval),
        approval.decision,
      );
    }
    alreadyApproved = true;
  }
  const additionalPermissions =
    alreadyApproved && sandboxPermissionApproval.kind === "prompt"
      ? requestedAdditionalPermissions
      : undefined;

  // Step 2 — first attempt with bounded transient retry.
  const firstSandbox = selectFirstAttemptSandbox(
    opts.sandboxMode,
    sandboxOverride,
  ) as SandboxMode;

  try {
    return await attemptWithRetry({
      dispatch: () =>
        opts.dispatch(firstSandbox, {
          approvalResolved: alreadyApproved,
          ...(additionalPermissions !== undefined
            ? { additionalPermissions }
            : {}),
        }),
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
      await recordSandboxPolicyOutcome(opts, "sandbox_escalation_disabled");
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
      await recordSandboxPolicyOutcome(opts, "sandbox_escalation_not_allowed");
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
        ...(opts.getActiveTurnId !== undefined ? { getActiveTurnId: opts.getActiveTurnId } : {}),
        ...(opts.onNoApprovalResolver !== undefined
          ? { onNoResolver: opts.onNoApprovalResolver }
          : {}),
      });
      await recordApprovalPolicyOutcome(opts, escalationCtx, approval, {
        stage: "sandbox_escalation",
      });
      if (!isApprovalAccepted(approval.decision)) {
        throw new ApprovalRejectedError(
          approvalRejectionMessage(approval),
          approval.decision,
        );
      }
    }

    // Retry with sandbox disabled (donor runtime `SandboxType::None`).
    return await opts.dispatch("danger_full_access", {
      approvalResolved: true,
      ...(additionalPermissions !== undefined
        ? { additionalPermissions }
        : {}),
    });
  }
}

type TerminalApprovalRequirement =
  | Extract<ExecApprovalRequirement, { readonly kind: "skip" }>
  | Extract<ExecApprovalRequirement, { readonly kind: "forbidden" }>;

async function recordApprovalRequirementOutcome(
  opts: OrchestrateToolCallOpts<unknown>,
  requirement: TerminalApprovalRequirement,
  effectiveApprovalPolicy: ApprovalPolicy,
): Promise<void> {
  await recordPermissionAuditEvent(
    opts.permissionAuditLogger,
    {
      eventKind: "policy_outcome",
      decision: requirement.kind === "skip" ? "approved" : "denied",
      source: "approval-classifier",
      subjectType: "tool_execution",
      toolName: opts.approvalCtx.toolName,
      callId: opts.approvalCtx.callId,
      sessionId: readAuditSessionId(opts.approvalCtx.invocation),
      reasonCode: approvalRequirementReasonCode(
        opts,
        requirement,
        effectiveApprovalPolicy,
      ),
      metadata: {
        approvalSource: "classifier",
        approvalStage: "approval_classification",
        policySource: effectiveApprovalPolicy,
      },
    },
    opts.onPermissionAuditError,
  );
}

async function recordSandboxPolicyOutcome(
  opts: OrchestrateToolCallOpts<unknown>,
  reasonCode: "sandbox_escalation_disabled" | "sandbox_escalation_not_allowed",
): Promise<void> {
  await recordPermissionAuditEvent(
    opts.permissionAuditLogger,
    {
      eventKind: "policy_outcome",
      decision: "denied",
      source: "sandbox-policy",
      subjectType: "tool_execution",
      toolName: opts.approvalCtx.toolName,
      callId: opts.approvalCtx.callId,
      sessionId: readAuditSessionId(opts.approvalCtx.invocation),
      reasonCode,
      metadata: {
        approvalSource: "classifier",
        approvalStage: "sandbox_escalation",
      },
    },
    opts.onPermissionAuditError,
  );
}

function approvalRequirementReasonCode(
  opts: OrchestrateToolCallOpts<unknown>,
  requirement: TerminalApprovalRequirement,
  effectiveApprovalPolicy: ApprovalPolicy,
): string {
  if (requirement.kind === "forbidden") {
    if (opts.toolDenylist?.has(opts.tool.name)) return "tool_denylisted";
    if (
      effectiveApprovalPolicy === "granular" &&
      opts.granular !== undefined &&
      !opts.granular.sandbox_approval
    ) {
      return "sandbox_approval_forbidden";
    }
    return "approval_forbidden";
  }

  if (opts.toolAllowlist?.has(opts.tool.name)) return "tool_allowlisted";
  if (opts.tool.defaultPermissionMode !== undefined) {
    return `default_permission_${opts.tool.defaultPermissionMode.replace(/-/g, "_")}_skipped`;
  }
  if (opts.payload?.kind === "tool_search") return "tool_search_skipped";
  if (
    opts.payload?.kind === "mcp" &&
    opts.mcpServerTrusted?.(opts.payload.server) === true
  ) {
    return "trusted_mcp_skipped";
  }
  if (requirement.bypassSandbox) return "policy_never_sandbox_bypass";
  switch (effectiveApprovalPolicy) {
    case "never":
      return "policy_never_skipped";
    case "on_failure":
      return "policy_on_failure_first_attempt";
    case "on_request":
      return "policy_on_request_skipped";
    case "granular":
      return "granular_read_only_or_unrestricted_skipped";
    case "untrusted":
      return "approval_skipped";
    default: {
      const _exhaustive: never = effectiveApprovalPolicy;
      void _exhaustive;
      return "approval_skipped";
    }
  }
}

async function recordApprovalPolicyOutcome(
  opts: OrchestrateToolCallOpts<unknown>,
  ctx: ApprovalCtx,
  result: RequestApprovalResult,
  metadata: { readonly stage: "initial_approval" | "sandbox_escalation" },
): Promise<void> {
  await recordPermissionAuditEvent(
    opts.permissionAuditLogger,
    {
      eventKind: "policy_outcome",
      decision: auditDecisionFromReviewDecision(result.decision),
      source: `approval-${result.source}`,
      subjectType: "tool_execution",
      toolName: ctx.toolName,
      callId: ctx.callId,
      sessionId: readAuditSessionId(ctx.invocation),
      reasonCode: approvalReasonCode(result),
      metadata: {
        approvalSource: result.source,
        approvalStage: metadata.stage,
      },
    },
    opts.onPermissionAuditError,
  );
}

function auditDecisionFromReviewDecision(
  decision: ReviewDecision,
): PermissionAuditDecision {
  return reviewDecisionIsAllow(decision) ? "approved" : "denied";
}

function approvalReasonCode(result: RequestApprovalResult): string {
  if (reviewDecisionIsAllow(result.decision)) {
    return `approved_${result.source}`;
  }
  if (result.source === "default_deny") return "default_deny";
  if (result.source === "aborted") return "aborted";
  if (result.decision.kind === "timed_out") return "timed_out";
  if (result.decision.kind === "abort") return "aborted";
  return `denied_${result.source}`;
}

function readAuditSessionId(
  invocation: ToolInvocation,
): string | undefined {
  if (
    typeof invocation !== "object" ||
    invocation === null ||
    !("session" in invocation)
  ) {
    return undefined;
  }
  const value = (
    (invocation as { readonly session?: unknown }).session as
      | { readonly conversationId?: unknown }
      | undefined
  )?.conversationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function evaluateLocalShellExecPolicyAction(opts: {
  readonly policy?: Policy;
  readonly payload?: ToolPayload;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  readonly sandboxPermissions: SandboxPermissionsInput;
  readonly granular?: GranularApprovalConfig;
}): InterceptedExecAction | null {
  if (opts.policy === undefined || opts.payload?.kind !== "local_shell") {
    return null;
  }
  const command = opts.payload.params.command;
  const program = command[0];
  if (program === undefined || program.length === 0) {
    return null;
  }
  const evaluated = evaluateInterceptedExecPolicy({
    policy: opts.policy,
    program,
    argv: command,
    unmatchedCommandContext: {
      approvalPolicy: opts.approvalPolicy,
      fileSystemSandboxKind: sandboxModeToEscalationFsKind(opts.sandboxMode),
      sandboxPermissions: opts.sandboxPermissions,
    },
    parseShellWrapper: true,
  });
  return determineInterceptedExecAction({
    evaluation: evaluated.evaluation,
    approvalPolicy: opts.approvalPolicy,
    sandboxPermissions: opts.sandboxPermissions,
    ...(opts.granular !== undefined ? { granular: opts.granular } : {}),
  });
}

function sandboxModeToEscalationFsKind(
  mode: SandboxMode,
): FileSystemSandboxKind {
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
      return _exhaustive;
    }
  }
}
