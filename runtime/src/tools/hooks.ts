/**
 * Pre/post tool hooks + MCP output modifier.
 *
 * Subset port of the donor `services/tools/toolHooks.ts`. AgenC's T6
 * surface is a composable chain: each hook function receives
 * `(invocation, args, dispatchResult)` and returns either a
 * pass-through value or a replacement.
 *
 * T6 (W1 parity pass): the decision set grew to match AgenC's
 * PostToolUse universe — `stop`, `preventContinuation`,
 * `additionalContext`, `hook_blocking_error`, and `rewrite` all live
 * here and every one is emitted by the live execution path. The
 * args-retry auto-fix loop (previously `runWithAutoFixRetry`) was
 * removed per `docs/plan/feature-matrix.md`: AgenC's auto-fix is
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
// Timing threshold (AgenC behavior — toolHooks.ts)
// ─────────────────────────────────────────────────────────────────────

/**
 * Hooks that run longer than this threshold (ms) emit a telemetry
 * event so slow hooks are discoverable. Matches AgenC's
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
  /**
   * Set when the hook's per-call `await` was cut short by an aborting
   * signal (drain/timeout) rather than the hook producing a verdict.
   * Distinct from a thrown hook (which is fail-open and never sets
   * this). See `raceHookWithSignal`.
   */
  readonly cancelled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Signal-aware single-hook race (mirrors execution.ts withTimeoutAndAbort
// minus the timeout leg). On abort, resolves `cancelled` WITHOUT awaiting
// the (possibly wedged) hook — this is what lets the surrounding loop
// return so the lock-wrapped fn() can settle and release its guard.
// ─────────────────────────────────────────────────────────────────────

/**
 * Typed three-variant terminal of a single hook race. Keeping
 * throw-vs-cancel in the type (never a cast) is load-bearing: a thrown
 * hook had its say and is treated fail-OPEN (swallow + continue) by every
 * runner, while a cancelled hook never produced its verdict and the
 * security-relevant runners treat it fail-CLOSED.
 */
export type HookRace<T> =
  | { readonly settled: "value"; readonly value: T }
  | { readonly settled: "cancelled"; readonly reason: unknown }
  | { readonly settled: "threw"; readonly error: unknown };

/**
 * Grace (ms) after a cancel before a still-pending hook is labelled an
 * orphan. A cooperative hook that resolves in response to the abort settles
 * within this window and is NOT counted; only a signal-blind hook is. Small
 * enough to be observable promptly, large enough to absorb the
 * resolve-on-abort microtask hop. The `cancelled` resolution does NOT wait
 * for this; only the `hook_orphaned` label does.
 */
const ORPHAN_GRACE_MS = 10;

/**
 * Run a single hook, racing it against `signal`.
 *
 * - No signal → just await the hook (value/threw).
 * - Already aborted → resolve `cancelled` immediately WITHOUT calling the
 *   hook (the already-aborted fast path).
 * - Otherwise → race the hook against the signal's `abort`. If the signal
 *   fires first, resolve `cancelled` immediately, WITHOUT awaiting the
 *   (possibly wedged) hook. The orphaned hook promise is detached and
 *   `.catch(()=>{})`'d so a wedged hook never becomes an unhandledRejection,
 *   and a first-settle `done` latch guarantees a late settle cannot mutate
 *   caller state (same first-settle-wins discipline as
 *   `finalizeOnce`/`startReclaimAccounting`).
 *
 * `onOrphaned` (optional) fires AT MOST ONCE if, after the race resolved
 * `cancelled`, the hook task is STILL pending past a short cooperative
 * grace — i.e. an uncooperative hook that ignored its signal and keeps
 * running detached. A cooperative hook that resolves *in response to* the
 * abort (a very common pattern: the hook itself listens on the same signal)
 * settles within the grace and is NOT counted as an orphan, even though it
 * is momentarily pending at the exact synchronous abort instant. This is
 * the same reclaimed-vs-leaked grace-race discipline as
 * `startReclaimAccounting`. `onOrphaned` is NEVER fired for the
 * already-aborted fast path (the hook never ran). The orphan accounting is
 * decoupled from — and never delays — the `cancelled` resolution, which
 * still happens immediately so the lock-wrapped fn() settles at once.
 */
export async function raceHookWithSignal<T>(
  call: () => Promise<T> | T,
  signal: AbortSignal | undefined,
  onOrphaned?: () => void,
): Promise<HookRace<T>> {
  if (!signal) {
    try {
      return { settled: "value", value: await call() };
    } catch (error) {
      return { settled: "threw", error };
    }
  }
  if (signal.aborted) {
    return { settled: "cancelled", reason: signal.reason };
  }

  let done = false;
  let hookSettled = false;
  let onAbort: (() => void) | null = null;
  const cleanup = (): void => {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
  };
  try {
    return await new Promise<HookRace<T>>((resolve) => {
      onAbort = (): void => {
        if (done) return;
        done = true;
        cleanup();
        // Resolve `cancelled` IMMEDIATELY — lock release must not wait for
        // the orphan determination.
        resolve({ settled: "cancelled", reason: signal.reason });
        // Orphan accounting is deferred and decoupled: a cooperative hook
        // that resolves in response to THIS abort settles within a short
        // grace and is NOT an orphan; only a hook still pending past the
        // grace is the uncooperative residue. Fire onOrphaned at most once.
        if (onOrphaned) {
          let orphanFired = false;
          const maybeOrphan = (): void => {
            if (orphanFired || hookSettled) return;
            orphanFired = true;
            try {
              onOrphaned();
            } catch {
              // observability must never throw into the hook loop
            }
          };
          const t = setTimeout(maybeOrphan, ORPHAN_GRACE_MS);
          (t as { unref?: () => void }).unref?.();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(call)
        .then(
          (value) => {
            hookSettled = true;
            if (done) return;
            done = true;
            cleanup();
            resolve({ settled: "value", value });
          },
          (error) => {
            hookSettled = true;
            if (done) return;
            done = true;
            cleanup();
            resolve({ settled: "threw", error });
          },
        )
        // Detached orphan: a wedged/late hook must never surface as an
        // unhandledRejection once the race has already settled.
        .catch(() => {});
    });
  } finally {
    cleanup(); // belt-and-suspenders listener removal on every path
  }
}

// ─────────────────────────────────────────────────────────────────────
// Hook permission result (AgenC behavior — used before the permission
// gate so PreToolUse hooks can steer the rule-based check).
// ─────────────────────────────────────────────────────────────────────

export type HookPermissionBehavior = "allow" | "deny" | "ask";

function isHookPermissionBehavior(
  value: unknown,
): value is HookPermissionBehavior {
  return value === "allow" || value === "deny" || value === "ask";
}

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
  /** Donor `decisionReason.hookName` passthrough for hook result metadata. */
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
   * Stop the turn entirely — AgenC PreToolUse `stop` (CANCEL_MESSAGE
   * tool_result, turn concluded). `stopReason` is surfaced as the
   * toolUseResult for downstream consumers.
   */
  | { readonly kind: "stop"; readonly stopReason?: string };

export type PreToolUseHook = (input: {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  /**
   * Drain/timeout-aware abort signal. Cooperative hooks may observe it
   * to bail early; the lock-release guarantee comes from the runner
   * racing the signal (see `raceHookWithSignal`), not from this field.
   */
  readonly signal?: AbortSignal;
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
  signal?: AbortSignal,
  onCancelled?: (idx: number) => void,
  onOrphaned?: (idx: number) => void,
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
    const race = await raceHookWithSignal(
      () =>
        hook({
          invocation: base.invocation,
          tool: base.tool,
          args,
          ...(signal !== undefined ? { signal } : {}),
        }),
      signal,
      () => onOrphaned?.(i),
    );
    if (race.settled === "cancelled") {
      // FAIL-CLOSED: synthesize a deny terminal carrying everything
      // accumulated by hooks that fully completed BEFORE this point.
      // This makes the surrounding loop RETURN so the lock-wrapped
      // dispatch fn() settles and its finally releases the guard. The
      // cancelled hook produced no decision ⇒ none of its
      // args/permission/context are applied (atomic break).
      const durationMs = Date.now() - started;
      onTiming?.({
        phase: "pre",
        toolName: base.tool.name,
        hookIndex: i,
        durationMs,
        overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
        cancelled: true,
      });
      onCancelled?.(i);
      return {
        kind: "deny",
        reason: `pre-hook cancelled (drain/timeout) before producing a verdict: ${base.tool.name}#${i}`,
        args,
        additionalContexts,
        ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
        ...(preventContinuation !== undefined ? { preventContinuation } : {}),
      };
    }
    if (race.settled === "threw") {
      // UNCHANGED existing fail-open behavior: a thrown hook is swallowed
      // and the loop proceeds (the hook had its say; throw != cancel).
      onError?.(race.error, i);
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
    decision = race.value;
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
      // decision. Matches donor `hookPermissionResult` threading.
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
   * Donor `stop` — the turn halts. Surfaces as a
   * `hook_stopped_continuation` attachment on the live path.
   */
  | {
      readonly kind: "stop";
      readonly stopReason?: string;
    }
  /**
   * Donor `preventContinuation` — the successful tool result is
   * kept, but the turn does not loop back to the model. Live path
   * emits `hook_stopped_continuation`.
   */
  | {
      readonly kind: "preventContinuation";
      readonly stopReason?: string;
      readonly result?: ToolDispatchResult;
    }
  /**
   * Donor `additionalContext` — inject extra synthesized user
   * messages after the tool_result (e.g. lint/test feedback). Live
   * path emits `hook_additional_context`.
   */
  | {
      readonly kind: "additionalContext";
      readonly content: ReadonlyArray<string>;
      readonly result?: ToolDispatchResult;
    }
  /**
   * Donor `hook_blocking_error` — the hook errored while
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
  readonly signal?: AbortSignal;
}) => Promise<PostToolUseDecision> | PostToolUseDecision;

/** Kinds of live-path attachments every hook pipeline can emit. */
export type HookAttachmentKind =
  | "hook_cancelled"
  /**
   * Distinct from `hook_cancelled` (which fires on every drain/timeout
   * cancellation) and from the execute-phase `leaked` count: a
   * `hook_orphaned` event fires only when a cancelled hook's underlying
   * task was STILL PENDING at cancel time — i.e. an uncooperative hook
   * that ignored its signal and keeps running detached. The LOCK is
   * already reclaimed; this honestly accounts the residual orphan task
   * (never claimed killed).
   */
  | "hook_orphaned"
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
 * `hook_error_during_execution` label instead (AgenC's label
 * for the throw path) should emit it from the `onError` callback.
 */
export async function runPostToolUseHooks(
  hooks: ReadonlyArray<PostToolUseHook>,
  base: {
    readonly invocation: ToolInvocation;
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
    readonly result: ToolDispatchResult;
    readonly signal?: AbortSignal;
  },
  onError?: (err: unknown, idx: number) => void,
  onTiming?: (record: HookTimingRecord) => void,
  onCancelled?: (idx: number) => void,
  onOrphaned?: (idx: number) => void,
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
    const race = await raceHookWithSignal(
      () =>
        hook({
          invocation: base.invocation,
          tool: base.tool,
          args: base.args,
          result,
          ...(base.signal !== undefined ? { signal: base.signal } : {}),
        }),
      base.signal,
      () => onOrphaned?.(i),
    );
    if (race.settled === "cancelled") {
      // FAIL-SAFE-AS-CONTINUE: the tool already ran. Keep the
      // already-rewritten result + everything accumulated and let the
      // loop return so the lock-wrapped fn() settles. NEVER coerce to
      // stop/preventContinuation on a cancel.
      const durationMs = Date.now() - started;
      onTiming?.({
        phase: "post",
        toolName: base.tool.name,
        hookIndex: i,
        durationMs,
        overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
        cancelled: true,
      });
      onCancelled?.(i);
      return { kind: "continue", result, additionalContexts, blockingErrors };
    }
    if (race.settled === "threw") {
      const err = race.error;
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
    decision = race.value;
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
// Post-tool-use failure hook (AgenC behavior — `executePostToolUseFailureHooks`)
// ─────────────────────────────────────────────────────────────────────

export interface PostToolUseFailureHookInput {
  readonly invocation: ToolInvocation;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  readonly error: unknown;
  readonly isInterrupt?: boolean;
  /** Drain/timeout-aware abort signal (cooperative hooks may observe it). */
  readonly signal?: AbortSignal;
}

export type PostToolUseFailureHook = (
  input: PostToolUseFailureHookInput,
) => Promise<void> | void;

/**
 * Port of donor `executePostToolUseFailureHooks`. Fires for every
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
  signal?: AbortSignal,
  onCancelled?: (idx: number) => void,
  onOrphaned?: (idx: number) => void,
): Promise<ReadonlyArray<HookTimingRecord>> {
  const records: HookTimingRecord[] = [];
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    const started = Date.now();
    const race = await raceHookWithSignal(
      () => hook(base),
      signal,
      () => onOrphaned?.(i),
    );
    if (race.settled === "cancelled") {
      // Drop the remaining (purely observational) failure hooks and
      // return the records gathered so far plus a cancelled marker. The
      // original tool error still bubbles from the caller (unchanged).
      onCancelled?.(i);
      const durationMs = Date.now() - started;
      const record: HookTimingRecord = {
        phase: "failure",
        toolName: base.tool.name,
        hookIndex: i,
        durationMs,
        overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
        cancelled: true,
      };
      records.push(record);
      onTiming?.(record);
      return records;
    }
    if (race.settled === "threw") {
      onError?.(race.error, i);
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
 * Placeholder for the MCP output modifier (AgenC toolHooks:
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
// Permission-decision hook (AgenC behavior — resolveHookPermissionDecision)
// ─────────────────────────────────────────────────────────────────────

/** First-match wins: `pass` means "no opinion, consult the next hook". */
export type PermissionDecisionKind = "allow" | "deny" | "ask" | "pass";

export interface PermissionDecisionResult {
  readonly kind: PermissionDecisionKind;
  readonly reason?: string;
  /** Optional updated args when an allow hook normalizes input. */
  readonly updatedArgs?: Record<string, unknown>;
}

export interface PermissionDecisionHookInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly invocation?: ToolInvocation;
  readonly callId?: string;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly transcriptPath?: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly matcherAliases?: readonly string[];
  readonly signal?: AbortSignal;
}

export type PermissionDecisionHook = (input: PermissionDecisionHookInput) =>
  | Promise<PermissionDecisionResult | undefined>
  | PermissionDecisionResult
  | undefined;

/**
 * Walk permission-request hooks in registration order and return the
 * first non-`pass`/non-`undefined` decision. A thrown hook is treated
 * as `pass` (safety: a broken hook must not silently deny).
 *
 * This is the typed, payload-shape-aware analog of AgenC
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
  context: Omit<PermissionDecisionHookInput, "toolName" | "args"> = {},
  onCancelled?: (idx: number) => void,
  onOrphaned?: (idx: number) => void,
): Promise<PermissionDecisionResult> {
  for (let i = 0; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!hook) continue;
    const started = Date.now();
    let decision: PermissionDecisionResult | undefined;
    const race = await raceHookWithSignal(
      () => hook({ toolName, args, ...context }),
      context.signal,
      () => onOrphaned?.(i),
    );
    if (race.settled === "cancelled") {
      // PRESERVE the documented fail-open-on-broken-hook contract: a
      // cancelled permission hook resolves to `pass` (falls through to
      // the next hook / the final {kind:"pass"}). The real fail-closed
      // gate is the pre-hook deny terminal + the already-shipped
      // execute-phase abort — NOT this runner. Do NOT flip to deny.
      onCancelled?.(i);
      const durationMs = Date.now() - started;
      onTiming?.({
        phase: "permission",
        toolName,
        hookIndex: i,
        durationMs,
        overThreshold: durationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS,
        cancelled: true,
      });
      continue;
    }
    if (race.settled === "threw") {
      onError?.(race.error, i);
      decision = undefined;
    } else {
      decision = race.value;
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
// Hook + rule merge (AgenC behavior — `resolveHookPermissionDecision`
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
 * permission check, preserving AgenC inc-4788 semantics:
 *
 *   - hook `allow` + rule `deny` → deny wins
 *   - hook `allow` + rule `ask`  → ask wins (dialog required)
 *   - hook `allow` + rule `pass` → allow (hook bypasses prompt)
 *   - hook `deny`                → deny (skip rule check)
 *   - hook `ask` + rule `deny`   → deny wins
 *   - hook `ask` + rule `ask/pass` → ask (dialog required)
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
  if (!isHookPermissionBehavior(hook.behavior)) return null;

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

  if (
    (hook.behavior === "ask" || hook.behavior === "allow") &&
    opts.ruleBasedCheck
  ) {
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
  return {
    behavior: "allow",
    args: rewrittenArgs,
    ...(hook.message !== undefined ? { message: hook.message } : {}),
    ...(hook.hookName !== undefined
      ? { decisionReason: { type: "hook", hookName: hook.hookName } }
      : { decisionReason: { type: "hook" } }),
  };
}
