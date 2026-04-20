/**
 * Pre/post tool hooks + auto-fix retry + MCP output modifier.
 *
 * Subset port of openclaude `services/tools/toolHooks.ts` (716 LOC).
 * The real openclaude implementation threads through every hook
 * registry in the codebase + auto-fix grammar + MCP renderer hooks.
 * AgenC's T7 surface is a simpler composable chain: each hook
 * function receives `(invocation, args, dispatchResult)` and returns
 * either the pass-through value or a replacement.
 *
 * T9 integrates the real MCP output modifier; T10 wires the config
 * sidecar pre/post hook DSL.
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
// Pre-tool-use hook
// ─────────────────────────────────────────────────────────────────────

export type PreToolUseDecision =
  | { readonly kind: "continue"; readonly args?: Record<string, unknown> }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "skip"; readonly synthResult: ToolDispatchResult };

export type PreToolUseHook = (input: {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
}) => Promise<PreToolUseDecision> | PreToolUseDecision;

/**
 * Run every pre-hook in order. First "deny" / "skip" short-circuits.
 * Arg mutations accumulate across hooks (later hooks see earlier hooks'
 * rewrites). Hooks that throw are treated as no-ops with a logged
 * warning (safety: don't let a broken hook brick the turn).
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
): Promise<PreToolUseDecision> {
  let args = base.args;
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
    if (decision.kind === "deny" || decision.kind === "skip") return decision;
    if (decision.args) args = decision.args;
  }
  return { kind: "continue", args };
}

// ─────────────────────────────────────────────────────────────────────
// Post-tool-use hook
// ─────────────────────────────────────────────────────────────────────

export type PostToolUseDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "rewrite"; readonly result: ToolDispatchResult }
  | { readonly kind: "retry"; readonly args: Record<string, unknown> };

export type PostToolUseHook = (input: {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  readonly result: ToolDispatchResult;
}) => Promise<PostToolUseDecision> | PostToolUseDecision;

/**
 * Run post-hooks in order. A `rewrite` decision replaces the result
 * and subsequent hooks see the new content. A `retry` decision is
 * returned to the caller (execution.ts loops, capped by
 * `MAX_AUTO_FIX_RETRIES`).
 *
 * Hooks that throw are logged and skipped.
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
): Promise<PostToolUseDecision & { readonly result?: ToolDispatchResult }> {
  let result = base.result;
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
    if (decision.kind === "retry") return decision;
    if (decision.kind === "rewrite") result = decision.result;
  }
  return { kind: "continue", result };
}

// ─────────────────────────────────────────────────────────────────────
// Auto-fix retry (port of openclaude autoFix pattern)
// ─────────────────────────────────────────────────────────────────────

export const MAX_AUTO_FIX_RETRIES = 2;

export interface AutoFixLoopOptions {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly initialArgs: Record<string, unknown>;
  readonly dispatch: (args: Record<string, unknown>) => Promise<ToolDispatchResult>;
  readonly postHooks: ReadonlyArray<PostToolUseHook>;
  readonly onError?: (err: unknown, idx: number) => void;
}

/**
 * Execute the dispatch-then-post-hooks loop with bounded retry. A
 * post-hook returning `retry` re-dispatches with the new args, up to
 * `MAX_AUTO_FIX_RETRIES` (2) total retries. Beyond that, the loop
 * surfaces the last result without further retries.
 */
export async function runWithAutoFixRetry(
  opts: AutoFixLoopOptions,
): Promise<ToolDispatchResult> {
  let args = opts.initialArgs;
  let result = await opts.dispatch(args);
  for (let attempt = 0; attempt <= MAX_AUTO_FIX_RETRIES; attempt += 1) {
    const decision = await runPostToolUseHooks(
      opts.postHooks,
      {
        invocation: opts.invocation,
        tool: opts.tool,
        args,
        result,
      },
      opts.onError,
    );
    if (decision.kind !== "retry") {
      // When decision is `continue`, the post-hooks may have rewritten
      // the result — the composed result is returned in decision.result.
      return decision.result ?? result;
    }
    if (attempt === MAX_AUTO_FIX_RETRIES) return result;
    args = decision.args;
    result = await opts.dispatch(args);
  }
  return result;
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
