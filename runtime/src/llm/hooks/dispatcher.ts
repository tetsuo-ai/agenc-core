/**
 * Lifecycle hook dispatcher.
 *
 * Drives the `PreCompact`, `PostCompact`, and `SessionStart` events
 * through the registered hook callbacks and aggregates results in the
 * shape the upstream compact pipeline expects (see
 * AgenC lifecycle hook dispatcher.
 *
 * Behavior preserved from upstream:
 *  - Hooks run sequentially; abort signal is propagated.
 *  - Hooks that throw are converted to a failed `HookResult` so a
 *    broken hook cannot crash the compact loop.
 *  - PreCompact merges every successful hook's trimmed `output` into
 *    `newCustomInstructions` (joined with `\n\n`) and builds a per-hook
 *    `userDisplayMessage` line.
 *  - PostCompact does the same display-line aggregation but does not
 *    surface custom instructions.
 *  - SessionStart returns `HookResultMessage[]` — one entry per hook
 *    that emitted a `message`, plus one synthesized
 *    `hook_additional_context` envelope when any hook contributed
 *    `additionalContexts`.
 *
 * @module
 */
import type { HookResultMessage } from "../../types/message.js";
import { peekAmbientRuntimeSession } from "../../session/current-session.js";
import {
  getLifecycleHookRegistry,
  LifecycleHookRegistry,
} from "./registry.js";
import type {
  HookResult,
  NotificationHookInput,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  SubagentStopHookInput,
} from "./types.js";

const PRE_COMPACT_LABEL = "PreCompact";
const POST_COMPACT_LABEL = "PostCompact";

/** Default hook execution timeout. Mirrors upstream
 *  `TOOL_HOOK_EXECUTION_TIMEOUT_MS` budget rationale: hooks must not
 *  stall the compact pipeline indefinitely. The dispatcher honors any
 *  caller-supplied AbortSignal but does not wire its own timer (the
 *  caller already passes `context.abortController.signal`). The
 *  constant is exported for test parity. */
export const HOOK_EXECUTION_TIMEOUT_MS = 60_000;

interface DispatchOpts<H> {
  readonly hooks?: ReadonlyArray<H>;
  /**
   * The dispatching session's lifecycle hook registry. Configured
   * per-session hooks (SessionStart/SessionEnd/PreCompact/…) live in the
   * session's own registry — NOT the process-global one — so concurrent
   * daemon sessions never fire each other's hooks. When omitted, the
   * dispatcher resolves the ambient session's registry (AsyncLocalStorage
   * turn scope, falling back to the module-level session only when the
   * process has a single one). Hooks in the process-global registry fire
   * for every session in addition to the session's own.
   */
  readonly registry?: LifecycleHookRegistry;
  readonly signal?: AbortSignal;
}

async function safeRun<I>(
  hook: (
    input: I,
    signal?: AbortSignal,
  ) => Promise<HookResult | undefined> | HookResult | undefined,
  input: I,
  signal: AbortSignal | undefined,
  failureLabel: string,
): Promise<HookResult> {
  try {
    const r = await hook(input, signal);
    if (r === undefined || r === null) {
      return { succeeded: true, output: "" };
    }
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      succeeded: false,
      output: msg,
      command: failureLabel,
    };
  }
}

export interface PreCompactDispatchResult {
  readonly newCustomInstructions?: string;
  readonly userDisplayMessage?: string;
}

export async function dispatchPreCompact(
  input: PreCompactHookInput,
  opts: DispatchOpts<
    (input: PreCompactHookInput, signal?: AbortSignal) =>
      | Promise<HookResult | undefined>
      | HookResult
      | undefined
  > = {},
): Promise<PreCompactDispatchResult> {
  const hooks =
    opts.hooks ?? resolveHooks((r) => r.getPreCompact(), opts.registry);
  if (hooks.length === 0) return {};

  const results: HookResult[] = [];
  for (const h of hooks) {
    if (opts.signal?.aborted) break;
    results.push(await safeRun(h, input, opts.signal, PRE_COMPACT_LABEL));
  }

  const successfulOutputs = results
    .filter((r) => r.succeeded && r.output.trim().length > 0)
    .map((r) => r.output.trim());

  const displayMessages = results.map((r) =>
    formatDisplayLine(PRE_COMPACT_LABEL, r),
  );

  const result: PreCompactDispatchResult = {};
  if (successfulOutputs.length > 0) {
    return Object.assign(result, {
      newCustomInstructions: successfulOutputs.join("\n\n"),
      userDisplayMessage: displayMessages.join("\n"),
    });
  }
  if (displayMessages.length > 0) {
    return Object.assign(result, {
      userDisplayMessage: displayMessages.join("\n"),
    });
  }
  return result;
}

export interface PostCompactDispatchResult {
  readonly userDisplayMessage?: string;
}

export async function dispatchPostCompact(
  input: PostCompactHookInput,
  opts: DispatchOpts<
    (input: PostCompactHookInput, signal?: AbortSignal) =>
      | Promise<HookResult | undefined>
      | HookResult
      | undefined
  > = {},
): Promise<PostCompactDispatchResult> {
  const hooks =
    opts.hooks ?? resolveHooks((r) => r.getPostCompact(), opts.registry);
  if (hooks.length === 0) return {};

  const results: HookResult[] = [];
  for (const h of hooks) {
    if (opts.signal?.aborted) break;
    results.push(await safeRun(h, input, opts.signal, POST_COMPACT_LABEL));
  }

  const displayMessages = results.map((r) =>
    formatDisplayLine(POST_COMPACT_LABEL, r),
  );

  if (displayMessages.length === 0) return {};
  return { userDisplayMessage: displayMessages.join("\n") };
}

export async function dispatchSessionStart(
  input: SessionStartHookInput,
  opts: DispatchOpts<
    (input: SessionStartHookInput, signal?: AbortSignal) =>
      | Promise<HookResult | undefined>
      | HookResult
      | undefined
  > = {},
): Promise<HookResultMessage[]> {
  const hooks =
    opts.hooks ?? resolveHooks((r) => r.getSessionStart(), opts.registry);
  if (hooks.length === 0) return [];

  const out: HookResultMessage[] = [];
  const additionalContexts: string[] = [];

  for (const h of hooks) {
    if (opts.signal?.aborted) break;
    const result = await safeRun(h, input, opts.signal, "SessionStart");
    if (result.message !== undefined) out.push(result.message);
    if (result.additionalContexts && result.additionalContexts.length > 0) {
      for (const c of result.additionalContexts) additionalContexts.push(c);
    }
  }

  if (additionalContexts.length > 0) {
    out.push({
      type: "hook_additional_context",
      hookEvent: "SessionStart",
      hookName: "SessionStart",
      content: additionalContexts,
    });
  }

  return out;
}

function formatDisplayLine(label: string, r: HookResult): string {
  const cmd = r.command ?? label;
  const trimmed = r.output.trim();
  if (r.succeeded) {
    return trimmed
      ? `${label} [${cmd}] completed successfully: ${trimmed}`
      : `${label} [${cmd}] completed successfully`;
  }
  return trimmed ? `${label} [${cmd}] failed: ${trimmed}` : `${label} [${cmd}] failed`;
}

/** Resolve the lifecycle hook registry owned by the ambient session, if
 *  any. Returns `undefined` outside a session scope, when the ambient
 *  session is ambiguous (multiple sessions bootstrapped, no turn scope),
 *  or when the session carries no per-session registry. */
function ambientSessionRegistry(): LifecycleHookRegistry | undefined {
  const registry =
    peekAmbientRuntimeSession()?.services?.hooks?.lifecycleHooks;
  return registry instanceof LifecycleHookRegistry ? registry : undefined;
}

/** Collect the hooks to run for one event: the dispatching session's own
 *  hooks (explicit `registry` from the dispatch opts, else the ambient
 *  session's) followed by process-global registry hooks, which fire for
 *  every session. */
function resolveHooks<H>(
  pick: (registry: LifecycleHookRegistry) => ReadonlyArray<H>,
  registry: LifecycleHookRegistry | undefined,
): ReadonlyArray<H> {
  const sessionRegistry = registry ?? ambientSessionRegistry();
  const globalHooks = pick(getLifecycleHookRegistry());
  if (
    sessionRegistry === undefined ||
    sessionRegistry === getLifecycleHookRegistry()
  ) {
    return globalHooks;
  }
  const sessionHooks = pick(sessionRegistry);
  if (sessionHooks.length === 0) return globalHooks;
  return globalHooks.length === 0
    ? sessionHooks
    : [...sessionHooks, ...globalHooks];
}

export interface SubagentStopDispatchResult {
  /** Feedback the PARENT agent should see alongside the completion
   *  notification: failed-hook outputs + every `additionalContext`. */
  readonly feedback?: string;
}

/**
 * Dispatch `SubagentStop` when a spawned agent reaches a terminal
 * state. A hook that FAILS (exit code ≠ 0 for configured command
 * hooks) or emits `additionalContext` produces feedback that is
 * appended to the completion notification the parent agent reads —
 * the observe/gate seam for subagent results.
 */
export async function dispatchSubagentStop(
  input: SubagentStopHookInput,
  opts: DispatchOpts<
    (input: SubagentStopHookInput, signal?: AbortSignal) =>
      | Promise<HookResult | undefined>
      | HookResult
      | undefined
  > = {},
): Promise<SubagentStopDispatchResult> {
  const hooks =
    opts.hooks ?? resolveHooks((r) => r.getSubagentStop(), opts.registry);
  if (hooks.length === 0) return {};
  const feedbackParts: string[] = [];
  for (const h of hooks) {
    if (opts.signal?.aborted) break;
    const result = await safeRun(h, input, opts.signal, "SubagentStop");
    if (!result.succeeded && result.output.trim().length > 0) {
      feedbackParts.push(result.output.trim());
    }
    if (result.additionalContexts) {
      for (const c of result.additionalContexts) {
        if (c.trim().length > 0) feedbackParts.push(c.trim());
      }
    }
  }
  return feedbackParts.length > 0
    ? { feedback: feedbackParts.join("\n\n") }
    : {};
}

/** Dispatch `SessionEnd` during session shutdown. Results are
 *  display-only (the session is going away); failures are contained. */
export async function dispatchSessionEnd(
  input: SessionEndHookInput,
  opts: DispatchOpts<
    (input: SessionEndHookInput, signal?: AbortSignal) =>
      | Promise<HookResult | undefined>
      | HookResult
      | undefined
  > = {},
): Promise<void> {
  const hooks =
    opts.hooks ?? resolveHooks((r) => r.getSessionEnd(), opts.registry);
  for (const h of hooks) {
    if (opts.signal?.aborted) break;
    await safeRun(h, input, opts.signal, "SessionEnd");
  }
}

/** Dispatch `Notification` when the runtime starts waiting on the
 *  human (permission request, elicitation). Fire-and-forget semantics;
 *  hook output is not fed back to the model. */
export async function dispatchNotification(
  input: NotificationHookInput,
  opts: DispatchOpts<
    (input: NotificationHookInput, signal?: AbortSignal) =>
      | Promise<HookResult | undefined>
      | HookResult
      | undefined
  > = {},
): Promise<void> {
  const hooks =
    opts.hooks ?? resolveHooks((r) => r.getNotification(), opts.registry);
  for (const h of hooks) {
    if (opts.signal?.aborted) break;
    await safeRun(h, input, opts.signal, "Notification");
  }
}
