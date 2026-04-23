/**
 * Lifecycle hook dispatcher.
 *
 * Drives the `PreCompact`, `PostCompact`, and `SessionStart` events
 * through the registered hook callbacks and aggregates results in the
 * shape the upstream compact pipeline expects (see
 * `claude/src/utils/hooks.ts::executePreCompactHooks` etc.).
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
import type { HookResultMessage } from "../compact/_deps/types-message.js";
import {
  getLifecycleHookRegistry,
  type LifecycleHookRegistry,
} from "./registry.js";
import type {
  HookResult,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
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
  readonly hooks: ReadonlyArray<H>;
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
  > = { hooks: getRegistryHooks("PreCompact") },
): Promise<PreCompactDispatchResult> {
  const hooks = opts.hooks;
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
  > = { hooks: getRegistryHooks("PostCompact") },
): Promise<PostCompactDispatchResult> {
  const hooks = opts.hooks;
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
  > = { hooks: getRegistryHooks("SessionStart") },
): Promise<HookResultMessage[]> {
  const hooks = opts.hooks;
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

function getRegistryHooks(
  event: "PreCompact",
): ReturnType<LifecycleHookRegistry["getPreCompact"]>;
function getRegistryHooks(
  event: "PostCompact",
): ReturnType<LifecycleHookRegistry["getPostCompact"]>;
function getRegistryHooks(
  event: "SessionStart",
): ReturnType<LifecycleHookRegistry["getSessionStart"]>;
function getRegistryHooks(
  event: "PreCompact" | "PostCompact" | "SessionStart",
): ReadonlyArray<unknown> {
  const r = getLifecycleHookRegistry();
  switch (event) {
    case "PreCompact":
      return r.getPreCompact();
    case "PostCompact":
      return r.getPostCompact();
    case "SessionStart":
      return r.getSessionStart();
  }
}
