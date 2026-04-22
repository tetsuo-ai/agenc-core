/**
 * Pre/post tool hooks + MCP output modifier.
 *
 * Subset port of openclaude `services/tools/toolHooks.ts`. AgenC's T6
 * surface is a composable chain: each hook function receives
 * `(invocation, args, dispatchResult)` and returns either a
 * pass-through value or a replacement.
 *
 * T6 (W1 parity pass): the decision set grew to match openclaude's
 * PostToolUse universe — `stop`, `preventContinuation`,
 * `additionalContext`, `hook_blocking_error`, and `rewrite` all live
 * here and every one is emitted by the live execution path. The
 * args-retry auto-fix loop (previously `runWithAutoFixRetry`) was
 * removed per `docs/plan/feature-matrix.md`: openclaude's auto-fix is
 * a lint/test runner injected as PostToolUse additional context, not
 * an args-retry — AgenC's `/auto-fix` command advertises that flow,
 * and the unrelated args-retry surface was confusing the contract.
 *
 * @module
 */

import type { ToolDispatchResult } from "../tool-registry.js";
import type { ToolInvocation } from "./context.js";
import type { Tool } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Timing threshold (openclaude parity — toolHooks.ts)
// ─────────────────────────────────────────────────────────────────────

/**
 * Hooks that run longer than this threshold (ms) emit a telemetry
 * event so slow hooks are discoverable. Matches openclaude's
 * `HOOK_TIMING_DISPLAY_THRESHOLD_MS=500`.
 */
export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500;

/**
 * Structured record describing a single hook's wall-clock cost. Callers
 * that consume `runPre*`/`runPost*` can watch for records with
 * `overThreshold=true` and surface them through their telemetry
 * pipeline (e.g. `emitWarning(eventLog, subId, "slow_tool_hook", …)`).
 */
export interface HookTimingRecord {
  readonly phase: "pre" | "post" | "failure" | "permission";
  readonly toolName: string;
  readonly hookIndex: number;
  readonly durationMs: number;
  readonly overThreshold: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Hook permission result (openclaude parity — used before the permission
// gate so PreToolUse hooks can steer the rule-based check).
// ─────────────────────────────────────────────────────────────────────

export type HookPermissionBehavior = "allow" | "deny" | "ask";

export interface HookPermissionResult {
  readonly behavior: HookPermissionBehavior;
  /** Humanized reason surfaced to the model on deny/ask. */
  readonly message?: string;
  /**
   * Optional normalized input: when a PreToolUse hook rewrites args
   * (e.g. redaction, path expansion), the downstream permission gate
   * and the tool's `execute()` both see the rewritten values.
   */
  readonly updatedInput?: Record<string, unknown>;
  /** openclaude `decisionReason.hookName` passthrough for analytics. */
  readonly hookName?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Pre-tool-use hook
// ─────────────────────────────────────────────────────────────────────

export type PreToolUseDecision =
  /**
   * Default flow: continue to the permission gate. `args` carries any
   * rewritten input for downstream hooks / the permission evaluator /
   * the tool's execute().
   */
  | {
      readonly kind: "continue";
      readonly args?: Record<string, unknown>;
      readonly hookPermissionResult?: HookPermissionResult;
      readonly additionalContext?: ReadonlyArray<string>;
      readonly preventContinuation?: { readonly stopReason?: string };
    }
  /**
   * Short-circuit: return a typed error tool_result without reaching
   * the permission gate or the tool's execute().
   */
  | { readonly kind: "deny"; readonly reason: string }
  /** Short-circuit: return a synthesized result (memoizing/cached hook). */
  | { readonly kind: "skip"; readonly synthResult: ToolDispatchResult }
  /**
   * Stop the turn entirely — openclaude PreToolUse `stop` (CANCEL_MESSAGE
   * tool_result, turn concluded). `stopReason` is surfaced as the
   * toolUseResult for analytics.
   */
  | { readonly kind: "stop"; readonly stopReason?: string };

export type PreToolUseHook = (input: {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
}) => Promise<PreToolUseDecision> | PreToolUseDecision;

export interface PreHooksResult {
  readonly kind: "continue" | "deny" | "skip" | "stop";
  readonly args?: Record<string, unknown>;
  /** Present when kind === "deny". */
  readonly reason?: string;
  /** Present when kind === "skip". */
  readonly synthResult?: ToolDispatchResult;
  /** Present when kind === "stop". */
  readonly stopReason?: string;
  /** Latest hook-provided permission decision (first wins). */
  readonly hookPermissionResult?: HookPermissionResult;
  /** Accumulated strings from every hook's `additionalContext`. */
  readonly additionalContexts: ReadonlyArray<string>;
  /** Latest prevent-continuation signal. */
  readonly preventContinuation?: { readonly stopReason?: string };
}

/**
 * Run every pre-hook in order. First `deny` / `skip` / `stop` short-
 * circuits. Arg mutations accumulate across hooks (later hooks see
 * earlier hooks' rewrites). Hooks that throw are treated as no-ops
 * with a logged warning (safety: don't let a broken hook brick the
 * turn).
 */
export async function runPreToolUseHooks(
  hooks: ReadonlyArray<PreToolUseHook>,
  base: {
    readonly invocation: ToolInvocation;
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
  },
  onError?: (err: unknown, idx: number) => void,
  onTiming?: (record: HookTimingRecord) => void,
): Promise<PreHooksResult> {
  let args = base.args;
  let hookPermissionResult: HookPermissionResult | undefined;
  const additionalContexts: string[] = [];
  let preventContinuation: { readonly stopReason?: string } | undefined;

  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    let decision: PreToolUseDecision;
    const started = Date.now();
    try {
      decision = await hook({ invocation: base.invocation, tool: base.tool, args });
    } catch (err) {
      onError?.(err, i);
      const durationMs = Date.now() - started;
      onTiming?.({
        phase: "pre",
        toolName: base.tool.name,
        hookIndex: i,
        durationMs,
        overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
      });
      continue;
    }
    const durationMs = Date.now() - started;
    onTiming?.({
      phase: "pre",
      toolName: base.tool.name,
      hookIndex: i,
      durationMs,
      overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
    });
    if (decision.kind === "deny") {
      return {
        kind: "deny",
        reason: decision.reason,
        args,
        additionalContexts,
        ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
        ...(preventContinuation !== undefined ? { preventContinuation } : {}),
      };
    }
    if (decision.kind === "skip") {
      return {
        kind: "skip",
        synthResult: decision.synthResult,
        args,
        additionalContexts,
        ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
        ...(preventContinuation !== undefined ? { preventContinuation } : {}),
      };
    }
    if (decision.kind === "stop") {
      return {
        kind: "stop",
        args,
        additionalContexts,
        ...(decision.stopReason !== undefined
          ? { stopReason: decision.stopReason }
          : {}),
        ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
        ...(preventContinuation !== undefined ? { preventContinuation } : {}),
      };
    }
    if (decision.args) args = decision.args;
    if (decision.hookPermissionResult && !hookPermissionResult) {
      // First hook that speaks up wins — subsequent hooks can still
      // rewrite args/add context but can't override the permission
      // decision. Matches openclaude `hookPermissionResult` threading.
      hookPermissionResult = decision.hookPermissionResult;
      if (decision.hookPermissionResult.updatedInput) {
        args = decision.hookPermissionResult.updatedInput;
      }
    }
    if (decision.additionalContext && decision.additionalContext.length > 0) {
      for (const c of decision.additionalContext) additionalContexts.push(c);
    }
    if (decision.preventContinuation) {
      preventContinuation = decision.preventContinuation;
    }
  }
  return {
    kind: "continue",
    args,
    additionalContexts,
    ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
    ...(preventContinuation !== undefined ? { preventContinuation } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Post-tool-use hook
// ─────────────────────────────────────────────────────────────────────

export type PostToolUseDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "rewrite"; readonly result: ToolDispatchResult }
  /**
   * openclaude `stop` — the turn halts. Surfaces as a
   * `hook_stopped_continuation` attachment on the live path.
   */
  | {
      readonly kind: "stop";
      readonly stopReason?: string;
    }
  /**
   * openclaude `preventContinuation` — the successful tool result is
   * kept, but the turn does not loop back to the model. Live path
   * emits `hook_stopped_continuation`.
   */
  | {
      readonly kind: "preventContinuation";
      readonly stopReason?: string;
      readonly result?: ToolDispatchResult;
    }
  /**
   * openclaude `additionalContext` — inject extra synthesized user
   * messages after the tool_result (e.g. lint/test feedback). Live
   * path emits `hook_additional_context`.
   */
  | {
      readonly kind: "additionalContext";
      readonly content: ReadonlyArray<string>;
      readonly result?: ToolDispatchResult;
    }
  /**
   * openclaude `hook_blocking_error` — the hook errored while
   * processing the result; surface the error alongside the (possibly
   * unchanged) result. Live path emits `hook_blocking_error`.
   */
  | {
      readonly kind: "hook_blocking_error";
      readonly blockingError: string;
      readonly result?: ToolDispatchResult;
    };

export type PostToolUseHook = (input: {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  readonly result: ToolDispatchResult;
}) => Promise<PostToolUseDecision> | PostToolUseDecision;

/** Kinds of live-path attachments every hook pipeline can emit. */
export type HookAttachmentKind =
  | "hook_cancelled"
  | "hook_blocking_error"
  | "hook_additional_context"
  | "hook_stopped_continuation"
  | "hook_error_during_execution"
  | "hook_permission_decision";

/** Cumulative outcome of running every post-hook. */
export interface PostHooksResult {
  readonly kind: "continue" | "stop" | "preventContinuation";
  readonly result: ToolDispatchResult;
  readonly additionalContexts: ReadonlyArray<string>;
  readonly stopReason?: string;
  readonly blockingErrors: ReadonlyArray<string>;
}

/**
 * Run post-hooks in order. Decisions accumulate: `rewrite` replaces
 * the result for subsequent hooks; `additionalContext` entries are
 * concatenated; `stop` / `preventContinuation` short-circuit the loop
 * but still return the accumulated context so the caller can surface
 * both the final result and any extra messages.
 *
 * Hooks that throw are captured via `onError`. A thrown hook is
 * equivalent to a `hook_blocking_error` decision with the error
 * message as the `blockingError`; callers that want the
 * `hook_error_during_execution` label instead (openclaude's label
 * for the throw path) should emit it from the `onError` callback.
 */
export async function runPostToolUseHooks(
  hooks: ReadonlyArray<PostToolUseHook>,
  base: {
    readonly invocation: ToolInvocation;
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
    readonly result: ToolDispatchResult;
  },
  onError?: (err: unknown, idx: number) => void,
  onTiming?: (record: HookTimingRecord) => void,
): Promise<PostHooksResult> {
  let result = base.result;
  const additionalContexts: string[] = [];
  const blockingErrors: string[] = [];
  let stopKind: "stop" | "preventContinuation" | undefined;
  let stopReason: string | undefined;

  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    let decision: PostToolUseDecision;
    const started = Date.now();
    try {
      decision = await hook({
        invocation: base.invocation,
        tool: base.tool,
        args: base.args,
        result,
      });
    } catch (err) {
      onError?.(err, i);
      const durationMs = Date.now() - started;
      onTiming?.({
        phase: "post",
        toolName: base.tool.name,
        hookIndex: i,
        durationMs,
        overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
      });
      blockingErrors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const durationMs = Date.now() - started;
    onTiming?.({
      phase: "post",
      toolName: base.tool.name,
      hookIndex: i,
      durationMs,
      overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
    });
    switch (decision.kind) {
      case "continue":
        continue;
      case "rewrite":
        result = decision.result;
        continue;
      case "additionalContext": {
        for (const c of decision.content) additionalContexts.push(c);
        if (decision.result) result = decision.result;
        continue;
      }
      case "hook_blocking_error": {
        blockingErrors.push(decision.blockingError);
        if (decision.result) result = decision.result;
        continue;
      }
      case "preventContinuation": {
        stopKind = "preventContinuation";
        stopReason = decision.stopReason;
        if (decision.result) result = decision.result;
        return {
          kind: stopKind,
          result,
          additionalContexts,
          ...(stopReason !== undefined ? { stopReason } : {}),
          blockingErrors,
        };
      }
      case "stop": {
        stopKind = "stop";
        stopReason = decision.stopReason;
        return {
          kind: stopKind,
          result,
          additionalContexts,
          ...(stopReason !== undefined ? { stopReason } : {}),
          blockingErrors,
        };
      }
    }
  }
  return {
    kind: "continue",
    result,
    additionalContexts,
    blockingErrors,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Post-tool-use failure hook (openclaude parity — `executePostToolUseFailureHooks`)
// ─────────────────────────────────────────────────────────────────────

export interface PostToolUseFailureHookInput {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  readonly error: unknown;
  readonly isInterrupt?: boolean;
}

export type PostToolUseFailureHook = (
  input: PostToolUseFailureHookInput,
) => Promise<void> | void;

/**
 * Port of openclaude `executePostToolUseFailureHooks`. Fires for every
 * hook in order after a tool throws. Purely observational: exceptions
 * inside a failure hook are swallowed + reported via `onError`, and the
 * original tool error is expected to bubble up from the caller. Returns
 * per-hook timing records so observers can watch the threshold.
 */
export async function runPostToolUseFailureHooks(
  hooks: ReadonlyArray<PostToolUseFailureHook>,
  base: PostToolUseFailureHookInput,
  onError?: (err: unknown, idx: number) => void,
  onTiming?: (record: HookTimingRecord) => void,
): Promise<ReadonlyArray<HookTimingRecord>> {
  const records: HookTimingRecord[] = [];
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    const started = Date.now();
    try {
      await hook(base);
    } catch (err) {
      onError?.(err, i);
    }
    const durationMs = Date.now() - started;
    const record: HookTimingRecord = {
      phase: "failure",
      toolName: base.tool.name,
      hookIndex: i,
      durationMs,
      overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
    };
    records.push(record);
    onTiming?.(record);
  }
  return records;
}

// ─────────────────────────────────────────────────────────────────────
// MCP output modifier (stub; T9 wires real)
// ─────────────────────────────────────────────────────────────────────

/**
 * Placeholder for the MCP output modifier (openclaude toolHooks:
 * `applyMcpOutputModifier`). T9 wires a real implementation that
 * lets per-server config transform raw MCP text content (e.g. strip
 * secrets, reformat Markdown). T7 ships the surface so the pipeline
 * call site exists.
 */
export async function applyMcpOutputModifier(
  input: { readonly raw: string; readonly serverId: string },
): Promise<string> {
  // T9 wires real transformation. Today: passthrough.
  return input.raw;
}

// ─────────────────────────────────────────────────────────────────────
// Registry: a simple holder for hook arrays.
// ─────────────────────────────────────────────────────────────────────

export class ToolHookRegistry {
  private pre: PreToolUseHook[] = [];
  private post: PostToolUseHook[] = [];
  private failure: PostToolUseFailureHook[] = [];
  private permission: PermissionDecisionHook[] = [];

  addPre(hook: PreToolUseHook): void {
    this.pre.push(hook);
  }

  addPost(hook: PostToolUseHook): void {
    this.post.push(hook);
  }

  addFailure(hook: PostToolUseFailureHook): void {
    this.failure.push(hook);
  }

  addPermission(hook: PermissionDecisionHook): void {
    this.permission.push(hook);
  }

  getPre(): ReadonlyArray<PreToolUseHook> {
    return this.pre;
  }

  getPost(): ReadonlyArray<PostToolUseHook> {
    return this.post;
  }

  getFailure(): ReadonlyArray<PostToolUseFailureHook> {
    return this.failure;
  }

  getPermission(): ReadonlyArray<PermissionDecisionHook> {
    return this.permission;
  }

  clear(): void {
    this.pre = [];
    this.post = [];
    this.failure = [];
    this.permission = [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// Permission-decision hook (openclaude parity — resolveHookPermissionDecision)
// ─────────────────────────────────────────────────────────────────────

/** First-match wins: `pass` means "no opinion, consult the next hook". */
export type PermissionDecisionKind = "allow" | "deny" | "ask" | "pass";

export interface PermissionDecisionResult {
  readonly kind: PermissionDecisionKind;
  readonly reason?: string;
  /** Optional updated args when an allow hook normalizes input. */
  readonly updatedArgs?: Record<string, unknown>;
}

export type PermissionDecisionHook = (input: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}) =>
  | Promise<PermissionDecisionResult | undefined>
  | PermissionDecisionResult
  | undefined;

/**
 * Walk permission-request hooks in registration order and return the
 * first non-`pass`/non-`undefined` decision. A thrown hook is treated
 * as `pass` (safety: a broken hook must not silently deny).
 *
 * This is the typed, payload-shape-aware analog of openclaude
 * `resolveHookPermissionDecision`. The orchestrator's `requestApproval`
 * pipeline consults this BEFORE falling back to the session approval
 * resolver so hooks get first-say on permission outcomes.
 */
export async function resolveHookPermissionDecision(
  toolName: string,
  args: Record<string, unknown>,
  hooks: ReadonlyArray<PermissionDecisionHook>,
  onError?: (err: unknown, idx: number) => void,
  onTiming?: (record: HookTimingRecord) => void,
): Promise<PermissionDecisionResult> {
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    const started = Date.now();
    let decision: PermissionDecisionResult | undefined;
    try {
      decision = await hook({ toolName, args });
    } catch (err) {
      onError?.(err, i);
      decision = undefined;
    }
    const durationMs = Date.now() - started;
    onTiming?.({
      phase: "permission",
      toolName,
      hookIndex: i,
      durationMs,
      overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
    });
    if (!decision || decision.kind === "pass") continue;
    return decision;
  }
  return { kind: "pass" };
}

// ─────────────────────────────────────────────────────────────────────
// Hook + rule merge (openclaude parity — `resolveHookPermissionDecision`
// inc-4788 semantics: hook `allow` does NOT bypass settings.json deny/ask).
// ─────────────────────────────────────────────────────────────────────

export interface MergedHookPermissionDecision {
  readonly behavior: "allow" | "deny" | "ask";
  readonly args: Record<string, unknown>;
  readonly message?: string;
  readonly decisionReason?: {
    readonly type: "hook" | "hook_plus_rule_deny" | "hook_plus_rule_ask";
    readonly hookName?: string;
  };
}

/**
 * Merge a PreToolUse hook's permission result with the rule-based
 * permission check, preserving openclaude inc-4788 semantics:
 *
 *   - hook `allow` + rule `deny` → deny wins
 *   - hook `allow` + rule `ask`  → ask wins (dialog required)
 *   - hook `allow` + rule `pass` → allow (hook bypasses prompt)
 *   - hook `deny`                → deny (skip rule check)
 *   - hook `ask`                 → ask (dialog with hook message)
 *   - no hook                    → defer to caller's normal flow
 *
 * The caller supplies `ruleBasedCheck` — an async function that
 * evaluates settings.json-style rules and returns `null` (no rule
 * matches) or a concrete {behavior:"deny"|"ask", message}. This keeps
 * the hook+rule seam decoupled from AgenC's permission evaluator
 * internals while still honoring the invariant.
 */
export async function mergeHookPermissionDecision(opts: {
  readonly hookPermissionResult: HookPermissionResult | undefined;
  readonly args: Record<string, unknown>;
  readonly ruleBasedCheck?: (
    args: Record<string, unknown>,
  ) => Promise<{
    readonly behavior: "deny" | "ask";
    readonly message?: string;
  } | null>;
}): Promise<MergedHookPermissionDecision | null> {
  const hook = opts.hookPermissionResult;
  if (!hook) return null;

  const rewrittenArgs = hook.updatedInput ?? opts.args;

  if (hook.behavior === "deny") {
    return {
      behavior: "deny",
      args: rewrittenArgs,
      ...(hook.message !== undefined ? { message: hook.message } : {}),
      ...(hook.hookName !== undefined
        ? { decisionReason: { type: "hook", hookName: hook.hookName } }
        : { decisionReason: { type: "hook" } }),
    };
  }

  if (hook.behavior === "ask") {
    return {
      behavior: "ask",
      args: rewrittenArgs,
      ...(hook.message !== undefined ? { message: hook.message } : {}),
      ...(hook.hookName !== undefined
        ? { decisionReason: { type: "hook", hookName: hook.hookName } }
        : { decisionReason: { type: "hook" } }),
    };
  }

  // hook.behavior === "allow" — preserve inc-4788 semantics: rule
  // deny/ask still applies even if the hook green-lit the call.
  if (opts.ruleBasedCheck) {
    const rule = await opts.ruleBasedCheck(rewrittenArgs);
    if (rule && rule.behavior === "deny") {
      return {
        behavior: "deny",
        args: rewrittenArgs,
        ...(rule.message !== undefined ? { message: rule.message } : {}),
        ...(hook.hookName !== undefined
          ? {
              decisionReason: {
                type: "hook_plus_rule_deny",
                hookName: hook.hookName,
              },
            }
          : { decisionReason: { type: "hook_plus_rule_deny" } }),
      };
    }
    if (rule && rule.behavior === "ask") {
      return {
        behavior: "ask",
        args: rewrittenArgs,
        ...(rule.message !== undefined ? { message: rule.message } : {}),
        ...(hook.hookName !== undefined
          ? {
              decisionReason: {
                type: "hook_plus_rule_ask",
                hookName: hook.hookName,
              },
            }
          : { decisionReason: { type: "hook_plus_rule_ask" } }),
      };
    }
  }

  return {
    behavior: "allow",
    args: rewrittenArgs,
    ...(hook.message !== undefined ? { message: hook.message } : {}),
    ...(hook.hookName !== undefined
      ? { decisionReason: { type: "hook", hookName: hook.hookName } }
      : { decisionReason: { type: "hook" } }),
  };
}
