/**
 * Tool dispatch context types.
 *
 * AgenC's tool output layer keeps each tool result shape explicit.
 * MCP results, function outputs, tool-search results, aborted calls,
 * and exec output each carry distinct payload data. Downstream
 * consumers (TUI rendering, rollout replay, MCP annotation pass-through,
 * code_mode projection) can switch on `kind` without re-parsing strings.
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
import { isRecord } from "../utils/record.js";

// ─────────────────────────────────────────────────────────────────────
// ToolCallSource — which layer injected the call
// ─────────────────────────────────────────────────────────────────────

/** Which runtime layer injected a tool call. */
export type ToolCallSource = "direct" | "js_repl" | "code_mode";

// ─────────────────────────────────────────────────────────────────────
// ToolPayload — per-call shape varies by tool kind
// ─────────────────────────────────────────────────────────────────────

/**
 * Per-call payload shape. The variants stay explicit so direct calls,
 * JS REPL calls, MCP calls, and code-mode projections can preserve
 * payload-specific behavior.
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
// ToolName — namespaced tool identifier
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
 * Bundles session + turn + tracker + callId + tool name + payload so
 * downstream hooks receive a consistent shape.
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
 * Tracks file diffs emitted during a single turn so the final
 * `TurnDiff` event can be synthesized from the tool side. T7 ships
 * an empty tracker; T12 (TUI transcript) materializes the diffs.
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
// Log preview — byte-boundary + line-limit truncation with a
// trailing notice marker.
// ─────────────────────────────────────────────────────────────────────

export const LOG_PREVIEW_MAX_BYTES = 2 * 1024; // 2 KiB
export const LOG_PREVIEW_MAX_LINES = 64;
export const LOG_PREVIEW_TRUNCATION_NOTICE = "[... log preview truncated ...]";

/**
 * Take up to `maxBytes` bytes from `s` respecting UTF-8 character
 * boundaries. Returns the original string when it already fits.
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
 * Truncates `content` by byte and line caps and appends the
 * truncation notice only when truncation occurred. Byte boundary is
 * UTF-8 safe.
 */
export function boundedLogPreview(content: string): string {
  return boundedLogPreviewWith(
    content,
    LOG_PREVIEW_MAX_BYTES,
    LOG_PREVIEW_MAX_LINES,
  );
}

/** Test-visible parameterized variant. */
export function boundedLogPreviewWith(
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
  // had one at the cut point.
  if (
    preview.length < truncatedSlice.length &&
    truncatedSlice[preview.length] === "\n"
  ) {
    preview += "\n";
  }
  if (preview.length > 0 && !preview.endsWith("\n")) {
    preview += "\n";
  }
  preview += LOG_PREVIEW_TRUNCATION_NOTICE;
  return preview;
}

// ─────────────────────────────────────────────────────────────────────
// Image detail sanitizer. When the model does not support
// `detail: "original"`, rewrite it to the default ("auto"). Returns
// a fresh copy; input is not mutated.
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
// ToolOutputVariant — discriminated union for runtime tool outputs
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
 * Discriminated union for the runtime `ToolOutput` variants:
 *
 *   - `function`      — function-call output content items.
 *   - `mcp`           — MCP content array, structuredContent, and wall time.
 *   - `exec`          — raw Buffer output, exit code, wall time, and
 *                       byte-based truncation metadata.
 *   - `tool_search`   — tool-search result array.
 *   - `aborted`       — cancellation result keyed by the payload variant.
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
 * Function-call output content item. Matches the Responses API input
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
 * Tool result envelope. The flat compatibility shape (`content` + `isError`
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
   * (MCP annotations, exec raw bytes, etc.). Absent on compatibility
   * constructions (treated as `function`).
   */
  readonly variant?: ToolOutputVariant;
}

// ─────────────────────────────────────────────────────────────────────
// Factories — one per variant
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a function tool output from plain text.
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
 * Build a function tool output from content items.
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
 * Preserves the full MCP structured content and wall time. `toText()`
 * emits output first followed by a compact `[mcp wall_time=...]` footer
 * (see mcpResponseText for the rationale).
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
 * Exec command output. `rawOutput` is a Buffer to preserve byte-level
 * fidelity. The cap is applied by `execResponseText()` via
 * `truncatedOutput()`.
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
 * Tool-search output.
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
 * Aborted tool output. Preserves the abort message; `toResponseItem`
 * dispatches on the payload variant so ToolSearch/MCP callers get
 * shape-compatible outputs.
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
    // Output-first format matches execResponseText so the model sees
    // the abort signal as the primary content and the timing as a
    // trailing footer (avoids the leading-metadata retry pattern).
    return `aborted by user\n\n[exec wall_time=${seconds}s aborted=true]`;
  }
  return `aborted by user after ${seconds}s`;
}

/**
 * Backwards-compatible factory for the common function-call output
 * shape. Kept as the default constructor for compatibility call sites that
 * pass a plain `content` string — same as
 * `functionToolOutputFromText` with the compatibility parameter shape.
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
 * Flattens a content-item body to a plain text body by joining text parts.
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
 * Flatten any tool output into text.
 */
export function intoText(output: ToolOutput): string {
  return toText(output);
}

/**
 * Flatten any variant into plain text. Used everywhere a compatibility
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
 * Render a bounded local log preview.
 */
export function logPreview(output: ToolOutput): string {
  return boundedLogPreview(toText(output));
}

/**
 * Determine whether the output should count as successful in logs.
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
 * Composes the MCP tool-result text. Output leads, compact metadata
 * footer trails — same rationale as execResponseText (a leading
 * "Wall time: ... / Output:" header looks like an incomplete result to
 * the model and triggers retry loops).
 */
function mcpResponseText(
  variant: Extract<ToolOutputVariant, { kind: "mcp" }>,
): string {
  const wallTimeSeconds = variant.wallTimeMs / 1000;
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
  const footer = `[mcp wall_time=${wallTimeSeconds.toFixed(4)}s]`;
  if (body.length === 0) return footer;
  return `${body}\n\n${footer}`;
}

/**
 * Applies the 400KB cap (I-15) and composes the output + compact metadata
 * footer. Output leads, footer trails — see exec-result-format.ts for the
 * matching sibling formatter and the rationale (Grok interpreted a
 * leading multi-line metadata header as an incomplete tool result and
 * re-emitted the same exec_command three times in a row).
 */
function execResponseText(
  variant: Extract<ToolOutputVariant, { kind: "exec" }>,
): string {
  const sections: string[] = [];
  sections.push(execTruncatedOutput(variant));

  const footerLines: string[] = [];
  if (variant.exitCode !== undefined) {
    footerLines.push(`exit_code=${variant.exitCode}`);
  }
  const wallTimeSeconds = variant.wallTimeMs / 1000;
  footerLines.push(`wall_time=${wallTimeSeconds.toFixed(4)}s`);
  if (variant.originalTokenCount !== undefined) {
    footerLines.push(`tokens=${variant.originalTokenCount}`);
  }
  if (variant.processId !== undefined) {
    footerLines.push(`session_id=${variant.processId}`);
  }
  if (variant.chunkId && variant.chunkId.length > 0) {
    footerLines.push(`chunk_id=${variant.chunkId}`);
  }
  sections.push("");
  sections.push(`[exec ${footerLines.join(" ")}]`);
  return sections.join("\n");
}

/**
 * AgenC uses byte-based truncation via `DEFAULT_MAX_EXEC_OUTPUT_BYTES`
 * (I-15: 400KB). The cap avoids pulling a tokenizer into the runtime.
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
 * Emit AgenC's provider-neutral tool-result message (`role:"tool"`,
 * `toolCallId`, `content`). Provider adapters map that back into the
 * wire-level function_call_output shape.
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
      // Dispatch on payload variant so each tool family receives the
      // shape it expects.
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
// code_mode projection — AgenC code-mode result mapping
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a `ToolOutput` to the provider-neutral code-mode result
 * shape. This is used by code-mode host paths that only have the
 * response item, not the original `ToolOutput`.
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
 * Convert the `LLMToolResultMessage` form emitted by `toResponseItem`.
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
 * Code-mode receives the useful item payloads joined by newlines, not
 * the response/transcript wrapper text.
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
