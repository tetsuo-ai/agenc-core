/**
 * Tool dispatch context types.
 *
 * Hand-port of AgenC runtime `core/src/tools/context.rs` (584 LOC). The AgenC runtime
 * trait `ToolOutput` has multiple concrete impls (`CallToolResult`,
 * `McpToolOutput`, `FunctionToolOutput`, `ToolSearchOutput`,
 * `AbortedToolOutput`, `ExecCommandToolOutput`) each with a distinct
 * payload shape. AgenC collapses `CallToolResult`/`McpToolOutput` into
 * one `mcp` variant and keeps the rest 1:1 so downstream consumers
 * (TUI rendering, rollout replay, MCP annotation pass-through,
 * code_mode projection) can switch on `kind` without re-parsing
 * strings.
 *
 * The public `ToolOutput` interface stays backwards compatible: the
 * old flat envelope now represents the `function` variant. Call sites
 * that read `.content` keep working; new code calls `toText()` or
 * switches on `.variant.kind`.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";

// ─────────────────────────────────────────────────────────────────────
// ToolCallSource — which layer injected the call
// ─────────────────────────────────────────────────────────────────────

/** Port of AgenC runtime `ToolCallSource` (context.rs:32-37). */
export type ToolCallSource = "direct" | "js_repl" | "code_mode";

// ─────────────────────────────────────────────────────────────────────
// ToolPayload — per-call shape varies by tool kind
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of AgenC runtime `ToolPayload` (context.rs:50-68). The variants stay
 * explicit so direct calls, JS REPL calls, MCP calls, and code-mode
 * projections can preserve their upstream payload-specific behavior.
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
// ToolName — namespaced name (port of AgenC runtime `ToolName`)
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
 * Port of AgenC runtime `ToolInvocation` (context.rs:39-47). Bundles session +
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
 * Port of AgenC runtime `SharedTurnDiffTracker` (context.rs:30). Tracks file
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
// Telemetry preview — port of AgenC runtime `telemetry_preview`
// (context.rs:542-580). Byte-boundary + line-limit truncation with a
// trailing notice marker. Constants mirror `tools/mod.rs:24-27`.
// ─────────────────────────────────────────────────────────────────────

export const TELEMETRY_PREVIEW_MAX_BYTES = 2 * 1024; // 2 KiB
export const TELEMETRY_PREVIEW_MAX_LINES = 64;
export const TELEMETRY_PREVIEW_TRUNCATION_NOTICE =
  "[... telemetry preview truncated ...]";

/**
 * Take up to `maxBytes` bytes from `s` respecting UTF-8 character
 * boundaries (AgenC runtime `take_bytes_at_char_boundary`). Returns the
 * original string when it already fits.
 */
function takeBytesAtCharBoundary(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Walk back to the nearest char boundary: continuation bytes start
  // with 10xxxxxx (0x80..0xBF).
  let end = maxBytes;
  while (end > 0 && (buf[end] ?? 0) >= 0x80 && (buf[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Port of AgenC runtime `telemetry_preview` (context.rs:542-580). Truncates
 * `content` by byte and line caps and appends the truncation notice
 * only when truncation occurred. Byte boundary is UTF-8 safe.
 */
export function telemetryPreview(content: string): string {
  return telemetryPreviewWith(
    content,
    TELEMETRY_PREVIEW_MAX_BYTES,
    TELEMETRY_PREVIEW_MAX_LINES,
  );
}

/** Test-visible parameterized variant. */
export function telemetryPreviewWith(
  content: string,
  byteLimit: number,
  lineLimit: number,
): string {
  const truncatedSlice = takeBytesAtCharBoundary(content, byteLimit);
  const truncatedByBytes = Buffer.byteLength(truncatedSlice, "utf8") <
    Buffer.byteLength(content, "utf8");

  const lines = truncatedSlice.split("\n");
  let preview = "";
  let emittedLines = 0;
  let truncatedByLines = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (idx >= lineLimit) {
      truncatedByLines = true;
      break;
    }
    if (idx > 0) preview += "\n";
    preview += lines[idx] ?? "";
    emittedLines = idx + 1;
  }
  // Account for a trailing empty last-element from `split("\n")` when
  // the truncated slice itself ends with `\n` (matches Rust `lines()`
  // which does not yield that phantom entry).
  if (
    !truncatedByLines &&
    lines[lines.length - 1] === "" &&
    truncatedSlice.endsWith("\n") &&
    emittedLines === lines.length
  ) {
    // Nothing to do — Rust behaviour is the same.
  }

  if (!truncatedByBytes && !truncatedByLines) {
    return content;
  }

  // Preserve the immediate trailing newline when the truncated slice
  // had one at the cut point (AgenC runtime lines 565-571).
  if (
    preview.length < truncatedSlice.length &&
    truncatedSlice[preview.length] === "\n"
  ) {
    preview += "\n";
  }
  if (preview.length > 0 && !preview.endsWith("\n")) {
    preview += "\n";
  }
  preview += TELEMETRY_PREVIEW_TRUNCATION_NOTICE;
  return preview;
}

// ─────────────────────────────────────────────────────────────────────
// Image detail sanitizer — port of AgenC runtime
// `sanitize_original_image_detail` (tools/src/image_detail.rs). When
// the model does not support `detail: "original"`, rewrite it to the
// default ("auto"). Returns a fresh copy; input is not mutated.
// ─────────────────────────────────────────────────────────────────────

/** Default image detail when the model cannot request `"original"`. */
export const DEFAULT_IMAGE_DETAIL = "auto" as const;

/**
 * MCP content item shape as consumed/produced by AgenC. The annotation
 * field from the MCP spec is preserved; `original_image_detail` (an
 * xAI-specific nested field) is stripped when unsupported.
 */
export type MCPContentItem =
  | {
      readonly type: "text";
      readonly text: string;
      readonly annotations?: Record<string, unknown>;
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
      readonly annotations?: Record<string, unknown>;
      readonly _meta?: Record<string, unknown>;
      readonly original_image_detail?: "auto" | "low" | "high" | "original";
    }
  | {
      readonly type: "audio";
      readonly data: string;
      readonly mimeType: string;
      readonly annotations?: Record<string, unknown>;
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly type: "resource_link";
      readonly uri: string;
      readonly name: string;
      readonly mimeType?: string;
      readonly description?: string;
      readonly annotations?: Record<string, unknown>;
      readonly _meta?: Record<string, unknown>;
    }
  | {
      readonly type: "resource";
      readonly resource: Readonly<Record<string, unknown>>;
      readonly annotations?: Record<string, unknown>;
      readonly _meta?: Record<string, unknown>;
    };

/**
 * Port of AgenC runtime `sanitize_original_image_detail` (tools/image_detail.rs:23-38).
 * When the model does not support `detail: "original"`, rewrite every
 * nested `original_image_detail` on image items to the default
 * (`"auto"`). Non-mutating: the returned array is a fresh copy.
 */
export function sanitizeOriginalImageDetail(
  canRequestOriginal: boolean,
  items: ReadonlyArray<MCPContentItem>,
): ReadonlyArray<MCPContentItem> {
  if (canRequestOriginal) return items.map((item) => ({ ...item }));
  return items.map((item) => {
    if (item.type !== "image") return { ...item };
    const { original_image_detail, ...rest } = item;
    if (original_image_detail === "original") {
      return {
        ...rest,
        original_image_detail: DEFAULT_IMAGE_DETAIL,
      };
    }
    if (original_image_detail !== undefined) {
      return {
        ...rest,
        original_image_detail,
      };
    }
    return { ...rest };
  });
}

// ─────────────────────────────────────────────────────────────────────
// MCP structured output — subset of `CallToolResult` from the MCP SDK
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal subset of `CallToolResult` that the runtime needs to
 * preserve for TUI rendering + rollout replay. Matches the MCP SDK
 * shape (`@modelcontextprotocol/sdk` types v1.27) but stays narrow so
 * we don't pull Zod types into the public runtime surface.
 */
export interface MCPStructuredContent {
  readonly content: ReadonlyArray<MCPContentItem>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// ToolOutputVariant — discriminated union mirroring the 7 AgenC runtime impls
// ─────────────────────────────────────────────────────────────────────

/** Common fields carried by every variant. */
interface ToolOutputVariantCommon {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated union — AgenC runtime `context.rs:82-96` trait `ToolOutput`
 * plus its concrete impls:
 *
 *   - `function`      — `FunctionToolOutput` (context.rs:226-275)
 *   - `mcp`           — `CallToolResult` / `McpToolOutput`
 *                       (context.rs:98-183). Preserves MCP content
 *                       array + structuredContent + wall_time.
 *   - `exec`          — `ExecCommandToolOutput` (context.rs:350-455).
 *                       Keeps `rawOutput: Buffer` + exitCode + wall
 *                       time + token-based truncation.
 *   - `tool_search`   — `ToolSearchOutput` (context.rs:185-224).
 *   - `aborted`       — `AbortedToolOutput` (context.rs:312-347).
 *                       Dispatches on the payload variant.
 */
export type ToolOutputVariant =
  | ({
      readonly kind: "function";
      /** Content items — when a single text item, this collapses to a
       *  plain-text body in `toResponseItem`. */
      readonly body: ReadonlyArray<FunctionCallOutputContentItem>;
      readonly success?: boolean;
      readonly postToolUseResponse?: unknown;
      readonly isError: boolean;
    } & ToolOutputVariantCommon)
  | ({
      readonly kind: "mcp";
      readonly structured: MCPStructuredContent;
      readonly wallTimeMs: number;
      readonly originalImageDetailSupported: boolean;
      readonly isError: boolean;
    } & ToolOutputVariantCommon)
  | ({
      readonly kind: "exec";
      readonly rawOutput: Buffer;
      readonly exitCode?: number;
      readonly wallTimeMs: number;
      readonly chunkId?: string;
      readonly processId?: number;
      readonly originalTokenCount?: number;
      readonly sessionCommand?: ReadonlyArray<string>;
      readonly maxOutputBytes?: number;
      readonly isError: boolean;
    } & ToolOutputVariantCommon)
  | ({
      readonly kind: "tool_search";
      readonly tools: ReadonlyArray<Readonly<Record<string, unknown>>>;
      readonly isError: boolean;
    } & ToolOutputVariantCommon)
  | ({
      readonly kind: "aborted";
      readonly reason: string;
      readonly abortedAtMs: number;
      readonly isError: boolean;
    } & ToolOutputVariantCommon);

/**
 * Function-call output content item — port of AgenC runtime
 * `FunctionCallOutputContentItem`. Matches the OpenAI responses input
 * shape. Image URLs carry an optional `detail` field.
 */
export type FunctionCallOutputContentItem =
  | { readonly type: "input_text"; readonly text: string }
  | {
      readonly type: "input_image";
      readonly image_url: string;
      readonly detail?: "auto" | "low" | "high" | "original";
    };

// ─────────────────────────────────────────────────────────────────────
// ToolOutput — the result envelope
// ─────────────────────────────────────────────────────────────────────

/**
 * Tool result envelope. The flat legacy shape (`content` + `isError`
 * + `durationMs`) is preserved for backwards compatibility — existing
 * call sites read `.content` and still work. New code should branch
 * on `.variant?.kind` or call `toText()` to flatten any variant into
 * a deterministic text body.
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
  /**
   * Discriminated-union payload preserving per-variant shape
   * (MCP annotations, exec raw bytes, etc.). Absent on legacy
   * constructions (treated as `function`).
   */
  readonly variant?: ToolOutputVariant;
}

// ─────────────────────────────────────────────────────────────────────
// Factories — one per variant
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of AgenC runtime `FunctionToolOutput::from_text` (context.rs:233-239).
 */
export function functionToolOutputFromText(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly text: string;
  readonly success?: boolean;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
  readonly postToolUseResponse?: unknown;
}): ToolOutput {
  const body: FunctionCallOutputContentItem[] = [
    { type: "input_text", text: opts.text },
  ];
  return buildFunctionToolOutput({ ...opts, body });
}

/**
 * Port of AgenC runtime `FunctionToolOutput::from_content` (context.rs:241-250).
 */
export function functionToolOutputFromContent(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly body: ReadonlyArray<FunctionCallOutputContentItem>;
  readonly success?: boolean;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
  readonly postToolUseResponse?: unknown;
}): ToolOutput {
  return buildFunctionToolOutput(opts);
}

function buildFunctionToolOutput(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly body: ReadonlyArray<FunctionCallOutputContentItem>;
  readonly success?: boolean;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
  readonly postToolUseResponse?: unknown;
}): ToolOutput {
  const text = contentItemsToText(opts.body);
  const variant: ToolOutputVariant = {
    kind: "function",
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    body: opts.body,
    ...(opts.success !== undefined ? { success: opts.success } : {}),
    ...(opts.postToolUseResponse !== undefined
      ? { postToolUseResponse: opts.postToolUseResponse }
      : {}),
    isError: opts.isError,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  return {
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    content: text,
    isError: opts.isError,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    ...(opts.postToolUseResponse !== undefined
      ? { postToolUseResponse: opts.postToolUseResponse }
      : {}),
    variant,
  };
}

/**
 * Port of AgenC runtime `McpToolOutput` (context.rs:123-183). Preserves the
 * full MCP structured content + wall time. `toText()` synthesizes the
 * "Wall time: N.NNNN seconds\nOutput:" header (`response_payload`).
 */
export function mcpToolOutput(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly structured: MCPStructuredContent;
  readonly wallTimeMs: number;
  readonly originalImageDetailSupported?: boolean;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}): ToolOutput {
  const isError = opts.structured.isError === true;
  const variant: ToolOutputVariant = {
    kind: "mcp",
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    structured: opts.structured,
    wallTimeMs: opts.wallTimeMs,
    originalImageDetailSupported: opts.originalImageDetailSupported ?? false,
    isError,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  return {
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    content: mcpResponseText(variant),
    isError,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    variant,
  };
}

/**
 * Port of AgenC runtime `ExecCommandToolOutput` (context.rs:349-455).
 * `rawOutput` is a Buffer to preserve byte-level fidelity. The cap is
 * applied by `execResponseText()` via `truncatedOutput()`.
 */
export function execToolOutput(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly rawOutput: Buffer;
  readonly exitCode?: number;
  readonly wallTimeMs: number;
  readonly chunkId?: string;
  readonly processId?: number;
  readonly originalTokenCount?: number;
  readonly sessionCommand?: ReadonlyArray<string>;
  readonly maxOutputBytes?: number;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}): ToolOutput {
  const variant: ToolOutputVariant = {
    kind: "exec",
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    rawOutput: opts.rawOutput,
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    wallTimeMs: opts.wallTimeMs,
    ...(opts.chunkId !== undefined ? { chunkId: opts.chunkId } : {}),
    ...(opts.processId !== undefined ? { processId: opts.processId } : {}),
    ...(opts.originalTokenCount !== undefined
      ? { originalTokenCount: opts.originalTokenCount }
      : {}),
    ...(opts.sessionCommand !== undefined
      ? { sessionCommand: opts.sessionCommand }
      : {}),
    ...(opts.maxOutputBytes !== undefined
      ? { maxOutputBytes: opts.maxOutputBytes }
      : {}),
    isError: false,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  return {
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    content: execResponseText(variant),
    isError: false,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    variant,
  };
}

/**
 * Port of AgenC runtime `ToolSearchOutput` (context.rs:186-224).
 */
export function toolSearchToolOutput(opts: {
  readonly callId: string;
  readonly toolName: ToolName;
  readonly payload: ToolPayload;
  readonly tools: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly durationMs: number;
  readonly metadata?: Record<string, unknown>;
}): ToolOutput {
  const variant: ToolOutputVariant = {
    kind: "tool_search",
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    tools: opts.tools,
    isError: false,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  return {
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    content: JSON.stringify(opts.tools),
    isError: false,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    variant,
  };
}

/**
 * Port of AgenC runtime `AbortedToolOutput` (context.rs:312-347). Preserves
 * the abort message; `toResponseItem` dispatches on the payload
 * variant so ToolSearch/MCP callers get shape-compatible outputs.
 */
export function abortedToolOutput(
  callId: string,
  toolName: ToolName,
  payload: ToolPayload,
  elapsedMs: number,
): ToolOutput {
  const content = abortMessage(toolName, elapsedMs);
  const variant: ToolOutputVariant = {
    kind: "aborted",
    callId,
    toolName,
    payload,
    reason: content,
    abortedAtMs: Date.now(),
    isError: true,
    durationMs: elapsedMs,
    metadata: { aborted: true },
  };
  return {
    callId,
    toolName,
    payload,
    content,
    isError: true,
    durationMs: elapsedMs,
    metadata: { aborted: true },
    variant,
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
    "exec_command",
    "system.bash",
  ]);
  if (shellTools.has(toolName.name) || shellTools.has(toolNameDisplay(toolName))) {
    return `Wall time: ${seconds} seconds\naborted by user`;
  }
  return `aborted by user after ${seconds}s`;
}

/**
 * Backwards-compatible factory for the common function-call output
 * shape. Kept as the default constructor for legacy call sites that
 * pass a plain `content` string — same as
 * `functionToolOutputFromText` with the legacy parameter shape.
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
  return functionToolOutputFromText({
    callId: opts.callId,
    toolName: opts.toolName,
    payload: opts.payload,
    text: opts.content,
    isError: opts.isError,
    durationMs: opts.durationMs,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — per-variant text + response-item projection
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of AgenC runtime `function_call_output_content_items_to_text`. Flattens
 * a content-item body to a plain text body by joining text parts.
 */
export function contentItemsToText(
  items: ReadonlyArray<FunctionCallOutputContentItem>,
): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === "input_text") parts.push(item.text);
    else if (item.type === "input_image") parts.push(item.image_url);
  }
  return parts.join("");
}

/**
 * Port of AgenC runtime `FunctionToolOutput::into_text` (context.rs:252-254).
 */
export function intoText(output: ToolOutput): string {
  return toText(output);
}

/**
 * Flatten any variant into plain text. Used everywhere a legacy
 * consumer needs a single string — matches the old `.content` field.
 */
export function toText(output: ToolOutput): string {
  const variant = output.variant;
  if (!variant) return output.content;
  switch (variant.kind) {
    case "function":
      return contentItemsToText(variant.body);
    case "mcp":
      return mcpResponseText(variant);
    case "exec":
      return execResponseText(variant);
    case "tool_search":
      return JSON.stringify(variant.tools);
    case "aborted":
      return variant.reason;
  }
}

/**
 * Port of AgenC runtime `ToolOutput::log_preview` dispatch (context.rs:83).
 */
export function logPreview(output: ToolOutput): string {
  return telemetryPreview(toText(output));
}

/**
 * Port of AgenC runtime `ToolOutput::success_for_logging` (context.rs:85).
 */
export function successForLogging(output: ToolOutput): boolean {
  const variant = output.variant;
  if (!variant) return !output.isError;
  switch (variant.kind) {
    case "function":
      return variant.success ?? !variant.isError;
    case "mcp":
      return !variant.isError;
    case "exec":
      return true;
    case "tool_search":
      return true;
    case "aborted":
      return false;
  }
}

/**
 * Port of AgenC runtime `McpToolOutput::response_payload` (context.rs:159-182).
 * Prepends the wall-time header and runs the image-detail sanitizer
 * on nested image items.
 */
function mcpResponseText(
  variant: Extract<ToolOutputVariant, { kind: "mcp" }>,
): string {
  const wallTimeSeconds = variant.wallTimeMs / 1000;
  const header = `Wall time: ${wallTimeSeconds.toFixed(4)} seconds\nOutput:`;
  const items = sanitizeOriginalImageDetail(
    variant.originalImageDetailSupported,
    variant.structured.content,
  );
  const body = items
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "image") return `[image:${item.mimeType}]`;
      if (item.type === "audio") return `[audio:${item.mimeType}]`;
      if (item.type === "resource_link") return `[resource:${item.uri}]`;
      if (item.type === "resource")
        return `[resource:${JSON.stringify(item.resource)}]`;
      return "";
    })
    .join("\n");
  if (body.length === 0) return header;
  return `${header}\n${body}`;
}

/**
 * Port of AgenC runtime `ExecCommandToolOutput::response_text` + `truncated_output`
 * (context.rs:422-454). Applies the 400KB cap (I-15) and composes the
 * chunk/exit/process sections.
 */
function execResponseText(
  variant: Extract<ToolOutputVariant, { kind: "exec" }>,
): string {
  const sections: string[] = [];
  if (variant.chunkId && variant.chunkId.length > 0) {
    sections.push(`Chunk ID: ${variant.chunkId}`);
  }
  const wallTimeSeconds = variant.wallTimeMs / 1000;
  sections.push(`Wall time: ${wallTimeSeconds.toFixed(4)} seconds`);
  if (variant.exitCode !== undefined) {
    sections.push(`Process exited with code ${variant.exitCode}`);
  }
  if (variant.processId !== undefined) {
    sections.push(`Process running with session ID ${variant.processId}`);
  }
  if (variant.originalTokenCount !== undefined) {
    sections.push(`Original token count: ${variant.originalTokenCount}`);
  }
  sections.push("Output:");
  sections.push(execTruncatedOutput(variant));
  return sections.join("\n");
}

/**
 * Port of AgenC runtime `ExecCommandToolOutput::truncated_output`
 * (context.rs:422-426). AgenC uses byte-based truncation via
 * `DEFAULT_MAX_EXEC_OUTPUT_BYTES` (I-15: 400KB) instead of AgenC runtime's
 * token-based policy — the cap is equivalent and avoids pulling a
 * tokenizer into the runtime.
 */
export const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 400_000;

function execTruncatedOutput(
  variant: Extract<ToolOutputVariant, { kind: "exec" }>,
): string {
  const cap = variant.maxOutputBytes ?? DEFAULT_MAX_EXEC_OUTPUT_BYTES;
  if (variant.rawOutput.length <= cap) {
    return variant.rawOutput.toString("utf8");
  }
  const marker = `\n\n[truncated: original was ${variant.rawOutput.length} bytes, returning first ${cap}]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const keepBytes = Math.max(0, cap - markerBytes);
  const kept = variant.rawOutput.subarray(0, keepBytes).toString("utf8");
  return `${kept}${marker}`;
}

/**
 * Port of AgenC runtime `ToolOutput::to_response_item` dispatch plus the
 * per-impl implementations (context.rs:87, 109-114, 144-149, 208-222,
 * 268-270, 296-305, 325-345). Emits an AgenC `LLMMessage`
 * (`role:"tool"`, `toolCallId`, `content`) — provider adapters map
 * that back into the wire-level function_call_output shape.
 */
export interface LLMToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: string;
  /**
   * Provider-neutral structured payload carried alongside the text
   * content. Adapters that support structured function_call_output
   * replay this (MCP annotations, tool_search tools array, etc.);
   * adapters that don't fall back to `content`.
   */
  readonly structured?: Readonly<Record<string, unknown>>;
}

export function toResponseItem(output: ToolOutput): LLMToolResultMessage {
  const variant = output.variant;
  const base = {
    role: "tool" as const,
    toolCallId: output.callId,
    toolName: toolNameDisplay(output.toolName),
  };
  if (!variant) {
    return { ...base, content: output.content };
  }
  switch (variant.kind) {
    case "function":
      return { ...base, content: contentItemsToText(variant.body) };
    case "mcp":
      return {
        ...base,
        content: mcpResponseText(variant),
        structured: {
          type: "mcp_tool_call_output",
          result: variant.structured,
        },
      };
    case "exec":
      return { ...base, content: execResponseText(variant) };
    case "tool_search": {
      const tools = variant.tools;
      return {
        ...base,
        content: JSON.stringify(tools),
        structured: {
          type: "tool_search_output",
          status: "completed",
          execution: "client",
          tools,
        },
      };
    }
    case "aborted":
      // Dispatch on payload variant — matches AgenC runtime `AbortedToolOutput::to_response_item`
      // (context.rs:325-345).
      if (variant.payload.kind === "tool_search") {
        return {
          ...base,
          content: "",
          structured: {
            type: "tool_search_output",
            status: "completed",
            execution: "client",
            tools: [],
          },
        };
      }
      if (variant.payload.kind === "mcp") {
        return {
          ...base,
          content: variant.reason,
          structured: {
            type: "mcp_tool_call_output",
            result: {
              content: [{ type: "text", text: variant.reason }],
              isError: true,
            } satisfies MCPStructuredContent,
          },
        };
      }
      return { ...base, content: variant.reason };
  }
}

// ─────────────────────────────────────────────────────────────────────
// code_mode projection — port of AgenC runtime code-mode result mapping
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of AgenC runtime `response_input_to_code_mode_result`
 * (context.rs:483-515) adapted to AgenC's provider-neutral
 * `LLMToolResultMessage` shape. This is used by code-mode host paths
 * that only have the response item, not the original `ToolOutput`.
 */
export function codeModeResult(output: ToolOutput): unknown {
  const variant = output.variant;
  if (!variant) return output.content;

  switch (variant.kind) {
    case "function":
      return contentItemsToCodeModeResult(variant.body);
    case "mcp":
      return mcpStructuredContentToCodeModeResult(variant.structured);
    case "exec":
      return execCodeModeResult(variant);
    case "tool_search":
      return cloneSerializable(variant.tools, "tool_search result");
    case "aborted":
      return abortedCodeModeResult(variant);
  }
}

/**
 * Port of AgenC runtime `response_input_to_code_mode_result` for the
 * `LLMToolResultMessage` form emitted by `toResponseItem`.
 */
export function responseInputToCodeModeResult(
  response: LLMToolResultMessage,
): unknown {
  const structured = response.structured;
  if (isRecord(structured)) {
    if (structured.type === "tool_search_output") {
      const tools = Array.isArray(structured.tools) ? structured.tools : [];
      return cloneSerializable(tools, "tool_search result");
    }
    if (structured.type === "mcp_tool_call_output") {
      return cloneSerializable(
        structured.result ?? { content: [], isError: true },
        "mcp result",
      );
    }
  }
  return response.content;
}

/**
 * Port of AgenC runtime `content_items_to_code_mode_result`
 * (context.rs:517-534). Code-mode receives the useful item payloads
 * joined by newlines, not the response/transcript wrapper text.
 */
export function contentItemsToCodeModeResult(
  items: ReadonlyArray<FunctionCallOutputContentItem>,
): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === "input_text") {
      if (item.text.trim().length > 0) parts.push(item.text);
    } else if (item.image_url.trim().length > 0) {
      parts.push(item.image_url);
    }
  }
  return parts.join("\n");
}

function mcpStructuredContentToCodeModeResult(
  structured: MCPStructuredContent,
): unknown {
  const result: Record<string, unknown> = {
    content: structured.content,
  };
  if (structured.structuredContent !== undefined) {
    result.structuredContent = structured.structuredContent;
  }
  if (structured.isError !== undefined) {
    result.isError = structured.isError;
  }
  if (structured._meta !== undefined) {
    result._meta = structured._meta;
  }
  return cloneSerializable(result, "mcp result");
}

function execCodeModeResult(
  variant: Extract<ToolOutputVariant, { kind: "exec" }>,
): unknown {
  const result: Record<string, unknown> = {
    wall_time_seconds: variant.wallTimeMs / 1000,
    output: execTruncatedOutput(variant),
  };
  if (variant.chunkId && variant.chunkId.length > 0) {
    result.chunk_id = variant.chunkId;
  }
  if (variant.exitCode !== undefined) {
    result.exit_code = variant.exitCode;
  }
  if (variant.processId !== undefined) {
    result.session_id = variant.processId;
  }
  if (variant.originalTokenCount !== undefined) {
    result.original_token_count = variant.originalTokenCount;
  }
  return result;
}

function abortedCodeModeResult(
  variant: Extract<ToolOutputVariant, { kind: "aborted" }>,
): unknown {
  if (variant.payload.kind === "tool_search") return [];
  if (variant.payload.kind === "mcp") {
    return mcpStructuredContentToCodeModeResult({
      content: [{ type: "text", text: variant.reason }],
      isError: true,
    });
  }
  return variant.reason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSerializable(value: unknown, label: string): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return JSON.parse(serialized) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `failed to serialize ${label}: ${message}`;
  }
}
