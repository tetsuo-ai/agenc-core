/**
 * Lifecycle hook event types for the gut runtime.
 *
 * Lean port of the upstream `PreCompact` / `PostCompact` / `SessionStart`
 * hook surfaces. Tool-use hooks live in
 * `runtime/src/tools/hooks.ts` and are unrelated — this module is for
 * runtime lifecycle dispatch (compaction boundaries, session start).
 *
 * Kept intentionally minimal: just enough to model dispatch + result
 * collection. No matcher DSL, no plugin loader, no settings-driven shell
 * exec — the gut runtime registers hooks programmatically.
 *
 * @module
 */
import type { HookResultMessage } from "../../types/message.js";

export type LifecycleHookEvent = "PreCompact" | "PostCompact" | "SessionStart";

export type CompactTrigger = "manual" | "auto";
export type SessionStartSource = "startup" | "resume" | "clear" | "compact";

/** Input passed to a `PreCompact` hook. Shape mirrors upstream
 *  `PreCompactHookInput` but trimmed to the fields the gut compact
 *  pipeline actually supplies. */
export interface PreCompactHookInput {
  readonly hook_event_name: "PreCompact";
  readonly trigger: CompactTrigger;
  readonly custom_instructions: string | null;
}

/** Input passed to a `PostCompact` hook. */
export interface PostCompactHookInput {
  readonly hook_event_name: "PostCompact";
  readonly trigger: CompactTrigger;
  readonly compact_summary: string;
}

/** Input passed to a `SessionStart` hook. */
export interface SessionStartHookInput {
  readonly hook_event_name: "SessionStart";
  readonly source: SessionStartSource;
  readonly session_id?: string;
  readonly transcript_path?: string | null;
  readonly cwd?: string;
  readonly agent_type?: string;
  readonly model?: string;
  readonly permission_mode?: string;
}

export type HookInput =
  | PreCompactHookInput
  | PostCompactHookInput
  | SessionStartHookInput;

/**
 * Result returned by a single hook invocation. Modeled after upstream
 * `AggregatedHookResult` but only carries the fields the gut compact /
 * session-start pipelines actually consume:
 *
 *  - `succeeded` / `output` — drive PreCompact/PostCompact display +
 *    custom-instruction merging.
 *  - `command` — surfaces in `[command] completed/failed` display lines.
 *  - `message` — SessionStart hooks may emit a synthesized message that
 *    is concatenated into the post-compact prefix.
 *  - `additionalContexts` — SessionStart hooks may emit extra context
 *    strings that the runtime wraps in a single attachment message.
 */
export interface HookResult {
  readonly succeeded: boolean;
  readonly output: string;
  readonly command?: string;
  readonly message?: HookResultMessage;
  readonly additionalContexts?: ReadonlyArray<string>;
}

/**
 * Hook callback signature. Hooks receive the typed input for their
 * registered event and may return undefined to signal "no result"
 * (the dispatcher drops undefined results before aggregation).
 */
export type LifecycleHook<I extends HookInput = HookInput> = (
  input: I,
  signal?: AbortSignal,
) => Promise<HookResult | undefined> | HookResult | undefined;

export type PreCompactHook = LifecycleHook<PreCompactHookInput>;
export type PostCompactHook = LifecycleHook<PostCompactHookInput>;
export type SessionStartHook = LifecycleHook<SessionStartHookInput>;
