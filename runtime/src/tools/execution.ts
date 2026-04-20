/**
 * Tool execution — the central gate between the model's tool_use
 * blocks and the actual `Tool.execute()` call.
 *
 * Subset port of openclaude `services/tools/toolExecution.ts` (1,777 LOC)
 * distilled into the AgenC model (Tool interface in `tools/types.ts`,
 * no Zod — JSON Schema validation is lightweight).
 *
 * Invariants enforced here:
 *   I-8  (every error site emits a typed event) — errors funnel
 *        through the caller's event log via `eventLog` option.
 *   I-9  (per-tool execution timeout) — `Promise.race([tool, timer])`.
 *        Default `DEFAULT_TOOL_TIMEOUT_MS=30000`; per-tool override
 *        via `tool.timeoutMs`; per-call override via `args.timeoutMs`.
 *   I-15 (tool result size cap) — result bytes truncated to
 *        `MAX_TOOL_RESULT_BYTES=400_000`; warning marker appended.
 *   I-21 (approval modal abort race) — modal promise wrapped with
 *        `Promise.race([modal, abortSignal])`; signal → `{behavior:'abort'}`.
 *   I-44 (stale modal decision rejected) — modal decisions carry
 *        `decisionAtTurnId`; execution rejects mismatches.
 *   I-79 (large-int JSON reviver) — pre-parse regex wraps >=16-digit
 *        literals as strings, then a reviver converts them to BigInt
 *        for tools whose schema declares `bigint` fields.
 *
 * @module
 */

import {
  type EventLog,
  emitError as emitErrorEvent,
  emitWarning as emitWarningEvent,
} from "../session/event-log.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import type {
  ToolInvocation,
  ToolName,
  ToolOutput,
  ToolPayload,
} from "./context.js";
import { functionToolOutput, toolNameDisplay } from "./context.js";
import type { Tool } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * I-15: default cap on tool result size in bytes. 400 KB matches
 * openclaude `MAX_TOOL_RESULT_TOKENS=100_000 × BYTES_PER_TOKEN=4`.
 * Per-tool override via `tool.maxResultBytes`.
 */
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 400_000;

/** Appended marker when a result is truncated. */
const TRUNCATION_MARKER_TEMPLATE =
  "\n\n[truncated: original was {ORIG} bytes, returning first {KEPT}]\n";

// ─────────────────────────────────────────────────────────────────────
// Per-tool metadata hooks (extending the base Tool shape)
// ─────────────────────────────────────────────────────────────────────

export interface ToolExecutionOverrides {
  /** I-9 per-tool timeout override. */
  readonly timeoutMs?: number;
  /** I-15 per-tool size cap override. */
  readonly maxResultBytes?: number;
}

// ─────────────────────────────────────────────────────────────────────
// I-79: large-int JSON reviver
// ─────────────────────────────────────────────────────────────────────

/**
 * Pre-parse regex for numeric literals that exceed JavaScript's
 * safe integer range. Matches any JSON number of 16+ digits (with
 * optional leading `-`), captures the surrounding key + value, and
 * rewrites the literal as a quoted string so `JSON.parse` returns
 * a `string` instead of a corrupted `number`.
 *
 * Applied BEFORE parsing; the custom reviver then converts the
 * string back to `bigint` for schema fields tagged as bigint.
 */
const LARGE_INT_LITERAL_RE = /(:|,|\[|\{|\s)\s*(-?\d{16,})(\s*)(?=,|\}|\])/g;

function wrapLargeInts(raw: string): string {
  return raw.replace(
    LARGE_INT_LITERAL_RE,
    (_m, pre: string, digits: string, post: string) =>
      `${pre}"__bigint__${digits}"${post}`,
  );
}

const BIGINT_PREFIX = "__bigint__";

/**
 * Reviver that turns `"__bigint__<digits>"` markers into `bigint`
 * values. Tools whose schema opts into bigint fields consume those
 * values directly; everything else gets the string.
 */
function bigIntReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith(BIGINT_PREFIX)) {
    const digits = value.slice(BIGINT_PREFIX.length);
    try {
      return BigInt(digits);
    } catch {
      return digits;
    }
  }
  return value;
}

/**
 * I-79: parse a JSON tool-args blob with large-integer tolerance.
 * Returns the parsed object (record of string → unknown) or `null`
 * when parsing fails — callers surface a typed error.
 */
export function parseToolArgsWithBigInt(
  raw: string,
): Record<string, unknown> | null {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  try {
    const wrapped = wrapLargeInts(trimmed);
    const parsed = JSON.parse(wrapped, bigIntReviver);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// I-15: result size cap
// ─────────────────────────────────────────────────────────────────────

export function capToolResult(
  content: string,
  maxBytes: number,
): { readonly capped: string; readonly truncated: boolean; readonly originalBytes: number } {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= maxBytes) {
    return { capped: content, truncated: false, originalBytes };
  }
  const marker = TRUNCATION_MARKER_TEMPLATE
    .replace("{ORIG}", String(originalBytes))
    .replace("{KEPT}", String(maxBytes));
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const keepBytes = Math.max(0, maxBytes - markerBytes);
  // Truncate on character boundary using Buffer.slice for safety.
  const buf = Buffer.from(content, "utf8");
  const kept = buf.subarray(0, keepBytes).toString("utf8");
  return { capped: `${kept}${marker}`, truncated: true, originalBytes };
}

// ─────────────────────────────────────────────────────────────────────
// I-9: per-tool timeout wrapper
// ─────────────────────────────────────────────────────────────────────

export class ToolTimeoutError extends Error {
  readonly reason = "timeout" as const;
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`tool ${toolName} exceeded ${timeoutMs}ms timeout`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Resolve the effective timeout for a tool call. Order:
 *   1. per-call override via `args.timeoutMs` (must be positive int)
 *   2. per-tool override via `tool.timeoutMs`
 *   3. default `DEFAULT_TOOL_TIMEOUT_MS`
 */
export function resolveTimeoutMs(
  tool: Tool & Partial<ToolExecutionOverrides>,
  args: Record<string, unknown>,
): number {
  const perCall = args["timeoutMs"];
  if (typeof perCall === "number" && Number.isFinite(perCall) && perCall > 0) {
    return Math.floor(perCall);
  }
  if (
    typeof tool.timeoutMs === "number" &&
    Number.isFinite(tool.timeoutMs) &&
    tool.timeoutMs > 0
  ) {
    return Math.floor(tool.timeoutMs);
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Run `fn` under a timeout race + abort-signal bail. Returns the
 * value on success; throws `ToolTimeoutError` on timeout or the
 * abort reason on signal. Sets up a cleanup path that clears the
 * timer + removes the abort listener when the inner promise settles
 * first.
 */
export async function withTimeoutAndAbort<T>(
  fn: () => Promise<T>,
  opts: {
    readonly timeoutMs: number;
    readonly toolName: string;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (opts.signal && onAbort) {
      opts.signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
  };

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(new ToolTimeoutError(opts.toolName, opts.timeoutMs));
    }, opts.timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        cleanup();
        reject(new Error(String(opts.signal.reason ?? "aborted")));
        return;
      }
      onAbort = () => {
        cleanup();
        reject(new Error(String(opts.signal?.reason ?? "aborted")));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    fn().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// I-21 + I-44: approval modal integration
// ─────────────────────────────────────────────────────────────────────

/**
 * I-44: modal decisions carry the turn id they were issued against.
 * The execution layer rejects decisions whose turn id doesn't match
 * the current turn.
 */
export interface ModalDecision {
  readonly behavior: "allow" | "deny" | "abort";
  readonly decisionAtTurnId: string;
  readonly message?: string;
}

export interface ApprovalRequestFn {
  (opts: {
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
    readonly currentTurnId: string;
    readonly signal: AbortSignal;
  }): Promise<ModalDecision>;
}

/**
 * I-21 + I-44: resolve an approval request against the session's
 * abort signal and the current turn id. Returns `{allow:true}` when
 * the modal decision is accepted; `{allow:false, cause}` otherwise
 * (with a classified cause the caller can surface to the model).
 */
export async function requestApprovalWithAbortRace(
  request: ApprovalRequestFn,
  opts: {
    readonly tool: Tool;
    readonly args: Record<string, unknown>;
    readonly currentTurnId: string;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly allow: true } | { readonly allow: false; readonly cause: string }> {
  // I-21 fast-path: already aborted.
  if (opts.signal.aborted) {
    return { allow: false, cause: "aborted_before_approval" };
  }

  // Race the modal against the abort signal — signal wins even if the
  // modal would eventually resolve with 'allow'.
  const decision = await new Promise<ModalDecision>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve({
        behavior: "abort",
        decisionAtTurnId: opts.currentTurnId,
      });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    request(opts).then(
      (d) => {
        if (settled) return;
        settled = true;
        opts.signal.removeEventListener("abort", onAbort);
        resolve(d);
      },
      () => {
        if (settled) return;
        settled = true;
        opts.signal.removeEventListener("abort", onAbort);
        // A throwing modal is treated as abort for safety.
        resolve({
          behavior: "abort",
          decisionAtTurnId: opts.currentTurnId,
        });
      },
    );
  });

  // I-44: turn-id stamp must match the current turn.
  if (decision.decisionAtTurnId !== opts.currentTurnId) {
    return { allow: false, cause: "stale_modal_decision" };
  }
  if (decision.behavior === "allow") return { allow: true };
  if (decision.behavior === "deny") return { allow: false, cause: "denied" };
  return { allow: false, cause: "aborted" };
}

// ─────────────────────────────────────────────────────────────────────
// Error classification — port of openclaude `classifyToolError`.
// ─────────────────────────────────────────────────────────────────────

export type ToolErrorClass =
  | "timeout"
  | "aborted"
  | "permission_denied"
  | "invalid_args"
  | "not_found"
  | "stale_modal_decision"
  | "tool_threw"
  | "unknown";

export function classifyToolError(err: unknown): ToolErrorClass {
  if (err instanceof ToolTimeoutError) return "timeout";
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("aborted")) return "aborted";
    if (msg.includes("permission") || msg.includes("eacces")) {
      return "permission_denied";
    }
    if (msg.includes("invalid_args") || msg.includes("validation")) {
      return "invalid_args";
    }
    if (msg.includes("enoent") || msg.includes("not found")) {
      return "not_found";
    }
    return "tool_threw";
  }
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────
// runToolUse — the single entry point
// ─────────────────────────────────────────────────────────────────────

export interface RunToolUseOptions {
  /** Session-scoped AbortSignal — phase-5 passes `session.abortController.signal`. */
  readonly signal?: AbortSignal;
  /** Current turn id for I-44 modal-decision stamping. */
  readonly currentTurnId: string;
  /** Optional approval-request function (T11 wires real TUI modal). */
  readonly requestApproval?: ApprovalRequestFn;
  /** Optional EventLog for I-8 typed error emissions. */
  readonly eventLog?: EventLog;
  /** SubId used on emitted events (defaults to callId). */
  readonly subId?: string;
  /** Tool definition (registry.byName lookup is done by the caller). */
  readonly tool: Tool & Partial<ToolExecutionOverrides>;
  /** Invocation envelope — phase-5 builds from the LLMToolCall. */
  readonly invocation: ToolInvocation;
}

/**
 * Execute one tool invocation end-to-end.
 *
 *   1. Parse args with the large-int reviver (I-79).
 *   2. Check for required approval; race against abort (I-21) +
 *      reject stale decisions (I-44).
 *   3. Resolve effective timeout (I-9) + run under race.
 *   4. Cap result size (I-15).
 *   5. Return a `ToolOutput`.
 *
 * Errors surface as an `isError:true` ToolOutput AND emit a typed
 * event via `eventLog` (I-8).
 */
export async function runToolUse(
  rawArgs: string,
  opts: RunToolUseOptions,
): Promise<ToolOutput> {
  const { tool, invocation, signal, currentTurnId } = opts;
  const subId = opts.subId ?? invocation.callId;
  const startedAt = performance.now();

  // Step 1: I-79 arg parse.
  const parsedArgs = parseToolArgsWithBigInt(rawArgs);
  if (parsedArgs === null) {
    const message = `invalid JSON arguments for tool ${toolNameDisplay(invocation.toolName)}`;
    if (opts.eventLog) {
      emitErrorEvent(opts.eventLog, subId, {
        cause: "invalid_args",
        message,
      });
    }
    return errorOutput({
      invocation,
      content: message,
      elapsedMs: performance.now() - startedAt,
    });
  }

  // Step 2: I-21 + I-44 approval.
  if (opts.requestApproval) {
    const effectiveSignal = signal ?? new AbortController().signal;
    const decision = await requestApprovalWithAbortRace(opts.requestApproval, {
      tool,
      args: parsedArgs,
      currentTurnId,
      signal: effectiveSignal,
    });
    if (!decision.allow) {
      const cause = decision.cause;
      const message = `approval ${cause} for tool ${toolNameDisplay(invocation.toolName)}`;
      if (opts.eventLog) {
        if (cause === "stale_modal_decision") {
          emitWarningEvent(opts.eventLog, subId, cause, message);
        } else {
          emitErrorEvent(opts.eventLog, subId, { cause, message });
        }
      }
      return errorOutput({
        invocation,
        content: message,
        elapsedMs: performance.now() - startedAt,
      });
    }
  }

  // Step 3: I-9 timeout + abort race.
  const timeoutMs = resolveTimeoutMs(tool, parsedArgs);
  let dispatch: ToolDispatchResult;
  try {
    dispatch = await withTimeoutAndAbort(
      async () => {
        const result = await tool.execute(parsedArgs);
        return {
          content: result.content,
          isError: result.isError,
        } satisfies ToolDispatchResult;
      },
      {
        timeoutMs,
        toolName: tool.name,
        ...(signal !== undefined ? { signal } : {}),
      },
    );
  } catch (err) {
    const cls = classifyToolError(err);
    const message = err instanceof Error ? err.message : String(err);
    if (opts.eventLog) {
      if (cls === "timeout" || cls === "aborted") {
        emitErrorEvent(opts.eventLog, subId, {
          cause: cls === "timeout" ? "tool_timeout" : "aborted",
          message,
          streamError: cls === "timeout",
        });
      } else {
        emitErrorEvent(opts.eventLog, subId, {
          cause: `tool_threw:${cls}`,
          message,
        });
      }
    }
    return errorOutput({
      invocation,
      content: `<tool_use_error>${message}</tool_use_error>`,
      elapsedMs: performance.now() - startedAt,
    });
  }

  // Step 4: I-15 result-size cap.
  const maxResultBytes =
    tool.maxResultBytes !== undefined && tool.maxResultBytes > 0
      ? tool.maxResultBytes
      : DEFAULT_MAX_TOOL_RESULT_BYTES;
  const capped = capToolResult(dispatch.content, maxResultBytes);
  if (capped.truncated && opts.eventLog) {
    emitWarningEvent(
      opts.eventLog,
      subId,
      "tool_result_truncated",
      `tool ${toolNameDisplay(invocation.toolName)} output ${capped.originalBytes}B truncated to ${maxResultBytes}B (I-15)`,
    );
  }

  return functionToolOutput({
    callId: invocation.callId,
    toolName: invocation.toolName,
    payload: invocation.payload,
    content: capped.capped,
    isError: dispatch.isError === true,
    durationMs: performance.now() - startedAt,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function errorOutput(opts: {
  readonly invocation: ToolInvocation;
  readonly content: string;
  readonly elapsedMs: number;
}): ToolOutput {
  return functionToolOutput({
    callId: opts.invocation.callId,
    toolName: opts.invocation.toolName,
    payload: opts.invocation.payload,
    content: opts.content,
    isError: true,
    durationMs: opts.elapsedMs,
  });
}

export { toolNameDisplay };
export type { ToolName, ToolOutput, ToolPayload };
