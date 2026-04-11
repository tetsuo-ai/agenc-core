/**
 * Hook system types — Phase H narrowed vocabulary.
 *
 * Mirrors a subset of `/home/tetsuo/git/claude_code/utils/hooks.ts`:
 * the events this runtime actually fires, plus the ones it has a
 * clear wiring plan for. Phase H (16-phase refactor, TODO.MD)
 * deleted 8 event types that were declared but never dispatched:
 * `UserPromptSubmit`, `Notification`, `FileChanged`, `ConfigChange`,
 * `PermissionRequest`, `PermissionDenied`, `SubagentStart`,
 * `SubagentStop`. AgenC has no watcher that would fire the
 * filesystem/config events; the approval engine already owns
 * permission escalation; subagent lifecycle goes through WebSocket
 * `WS_SUBAGENTS_*` events instead; and user prompt submission is
 * a channel-plugin concern, not a hook-dispatcher concern.
 *
 * The 8 remaining events are:
 *   - `PreToolUse` / `PostToolUse` / `PostToolUseFailure` — LIVE.
 *     Fired from the tool dispatch loop around every tool call.
 *   - `SessionStart` — fired from `daemon.ts` when a new session is
 *     created (Phase H wire-up pending — declared for now).
 *   - `Stop` / `StopFailure` — fired from the generator Terminal
 *     path in `execute-chat.ts` (Phase H wire-up pending).
 *   - `PreCompact` / `PostCompact` — fired from the layered
 *     compaction chain in `chat-executor-tool-loop.ts` (Phase H
 *     wire-up pending).
 *
 * @module
 */

import type { LLMMessage, LLMToolCall } from "../types.js";

export type HookEvent =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "PostCompact";

export type HookKind = "command" | "callback" | "function" | "http";

export interface HookDefinition {
  readonly event: HookEvent;
  readonly kind: HookKind;
  /** Glob / regex / pipe-separated alternatives the matcher resolves. */
  readonly matcher?: string;
  /** Shell command or HTTP URL or callback id. */
  readonly target: string;
  /** Per-hook timeout. */
  readonly timeoutMs?: number;
}

interface HookContextBase {
  readonly event: HookEvent;
  readonly sessionId: string;
  readonly chainId?: string;
  readonly depth?: number;
}

interface PreToolUseContext extends HookContextBase {
  readonly event: "PreToolUse";
  readonly toolCall: LLMToolCall;
}

interface PostToolUseContext extends HookContextBase {
  readonly event: "PostToolUse";
  readonly toolCall: LLMToolCall;
  readonly result: string;
  readonly isError?: boolean;
}

interface PostToolUseFailureContext extends HookContextBase {
  readonly event: "PostToolUseFailure";
  readonly toolCall: LLMToolCall;
  readonly errorMessage: string;
}

interface SessionLifecycleContext extends HookContextBase {
  readonly event: "SessionStart" | "Stop" | "StopFailure";
  readonly messages: readonly LLMMessage[];
}

interface CompactContext extends HookContextBase {
  readonly event: "PreCompact" | "PostCompact";
  readonly layer: "snip" | "microcompact" | "autocompact" | "reactive-compact";
}

export type HookContext =
  | PreToolUseContext
  | PostToolUseContext
  | PostToolUseFailureContext
  | SessionLifecycleContext
  | CompactContext;

export interface HookOutcome {
  readonly action: "allow" | "deny" | "noop";
  readonly message?: string;
  /** Optional input override (e.g. PreToolUse rewriting tool args). */
  readonly updatedInput?: Record<string, unknown>;
  /** Async hook elapsed time for diagnostics. */
  readonly durationMs?: number;
}
