/**
 * Tool dispatch context types.
 *
 * Hand-port of codex `core/src/tools/context.rs` (584 LOC).
 * Codex's `ToolPayload` discriminated union carries per-call shape
 * that the router dispatches on. `ToolOutput` is the trait every
 * tool result satisfies.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";

// ─────────────────────────────────────────────────────────────────────
// ToolCallSource — which layer injected the call
// ─────────────────────────────────────────────────────────────────────

/** Port of codex `ToolCallSource` (context.rs:32-37). */
export type ToolCallSource = "direct" | "js_repl" | "code_mode";

// ─────────────────────────────────────────────────────────────────────
// ToolPayload — per-call shape varies by tool kind
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of codex `ToolPayload` (context.rs:50-68). AgenC subset: we
 * don't ship JsRepl or CodeMode as of T7 — those live behind future
 * subsystems — but the variants are wired so the router can switch
 * on them when they land.
 */
export type ToolPayload =
  | { readonly kind: "function"; readonly arguments: string }
  | { readonly kind: "custom"; readonly input: string }
  | { readonly kind: "tool_search"; readonly arguments: { readonly query: string } }
  | {
      readonly kind: "local_shell";
      readonly params: {
        readonly command: ReadonlyArray<string>;
        readonly cwd?: string;
        readonly env?: Record<string, string>;
        readonly timeoutMs?: number;
      };
    }
  | {
      readonly kind: "mcp";
      readonly server: string;
      readonly tool: string;
      readonly rawArguments: string;
    };

export function logPayload(payload: ToolPayload): string {
  switch (payload.kind) {
    case "function":
      return payload.arguments;
    case "custom":
      return payload.input;
    case "tool_search":
      return payload.arguments.query;
    case "local_shell":
      return payload.params.command.join(" ");
    case "mcp":
      return payload.rawArguments;
  }
}

// ─────────────────────────────────────────────────────────────────────
// ToolName — namespaced name (port of codex `ToolName`)
// ─────────────────────────────────────────────────────────────────────

export interface ToolName {
  readonly namespace?: string;
  readonly name: string;
}

export function toolNameDisplay(name: ToolName): string {
  return name.namespace ? `${name.namespace}.${name.name}` : name.name;
}

export function parseToolName(full: string): ToolName {
  const dot = full.indexOf(".");
  if (dot < 0) return { name: full };
  return { namespace: full.slice(0, dot), name: full.slice(dot + 1) };
}

// ─────────────────────────────────────────────────────────────────────
// ToolInvocation — everything a dispatcher needs for one call
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of codex `ToolInvocation` (context.rs:39-47). Bundles session +
 * turn + tracker + callId + tool name + payload so downstream hooks
 * receive a consistent shape.
 */
export interface ToolInvocation {
  readonly session: Session;
  readonly turn: TurnContext;
  readonly tracker: SharedTurnDiffTracker;
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly source: ToolCallSource;
}

/**
 * Port of codex `SharedTurnDiffTracker` (context.rs:30). Tracks file
 * diffs emitted during a single turn so the final `TurnDiff` event
 * can be synthesized from the tool-side. T7 ships an empty tracker;
 * T12 (TUI transcript) materializes the diffs.
 */
export interface SharedTurnDiffTracker {
  appendFileDiff(path: string, before: string, after: string): void;
  snapshot(): ReadonlyArray<{
    readonly path: string;
    readonly before: string;
    readonly after: string;
  }>;
  clear(): void;
}

export function createTurnDiffTracker(): SharedTurnDiffTracker {
  const entries: Array<{ path: string; before: string; after: string }> = [];
  return {
    appendFileDiff(path, before, after) {
      entries.push({ path, before, after });
    },
    snapshot() {
      return [...entries];
    },
    clear() {
      entries.length = 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// ToolOutput — the result trait
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool result envelope. Wraps the per-invocation content string with
 * structured metadata so downstream consumers (phase-5 execute-tools,
 * post-tool hooks, TUI transcript) can render without re-parsing.
 *
 * `responseItem` is the shape codex emits for the rollout — in AgenC
 * terms that's `{role:'tool', toolCallId, content}`.
 */
export interface ToolOutput {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  /** Rendered result string sent back to the model. */
  readonly content: string;
  readonly isError: boolean;
  /** Wall-clock duration for telemetry. */
  readonly durationMs: number;
  /** Optional structured metadata: provenance, warnings, tokens. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optional post-tool response override emitted by the hook. */
  readonly postToolUseResponse?: unknown;
}

/**
 * Standard "aborted" output used by the ToolCallRuntime when
 * cancellation fires mid-execution (codex `AbortedToolOutput`).
 */
export function abortedToolOutput(
  callId: string,
  toolName: ToolName,
  payload: ToolPayload,
  elapsedMs: number,
): ToolOutput {
  return {
    callId,
    toolName,
    payload,
    content: abortMessage(toolName, elapsedMs),
    isError: true,
    durationMs: elapsedMs,
    metadata: { aborted: true },
  };
}

function abortMessage(toolName: ToolName, elapsedMs: number): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  const shellTools = new Set([
    "shell",
    "bash",
    "container.exec",
    "local_shell",
    "shell_command",
    "unified_exec",
    "system.bash",
  ]);
  if (shellTools.has(toolName.name) || shellTools.has(toolNameDisplay(toolName))) {
    return `Wall time: ${seconds} seconds\naborted by user`;
  }
  return `aborted by user after ${seconds}s`;
}

/**
 * Convenience factory for the common function-call output shape.
 */
export function functionToolOutput(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly content: string;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}): ToolOutput {
  return {
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    content: opts.content,
    isError: opts.isError,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}
