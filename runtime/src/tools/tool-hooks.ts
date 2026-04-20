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
): Promise<PreToolUseDecision> {
  let args = base.args;
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    let decision: PreToolUseDecision;
    try {
      decision = await hook({ invocation: base.invocation, tool: base.tool, args });
    } catch (err) {
      onError?.(err, i);
      continue;
    }
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
): Promise<PostToolUseDecision> {
  let result = base.result;
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    let decision: PostToolUseDecision;
    try {
      decision = await hook({
        invocation: base.invocation,
        tool: base.tool,
        args: base.args,
        result,
      });
    } catch (err) {
      onError?.(err, i);
      continue;
    }
    if (decision.kind === "retry") return decision;
    if (decision.kind === "rewrite") result = decision.result;
  }
  return { kind: "continue" };
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
    if (decision.kind !== "retry") return result;
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

  addPre(hook: PreToolUseHook): void {
    this.pre.push(hook);
  }

  addPost(hook: PostToolUseHook): void {
    this.post.push(hook);
  }

  getPre(): ReadonlyArray<PreToolUseHook> {
    return this.pre;
  }

  getPost(): ReadonlyArray<PostToolUseHook> {
    return this.post;
  }

  clear(): void {
    this.pre = [];
    this.post = [];
  }
}
