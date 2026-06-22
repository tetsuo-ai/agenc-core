/**
 * Guardian approval arbiter.
 *
 * Source parity:
 * - core/src/guardian/approval_request.rs
 * - core/src/guardian/review.rs
 *
 * This is the single approval-request entry point for tool dispatch. It owns
 * hook routing, automatic guardian review, user prompt fallback, stale-turn
 * checks, and session approval-cache writes.
 *
 * @module
 */

import type { EventLog } from "../../session/event-log.js";
import { nonEmptyString as stringValue } from "../../utils/stringUtils.js";
import type { ToolInvocation, ToolPayload } from "../../tools/context.js";
import type { Tool } from "../../tools/types.js";
import type {
  AdditionalSandboxPermissions,
} from "../../sandbox/escalation/sandboxing.js";
import type {
  BlockedRequestObserver,
  NetworkPolicyDecider,
} from "../../sandbox/network-policy.js";
import type {
  AvailableApprovalDecision,
  NetworkApprovalContext,
  ParsedApprovalCommand,
} from "../../sandbox/escalation/approvals.js";
import type {
  ExecPolicyAmendment,
  NetworkPolicyAmendment,
} from "../review-decision.js";
import {
  mergeHookPermissionDecision,
  resolveHookPermissionDecision,
  type HookPermissionResult,
  type MergedHookPermissionDecision,
  type PermissionDecisionHook,
  type PermissionDecisionHookInput,
} from "../../tools/hooks.js";
import {
  buildShellApprovalKey,
  canonicalJsonKey,
} from "../approval-cache.js";
import {
  defaultExecApprovalRequirement as defaultExecApprovalRequirementFromPermissions,
  type ApprovalPolicy as PermissionsApprovalPolicy,
  type ExecApprovalRequirement as PermissionsExecApprovalRequirement,
  type FileSystemSandboxKind as PermissionsFileSystemSandboxKind,
  type GranularApprovalConfig,
} from "../approval-policy.js";
import {
  reviewDecisionIsAllow,
  type ReviewDecision,
} from "../review-decision.js";
import {
  getAskRuleForTool,
  getDenyRuleForTool,
} from "../rules.js";
import { hookDispatcherApprovalSource } from "../tool-approval.js";
import type { CanUseToolFn, ToolEvaluatorContext, ToolLike } from "../evaluator.js";
import type {
  PermissionDecisionReason,
  ToolPermissionContext,
} from "../types.js";
import {
  newGuardianReviewId,
  shouldRouteApprovalToGuardian,
  type GuardianApprovalReviewer,
} from "./reviewer.js";

export type GuardianApprovalPolicy = PermissionsApprovalPolicy;

export type GuardianSandboxMode =
  | "danger_full_access"
  | "read_only"
  | "workspace_write"
  | "external_sandbox";

export type GuardianFileSystemSandboxKind =
  | "restricted"
  | "unrestricted"
  | "external_sandbox";

export type GuardianExecApprovalRequirement = PermissionsExecApprovalRequirement;

export interface GuardianClassifyToolOptions {
  readonly approvalPolicy: GuardianApprovalPolicy;
  readonly sandboxMode: GuardianSandboxMode;
  readonly toolAllowlist?: ReadonlySet<string>;
  readonly toolDenylist?: ReadonlySet<string>;
  readonly payload?: ToolPayload;
  readonly mcpServerTrusted?: (server: string) => boolean;
  readonly granular?: GranularApprovalConfig;
  /**
   * Set when the session-wide permission mode is `bypassPermissions`
   * (the `--yolo` flag). Short-circuits the arbiter to `skip` for every
   * tool — the user opted out of approval gating and approvalPolicy
   * being `untrusted` shouldn't override that. Mirrors the bypass
   * short-circuits in permissions/bash.ts and the filesystem helpers.
   */
  readonly bypassPermissions?: boolean;
}

export interface ApprovalDecision {
  readonly decision: ReviewDecision;
  readonly decisionAtTurnId: string;
  readonly reason?: string;
}

export function classifyToolApproval(
  tool: Tool,
  opts: GuardianClassifyToolOptions,
): GuardianExecApprovalRequirement {
  const { name } = tool;
  if (opts.toolDenylist?.has(name)) {
    return { kind: "forbidden", reason: "tool denylisted for this session" };
  }
  if (opts.toolAllowlist?.has(name)) {
    return { kind: "skip", bypassSandbox: false };
  }
  // Permission-mode bypass: under `--yolo` (mode === bypassPermissions)
  // every approval gate should skip, regardless of approvalPolicy.
  // Without this, approvalPolicy="untrusted" surfaces a "approve every
  // call" overlay even though the user opted out at the mode level.
  // See GAP-PE-GUARDIAN-YOLO-LEAK.
  if (opts.bypassPermissions === true) {
    return { kind: "skip", bypassSandbox: false };
  }

  const payload = opts.payload;
  if (payload) {
    switch (payload.kind) {
      case "tool_search":
        return { kind: "skip", bypassSandbox: false };
      case "mcp": {
        if (opts.mcpServerTrusted?.(payload.server) === true) {
          return { kind: "skip", bypassSandbox: false };
        }
        break;
      }
      case "local_shell": {
        const fsKind = sandboxKindFromMode(opts.sandboxMode);
        const fallback = defaultExecApprovalRequirement(
          opts.approvalPolicy,
          fsKind,
          opts.granular,
        );
        if (fallback.kind === "forbidden") return fallback;
        if (fallback.kind === "needs_approval") {
          return {
            kind: "needs_approval",
            reason: `local_shell under ${fsKind} sandbox requires approval`,
          };
        }
        return {
          kind: "skip",
          bypassSandbox:
            opts.sandboxMode === "danger_full_access" &&
            opts.approvalPolicy === "never",
        };
      }
      case "custom":
      case "function":
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

export function sandboxKindFromMode(
  mode: GuardianSandboxMode,
): GuardianFileSystemSandboxKind {
  switch (mode) {
    case "danger_full_access":
      return "unrestricted";
    case "read_only":
    case "workspace_write":
      return "restricted";
    case "external_sandbox":
      return "external_sandbox";
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return "restricted";
    }
  }
}

export function defaultExecApprovalRequirement(
  policy: GuardianApprovalPolicy,
  fsKind: GuardianFileSystemSandboxKind,
  granular?: GranularApprovalConfig,
): GuardianExecApprovalRequirement {
  const narrowed: PermissionsFileSystemSandboxKind =
    fsKind === "restricted" ? "restricted" : "full_access";
  return defaultExecApprovalRequirementFromPermissions(
    policy,
    narrowed,
    granular,
  );
}

export interface ApprovalCtx {
  readonly invocation: ToolInvocation;
  readonly callId: string;
  readonly toolName: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly guardianReviewId?: string;
  readonly retryReason?: string;
  readonly cwd?: string;
  readonly command?: readonly string[];
  readonly parsedCommand?: ParsedApprovalCommand;
  readonly networkApprovalContext?: NetworkApprovalContext;
  readonly networkPolicyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
  readonly additionalPermissions?: AdditionalSandboxPermissions;
  readonly proposedExecPolicyAmendment?: ExecPolicyAmendment;
  readonly proposedNetworkPolicyAmendments?: readonly NetworkPolicyAmendment[];
  readonly availableDecisions?: readonly AvailableApprovalDecision[];
  readonly planContent?: string;
  readonly planFilePath?: string;
}

export interface ApprovalResolver {
  request(ctx: ApprovalCtx): Promise<ReviewDecision>;
}

export type PermissionRequestHook = (
  ctx: ApprovalCtx,
) => Promise<ReviewDecision | undefined> | ReviewDecision | undefined;

export interface RequestApprovalOpts {
  readonly ctx: ApprovalCtx;
  readonly hooks?: ReadonlyArray<PermissionRequestHook>;
  readonly permissionDecisionHooks?: ReadonlyArray<PermissionDecisionHook>;
  readonly args?: Record<string, unknown>;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly resolver?: ApprovalResolver;
  readonly signal?: AbortSignal;
  readonly getActiveTurnId?: () => string | null;
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
    | "cache"
    | "aborted";
  readonly reason?: string;
}

type GuardianHookDecisionReason = {
  readonly type: "hook" | "hook_plus_rule_deny" | "hook_plus_rule_ask";
  readonly hookName?: string;
};

export type GuardianPermissionModeReason =
  | PermissionDecisionReason
  | GuardianHookDecisionReason;

export type GuardianPermissionModeSource =
  | "pre-tool-use-hook"
  | "permission-evaluator";

export interface GuardianPermissionModeOptions {
  readonly tool: ToolLike;
  readonly args: Record<string, unknown>;
  readonly hookPermissionResult?: HookPermissionResult;
  readonly mergedPermissionDecision?: MergedHookPermissionDecision;
  readonly canUseTool?: CanUseToolFn;
  readonly permissionContext?: ToolEvaluatorContext | null;
  readonly includeEvaluator?: boolean;
}

export type GuardianPermissionModeDecision =
  | {
      readonly kind: "none";
      readonly args: Record<string, unknown>;
    }
  | {
      readonly kind: "deny" | "ask" | "allow";
      readonly args: Record<string, unknown>;
      readonly source: GuardianPermissionModeSource;
      readonly reasonCode: string;
      readonly message?: string;
      readonly decisionReason?: GuardianPermissionModeReason;
      readonly mergedDecision?: MergedHookPermissionDecision;
    };

export interface ModalDecision {
  readonly behavior: "allow" | "deny" | "abort";
  readonly decisionAtTurnId: string;
  readonly message?: string;
  readonly reviewDecision?: ReviewDecision;
}

export interface ApprovalRequestFn {
  (opts: {
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
    readonly currentTurnId: string;
    readonly signal: AbortSignal;
  }): Promise<ModalDecision>;
}

interface ApprovalCacheAdapter {
  withCachedApproval(opts: {
    readonly keys: readonly unknown[];
    readonly fetchDecision: () => Promise<ReviewDecision>;
  }): Promise<ReviewDecision>;
}

export interface RequestToolUserApprovalOpts {
  readonly request: ApprovalRequestFn;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  readonly invocation: ToolInvocation;
  readonly currentTurnId: string;
  readonly signal: AbortSignal;
  readonly eventLog?: EventLog;
  readonly subId?: string;
  readonly callId?: string;
  readonly approvalReason?: string;
  readonly getActiveTurnId?: () => string | null;
}

export type ToolUserApprovalResult =
  | { readonly allow: true; readonly reviewDecision: ReviewDecision }
  | { readonly allow: false; readonly cause: string };

class ModalApprovalError extends Error {
  constructor(readonly cause: string) {
    super(cause);
    this.name = "ModalApprovalError";
  }
}

function alreadyAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (err === null || err === undefined) return false;
  if (signal?.aborted === true && err instanceof Error) {
    const expected = String(signal.reason ?? "aborted");
    if (err.message === expected) return true;
  }
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
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

  if (opts.permissionDecisionHooks && opts.permissionDecisionHooks.length > 0) {
    let decision;
    try {
      decision = await awaitWithAbort(
        resolveHookPermissionDecision(
          opts.ctx.toolName,
          opts.args ?? {},
          opts.permissionDecisionHooks,
          undefined,
          undefined,
          permissionDecisionHookContext(opts.ctx, signal),
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
      return { decision: { kind: "approved" }, source: hookDispatcherApprovalSource };
    }
    if (decision.kind === "deny") {
      return {
        decision: { kind: "denied" },
        source: hookDispatcherApprovalSource,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
    }
  }

  const shouldUseGuardian =
    opts.guardianApprovalReviewer !== undefined &&
    shouldRouteApprovalToGuardian(opts.ctx);
  if (shouldUseGuardian || opts.resolver) {
    if (!activeApprovalTurnStillMatches(opts.ctx, opts.getActiveTurnId)) {
      return {
        decision: { kind: "abort" },
        source: "aborted",
        reason: "stale_modal_decision",
      };
    }
    const approvalCache = resolveApprovalCache(opts.ctx.invocation);
    const approvalKeys =
      approvalCache !== null
        ? buildApprovalCacheKeys(toolFromApprovalCtx(opts.ctx), opts.ctx.invocation, opts.args ?? {})
        : [];
    let fetchedResult: RequestApprovalResult | undefined;
    const fetchApprovalResult = async (): Promise<RequestApprovalResult> => {
      if (!activeApprovalTurnStillMatches(opts.ctx, opts.getActiveTurnId)) {
        throw new ModalApprovalError("stale_modal_decision");
      }
      if (shouldUseGuardian) {
        const reviewId = opts.ctx.guardianReviewId ?? newGuardianReviewId();
        const guardianCtx: ApprovalCtx = {
          ...opts.ctx,
          guardianReviewId: reviewId,
          ...(signal !== undefined ? { signal } : {}),
        };
        const result = await opts.guardianApprovalReviewer!.reviewApprovalRequest({
          ctx: guardianCtx,
          args: opts.args ?? {},
          ...(signal !== undefined ? { signal } : {}),
        });
        if (!activeApprovalTurnStillMatches(opts.ctx, opts.getActiveTurnId)) {
          throw new ModalApprovalError("stale_modal_decision");
        }
        return {
          decision: result.decision,
          source: "guardian",
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        };
      }
      const decision = await opts.resolver!.request({
        ...opts.ctx,
        ...(signal !== undefined ? { signal } : {}),
      });
      if (!activeApprovalTurnStillMatches(opts.ctx, opts.getActiveTurnId)) {
        throw new ModalApprovalError("stale_modal_decision");
      }
      return { decision, source: "resolver" };
    };
    const fetchDecision = async (): Promise<ReviewDecision> => {
      fetchedResult = await fetchApprovalResult();
      return fetchedResult.decision;
    };
    try {
      const decision = await awaitWithAbort(
        approvalCache !== null && approvalKeys.length > 0
          ? approvalCache.withCachedApproval({
              keys: approvalKeys,
              fetchDecision,
            })
          : fetchDecision(),
        signal,
      );
      if (!activeApprovalTurnStillMatches(opts.ctx, opts.getActiveTurnId)) {
        return {
          decision: { kind: "abort" },
          source: "aborted",
          reason: "stale_modal_decision",
        };
      }
      return fetchedResult ?? { decision, source: "cache" };
    } catch (err) {
      if (err instanceof ModalApprovalError) {
        return {
          decision: { kind: "abort" },
          source: "aborted",
          reason: err.cause,
        };
      }
      if (alreadyAborted(signal) || isAbortError(err, signal)) {
        return { decision: { kind: "abort" }, source: "aborted" };
      }
      throw err;
    }
  }

  opts.onNoResolver?.(opts.ctx);
  return { decision: { kind: "denied" }, source: "default_deny" };
}

export async function arbitratePermissionMode(
  opts: GuardianPermissionModeOptions,
): Promise<GuardianPermissionModeDecision> {
  const canUseTool = opts.canUseTool;
  const permissionContext = opts.permissionContext;

  const merged =
    opts.mergedPermissionDecision ??
    (await mergeHookPermissionDecision({
      hookPermissionResult: opts.hookPermissionResult,
      args: opts.args,
      ...(permissionContext !== null && permissionContext !== undefined
        ? {
            ruleBasedCheck: async (candidateArgs) => {
              const permissionSnapshot =
                readGuardianToolPermissionContext(permissionContext);
              if (permissionSnapshot) {
                if (
                  getDenyRuleForTool(permissionSnapshot, opts.tool.name, candidateArgs)
                ) {
                  return {
                    behavior: "deny" as const,
                    message: `permission denied by rule: ${opts.tool.name}`,
                  };
                }
                if (
                  getAskRuleForTool(permissionSnapshot, opts.tool.name, candidateArgs)
                ) {
                  return {
                    behavior: "ask" as const,
                    message: `approval required by rule: ${opts.tool.name}`,
                  };
                }
              }
              return null;
            },
          }
        : {}),
    }));
  if (merged) {
    return {
      kind: merged.behavior,
      args: merged.args,
      source: "pre-tool-use-hook",
      reasonCode: hookPermissionReasonCode(merged.behavior, merged.decisionReason),
      ...(merged.message !== undefined ? { message: merged.message } : {}),
      ...(merged.decisionReason !== undefined
        ? { decisionReason: merged.decisionReason }
        : {}),
      mergedDecision: merged,
    };
  }
  if (opts.includeEvaluator === false) {
    return { kind: "none", args: opts.args };
  }
  if (!canUseTool || !permissionContext) {
    return { kind: "none", args: opts.args };
  }

  const decision = await canUseTool(opts.tool, opts.args, permissionContext);
  if (decision.behavior === "deny") {
    return {
      kind: "deny",
      args: opts.args,
      source: "permission-evaluator",
      reasonCode:
        decision.decisionReason?.type === "rule"
          ? "rule_denied"
          : "evaluator_denied",
      message: decision.message,
      decisionReason: decision.decisionReason,
    };
  }
  if (decision.behavior === "ask") {
    // bypassPermissions mode override: --yolo opts the user out of approval
    // gating. The evaluator's per-tool checkPermissions may return "ask"
    // for non-rule, non-safetyCheck reasons (e.g. working-dir prompts that
    // didn't reach the mode bypass at evaluator.ts:389 because of the
    // single-source-of-truth re-invoke at evaluator.ts:479). Honor the
    // session mode here: if the user explicitly opted into bypass and the
    // ask isn't a content-specific rule or safetyCheck, convert to allow
    // with the original updatedInput.
    const reasonType = decision.decisionReason?.type;
    const isBypassImmune =
      (reasonType === "rule" &&
        (decision.decisionReason as { rule?: { ruleBehavior?: string } } | undefined)
          ?.rule?.ruleBehavior === "ask") ||
      reasonType === "safetyCheck";
    const sessionMode = readGuardianToolPermissionContext(permissionContext)?.mode;
    if (sessionMode === "bypassPermissions" && !isBypassImmune) {
      return {
        kind: "allow",
        args: decision.updatedInput ?? opts.args,
        source: "permission-evaluator",
        reasonCode: "mode_bypass",
        decisionReason: { type: "mode", mode: "bypassPermissions" },
      };
    }
    return {
      kind: "ask",
      args: decision.updatedInput ?? opts.args,
      source: "permission-evaluator",
      reasonCode:
        decision.decisionReason?.type === "rule"
          ? "rule_asked"
          : "evaluator_asked",
      message: decision.message,
      ...(decision.decisionReason !== undefined
        ? { decisionReason: decision.decisionReason }
        : {}),
    };
  }
  if (decision.behavior === "allow") {
    return {
      kind: "allow",
      args: decision.updatedInput ?? opts.args,
      source: "permission-evaluator",
      reasonCode:
        decision.decisionReason?.type === "rule"
          ? "rule_allowed"
          : "evaluator_allowed",
      ...(decision.decisionReason !== undefined
        ? { decisionReason: decision.decisionReason }
        : {}),
    };
  }
  return { kind: "none", args: opts.args };
}

export async function requestToolUserApproval(
  opts: RequestToolUserApprovalOpts,
): Promise<ToolUserApprovalResult> {
  if (opts.signal.aborted) {
    return { allow: false, cause: "aborted_before_approval" };
  }
  if (!activeTurnStillMatches(opts.currentTurnId, opts.getActiveTurnId)) {
    return { allow: false, cause: "stale_modal_decision" };
  }

  emitApprovalPromptEvents(opts);
  const approvalCache = resolveApprovalCache(opts.invocation);
  const approvalKeys =
    approvalCache !== null
      ? buildApprovalCacheKeys(opts.tool, opts.invocation, opts.args)
      : [];

  const fetchModalDecision = async (): Promise<ModalDecision> =>
    await new Promise<ModalDecision>((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        resolve({
          behavior: "abort",
          decisionAtTurnId: opts.currentTurnId,
        });
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
      let requestPromise: Promise<ModalDecision>;
      try {
        requestPromise = opts.request(opts);
      } catch {
        opts.signal.removeEventListener("abort", onAbort);
        resolve({
          behavior: "abort",
          decisionAtTurnId: opts.currentTurnId,
        });
        return;
      }
      requestPromise.then(
        (d) => {
          if (settled) return;
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          resolve(d);
        },
        () => {
          if (settled) return;
          settled = true;
          opts.signal.removeEventListener("abort", onAbort);
          resolve({
            behavior: "abort",
            decisionAtTurnId: opts.currentTurnId,
          });
        },
      );
    });

  const resolveModalReviewDecision = async (): Promise<ReviewDecision> => {
    const decision = await fetchModalDecision();
    if (!activeTurnStillMatches(opts.currentTurnId, opts.getActiveTurnId)) {
      throw new ModalApprovalError("stale_modal_decision");
    }
    if (decision.decisionAtTurnId !== opts.currentTurnId) {
      throw new ModalApprovalError("stale_modal_decision");
    }
    if (decision.reviewDecision) {
      if (!reviewDecisionIsAllow(decision.reviewDecision)) {
        throw new ModalApprovalError(
          decision.behavior === "deny" ? "denied" : "aborted",
        );
      }
      return decision.reviewDecision;
    }
    if (decision.behavior === "allow") return { kind: "approved" };
    if (decision.behavior === "deny") {
      throw new ModalApprovalError("denied");
    }
    throw new ModalApprovalError("aborted");
  };

  try {
    const reviewDecision =
      approvalCache !== null && approvalKeys.length > 0
        ? await approvalCache.withCachedApproval({
            keys: approvalKeys,
            fetchDecision: resolveModalReviewDecision,
          })
        : await resolveModalReviewDecision();
    return { allow: true, reviewDecision };
  } catch (error) {
    if (error instanceof ModalApprovalError) {
      return { allow: false, cause: error.cause };
    }
    throw error;
  }
}

function emitApprovalPromptEvents(opts: RequestToolUserApprovalOpts): void {
  if (!opts.eventLog) return;
  const subId = opts.subId ?? opts.callId ?? "approval";
  const callId = opts.callId ?? opts.subId ?? "approval";
  opts.eventLog.emit({
    id: subId,
    msg: {
      type: "exec_approval_request",
      payload: {
        callId,
        command: extractCommandPreview(opts.tool, opts.args),
        ...(opts.approvalReason !== undefined
          ? { reason: opts.approvalReason }
          : {}),
      },
    },
  });
  opts.eventLog.emit({
    id: subId,
    msg: {
      type: "request_permissions",
      payload: {
        callId,
        toolName: opts.tool.name,
        permissions: deriveToolPermissions(opts.tool),
      },
    },
  });
}

function readGuardianToolPermissionContext(
  permissionContext: ToolEvaluatorContext,
): ToolPermissionContext | null {
  if (typeof permissionContext.getAppState !== "function") return null;
  const appState = permissionContext.getAppState();
  const candidate =
    typeof permissionContext.toolPermissionContext === "function"
      ? permissionContext.toolPermissionContext(appState)
      : appState.toolPermissionContext;
  return typeof candidate === "object" && candidate !== null ? candidate : null;
}

function hookPermissionReasonCode(
  behavior: "allow" | "deny" | "ask",
  reason: GuardianHookDecisionReason | undefined,
): string {
  if (behavior === "allow") return "hook_allowed";
  if (behavior === "deny") {
    return reason?.type === "hook_plus_rule_deny"
      ? "rule_denied"
      : "hook_denied";
  }
  return reason?.type === "hook_plus_rule_ask" ? "rule_asked" : "hook_asked";
}

function activeTurnStillMatches(
  currentTurnId: string,
  getActiveTurnId?: (() => string | null) | undefined,
): boolean {
  if (typeof getActiveTurnId !== "function") return true;
  return getActiveTurnId() === currentTurnId;
}

function activeApprovalTurnStillMatches(
  ctx: ApprovalCtx,
  getActiveTurnId?: (() => string | null) | undefined,
): boolean {
  const active = typeof getActiveTurnId === "function"
    ? getActiveTurnId()
    : readSessionActiveTurnId(ctx.invocation.session);
  return active === undefined || active === ctx.turnId;
}

function readSessionActiveTurnId(session: unknown): string | null | undefined {
  const activeTurn = (session as {
    readonly activeTurn?: {
      unsafePeek?: () => { readonly turnId?: unknown } | undefined;
    };
  })?.activeTurn;
  if (typeof activeTurn?.unsafePeek !== "function") return undefined;
  const turnId = activeTurn?.unsafePeek?.()?.turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

function toolFromApprovalCtx(ctx: ApprovalCtx): Tool {
  return {
    name: ctx.toolName,
  } as Tool;
}

function resolveApprovalCache(
  invocation: ToolInvocation,
): ApprovalCacheAdapter | null {
  const session = (invocation as { readonly session?: unknown }).session;
  const services =
    typeof session === "object" && session !== null
      ? (session as { readonly services?: unknown }).services
      : undefined;
  if (typeof services !== "object" || services === null) return null;
  const store = (services as {
    readonly toolApprovals?: ApprovalCacheAdapter | null;
  }).toolApprovals;
  return store && typeof store.withCachedApproval === "function" ? store : null;
}

function buildApprovalCacheKeys(
  tool: Tool,
  invocation: ToolInvocation,
  args: Record<string, unknown>,
): readonly unknown[] {
  const cwd =
    typeof args.cwd === "string" && args.cwd.length > 0
      ? args.cwd
      : typeof args.workdir === "string" && args.workdir.length > 0
        ? args.workdir
        : invocation.turn.cwd;
  if (
    tool.name === "exec_command" ||
    tool.name === "system.bash" ||
    tool.name === "Bash" ||
    invocation.payload.kind === "local_shell"
  ) {
    const command = Array.isArray(args.args)
      ? [
          typeof args.command === "string" ? args.command : "",
          ...args.args.filter((part): part is string => typeof part === "string"),
        ].filter((part) => part.length > 0)
      : invocation.payload.kind === "local_shell"
        ? invocation.payload.params.command
        : typeof args.command === "string"
          ? [args.command]
          : typeof args.cmd === "string"
            ? [args.cmd]
            : [];
    if (command.length > 0) {
      const sandboxPermissions: string[] = [invocation.turn.sandboxPolicy.value];
      if (args.sandbox_permissions !== undefined) {
        sandboxPermissions.push(canonicalJsonKey(args.sandbox_permissions));
      }
      const additionalPermissions: string[] = [invocation.turn.approvalPolicy.value];
      if (args.additional_permissions !== undefined) {
        additionalPermissions.push(canonicalJsonKey(args.additional_permissions));
      }
      return [
        buildShellApprovalKey({
          command,
          cwd,
          ...(typeof args.tty === "boolean" ? { tty: args.tty } : {}),
          sandbox_permissions: sandboxPermissions,
          additional_permissions: additionalPermissions,
        }),
      ];
    }
  }
  return [
    {
      toolName: tool.name,
      cwd,
      sandboxMode: invocation.turn.sandboxPolicy.value,
      approvalPolicy: invocation.turn.approvalPolicy.value,
      args,
    },
  ];
}

function permissionDecisionHookContext(
  ctx: ApprovalCtx,
  signal: AbortSignal | undefined,
): Omit<PermissionDecisionHookInput, "toolName" | "args"> {
  const invocation = ctx.invocation;
  const session = asRecord(invocation.session);
  const turn = asRecord(invocation.turn);
  const cwd = stringValue(turn?.cwd);
  const sessionId = stringValue(session?.conversationId);
  const transcriptPath = stringValue(session?.transcriptPath);
  const model =
    stringValue(asRecord(turn?.modelInfo)?.slug) ??
    stringValue(asRecord(turn?.collaborationMode)?.model) ??
    stringValue(asRecord(turn?.config)?.model);
  const permissionMode = stringValue(turn?.permissionMode);
  const matcherAliases = [
    ...toolNameMatcherAliases(ctx.toolName),
    ...stringArrayValue(asRecord(invocation.toolName)?.matcherAliases),
  ];
  return {
    invocation,
    callId: ctx.callId,
    turnId: ctx.turnId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(matcherAliases.length > 0 ? { matcherAliases } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

function toolNameMatcherAliases(toolName: string): readonly string[] {
  if (toolName === "apply_patch") return ["Write", "Edit"];
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArrayValue(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function extractCommandPreview(
  tool: Tool,
  args: Record<string, unknown>,
): string {
  const candidates = ["command", "cmd", "path", "url"];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value.slice(0, 256);
    }
  }
  return tool.name;
}

function deriveToolPermissions(tool: Tool): ReadonlyArray<string> {
  const declared = (tool as unknown as { readonly permissions?: unknown })
    .permissions;
  if (Array.isArray(declared) && declared.every((p) => typeof p === "string")) {
    return declared as ReadonlyArray<string>;
  }
  return ["execute"];
}
