/**
 * Hook system types — Phase H narrowed vocabulary.
 *
 * Covers the events this runtime actually fires, plus the ones it has
 * a clear wiring plan for. Phase H (16-phase refactor, TODO.MD)
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
  /** Absolute path to the session transcript for hook stdin payloads. */
  readonly transcriptPath?: string;
  /** Current working directory reported to hook subprocesses. */
  readonly cwd?: string;
  /** Optional permission mode surfaced to matcher-aware hooks. */
  readonly permissionMode?: string;
}

interface HookFailureContext {
  readonly name?: string;
  readonly message: string;
  readonly stopReason?: string;
  readonly stopReasonDetail?: string;
  readonly failureClass?: string;
  readonly providerName?: string;
  readonly statusCode?: number;
  readonly timeoutMs?: number;
}

interface PreToolUseContext extends HookContextBase {
  readonly event: "PreToolUse";
  readonly toolCall: LLMToolCall;
  /** Pre-parsed tool args surfaced to hook stdin as `tool_input`. */
  readonly parsedInput?: Record<string, unknown>;
}

interface PostToolUseContext extends HookContextBase {
  readonly event: "PostToolUse";
  readonly toolCall: LLMToolCall;
  readonly result: string;
  readonly isError?: boolean;
  readonly parsedInput?: Record<string, unknown>;
}

interface PostToolUseFailureContext extends HookContextBase {
  readonly event: "PostToolUseFailure";
  readonly toolCall: LLMToolCall;
  readonly errorMessage: string;
  readonly parsedInput?: Record<string, unknown>;
  readonly isInterrupt?: boolean;
}

interface SessionLifecycleContext extends HookContextBase {
  readonly event: "SessionStart" | "Stop" | "StopFailure";
  readonly messages: readonly LLMMessage[];
  readonly finalContent?: string;
  readonly stopReason?: string;
  readonly stopReasonDetail?: string;
  readonly failure?: HookFailureContext;
}

interface CompactContext extends HookContextBase {
  readonly event: "PreCompact" | "PostCompact";
  readonly layer:
    | "snip"
    | "microcompact"
    | "context-collapse"
    | "autocompact"
    | "reactive-compact";
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
