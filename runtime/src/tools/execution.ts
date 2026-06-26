/**
 * Tool execution — the central gate between the model's tool_use
 * blocks and the actual `Tool.execute()` call.
 *
 * 1:1 port of donor TS `services/tools/toolExecution.ts` plus
 * `utils/toolErrors.ts:formatError`. AgenC's Tool shape carries a raw
 * JSON Schema (not Zod), so the validator is a richer JSON-schema
 * engine implemented here; the observable tool_result prose matches
 * AgenC's `formatZodValidationError` + `CANCEL_MESSAGE` /
 * `INTERRUPT_MESSAGE_FOR_TOOL_USE` / `createToolResultStopMessage`.
 *
 * Control flow (AgenC behavior):
 *   1. Parse args (I-79 large-int reviver).
 *   2. Run schema validation (+ `getSchemaValidationErrorOverride` +
 *      `buildSchemaNotSentHint`).
 *   3. Run PreToolUse hooks BEFORE the permission gate (AgenC
 *      `toolExecution.ts:832-894`). Hooks can rewrite args, synthesize
 *      a `hookPermissionResult`, inject `additionalContext`, deny,
 *      skip with a synthesized result, or stop the turn.
 *   4. Permission gate: the guardian arbiter merges hook, rule, and
 *      evaluator decisions. inc-4788: hook `allow` does NOT bypass
 *      rule `deny` / `ask`.
 *   5. Compatibility approval-modal fallback (only when the evaluator path is
 *      unavailable).
 *   6. Execute under timeout + abort race (I-9 / I-21).
 *   7. PostToolUse hooks; emit the six hook-attachment kinds on the
 *      live path (`hook_cancelled`, `hook_blocking_error`,
 *      `hook_additional_context`, `hook_stopped_continuation`,
 *      `hook_error_during_execution`, `hook_permission_decision`).
 *   8. Cap result size (I-15).
 *   9. Return a `ToolOutput`.
 *
 * Errors thread through `formatError` + `CANCEL_MESSAGE` /
 * `INTERRUPT_MESSAGE_FOR_TOOL_USE` so the live path's tool_result
 * text matches AgenC's observable output. The args-retry
 * `runWithAutoFixRetry` was removed (see
 * `docs/plan/feature-matrix.md`) — AgenC's auto-fix is a
 * lint/test runner injected as PostToolUse additional context, not
 * an args retry.
 *
 * Invariants enforced here:
 *   I-8  (every error site emits a typed event) — errors funnel
 *        through the caller's event log via `eventLog` option.
 *   I-9  (per-tool execution timeout) — `Promise.race([tool, timer])`.
 *        Default `DEFAULT_TOOL_TIMEOUT_MS=30000`; per-tool override
 *        via `tool.timeoutMs`; per-call override via `args.timeoutMs`.
 *        Tools with `timeoutBehavior:'tool'` own their deadline and
 *        keep only the abort race.
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
import { isRecord } from "../utils/record.js";
import {
  isPersistError,
  persistToolResult,
} from "../utils/toolResultStorage.js";
import { formatFileSize } from "../utils/format.js";
import type {
  FunctionCallOutputContentItem,
  ToolInvocation,
  ToolName,
  ToolOutput,
  ToolPayload,
} from "./context.js";
import {
  codeModeResult,
  functionToolOutput,
  functionToolOutputFromContent,
  toolNameDisplay,
} from "./context.js";
import type { Tool } from "./types.js";
import {
  SESSION_ID_SIG_ARG,
  signSessionId,
} from "./system/filesystem.js";
import {
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
  type HookAttachmentKind,
  type HookPermissionResult,
  type HookTimingRecord,
  type MergedHookPermissionDecision,
  type PostToolUseFailureHook,
  type PostToolUseHook,
  type PreToolUseHook,
} from "./hooks.js";
import {
  buildSchemaNotSentHint,
  formatSchemaValidationError,
  getSchemaValidationErrorOverride,
} from "./schema-errors.js";
import { buildRecoverableToolFailureMetadata } from "./result-metadata.js";
// Inline copies of donor TS `utils/messages.ts` constants. The full
// messages.ts is a heavy port that pulls in `bun:bundle`, analytics,
// and the entire session service graph; importing two constants from
// it bricks the whole tools/ test surface. The canonical strings are
// authored once here and mirrored by the UI surface (T7 wires the
// real messages.ts import when the runtime graph lands).
const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  "[Request interrupted by user for tool use]";
const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
import type {
  CanUseToolFn,
  ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import { reviewDecisionIsAllow } from "../permissions/review-decision.js";
import type { PermissionMode } from "../permissions/types.js";
import type { PermissionModeRegistry } from "../permissions/permission-mode.js";
import type { GuardianApprovalReviewer } from "../permissions/guardian/reviewer.js";
import {
  arbitratePermissionMode,
  requestApproval as requestGuardianApproval,
  requestToolUserApproval,
  type ApprovalCtx,
  type ApprovalRequestFn,
  type ApprovalResolver,
} from "../permissions/guardian/arbiter.js";
export type { ApprovalRequestFn, ModalDecision } from "../permissions/guardian/arbiter.js";
import {
  recordPermissionAuditEvent,
  type PermissionAuditErrorHandler,
  type PermissionAuditLogger,
} from "../permissions/permission-audit-log.js";
import {
  attachToolRuntimeContext,
  type ToolRuntimeAttemptContext,
} from "./runtimes/context.js";
import {
  DEFAULT_BYTES_PER_TOKEN,
  detectContentType,
} from "../llm/token-estimation.js";
import { enforceRuntimeSandboxAttempt } from "./runtimes/sandboxing.js";
import {
  createTransactionGuardContextFromEnv,
  evaluateToolInvocationTransactionGuard,
  formatTransactionGuardDenialMessage,
  formatTransactionGuardEventMessage,
  transactionGuardAuditMetadata,
  type TransactionGuardContext,
} from "../transaction-guard/index.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * I-15: default cap on tool result size in bytes. 400 KB matches
 * donor TS `MAX_TOOL_RESULT_TOKENS=100_000 × BYTES_PER_TOKEN=4`.
 * Per-tool override via `tool.maxResultBytes`.
 *
 * This is now used as the absolute *ceiling* for the model-aware cap
 * (`computeEffectiveMaxResultBytes`): large-window models (≥200K tokens)
 * meet/exceed this value and so keep the original 400 KB behavior, while
 * small-window models get a tighter, window-relative cap so one result
 * can never blow out the context window.
 */
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 400_000;

/**
 * Floor for the model-aware per-result cap. Even on a tiny context
 * window we never starve tools below ~16 KB (~4-8K tokens), so small
 * configs can still read meaningful output.
 */
export const MIN_TOOL_RESULT_BYTES = 16_000;

/**
 * Fraction of the model's context window a single tool result may
 * occupy by default. 0.20 keeps one result at ≤ ~20% of the window,
 * leaving headroom for the system prompt, prior history, and a few more
 * results before the auto-compact threshold. Tunable via
 * `AGENC_MAX_TOOL_RESULT_WINDOW_FRACTION`.
 */
export const DEFAULT_SINGLE_RESULT_WINDOW_FRACTION = 0.2;

/** JSON-ish content packs ~2 bytes/token; plain text ~4 bytes/token. */
const JSON_BYTES_PER_TOKEN = 2;

/**
 * At or above this window the fixed 400 KB ceiling is kept verbatim, so
 * large-window models (Claude ~200K+) are entirely unaffected by the
 * model-aware cap — no regression for their existing behavior. (Without
 * this gate a 200K window would otherwise compute 160 KB for text.)
 */
export const LARGE_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Resolve the window-fraction override from the environment, falling
 * back to the 0.20 default. Out-of-range / unparseable values are
 * ignored so a bad env var can never disable the guard.
 */
function resolveSingleResultWindowFraction(): number {
  const raw = process.env.AGENC_MAX_TOOL_RESULT_WINDOW_FRACTION;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SINGLE_RESULT_WINDOW_FRACTION;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_SINGLE_RESULT_WINDOW_FRACTION;
  }
  return parsed;
}

/**
 * Pick a bytes-per-token estimate for the result content. JSON / JSONL /
 * JSONC content is denser (~2 B/tok) than plain text (~4 B/tok), so the
 * same token target maps to a *tighter byte cap* for JSON — this is what
 * fixes the "400 KB of JSON ≈ 200K tokens" worst case.
 */
function bytesPerTokenForContent(content: string): number {
  return detectContentType(content) === "json"
    ? JSON_BYTES_PER_TOKEN
    : DEFAULT_BYTES_PER_TOKEN;
}

/**
 * Compute the effective per-result byte cap, scaled to the model's
 * context window so a single tool result can never overflow a
 * small-window model. Returns the fixed `DEFAULT_MAX_TOOL_RESULT_BYTES`
 * when no window is known (preserving today's behavior) and lets a
 * per-tool `tool.maxResultBytes` override win unconditionally.
 *
 *   effectiveCapBytes = clamp(
 *     floor(window * FRACTION * bytesPerToken),
 *     MIN_TOOL_RESULT_BYTES,            // floor
 *     DEFAULT_MAX_TOOL_RESULT_BYTES,    // ceiling
 *   )
 *
 * On a 131,072-token window: text → ~104 KB, JSON → ~52 KB.
 * At or above `LARGE_CONTEXT_WINDOW_TOKENS` (200K) the fixed 400 KB
 * ceiling is returned verbatim, so Claude-class models are unaffected.
 */
export function computeEffectiveMaxResultBytes(args: {
  readonly content: string;
  readonly contextWindowTokens?: number | undefined;
  readonly toolMaxResultBytes?: number | undefined;
}): number {
  const { content, contextWindowTokens, toolMaxResultBytes } = args;
  // Per-tool override always wins (preserves the I-15 branch).
  if (toolMaxResultBytes !== undefined && toolMaxResultBytes > 0) {
    return toolMaxResultBytes;
  }
  // No usable window → keep the fixed 400 KB cap (nothing breaks).
  if (
    contextWindowTokens === undefined ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return DEFAULT_MAX_TOOL_RESULT_BYTES;
  }
  // Large-window models keep the fixed 400 KB ceiling — no regression.
  if (contextWindowTokens >= LARGE_CONTEXT_WINDOW_TOKENS) {
    return DEFAULT_MAX_TOOL_RESULT_BYTES;
  }
  const fraction = resolveSingleResultWindowFraction();
  const bytesPerToken = bytesPerTokenForContent(content);
  const windowRelative = Math.floor(
    contextWindowTokens * fraction * bytesPerToken,
  );
  return Math.max(
    MIN_TOOL_RESULT_BYTES,
    Math.min(windowRelative, DEFAULT_MAX_TOOL_RESULT_BYTES),
  );
}
const RICH_OUTPUT_CONTENT_ITEMS = new WeakMap<
  ToolOutput,
  readonly FunctionCallOutputContentItem[]
>();
const STRUCTURED_CODE_MODE_RESULTS = new WeakMap<ToolOutput, unknown>();
const PREVENT_CONTINUATION_OUTPUTS = new WeakSet<ToolOutput>();

/** Appended marker when a result is truncated. */
const TRUNCATION_MARKER_TEMPLATE =
  "\n\n[truncated: original was {ORIG} bytes, returning first {KEPT}]\n";

/**
 * Informative truncation marker. Unlike the legacy template it tells the
 * agent how much was kept (bytes + estimated tokens), that the result was
 * capped to fit the model's context window, and how to retrieve more —
 * so the agent can ADAPT (narrow the query, use offset+limit, or a more
 * specific search) instead of silently losing data.
 */
function buildTruncationMarker(args: {
  readonly originalBytes: number;
  readonly keptBytes: number;
  readonly bytesPerToken: number;
  readonly contextWindowTokens?: number | undefined;
}): string {
  const { originalBytes, keptBytes, bytesPerToken, contextWindowTokens } = args;
  const keptTokens = Math.round(keptBytes / bytesPerToken);
  const originalTokens = Math.round(originalBytes / bytesPerToken);
  const windowNote =
    contextWindowTokens !== undefined &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? ` to fit the ${contextWindowTokens}-token context window`
      : "";
  return (
    `\n\n[result truncated: kept ${keptBytes} of ${originalBytes} bytes ` +
    `(~${keptTokens} of ~${originalTokens} tokens)${windowNote}. ` +
    `To see more, narrow the query, use offset+limit, or run a more ` +
    `specific search.]\n`
  );
}

/**
 * Hard cap on formatted error prose before middle-truncation. Mirrors
 * donor TS `formatError`'s 10,000-char cutoff.
 */
const FORMAT_ERROR_MAX_BYTES = 10_000;

// ─────────────────────────────────────────────────────────────────────
// Per-tool metadata hooks (extending the base Tool shape)
// ─────────────────────────────────────────────────────────────────────

export interface ToolExecutionOverrides {
  /** I-9 per-tool timeout override. */
  readonly timeoutMs?: number;
  /** Tool-owned timeout semantics; executor keeps abort handling only. */
  readonly timeoutBehavior?: "executor" | "tool";
  /** I-15 per-tool size cap override. */
  readonly maxResultBytes?: number;
}

// ─────────────────────────────────────────────────────────────────────
// I-79: large-int JSON reviver
// ─────────────────────────────────────────────────────────────────────

const LARGE_INT_LITERAL_RE = /(:|,|\[|\{|\s)\s*(-?\d{16,})(\s*)(?=,|\}|\])/g;

function wrapLargeInts(raw: string): string {
  return raw.replace(
    LARGE_INT_LITERAL_RE,
    (_m, pre: string, digits: string, post: string) =>
      `${pre}"__bigint__${digits}"${post}`,
  );
}

const BIGINT_PREFIX = "__bigint__";

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

export interface CapToolResultMarkerInfo {
  /** Bytes-per-token estimate used for the ~tokens figures in the marker. */
  readonly bytesPerToken: number;
  /** Effective context window the cap was derived from (for the marker). */
  readonly contextWindowTokens?: number | undefined;
}

export function capToolResult(
  content: string,
  maxBytes: number,
  markerInfo?: CapToolResultMarkerInfo,
): { readonly capped: string; readonly truncated: boolean; readonly originalBytes: number } {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= maxBytes) {
    return { capped: content, truncated: false, originalBytes };
  }
  // When marker info is supplied (the live cap path), emit the
  // informative window-aware marker; otherwise keep the legacy marker
  // so older callers/tests observe unchanged prose. The marker length
  // is bounded by `maxBytes` either way so the result never grows past
  // the cap.
  let marker: string;
  if (markerInfo !== undefined) {
    // Provisional marker to measure its own byte cost, then recompute
    // against the actual kept length.
    const provisional = buildTruncationMarker({
      originalBytes,
      keptBytes: maxBytes,
      bytesPerToken: markerInfo.bytesPerToken,
      contextWindowTokens: markerInfo.contextWindowTokens,
    });
    const provisionalBytes = Buffer.byteLength(provisional, "utf8");
    const keptBytes = Math.max(0, maxBytes - provisionalBytes);
    marker = buildTruncationMarker({
      originalBytes,
      keptBytes,
      bytesPerToken: markerInfo.bytesPerToken,
      contextWindowTokens: markerInfo.contextWindowTokens,
    });
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const finalKeepBytes = Math.max(0, maxBytes - markerBytes);
    const kept = Buffer.from(content, "utf8")
      .subarray(0, finalKeepBytes)
      .toString("utf8");
    return { capped: `${kept}${marker}`, truncated: true, originalBytes };
  }
  marker = TRUNCATION_MARKER_TEMPLATE
    .replace("{ORIG}", String(originalBytes))
    .replace("{KEPT}", String(maxBytes));
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const keepBytes = Math.max(0, maxBytes - markerBytes);
  const buf = Buffer.from(content, "utf8");
  const kept = buf.subarray(0, keepBytes).toString("utf8");
  return { capped: `${kept}${marker}`, truncated: true, originalBytes };
}

// ─────────────────────────────────────────────────────────────────────
// Technique D — model-aware OFFLOAD (persist full + reference)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the actionable reference message injected in place of a result
 * that overflowed the model-aware cap. It carries a HEAD preview of the
 * output, the on-disk path the FULL output was persisted to, and a
 * concrete pointer the agent can act on (read the file, a byte/line
 * range, or narrow the query). This is the cap done as an OFFLOAD
 * (Technique D / MemGPT memory-pointers) rather than a blind truncation:
 * no data is lost — the full output is recoverable from `filepath`.
 *
 * The whole message is byte-bounded by `maxBytes` so the reference can
 * never itself overflow the cap.
 */
function buildOffloadReferenceMessage(args: {
  readonly content: string;
  readonly filepath: string;
  readonly originalBytes: number;
  readonly maxBytes: number;
  readonly bytesPerToken: number;
}): string {
  const { content, filepath, originalBytes, maxBytes, bytesPerToken } = args;
  const originalTokens = Math.round(originalBytes / bytesPerToken);
  // Header + footer first so the head preview can be sized to the room
  // that remains under the cap. Keep the pointer phrasing aligned with
  // the truncation marker ("narrow the query"/"offset+limit"/"search").
  const header =
    `[full output (~${formatFileSize(originalBytes)} / ~${originalTokens} tokens) ` +
    `saved to ${filepath} — read that file (or a byte/line range with ` +
    `offset+limit) to see more, or narrow your query / run a more specific ` +
    `search. Head preview follows:]\n`;
  const footer = `\n[…truncated — full output at ${filepath}]\n`;
  const headerBytes = Buffer.byteLength(header, "utf8");
  const footerBytes = Buffer.byteLength(footer, "utf8");
  const room = Math.max(0, maxBytes - headerBytes - footerBytes);
  // Trim the head preview to fit, cutting on a UTF-8 boundary.
  let head = Buffer.from(content, "utf8").subarray(0, room).toString("utf8");
  // Prefer a clean line boundary for the preview when one is reasonably
  // close to the end (mirrors generatePreview in toolResultStorage).
  const lastNewline = head.lastIndexOf("\n");
  if (lastNewline > room * 0.5) {
    head = head.slice(0, lastNewline);
  }
  return `${header}${head}${footer}`;
}

/**
 * Apply the model-aware per-result cap as an OFFLOAD (Technique D), not a
 * guillotine. When `content` fits within `maxBytes` it is returned
 * unchanged. When it overflows, the FULL content is persisted to disk
 * (reusing `persistToolResult` — same session tool-results store the
 * agent can read back with FileRead) and the model receives a REFERENCE
 * message: a head preview + the persisted path + an actionable
 * "read range / narrow query" pointer. If persistence fails for any
 * reason, we fall back to the legacy blind truncation so the hard cap is
 * still honored and the wire message can never overflow the window.
 *
 * The same `maxBytes` (from `computeEffectiveMaxResultBytes`) is used, so
 * the per-tool `maxResultBytes` override and the ≥200K-window (Claude)
 * "fixed 400 KB ceiling" behavior are unchanged — only the over-cap
 * branch changes from truncate-and-lose to offload-and-reference.
 */
async function offloadOrCapToolResult(args: {
  readonly content: string;
  readonly toolUseId: string;
  readonly maxBytes: number;
  readonly bytesPerToken: number;
  readonly contextWindowTokens?: number | undefined;
}): Promise<{
  readonly content: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly persistedPath?: string;
}> {
  const { content, toolUseId, maxBytes, bytesPerToken, contextWindowTokens } =
    args;
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= maxBytes) {
    return { content, truncated: false, originalBytes };
  }

  // Over the cap: OFFLOAD the full output, then return a reference.
  const persisted = await persistToolResult(content, toolUseId);
  if (!isPersistError(persisted)) {
    const reference = buildOffloadReferenceMessage({
      content,
      filepath: persisted.filepath,
      originalBytes,
      maxBytes,
      bytesPerToken,
    });
    return {
      content: reference,
      truncated: true,
      originalBytes,
      persistedPath: persisted.filepath,
    };
  }

  // Persist failed → fall back to the legacy blind truncation so the hard
  // model-aware cap is still enforced (the wire message can never overflow).
  const capped = capToolResult(content, maxBytes, {
    bytesPerToken,
    contextWindowTokens,
  });
  return {
    content: capped.capped,
    truncated: capped.truncated,
    originalBytes: capped.originalBytes,
  };
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
 * Construct an abort rejection carrying *structural* abort signals
 * (`name === "AbortError"` + `code === "ABORT_ERR"`), so downstream
 * classification (`isAbortLikeError` / `classifyToolError`) recognizes
 * a genuine abort without resorting to a free-text "aborted" substring
 * match. The substring match alone misclassified real tool failures
 * whose message merely contained the word "aborted" as user interrupts.
 */
function makeAbortError(reason: unknown): Error {
  const err = new Error(String(reason ?? "aborted"));
  err.name = "AbortError";
  (err as { code?: string }).code = "ABORT_ERR";
  return err;
}

export function resolveTimeoutMs(
  tool: Tool & Partial<ToolExecutionOverrides>,
  args: Record<string, unknown>,
): number | null {
  if (tool.timeoutBehavior === "tool") {
    return null;
  }
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

export async function withTimeoutAndAbort<T>(
  fn: () => Promise<T>,
  opts: {
    readonly timeoutMs: number | null;
    readonly toolName: string;
    readonly signal?: AbortSignal;
    readonly abortController?: AbortController;
  },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let settled = false;

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
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (
          opts.abortController &&
          !opts.abortController.signal.aborted
        ) {
          try {
            opts.abortController.abort(
              `tool timeout: ${opts.toolName} exceeded ${timeoutMs}ms`,
            );
          } catch {
            // already aborted
          }
        }
        reject(new ToolTimeoutError(opts.toolName, timeoutMs));
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        settled = true;
        cleanup();
        reject(makeAbortError(opts.signal.reason));
        return;
      }
      onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(makeAbortError(opts.signal?.reason));
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// Error classification — port of donor TS `classifyToolError`.
// ─────────────────────────────────────────────────────────────────────

export type ToolErrorClass =
  | "timeout"
  | "aborted"
  | "permission_denied"
  | "invalid_args"
  | "not_found"
  | "stale_modal_decision"
  | "tool_threw"
  | "shell_interrupted"
  | "mcp_auth"
  | "mcp_tool_call"
  | "unknown";

export function classifyToolError(err: unknown): ToolErrorClass {
  if (err instanceof ToolTimeoutError) return "timeout";
  if (isMcpAuthError(err)) return "mcp_auth";
  if (isMcpToolCallError(err)) return "mcp_tool_call";
  if (isShellInterruptError(err)) return "shell_interrupted";
  if (isAbortLikeError(err)) return "aborted";
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
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

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Structural signals only. A free-text "aborted" substring is NOT a
  // reliable abort signal: a genuine tool failure (e.g. "transaction
  // aborted by the database engine") must not be reclassified as a user
  // interrupt and have its real message discarded. The runtime's own
  // abort plumbing tags its rejections via makeAbortError so genuine
  // aborts are still recognized here.
  const name = (err as { name?: string }).name;
  if (name === "AbortError") return true;
  const code = (err as { code?: string }).code;
  if (code === "ABORT_ERR") return true;
  return false;
}

/**
 * MCP auth error detection (duck-typed: looks for
 * `name === "McpAuthError"` + `serverName: string`). Avoids a hard
 * import of `runtime/src/services/mcp/client.ts`, which is a stub in
 * the T6 tree — real MCP clients in the wild set `err.name` directly.
 */
function isMcpAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name !== "McpAuthError") return false;
  return typeof (err as { serverName?: unknown }).serverName === "string";
}

function getMcpServerName(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const s = (err as { serverName?: unknown }).serverName;
  return typeof s === "string" ? s : undefined;
}

function isMcpToolCallError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return (
    name === "McpToolCallError" ||
    name === "McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS"
  );
}

function getMcpMeta(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as { mcpMeta?: unknown }).mcpMeta;
}

function isShellInterruptError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name !== "ShellError") return false;
  return (err as { interrupted?: unknown }).interrupted === true;
}

// ─────────────────────────────────────────────────────────────────────
// donor TS `formatError` parity — produces tool_result content.
// ─────────────────────────────────────────────────────────────────────

export function formatError(error: unknown): string {
  if (isAbortLikeError(error)) {
    const msg = error instanceof Error ? error.message : "";
    return msg || INTERRUPT_MESSAGE_FOR_TOOL_USE;
  }
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts = getErrorParts(error);
  const fullMessage =
    parts.filter(Boolean).join("\n").trim() || "Command failed with no output";
  if (fullMessage.length <= FORMAT_ERROR_MAX_BYTES) {
    return fullMessage;
  }
  const halfLength = FORMAT_ERROR_MAX_BYTES / 2;
  const start = fullMessage.slice(0, halfLength);
  const end = fullMessage.slice(-halfLength);
  return `${start}\n\n... [${fullMessage.length - FORMAT_ERROR_MAX_BYTES} characters truncated] ...\n\n${end}`;
}

function getErrorParts(error: Error): string[] {
  const name = error.name;
  if (name === "ShellError") {
    const shell = error as Error & {
      code?: number;
      interrupted?: boolean;
      stderr?: unknown;
      stdout?: unknown;
    };
    return [
      shell.code !== undefined ? `Exit code ${shell.code}` : "",
      shell.interrupted ? INTERRUPT_MESSAGE_FOR_TOOL_USE : "",
      typeof shell.stderr === "string" ? shell.stderr : "",
      typeof shell.stdout === "string" ? shell.stdout : "",
    ];
  }
  const parts = [error.message];
  const withStreams = error as Error & {
    stderr?: unknown;
    stdout?: unknown;
  };
  if (typeof withStreams.stderr === "string") parts.push(withStreams.stderr);
  if (typeof withStreams.stdout === "string") parts.push(withStreams.stdout);
  return parts;
}

// ─────────────────────────────────────────────────────────────────────
// JSON Schema validation (richer than the old hand-rolled subset —
// handles anyOf, oneOf, allOf, const, format, and $ref chasing so
// AgenC's Zod-backed parity is observable).
// ─────────────────────────────────────────────────────────────────────

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
  /**
   * Category driving the AgenC-style prose: missing required,
   * unexpected key, type mismatch, or `other` for everything else.
   */
  readonly category: "missing" | "unexpected_key" | "type" | "other";
  readonly expected?: string;
  readonly received?: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<SchemaValidationError>;
}

function schemaTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "bigint":
      return "integer";
    case "object":
      return "object";
    default:
      return typeof value;
  }
}

function typeMatches(expected: string, actualType: string): boolean {
  if (expected === actualType) return true;
  if (expected === "number" && actualType === "integer") return true;
  return false;
}

type SchemaObj = Record<string, unknown>;

function resolveRef(schema: SchemaObj, rootSchema: SchemaObj): SchemaObj {
  const ref = schema["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  const segments = ref.slice(2).split("/");
  let node: unknown = rootSchema;
  for (const seg of segments) {
    if (!isRecord(node)) return schema;
    node = node[seg];
  }
  return isRecord(node) ? node : schema;
}

function joinPath(prefix: string, key: string | number): string {
  if (prefix === "") return String(key);
  return `${prefix}.${key}`;
}

/**
 * Richer JSON Schema validator that covers the keywords AgenC's
 * Zod schemas emit: `type`, `required`, `properties`,
 * `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`,
 * `allOf`, `$ref`, `format`, plus coarse string length / number
 * range bounds. Unknown keywords are ignored (consistent with the
 * "catch glaring contract violations" intent).
 */
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  if (!schema || typeof schema !== "object") {
    return { valid: true, errors: [] };
  }
  validateNode(schema, args, "", errors, schema);
  return { valid: errors.length === 0, errors };
}

function validateNode(
  schema: SchemaObj,
  value: unknown,
  path: string,
  errors: SchemaValidationError[],
  rootSchema: SchemaObj,
): void {
  const resolved = resolveRef(schema, rootSchema);

  const anyOf = resolved["anyOf"];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    let anyValid = false;
    for (const sub of anyOf) {
      if (!isRecord(sub)) continue;
      const subErrors: SchemaValidationError[] = [];
      validateNode(sub, value, path, subErrors, rootSchema);
      if (subErrors.length === 0) {
        anyValid = true;
        break;
      }
    }
    if (!anyValid) {
      errors.push({
        path: path || "(root)",
        message: "value does not match any of the expected schemas",
        category: "other",
      });
      return;
    }
  }

  const oneOf = resolved["oneOf"];
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    let matched = 0;
    for (const sub of oneOf) {
      if (!isRecord(sub)) continue;
      const subErrors: SchemaValidationError[] = [];
      validateNode(sub, value, path, subErrors, rootSchema);
      if (subErrors.length === 0) matched += 1;
    }
    if (matched !== 1) {
      errors.push({
        path: path || "(root)",
        message:
          matched === 0
            ? "value does not match any oneOf branch"
            : "value matches more than one oneOf branch",
        category: "other",
      });
      return;
    }
  }

  const allOf = resolved["allOf"];
  if (Array.isArray(allOf) && allOf.length > 0) {
    for (const sub of allOf) {
      if (!isRecord(sub)) continue;
      validateNode(sub, value, path, errors, rootSchema);
    }
  }

  if ("const" in resolved) {
    const constVal = resolved["const"];
    if (!deepEq(value, constVal)) {
      errors.push({
        path: path || "(root)",
        message: `value must equal ${JSON.stringify(constVal)}`,
        category: "other",
      });
      return;
    }
  }

  const declaredType = resolved["type"];
  if (declaredType !== undefined) {
    const actual = schemaTypeOf(value);
    if (typeof declaredType === "string") {
      if (!typeMatches(declaredType, actual)) {
        errors.push({
          path: path || "(root)",
          message: `expected ${declaredType}, got ${actual}`,
          category: "type",
          expected: declaredType,
          received: actual,
        });
        return;
      }
    } else if (Array.isArray(declaredType)) {
      if (
        !declaredType.some(
          (t) => typeof t === "string" && typeMatches(t, actual),
        )
      ) {
        const expected = declaredType
          .filter((t) => typeof t === "string")
          .join(" | ");
        errors.push({
          path: path || "(root)",
          message: `expected one of ${expected}, got ${actual}`,
          category: "type",
          expected,
          received: actual,
        });
        return;
      }
    }
  }

  const enumVals = resolved["enum"];
  if (Array.isArray(enumVals) && enumVals.length > 0) {
    if (!enumVals.some((v) => deepEq(v, value))) {
      errors.push({
        path: path || "(root)",
        message: "value not in enum",
        category: "other",
      });
      return;
    }
  }

  const format = resolved["format"];
  if (typeof format === "string") {
    if (typeof value !== "string") {
      errors.push({
        path: path || "(root)",
        message: `expected ${format}-formatted string, got ${schemaTypeOf(value)}`,
        category: "type",
        expected: "string",
        received: schemaTypeOf(value),
      });
      return;
    }
  }

  if (Array.isArray(value)) {
    validateArray(resolved, value, path, errors, rootSchema);
    return;
  }
  if (isRecord(value)) {
    validateObject(resolved, value, path, errors, rootSchema);
    return;
  }
  if (typeof value === "string") {
    const minLen = resolved["minLength"];
    const maxLen = resolved["maxLength"];
    if (typeof minLen === "number" && value.length < minLen) {
      errors.push({
        path: path || "(root)",
        message: `string too short (min ${minLen})`,
        category: "other",
      });
    }
    if (typeof maxLen === "number" && value.length > maxLen) {
      errors.push({
        path: path || "(root)",
        message: `string too long (max ${maxLen})`,
        category: "other",
      });
    }
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const min = resolved["minimum"];
    const max = resolved["maximum"];
    const num = typeof value === "bigint" ? Number(value) : value;
    if (typeof min === "number" && num < min) {
      errors.push({
        path: path || "(root)",
        message: `value below minimum (${min})`,
        category: "other",
      });
    }
    if (typeof max === "number" && num > max) {
      errors.push({
        path: path || "(root)",
        message: `value above maximum (${max})`,
        category: "other",
      });
    }
  }
}

function validateArray(
  schema: SchemaObj,
  value: ReadonlyArray<unknown>,
  path: string,
  errors: SchemaValidationError[],
  rootSchema: SchemaObj,
): void {
  const items = schema["items"];
  if (isRecord(items)) {
    for (let i = 0; i < value.length; i += 1) {
      validateNode(items, value[i], joinPath(path, i), errors, rootSchema);
    }
  }
  const minItems = schema["minItems"];
  if (typeof minItems === "number" && value.length < minItems) {
    errors.push({
      path: path || "(root)",
      message: `array has fewer than ${minItems} items`,
      category: "other",
    });
  }
  const maxItems = schema["maxItems"];
  if (typeof maxItems === "number" && value.length > maxItems) {
    errors.push({
      path: path || "(root)",
      message: `array has more than ${maxItems} items`,
      category: "other",
    });
  }
}

function validateObject(
  schema: SchemaObj,
  obj: SchemaObj,
  path: string,
  errors: SchemaValidationError[],
  rootSchema: SchemaObj,
): void {
  const declaredType = schema["type"];
  if (typeof declaredType === "string" && declaredType !== "object") return;

  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!(key in obj)) {
        errors.push({
          path: joinPath(path, key),
          message: "missing required field",
          category: "missing",
        });
      }
    }
  }
  const properties = schema["properties"];
  const declaredProps = new Set<string>();
  if (properties && typeof properties === "object") {
    const propMap = properties as Record<string, unknown>;
    for (const [key, sub] of Object.entries(propMap)) {
      declaredProps.add(key);
      if (!(key in obj)) continue;
      if (!isRecord(sub)) continue;
      validateNode(sub, obj[key], joinPath(path, key), errors, rootSchema);
    }
  }
  const additional = schema["additionalProperties"];
  if (additional === false) {
    for (const key of Object.keys(obj)) {
      if (!declaredProps.has(key)) {
        errors.push({
          path: joinPath(path, key),
          message: "unexpected field",
          category: "unexpected_key",
        });
      }
    }
  } else if (isRecord(additional)) {
    for (const [key, val] of Object.entries(obj)) {
      if (declaredProps.has(key)) continue;
      validateNode(additional, val, joinPath(path, key), errors, rootSchema);
    }
  }
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEq(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Progress events (A-side channel for long-running tools)
// ─────────────────────────────────────────────────────────────────────

export interface ToolProgressEvent {
  readonly chunk: string;
  readonly stream?: "stdout" | "stderr" | "status";
  readonly processId?: number;
}

export type ToolProgressCallback = (event: ToolProgressEvent) => void;

// ─────────────────────────────────────────────────────────────────────
// runToolUse — the single entry point
// ─────────────────────────────────────────────────────────────────────

export interface RunToolUseOptions {
  readonly signal?: AbortSignal;
  readonly currentTurnId: string;
  readonly getActiveTurnId?: () => string | null;
  readonly requestApproval?: ApprovalRequestFn;
  readonly approvalResolver?: ApprovalResolver;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly eventLog?: EventLog;
  readonly subId?: string;
  readonly tool: Tool & Partial<ToolExecutionOverrides>;
  readonly invocation: ToolInvocation;
  readonly preHooks?: ReadonlyArray<PreToolUseHook>;
  readonly prePreventContinuation?: { readonly stopReason?: string };
  readonly postHooks?: ReadonlyArray<PostToolUseHook>;
  readonly failureHooks?: ReadonlyArray<PostToolUseFailureHook>;
  readonly onHookTiming?: (record: HookTimingRecord) => void;
  readonly onHookError?: (
    phase: "pre" | "post" | "failure",
    err: unknown,
    idx: number,
  ) => void;
  readonly onProgress?: ToolProgressCallback;
  readonly skipArgValidation?: boolean;
  readonly preHookPermissionDecision?: MergedHookPermissionDecision;
  readonly approvalAlreadyResolved?: boolean;
  readonly canUseTool?: CanUseToolFn;
  readonly permissionContext?: ToolEvaluatorContext;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
  readonly onHookAdditionalContext?: (contexts: readonly string[]) => void;
  readonly modeChangeRegistry?: PermissionModeRegistry;
  readonly checkModeStillAllowed?: (
    tool: Tool,
    args: Record<string, unknown>,
    newMode: PermissionMode,
  ) => boolean;
  readonly abortController?: AbortController;
  readonly throwOnExecutionError?: boolean;
  /**
   * Optional set of tool names whose schemas were actually sent to the
   * provider. Used by `buildSchemaNotSentHint` to catch deferred-tool
   * calls made without loading the schema first.
   */
  readonly discoveredToolNames?: ReadonlySet<string>;
  /**
   * Optional MCP side-effect hook. Called when the tool throws an
   * `McpAuthError` — allows the caller (session services) to flip the
   * corresponding client to `needs-auth` state. Duck-typed on
   * `err.serverName` so we don't need a hard dep on the MCP package.
   */
  readonly onMcpAuthError?: (serverName: string) => void;
  /**
   * Optional MCP pass-through for `err.mcpMeta`. When supplied and
   * the tool throws an `McpToolCallError`, the error's `mcpMeta` is
   * forwarded so the executor's user-message includes it.
   */
  readonly onMcpToolCallError?: (mcpMeta: unknown) => void;
  /** Hidden per-call runtime context selected by router/orchestrator. */
  readonly runtimeAttemptContext?: ToolRuntimeAttemptContext;
  /**
   * Optional fail-closed SLM transaction guard. Undefined means resolve
   * from environment; null means explicitly disabled for this call.
   */
  readonly transactionGuardContext?: TransactionGuardContext | null;
  /**
   * Effective context window (in tokens) for the model running this
   * turn. Threaded from the dispatch layer (`modelContextWindow(turn)`).
   * When present, the I-15 per-result byte cap is scaled to the window
   * so a single result can never overflow a small-window model. When
   * absent the cap falls back to the fixed `DEFAULT_MAX_TOOL_RESULT_BYTES`.
   */
  readonly contextWindowTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────
// T11 W3-B — permission gate helpers
// ─────────────────────────────────────────────────────────────────────

const WRITE_CAPABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "system.bash",
  "Write",
  "Edit",
  "system.delete",
  "Bash",
  "write_file",
  "edit_file",
]);

export function defaultCheckModeStillAllowed(
  tool: Tool,
  _args: Record<string, unknown>,
  newMode: PermissionMode,
): boolean {
  if (newMode !== "plan") return true;
  if (WRITE_CAPABLE_TOOL_NAMES.has(tool.name)) return false;
  if (tool.isReadOnly === true) return true;
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Hook-attachment emission
// ─────────────────────────────────────────────────────────────────────

/**
 * Emit one of the six AgenC hook-attachment kinds as a warning on
 * the event log. AgenC's event stream doesn't have a dedicated
 * `attachment` message type, so we carry the kind + human-readable
 * message through the warning channel — consumers filter on
 * `cause: hook_*` to reproduce AgenC's attachment view.
 */
function emitHookAttachment(
  log: EventLog | undefined,
  subId: string,
  kind: HookAttachmentKind,
  detail: string,
): void {
  if (!log) return;
  emitWarningEvent(log, subId, kind, detail);
}

/**
 * Execute one tool invocation end-to-end. See module comment for the
 * full AgenC-compatible ordering.
 */
export async function runToolUse(
  rawArgs: string,
  opts: RunToolUseOptions,
): Promise<ToolOutput> {
  const effectiveSignal = opts.signal ?? opts.abortController?.signal;
  const { tool, invocation, currentTurnId } = opts;
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
  if (opts.runtimeAttemptContext !== undefined) {
    attachToolRuntimeContext(parsedArgs, opts.runtimeAttemptContext);
  }

  // Step 2: JSON Schema validation (+ humanized prose override + hint).
  // Strip AgenC-internal `__agenc*` context fields (e.g.
  // `__agencSessionId`, `__agencSessionAllowedRoots`) from the validator's
  // view. They ride alongside model args via the ChildToolPolicy /
  // agent run-loop transport but are not part of the public schema.
  // See services/tools/toolExecution.ts for the parallel implementation.
  if (!opts.skipArgValidation) {
    const validatorArgs = stripAgenCInternalArgsForValidation(parsedArgs);
    const validation = validateToolArgs(
      tool.inputSchema as Record<string, unknown> | undefined,
      validatorArgs,
    );
    if (!validation.valid) {
      const override = getSchemaValidationErrorOverride(tool, parsedArgs);
      const prose =
        override ??
        formatSchemaValidationError(
          toolNameDisplay(invocation.toolName),
          validation.errors,
        );
      const hint = buildSchemaNotSentHint(tool, opts.discoveredToolNames);
      const body = hint ? `${prose}${hint}` : prose;
      const message = `InputValidationError: ${body}`;
      if (opts.eventLog) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "schema_validation_failed",
          message,
        });
      }
      return errorOutput({
        invocation,
        content: `<tool_use_error>${message}</tool_use_error>`,
        elapsedMs: performance.now() - startedAt,
        metadata: buildRecoverableToolFailureMetadata("input_validation"),
      });
    }
  }

  // Step 3: PreToolUse hooks — BEFORE the permission gate.
  let args: Record<string, unknown> = parsedArgs;
  let hookPermissionResult: HookPermissionResult | undefined;
  let prePreventContinuation = opts.prePreventContinuation;
  let shouldPreventContinuation = prePreventContinuation !== undefined;
  const preHooks = opts.preHooks ?? [];
  if (preHooks.length > 0) {
    const preDecision = await runPreToolUseHooks(
      preHooks,
      { invocation, tool, args },
      (err, idx) => {
        opts.onHookError?.("pre", err, idx);
        emitHookAttachment(
          opts.eventLog,
          subId,
          "hook_error_during_execution",
          `PreToolUse:${tool.name} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
      opts.onHookTiming,
      // Direct/test (non-router) pre-hook seam. Dead on the live router
      // hot path (router passes preHooks:[] into runToolUse), but
      // reachable by direct callers and tests — thread for coherence so
      // a wedged pre-hook here is also bounded by the abort signal.
      effectiveSignal,
      (idx) => {
        emitHookAttachment(
          opts.eventLog,
          subId,
          "hook_cancelled",
          `PreToolUse:${tool.name}#${idx} cancelled (drain/timeout); fail-closed deny synthesized`,
        );
      },
      (idx) => {
        emitHookAttachment(
          opts.eventLog,
          subId,
          "hook_orphaned",
          `PreToolUse:${tool.name}#${idx} ignored its cancel signal; lock reclaimed, hook task orphaned`,
        );
      },
    );
    args = preDecision.args ?? args;
    if (preDecision.hookPermissionResult) {
      hookPermissionResult = preDecision.hookPermissionResult;
    }
    for (const c of preDecision.additionalContexts) {
      emitHookAttachment(
        opts.eventLog,
        subId,
        "hook_additional_context",
        `PreToolUse:${tool.name} context: ${c}`,
      );
    }
    if (preDecision.additionalContexts.length > 0) {
      opts.onHookAdditionalContext?.(preDecision.additionalContexts);
    }
    if (preDecision.preventContinuation) {
      prePreventContinuation = preDecision.preventContinuation;
      shouldPreventContinuation = true;
    }

    if (preDecision.kind === "deny") {
      const message = `pre-hook denied ${toolNameDisplay(invocation.toolName)}: ${preDecision.reason ?? ""}`;
      await recordRunToolPolicyAudit(opts, {
        decision: "denied",
        source: "pre-tool-use-hook",
        reasonCode: "pre_hook_denied",
      });
      if (opts.eventLog) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "pre_hook_denied",
          message,
        });
      }
      return errorOutput({
        invocation,
        content: `<tool_use_error>${preDecision.reason ?? "denied"}</tool_use_error>`,
        elapsedMs: performance.now() - startedAt,
      });
    }
    if (preDecision.kind === "skip" && preDecision.synthResult) {
      return functionToolOutput({
        callId: invocation.callId,
        toolName: invocation.toolName,
        payload: invocation.payload,
        content: preDecision.synthResult.content,
        isError: preDecision.synthResult.isError === true,
        durationMs: performance.now() - startedAt,
      });
    }
    if (preDecision.kind === "stop") {
      // AgenC PreToolUse `stop` — return CANCEL_MESSAGE so the
      // turn halts and the model stops generating.
      emitHookAttachment(
        opts.eventLog,
        subId,
        "hook_stopped_continuation",
        `PreToolUse:${tool.name} stopped execution${preDecision.stopReason ? `: ${preDecision.stopReason}` : ""}`,
      );
      const output = errorOutput({
        invocation,
        content: CANCEL_MESSAGE,
        elapsedMs: performance.now() - startedAt,
      });
      PREVENT_CONTINUATION_OUTPUTS.add(output);
      return output;
    }
  }

  // Step 4: permission gate. Merge hook result with rule/evaluator.
  let inputForTool: Record<string, unknown> = args;
  // When the evaluator (canUseTool) decides "ask" and a compatibility
  // requestApproval prompt is wired, we still need to invoke that prompt
  // to let the resolver record the modal decision. Track that here so
  // step 4b can opt back into the compatibility fallback even though the
  // evaluator path was wired.
  let evaluatorRequestedAsk = false;
  let permissionAlreadyAllowed = false;
  const canUseTool = opts.canUseTool;
  const permissionContext = opts.permissionContext;
  const shouldArbitratePermission =
    opts.preHookPermissionDecision !== undefined ||
    hookPermissionResult !== undefined ||
    (canUseTool !== undefined && permissionContext !== undefined);
  if (shouldArbitratePermission) {
    try {
      const permissionDecision = await arbitratePermissionMode({
        tool,
        args,
        ...(hookPermissionResult !== undefined ? { hookPermissionResult } : {}),
        ...(opts.preHookPermissionDecision !== undefined
          ? { mergedPermissionDecision: opts.preHookPermissionDecision }
          : {}),
        ...(canUseTool !== undefined ? { canUseTool } : {}),
        ...(permissionContext !== undefined ? { permissionContext } : {}),
      });
      if (permissionDecision.kind === "deny") {
        await recordRunToolPolicyAudit(opts, {
          decision: "denied",
          source: permissionDecision.source,
          reasonCode: permissionDecision.reasonCode,
        });
        if (permissionDecision.source === "pre-tool-use-hook") {
          const merged = permissionDecision.mergedDecision;
          emitHookAttachment(
            opts.eventLog,
            subId,
            "hook_permission_decision",
            `${tool.name} deny via ${merged?.decisionReason?.type ?? "hook"}${merged?.decisionReason?.hookName ? ` (${merged.decisionReason.hookName})` : ""}`,
          );
        }
        if (opts.eventLog) {
          emitErrorEvent(opts.eventLog, subId, {
            cause:
              permissionDecision.source === "pre-tool-use-hook"
                ? "permission_denied:hook"
                : `permission_denied:${permissionDecision.decisionReason?.type ?? "unknown"}`,
            message: permissionDecision.message ?? "denied by hook",
          });
        }
        return errorOutput({
          invocation,
          content: permissionDecision.message ?? "Permission denied",
          elapsedMs: performance.now() - startedAt,
        });
      }
      if (permissionDecision.kind === "ask") {
        const hasApprovalPath =
          opts.requestApproval !== undefined ||
          opts.approvalResolver !== undefined ||
          opts.guardianApprovalReviewer !== undefined;
        if (!hasApprovalPath && opts.approvalAlreadyResolved !== true) {
          await recordRunToolPolicyAudit(opts, {
            decision: "denied",
            source: "permission-evaluator",
            reasonCode: "ask_without_prompt",
          });
          if (opts.eventLog) {
            emitErrorEvent(opts.eventLog, subId, {
              cause:
                permissionDecision.source === "pre-tool-use-hook"
                  ? "permission_denied:hook_ask_without_prompt"
                  : "permission_denied:ask_without_prompt",
              message:
                permissionDecision.message ??
                "approval requested with no prompt wired",
            });
          }
          return errorOutput({
            invocation,
            content: permissionDecision.message ?? "Permission required",
            elapsedMs: performance.now() - startedAt,
          });
        }
        if (permissionDecision.source === "pre-tool-use-hook") {
          const merged = permissionDecision.mergedDecision;
          emitHookAttachment(
            opts.eventLog,
            subId,
            "hook_permission_decision",
            `${tool.name} ask via ${merged?.decisionReason?.type ?? "hook"}${merged?.decisionReason?.hookName ? ` (${merged.decisionReason.hookName})` : ""}${permissionDecision.message ? `: ${permissionDecision.message}` : ""}`,
          );
        }
        inputForTool = permissionDecision.args;
        evaluatorRequestedAsk = opts.approvalAlreadyResolved !== true;
      } else if (permissionDecision.kind === "allow") {
        permissionAlreadyAllowed = true;
        await recordRunToolPolicyAudit(opts, {
          decision: "approved",
          source: permissionDecision.source,
          reasonCode: permissionDecision.reasonCode,
        });
        if (permissionDecision.source === "pre-tool-use-hook") {
          const merged = permissionDecision.mergedDecision;
          emitHookAttachment(
            opts.eventLog,
            subId,
            "hook_permission_decision",
            `${tool.name} allow via ${merged?.decisionReason?.type ?? "hook"}${merged?.decisionReason?.hookName ? ` (${merged.decisionReason.hookName})` : ""}`,
          );
        }
        inputForTool = permissionDecision.args;
      }
    } catch (err) {
      if (isAbortLikeError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.eventLog) {
          emitErrorEvent(opts.eventLog, subId, {
            cause: "aborted",
            message,
          });
        }
        return errorOutput({
          invocation,
          content: INTERRUPT_MESSAGE_FOR_TOOL_USE,
          elapsedMs: performance.now() - startedAt,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (opts.eventLog) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "permission_evaluator_threw",
          message,
        });
      }
      return errorOutput({
        invocation,
        content: `Permission evaluation failed for ${toolNameDisplay(invocation.toolName)}: ${message}`,
        elapsedMs: performance.now() - startedAt,
      });
    }
  }

  // Step 4b: compatibility approval-modal fallback.
  //
  // If the evaluator path is wired, it already decided allow/deny/ask.
  // Falling through to the compatibility modal after an evaluator-side allow
  // defeats bypassPermissions / acceptEdits semantics by prompting a
  // second time on an already-approved call.
  const shouldUseGuardianApprovalFallback =
    (opts.approvalResolver !== undefined ||
      opts.guardianApprovalReviewer !== undefined) &&
    opts.approvalAlreadyResolved !== true &&
    !permissionAlreadyAllowed &&
    (!opts.canUseTool || !opts.permissionContext || evaluatorRequestedAsk);
  if (shouldUseGuardianApprovalFallback) {
    const approval = await requestGuardianApproval({
      ctx: {
        invocation,
        callId: invocation.callId,
        toolName: toolNameDisplay(invocation.toolName),
        turnId: currentTurnId,
        ...networkPolicyInterfacesFromInvocation(invocation),
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      },
      args: inputForTool,
      ...(opts.guardianApprovalReviewer !== undefined
        ? { guardianApprovalReviewer: opts.guardianApprovalReviewer }
        : {}),
      ...(opts.approvalResolver !== undefined
        ? { resolver: opts.approvalResolver }
        : {}),
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      ...(opts.getActiveTurnId !== undefined
        ? { getActiveTurnId: opts.getActiveTurnId }
        : {}),
    });
    const accepted = reviewDecisionIsAllow(approval.decision);
    await recordRunToolPolicyAudit(opts, {
      decision: accepted ? "approved" : "denied",
      source: `approval-${approval.source}`,
      reasonCode: accepted
        ? `approved_${approval.source}`
        : approval.source === "default_deny"
          ? "default_deny"
          : approval.source === "aborted"
            ? "aborted"
            : `denied_${approval.source}`,
    });
    if (!accepted) {
      const message =
        approval.reason ??
        (approval.decision.kind === "abort"
          ? "approval aborted"
          : "Permission denied");
      if (opts.eventLog) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: `permission_denied:${approval.source}`,
          message,
        });
      }
      return errorOutput({
        invocation,
        content: message,
        elapsedMs: performance.now() - startedAt,
      });
    }
  }

  const shouldUseLegacyApprovalFallback =
    opts.requestApproval &&
    !shouldUseGuardianApprovalFallback &&
    (!opts.canUseTool || !opts.permissionContext || evaluatorRequestedAsk);
  if (shouldUseLegacyApprovalFallback) {
    const decision = await requestToolUserApproval({
      request: opts.requestApproval,
      tool,
      args: inputForTool,
      invocation,
      currentTurnId,
      getActiveTurnId: opts.getActiveTurnId,
      signal: effectiveSignal ?? new AbortController().signal,
      ...(opts.eventLog !== undefined ? { eventLog: opts.eventLog } : {}),
      subId,
      callId: invocation.callId,
    });
    await recordRunToolPolicyAudit(opts, {
      decision: decision.allow ? "approved" : "denied",
      source: "legacy-approval-modal",
      reasonCode: decision.allow
        ? "approved_resolver"
        : legacyApprovalDenyReasonCode(decision.cause),
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

  const transactionGuardContext =
    opts.transactionGuardContext === undefined
      ? createTransactionGuardContextFromEnv()
      : opts.transactionGuardContext;
  const transactionGuardOutcome = await evaluateToolInvocationTransactionGuard({
    context: transactionGuardContext,
    tool,
    invocation,
    args: inputForTool,
  });
  if (transactionGuardOutcome.kind === "evaluated") {
    const { decision } = transactionGuardOutcome;
    const auditMetadata = transactionGuardAuditMetadata(decision);
    await recordRunToolPolicyAudit(opts, {
      decision: decision.allowed ? "approved" : "denied",
      source: "transaction-guard",
      reasonCode: decision.allowed
        ? "transaction_guard_allowed"
        : decision.code ?? "transaction_guard_denied",
    });
    if (opts.eventLog) {
      const message = formatTransactionGuardEventMessage(tool.name, decision);
      if (decision.allowed) {
        emitWarningEvent(
          opts.eventLog,
          subId,
          "transaction_guard_allowed",
          message,
        );
      } else {
        emitErrorEvent(opts.eventLog, subId, {
          cause: `transaction_guard:${decision.code ?? decision.verdict}`,
          message,
        });
      }
    }
    if (!decision.allowed) {
      return errorOutput({
        invocation,
        content: `<tool_use_error>${formatTransactionGuardDenialMessage(decision)}</tool_use_error>`,
        elapsedMs: performance.now() - startedAt,
        metadata: { transactionGuard: auditMetadata },
      });
    }
  }

  // Progress channel wiring.
  const progressCallback: ToolProgressCallback | undefined =
    opts.onProgress || opts.eventLog
      ? (event) => {
          opts.onProgress?.(event);
          if (opts.eventLog) {
            opts.eventLog.emit({
              id: subId,
              msg: {
                type: "tool_progress",
                payload: {
                  callId: invocation.callId,
                  toolName: toolNameDisplay(invocation.toolName),
                  chunk: event.chunk,
                  ...(event.stream !== undefined
                    ? { stream: event.stream }
                    : {}),
                  ...(event.processId !== undefined
                    ? { processId: event.processId }
                    : {}),
                  at: Date.now(),
                },
              },
            });
          }
        }
      : undefined;

  let argsForTool: Record<string, unknown> = inputForTool;
  if (progressCallback || effectiveSignal || invocation.callId.length > 0) {
    argsForTool = { ...inputForTool };
    if (progressCallback) {
      Object.defineProperty(argsForTool, "__onProgress", {
        value: progressCallback,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
    if (effectiveSignal) {
      Object.defineProperty(argsForTool, "__abortSignal", {
        value: effectiveSignal,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
    Object.defineProperty(argsForTool, "__callId", {
      value: invocation.callId,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    const sessionId = (invocation.session as unknown as {
      readonly conversationId?: unknown;
    }).conversationId;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      Object.defineProperty(argsForTool, "__agencSessionId", {
        value: sessionId,
        enumerable: false,
        writable: false,
        configurable: true,
      });
      // Sign the id (same per-process secret as the trusted-roots channel)
      // so the plan-file carve-out sinks honor this runtime-injected id; an
      // unsigned/forged id is rejected at the sink.
      Object.defineProperty(argsForTool, SESSION_ID_SIG_ARG, {
        value: signSessionId(sessionId),
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }
  }
  if (opts.runtimeAttemptContext !== undefined) {
    attachToolRuntimeContext(argsForTool, opts.runtimeAttemptContext);
    enforceRuntimeSandboxAttempt({
      context: opts.runtimeAttemptContext,
      tool,
      args: inputForTool,
    });
  }

  // Step 5: I-9 timeout + abort race.
  const timeoutMs = resolveTimeoutMs(tool, inputForTool);

  let unsubscribeMode: (() => void) | null = null;
  if (opts.modeChangeRegistry && opts.abortController) {
    const guard =
      opts.checkModeStillAllowed ?? defaultCheckModeStillAllowed;
    const abortCtl = opts.abortController;
    unsubscribeMode = opts.modeChangeRegistry.subscribeToModeChange(
      (newMode) => {
        if (abortCtl.signal.aborted) return;
        const stillAllowed = guard(tool, inputForTool, newMode);
        if (!stillAllowed) {
          if (opts.eventLog) {
            emitWarningEvent(
              opts.eventLog,
              subId,
              "mode_change_aborted_tool",
              `mode transitioned to ${newMode}; aborting in-flight ${toolNameDisplay(invocation.toolName)}`,
            );
          }
          try {
            abortCtl.abort(
              `aborted: permission mode changed to ${newMode}`,
            );
          } catch {
            // Already aborted; swallow.
          }
        }
      },
    );
  }

  const cleanupModeSub = (): void => {
    if (!unsubscribeMode) return;
    try {
      unsubscribeMode();
    } catch {
      // best-effort
    }
    unsubscribeMode = null;
  };

  let dispatch: ToolDispatchResult;
  try {
    dispatch = await withTimeoutAndAbort(
      async () => {
        const result = await tool.execute(argsForTool);
        return {
          content: result.content,
          isError: result.isError,
          ...(result.contentItems !== undefined
            ? { contentItems: result.contentItems }
            : {}),
          ...(result.codeModeResult !== undefined
            ? { codeModeResult: result.codeModeResult }
            : {}),
          metadata: result.metadata,
        } satisfies ToolDispatchResult;
      },
      {
        timeoutMs,
        toolName: tool.name,
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
        ...(opts.abortController !== undefined
          ? { abortController: opts.abortController }
          : {}),
      },
    );
  } catch (err) {
    const cls = classifyToolError(err);
    const message = err instanceof Error ? err.message : String(err);

    // MCP-class side effects (AgenC toolExecution :1633-1661 +
    // :1759-1764). Both are optional hooks on RunToolUseOptions so the
    // runtime can wire real MCP state while tests run without it.
    if (cls === "mcp_auth" && opts.onMcpAuthError) {
      const serverName = getMcpServerName(err);
      if (serverName) {
        try {
          opts.onMcpAuthError(serverName);
        } catch {
          // best-effort
        }
      }
    }
    if (cls === "mcp_tool_call" && opts.onMcpToolCallError) {
      try {
        opts.onMcpToolCallError(getMcpMeta(err));
      } catch {
        // best-effort
      }
    }

    if (opts.eventLog) {
      if (
        cls === "timeout" ||
        cls === "aborted" ||
        cls === "shell_interrupted"
      ) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: cls === "timeout" ? "tool_timeout" : "aborted",
          message,
          streamError: cls === "timeout",
        });
      } else if (cls === "mcp_auth") {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "mcp_auth_required",
          message,
        });
      } else if (cls === "mcp_tool_call") {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "mcp_tool_call_failed",
          message,
        });
      } else {
        emitErrorEvent(opts.eventLog, subId, {
          cause: `tool_threw:${cls}`,
          message,
        });
      }
    }
    const failureHooks = opts.failureHooks ?? [];
    if (failureHooks.length > 0) {
      await runPostToolUseFailureHooks(
        failureHooks,
        {
          invocation,
          tool,
          args: inputForTool,
          error: err,
          isInterrupt: cls === "aborted" || cls === "shell_interrupted",
          ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
        },
        (hookErr, idx) => {
          opts.onHookError?.("failure", hookErr, idx);
          emitHookAttachment(
            opts.eventLog,
            subId,
            "hook_error_during_execution",
            `PostToolUseFailure:${tool.name} threw: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        },
        opts.onHookTiming,
        // Race the drain/timeout signal: a wedged failure hook is dropped
        // (records-so-far returned) so the lock-wrapped fn() settles; the
        // original tool error still bubbles below (unchanged).
        effectiveSignal,
        (idx) => {
          emitHookAttachment(
            opts.eventLog,
            subId,
            "hook_cancelled",
            `PostToolUseFailure:${tool.name}#${idx} cancelled (drain/timeout); remaining failure hooks dropped`,
          );
        },
        (idx) => {
          emitHookAttachment(
            opts.eventLog,
            subId,
            "hook_orphaned",
            `PostToolUseFailure:${tool.name}#${idx} ignored its cancel signal; lock reclaimed, hook task orphaned`,
          );
        },
      );
    }
    cleanupModeSub();
    if (opts.throwOnExecutionError) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    // Terminal content per AgenC:
    //   aborted → INTERRUPT_MESSAGE_FOR_TOOL_USE
    //   otherwise → formatError (covers timeout, mcp, shell, tool_threw)
    const terminalContent =
      cls === "aborted"
        ? INTERRUPT_MESSAGE_FOR_TOOL_USE
        : formatError(err);
    return errorOutput({
      invocation,
      content: terminalContent,
      elapsedMs: performance.now() - startedAt,
    });
  }

  // Step 6: PostToolUse hooks.
  const postHooks = opts.postHooks ?? [];
  let finalDispatch = dispatch;
  if (postHooks.length > 0) {
    const postDecision = await runPostToolUseHooks(
      postHooks,
      {
        invocation,
        tool,
        args: inputForTool,
        result: finalDispatch,
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      },
      (err, idx) => {
        opts.onHookError?.("post", err, idx);
        emitHookAttachment(
          opts.eventLog,
          subId,
          "hook_error_during_execution",
          `PostToolUse:${tool.name} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
      opts.onHookTiming,
      // The signal in `base` is now RACED by the loop (not just plumbed):
      // a wedged post-hook resolves fail-safe `continue` (the tool already
      // ran) so this lock-wrapped fn() settles and releases the guard.
      (idx) => {
        emitHookAttachment(
          opts.eventLog,
          subId,
          "hook_cancelled",
          `PostToolUse:${tool.name}#${idx} cancelled (drain/timeout); rewritten result preserved (continue)`,
        );
      },
      (idx) => {
        emitHookAttachment(
          opts.eventLog,
          subId,
          "hook_orphaned",
          `PostToolUse:${tool.name}#${idx} ignored its cancel signal; lock reclaimed, hook task orphaned`,
        );
      },
    );
    finalDispatch = postDecision.result;
    for (const c of postDecision.additionalContexts) {
      emitHookAttachment(
        opts.eventLog,
        subId,
        "hook_additional_context",
        `PostToolUse:${tool.name} context: ${c}`,
      );
    }
    if (postDecision.additionalContexts.length > 0) {
      opts.onHookAdditionalContext?.(postDecision.additionalContexts);
    }
    for (const be of postDecision.blockingErrors) {
      emitHookAttachment(
        opts.eventLog,
        subId,
        "hook_blocking_error",
        `PostToolUse:${tool.name} blocking error: ${be}`,
      );
    }
    if (postDecision.kind === "stop") {
      shouldPreventContinuation = true;
      emitHookAttachment(
        opts.eventLog,
        subId,
        "hook_stopped_continuation",
        `PostToolUse:${tool.name} stopped execution${postDecision.stopReason ? `: ${postDecision.stopReason}` : ""}`,
      );
    } else if (postDecision.kind === "preventContinuation") {
      shouldPreventContinuation = true;
      emitHookAttachment(
        opts.eventLog,
        subId,
        "hook_stopped_continuation",
        `PostToolUse:${tool.name} prevented continuation${postDecision.stopReason ? `: ${postDecision.stopReason}` : ""}`,
      );
    }
  }

  // donor TS `shouldPreventContinuation` parity — when a PreToolUse
  // hook set `preventContinuation`, emit the attachment now that the
  // tool has actually run successfully.
  if (prePreventContinuation) {
    emitHookAttachment(
      opts.eventLog,
      subId,
      "hook_stopped_continuation",
      `PreToolUse:${tool.name} prevented continuation${prePreventContinuation.stopReason ? `: ${prePreventContinuation.stopReason}` : ""}`,
    );
  }

  // Step 7: I-15 result-size cap — now model-aware AND an OFFLOAD, not a
  // guillotine (Technique D). The effective cap scales to the dispatch
  // layer's context window so a single result can never overflow a
  // small-window model, while large-window models keep the fixed 400 KB
  // ceiling; a per-tool `tool.maxResultBytes` override still wins. When a
  // result exceeds the cap we now persist the FULL output to the session
  // tool-results store and inject a REFERENCE (head preview + path +
  // "read range to continue") instead of blindly truncating-and-losing —
  // so the data is recoverable via FileRead. Persist failure falls back
  // to the legacy truncation so the hard cap is always enforced.
  const maxResultBytes = computeEffectiveMaxResultBytes({
    content: finalDispatch.content,
    contextWindowTokens: opts.contextWindowTokens,
    toolMaxResultBytes: tool.maxResultBytes,
  });
  const capped = await offloadOrCapToolResult({
    content: finalDispatch.content,
    toolUseId: invocation.callId,
    maxBytes: maxResultBytes,
    bytesPerToken: bytesPerTokenForContent(finalDispatch.content),
    contextWindowTokens: opts.contextWindowTokens,
  });
  if (capped.truncated && opts.eventLog) {
    const disposition =
      capped.persistedPath !== undefined
        ? `offloaded to ${capped.persistedPath}`
        : `truncated to ${maxResultBytes}B`;
    emitWarningEvent(
      opts.eventLog,
      subId,
      "tool_result_truncated",
      `tool ${toolNameDisplay(invocation.toolName)} output ${capped.originalBytes}B ${disposition} (I-15)`,
    );
  }

  cleanupModeSub();
  if (finalDispatch.contentItems !== undefined && !capped.truncated) {
    const output = functionToolOutputFromContent({
      callId: invocation.callId,
      toolName: invocation.toolName,
      payload: invocation.payload,
      body: finalDispatch.contentItems,
      isError: finalDispatch.isError === true,
      durationMs: performance.now() - startedAt,
      ...(finalDispatch.metadata !== undefined
        ? { metadata: finalDispatch.metadata }
        : {}),
    });
    RICH_OUTPUT_CONTENT_ITEMS.set(output, finalDispatch.contentItems);
    if (finalDispatch.codeModeResult !== undefined) {
      STRUCTURED_CODE_MODE_RESULTS.set(output, finalDispatch.codeModeResult);
    }
    if (shouldPreventContinuation) {
      PREVENT_CONTINUATION_OUTPUTS.add(output);
    }
    return output;
  }
  const output = functionToolOutput({
    callId: invocation.callId,
    toolName: invocation.toolName,
    payload: invocation.payload,
    content: capped.content,
    isError: finalDispatch.isError === true,
    durationMs: performance.now() - startedAt,
    ...(finalDispatch.metadata !== undefined
      ? { metadata: finalDispatch.metadata }
      : {}),
  });
  if (finalDispatch.codeModeResult !== undefined) {
    STRUCTURED_CODE_MODE_RESULTS.set(output, finalDispatch.codeModeResult);
  }
  if (shouldPreventContinuation) {
    PREVENT_CONTINUATION_OUTPUTS.add(output);
  }
  return output;
}

export interface ExecuteToolDispatchOptions extends RunToolUseOptions {
  readonly rawArgs: string;
}

/**
 * Execute a single tool invocation and return just the
 * `ToolDispatchResult`. T6 removes the args-retry auto-fix loop per
 * `docs/plan/feature-matrix.md` — AgenC's auto-fix injects
 * lint/test output as PostToolUse `hook_additional_context`, it does
 * NOT re-dispatch with rewritten args.
 */
export async function executeToolDispatch(
  opts: ExecuteToolDispatchOptions,
): Promise<ToolDispatchResult> {
  const output = await runToolUse(opts.rawArgs, {
    ...opts,
    throwOnExecutionError: true,
  });
  return {
    content: output.content,
    isError: output.isError,
    codeModeResult: STRUCTURED_CODE_MODE_RESULTS.has(output)
      ? STRUCTURED_CODE_MODE_RESULTS.get(output)
      : codeModeResult(output),
    ...(RICH_OUTPUT_CONTENT_ITEMS.get(output) !== undefined
      ? { contentItems: RICH_OUTPUT_CONTENT_ITEMS.get(output)! }
      : {}),
    ...(PREVENT_CONTINUATION_OUTPUTS.has(output)
      ? { preventContinuation: true }
      : {}),
    metadata: output.metadata ? { ...output.metadata } : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function networkPolicyInterfacesFromInvocation(
  invocation: ToolInvocation,
): Partial<Pick<ApprovalCtx, "networkPolicyDecider" | "blockedRequestObserver">> {
  const network = invocation.turn.network;
  return {
    ...(network?.policyDecider !== undefined
      ? { networkPolicyDecider: network.policyDecider }
      : {}),
    ...(network?.blockedRequestObserver !== undefined
      ? { blockedRequestObserver: network.blockedRequestObserver }
      : {}),
  };
}

function errorOutput(opts: {
  readonly invocation: ToolInvocation;
  readonly content: string;
  readonly elapsedMs: number;
  readonly metadata?: Record<string, unknown>;
}): ToolOutput {
  return functionToolOutput({
    callId: opts.invocation.callId,
    toolName: opts.invocation.toolName,
    payload: opts.invocation.payload,
    content: opts.content,
    isError: true,
    durationMs: opts.elapsedMs,
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  });
}

async function recordRunToolPolicyAudit(
  opts: RunToolUseOptions,
  event: {
    readonly decision: "approved" | "denied";
    readonly source: string;
    readonly reasonCode: string;
  },
): Promise<void> {
  await recordPermissionAuditEvent(
    opts.permissionAuditLogger,
    {
      eventKind: "policy_outcome",
      decision: event.decision,
      source: event.source,
      subjectType: "tool_execution",
      toolName: opts.tool.name,
      callId: opts.invocation.callId,
      sessionId: readAuditSessionId(opts.invocation),
      reasonCode: event.reasonCode,
    },
    opts.onPermissionAuditError,
  );
}

function legacyApprovalDenyReasonCode(cause: string): string {
  if (cause.includes("abort")) return "aborted";
  if (cause === "stale_modal_decision") return "stale_modal_decision";
  return "denied_resolver";
}

function readAuditSessionId(
  invocation: ToolInvocation,
): string | undefined {
  if (
    typeof invocation !== "object" ||
    invocation === null ||
    !("session" in invocation)
  ) {
    return undefined;
  }
  const value = (
    (invocation as { readonly session?: unknown }).session as
      | { readonly conversationId?: unknown }
      | undefined
  )?.conversationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const AGENC_INTERNAL_ARG_PREFIX = "__agenc";

/**
 * Mirror of services/tools/toolExecution.ts's stripAgenCInternalArgs:
 * strip AgenC-only `__agenc*` context fields before public-schema
 * validation. Tool body still receives them on the original parsedArgs.
 */
function stripAgenCInternalArgsForValidation(
  input: Record<string, unknown>,
): Record<string, unknown> {
  let needed = false;
  for (const key of Object.keys(input)) {
    if (key.startsWith(AGENC_INTERNAL_ARG_PREFIX)) {
      needed = true;
      break;
    }
  }
  if (!needed) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith(AGENC_INTERNAL_ARG_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

export { toolNameDisplay };
export type { ToolName, ToolOutput, ToolPayload };
