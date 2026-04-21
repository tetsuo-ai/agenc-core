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
import {
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
  type HookTimingRecord,
  type PostToolUseFailureHook,
  type PostToolUseHook,
  type PreToolUseHook,
} from "./tool-hooks.js";
import type {
  CanUseToolFn,
  ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import type { PermissionMode } from "../permissions/types.js";
import type { PermissionModeRegistry } from "../permissions/mode.js";

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
    /**
     * T6 gap #119: optional EventLog + subId for `exec_approval_request`
     * emission. This is the single gate every tool-call approval flows
     * through, so emitting here gives rollouts a durable record of who
     * asked for approval on what and why.
     */
    readonly eventLog?: EventLog;
    readonly subId?: string;
    readonly callId?: string;
    /** Human-readable reason shown in the approval modal, if any. */
    readonly approvalReason?: string;
  },
): Promise<{ readonly allow: true } | { readonly allow: false; readonly cause: string }> {
  // I-21 fast-path: already aborted.
  if (opts.signal.aborted) {
    return { allow: false, cause: "aborted_before_approval" };
  }

  // T6 gap #119: emit `exec_approval_request` as soon as we're actually
  // racing the modal — this covers the real "we asked the user" moment.
  // `request_permissions` overlaps with this flow (same approval gate),
  // so we also emit a `request_permissions` view naming the tool +
  // declared permission scope. If a future permission model grows a
  // distinct surface, the new call sites should split from this.
  if (opts.eventLog) {
    const subId = opts.subId ?? opts.callId ?? "approval";
    const callId = opts.callId ?? opts.subId ?? "approval";
    const commandPreview = extractCommandPreview(opts.tool, opts.args);
    opts.eventLog.emit({
      id: subId,
      msg: {
        type: "exec_approval_request",
        payload: {
          callId,
          command: commandPreview,
          ...(opts.approvalReason !== undefined
            ? { reason: opts.approvalReason }
            : {}),
        },
      },
    });
    opts.eventLog.emit({
      id: subId,
      msg: {
        type: "request_permissions",
        payload: {
          callId,
          toolName: opts.tool.name,
          permissions: deriveToolPermissions(opts.tool),
        },
      },
    });
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

/**
 * T11 W3-B — AbortError/AbortController abort detection. The evaluator
 * throws a `DOMException("aborted", "AbortError")` when the caller
 * signals abort mid-evaluation; this helper lets `runToolUse` route
 * that case through the normal abort error path.
 */
function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "AbortError") return true;
  const code = (err as { code?: string }).code;
  if (code === "ABORT_ERR") return true;
  if (err instanceof Error && err.message.toLowerCase().includes("aborted")) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Lightweight JSON Schema validation (no ajv — just enough to enforce
// `required` + top-level field `type` + enum membership).
// ─────────────────────────────────────────────────────────────────────

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<SchemaValidationError>;
}

/**
 * Map a JavaScript value to its JSON Schema `type` name. BigInt is
 * treated as `integer` / `number` so the large-int reviver works with
 * `type: "integer"` schemas without special-casing.
 */
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

function typeMatches(
  expected: string,
  actualType: string,
): boolean {
  if (expected === actualType) return true;
  // Integer is a subset of number.
  if (expected === "number" && actualType === "integer") return true;
  return false;
}

/**
 * Validate `args` against a JSON Schema subset. Supports:
 *   - top-level object with `required: string[]`
 *   - per-property `type: string | string[]`
 *   - per-property `enum: unknown[]`
 *   - nested `properties` (recursive for nested objects only)
 *
 * Unknown / exotic keywords (`anyOf`, `$ref`, `format`, etc.) are
 * intentionally ignored — the goal is to catch glaring contract
 * violations (missing required field, wrong type) before the tool
 * runs, not to implement full JSON Schema semantics.
 */
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  if (!schema || typeof schema !== "object") {
    return { valid: true, errors: [] };
  }
  validateObject(schema, args, "", errors);
  return { valid: errors.length === 0, errors };
}

function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: SchemaValidationError[],
): void {
  const declaredType = schema["type"];
  if (typeof declaredType === "string" && declaredType !== "object") {
    // Top-level schema with `type:"object"` is the only shape we recurse
    // into; other top-level types short-circuit to a single type check.
    validateType(schema, value, path, errors);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (declaredType === "object") {
      errors.push({
        path: path || "(root)",
        message: `expected object, got ${schemaTypeOf(value)}`,
      });
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!(key in obj)) {
        errors.push({
          path: path ? `${path}.${key}` : key,
          message: `missing required field`,
        });
      }
    }
  }
  const properties = schema["properties"];
  if (properties && typeof properties === "object") {
    const propMap = properties as Record<string, unknown>;
    for (const [key, sub] of Object.entries(propMap)) {
      if (!(key in obj)) continue;
      if (!sub || typeof sub !== "object") continue;
      const childSchema = sub as Record<string, unknown>;
      const childPath = path ? `${path}.${key}` : key;
      const childVal = obj[key];
      validateType(childSchema, childVal, childPath, errors);
      const childType = childSchema["type"];
      if (childType === "object") {
        validateObject(childSchema, childVal, childPath, errors);
      }
    }
  }
}

function validateType(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: SchemaValidationError[],
): void {
  const declared = schema["type"];
  if (declared !== undefined) {
    const actual = schemaTypeOf(value);
    if (typeof declared === "string") {
      if (!typeMatches(declared, actual)) {
        errors.push({
          path: path || "(root)",
          message: `expected ${declared}, got ${actual}`,
        });
      }
    } else if (Array.isArray(declared)) {
      if (!declared.some((t) => typeof t === "string" && typeMatches(t, actual))) {
        errors.push({
          path: path || "(root)",
          message: `expected one of ${declared.join(",")}, got ${actual}`,
        });
      }
    }
  }
  const enumVals = schema["enum"];
  if (Array.isArray(enumVals) && enumVals.length > 0) {
    if (!enumVals.some((v) => v === value)) {
      errors.push({
        path: path || "(root)",
        message: `value not in enum`,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Progress events (A-side channel for long-running tools)
// ─────────────────────────────────────────────────────────────────────

/**
 * Structured progress chunk emitted by a tool while it runs. The
 * runtime forwards these via the session event log as
 * `tool_progress` events so TUI/telemetry consumers can render them.
 */
export interface ToolProgressEvent {
  readonly chunk: string;
  readonly stream?: "stdout" | "stderr" | "status";
}

export type ToolProgressCallback = (event: ToolProgressEvent) => void;

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
  /**
   * Optional pre/post/failure hook pipelines. `runToolUse` fires these
   * around the tool dispatch so every execution path — direct caller,
   * phases/execute-tools, code_mode, js_repl — shares one consistent
   * hook boundary.
   */
  readonly preHooks?: ReadonlyArray<PreToolUseHook>;
  readonly postHooks?: ReadonlyArray<PostToolUseHook>;
  readonly failureHooks?: ReadonlyArray<PostToolUseFailureHook>;
  readonly onHookTiming?: (record: HookTimingRecord) => void;
  readonly onHookError?: (
    phase: "pre" | "post" | "failure",
    err: unknown,
    idx: number,
  ) => void;
  /**
   * Optional progress callback. When the tool's `execute` is called
   * with an injected `onProgress` prop (second arg on the typed helper
   * or the `args.__onProgress` convention), each chunk is forwarded
   * through this callback AND emitted as a `tool_progress` event on
   * `eventLog` when supplied. Reserved so long-running tools (bash,
   * http, long-running MCP calls) can stream status without blocking
   * the caller promise.
   */
  readonly onProgress?: ToolProgressCallback;
  /**
   * When true, skip the lightweight JSON Schema validation step for
   * this specific call. Useful in testing or when the caller has
   * already validated args against a richer schema.
   */
  readonly skipArgValidation?: boolean;
  /**
   * T11 W3-B — permission evaluator injection.
   *
   * When supplied, `runToolUse` calls `canUseTool` (defaults to
   * `hasPermissionsToUseTool` from `permissions/evaluator`) BEFORE
   * invoking the tool's `execute()`. Wiring is pay-as-you-go: callers
   * that already run their own approval modal can skip this by leaving
   * `canUseTool` undefined — the `requestApproval` path remains
   * functional for back-compat.
   *
   *   - `behavior:'allow'` → proceed with (optionally updated) input
   *   - `behavior:'deny'`  → short-circuit with a typed error output
   *   - `behavior:'ask'`   → fall through to the existing
   *     `requestApproval` modal if one is supplied, otherwise deny
   */
  readonly canUseTool?: CanUseToolFn;
  /** Factory for the evaluator context. Required when `canUseTool` is set. */
  readonly permissionContext?: ToolEvaluatorContext;
  /**
   * I-3 mid-execution re-check. When supplied and a mode change occurs
   * mid-stream, the runtime aborts the in-flight tool via the supplied
   * AbortController if the new mode would strip the tool's permission
   * (currently: transitioning to `plan` aborts write-capable tools).
   */
  readonly modeChangeRegistry?: PermissionModeRegistry;
  /** Optional override for the mid-execution mode recheck. */
  readonly checkModeStillAllowed?: (
    tool: Tool,
    args: Record<string, unknown>,
    newMode: PermissionMode,
  ) => boolean;
  /** Optional abort controller invoked on a stricter-mode transition. */
  readonly abortController?: AbortController;
}

// ─────────────────────────────────────────────────────────────────────
// T11 W3-B — permission gate helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Names of tools that take a write-capable action on the host. Used by
 * the default mid-execution mode-change abort heuristic: a transition
 * into `plan` mode must abort any in-flight write. T13 will make the
 * classification more granular (e.g. per-argument for bash `read`
 * commands); T11 ships the coarse, safe list.
 */
const WRITE_CAPABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.bash",
  "system.writeFile",
  "system.editFile",
  "system.delete",
  "Bash",
  "write_file",
  "edit_file",
]);

/**
 * Default mid-execution mode-change recheck. Pragmatic per the T11
 * scope: a transition to `plan` aborts any write-capable tool in
 * flight. Other mode changes do not retroactively strip tools.
 */
export function defaultCheckModeStillAllowed(
  tool: Tool,
  _args: Record<string, unknown>,
  newMode: PermissionMode,
): boolean {
  if (newMode !== "plan") return true;
  if (WRITE_CAPABLE_TOOL_NAMES.has(tool.name)) return false;
  // Explicit opt-in on the Tool shape also blocks.
  if (tool.isReadOnly === true) return true;
  // Bash is the canonical non-read-only tool; default to read-only
  // otherwise so T11 doesn't surprise-abort unrelated tools.
  return true;
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

  // Step 1b: lightweight JSON Schema validation BEFORE approval/hooks
  // so a malformed request is surfaced as quickly as possible.
  if (!opts.skipArgValidation) {
    const validation = validateToolArgs(
      tool.inputSchema as Record<string, unknown> | undefined,
      parsedArgs,
    );
    if (!validation.valid) {
      const detail = validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ");
      const message = `schema validation failed for ${toolNameDisplay(invocation.toolName)}: ${detail}`;
      if (opts.eventLog) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "schema_validation_failed",
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

  // Step 1c: T11 W3-B — runtime permission gate. Runs BEFORE the
  // legacy approval modal so deny/ask decisions from rules, tool-level
  // checks, the mode gate, and the auto-mode classifier short-circuit
  // before we fall through to the user-facing prompt. The evaluator is
  // optional: callers that still use `requestApproval` alone get the
  // previous behavior.
  let inputForTool: Record<string, unknown> = parsedArgs;
  if (opts.canUseTool && opts.permissionContext) {
    try {
      const permResult = await opts.canUseTool(
        tool,
        parsedArgs,
        opts.permissionContext,
      );
      if (permResult.behavior === "deny") {
        const reasonMsg = permResult.message;
        const denialReasonType =
          permResult.decisionReason?.type ?? "unknown";
        if (opts.eventLog) {
          emitErrorEvent(opts.eventLog, subId, {
            cause: `permission_denied:${denialReasonType}`,
            message: `${toolNameDisplay(invocation.toolName)} denied: ${reasonMsg}`,
          });
        }
        return errorOutput({
          invocation,
          content: reasonMsg,
          elapsedMs: performance.now() - startedAt,
        });
      }
      if (permResult.behavior === "ask") {
        // Fall back to the legacy approval modal when a caller-provided
        // one is available; otherwise treat `ask` as a deny. T11 ships
        // this pragmatic seam — Wave 4 can add a richer pending-queue.
        if (!opts.requestApproval) {
          const message = permResult.message;
          if (opts.eventLog) {
            emitErrorEvent(opts.eventLog, subId, {
              cause: "permission_denied:ask_without_prompt",
              message: `${toolNameDisplay(invocation.toolName)} requires approval but no prompt is wired: ${message}`,
            });
          }
          return errorOutput({
            invocation,
            content: message,
            elapsedMs: performance.now() - startedAt,
          });
        }
      } else if (permResult.behavior === "allow") {
        if (permResult.updatedInput !== undefined) {
          inputForTool = permResult.updatedInput as Record<string, unknown>;
        }
      }
    } catch (err) {
      // AbortError from the evaluator surfaces through the normal abort
      // path; any other throw becomes a deny so we fail closed.
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
          content: `<tool_use_error>${message}</tool_use_error>`,
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

  // Step 2: I-21 + I-44 approval.
  if (opts.requestApproval) {
    const effectiveSignal = signal ?? new AbortController().signal;
    const decision = await requestApprovalWithAbortRace(opts.requestApproval, {
      tool,
      args: parsedArgs,
      currentTurnId,
      signal: effectiveSignal,
      ...(opts.eventLog !== undefined ? { eventLog: opts.eventLog } : {}),
      subId,
      callId: invocation.callId,
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

  // Step 2b: pre-tool-use hooks. `deny` short-circuits with an error
  // response; `skip` short-circuits with a synthesized result (used by
  // memoizing / cached hooks); otherwise arg mutations flow through to
  // the dispatch call. Starting args may have been updated by the
  // permission evaluator (W3-B) via `PermissionAllowDecision.updatedInput`.
  let args = inputForTool;
  const preHooks = opts.preHooks ?? [];
  if (preHooks.length > 0) {
    const preDecision = await runPreToolUseHooks(
      preHooks,
      { invocation, tool, args },
      (err, idx) => opts.onHookError?.("pre", err, idx),
      opts.onHookTiming,
    );
    if (preDecision.kind === "deny") {
      const message = `pre-hook denied ${toolNameDisplay(invocation.toolName)}: ${preDecision.reason}`;
      if (opts.eventLog) {
        emitErrorEvent(opts.eventLog, subId, {
          cause: "pre_hook_denied",
          message,
        });
      }
      return errorOutput({
        invocation,
        content: message,
        elapsedMs: performance.now() - startedAt,
      });
    }
    if (preDecision.kind === "skip") {
      return functionToolOutput({
        callId: invocation.callId,
        toolName: invocation.toolName,
        payload: invocation.payload,
        content: preDecision.synthResult.content,
        isError: preDecision.synthResult.isError === true,
        durationMs: performance.now() - startedAt,
      });
    }
    if (preDecision.args) args = preDecision.args;
  }

  // Progress channel — each chunk is forwarded to the caller's
  // `onProgress` callback AND re-emitted on the event log (if any) as
  // a `tool_progress` event.
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
                  at: Date.now(),
                },
              },
            });
          }
        }
      : undefined;

  // Inject onProgress into the args under the reserved key
  // `__onProgress` when the callback is present. Tools that know about
  // it (bash) read the callback; tools that don't simply ignore it.
  // We define it as NON-ENUMERABLE so `Object.keys(args)` /
  // deep-equality checks / schema validators never see it — callers can
  // still retrieve it via direct key access.
  let argsForTool: Record<string, unknown> = args;
  if (progressCallback) {
    argsForTool = { ...args };
    Object.defineProperty(argsForTool, "__onProgress", {
      value: progressCallback,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }

  // Step 3: I-9 timeout + abort race.
  const timeoutMs = resolveTimeoutMs(tool, args);

  // T11 W3-B — I-3 mid-execution re-check. If the caller supplied a
  // `modeChangeRegistry` (and an `abortController` to pair with),
  // subscribe to mode-change notifications. When the new mode would
  // strip this tool's permission (currently: plan-mode vs. write-
  // capable tool), fire the abort controller so the in-flight tool
  // bails via the AbortSignal path in `withTimeoutAndAbort`.
  let unsubscribeMode: (() => void) | null = null;
  if (opts.modeChangeRegistry && opts.abortController) {
    const guard =
      opts.checkModeStillAllowed ?? defaultCheckModeStillAllowed;
    const abortCtl = opts.abortController;
    unsubscribeMode = opts.modeChangeRegistry.subscribeToModeChange(
      (newMode) => {
        if (abortCtl.signal.aborted) return;
        const stillAllowed = guard(tool, args, newMode);
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

  // T11 W3-B — helper that releases the mode-change subscription on
  // every return path below.
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
    // Fire failure hooks for observability — purely observational, does
    // not change the error result returned to the caller.
    const failureHooks = opts.failureHooks ?? [];
    if (failureHooks.length > 0) {
      await runPostToolUseFailureHooks(
        failureHooks,
        {
          invocation,
          tool,
          args,
          error: err,
          isInterrupt: cls === "aborted",
        },
        (hookErr, idx) => opts.onHookError?.("failure", hookErr, idx),
        opts.onHookTiming,
      );
    }
    cleanupModeSub();
    return errorOutput({
      invocation,
      content: `<tool_use_error>${message}</tool_use_error>`,
      elapsedMs: performance.now() - startedAt,
    });
  }

  // Step 3b: post-tool-use hooks — `rewrite` replaces the result for
  // subsequent hooks AND the returned output. `retry` is surfaced up
  // to the caller via the runtime-level auto-fix loop; runToolUse
  // itself never re-dispatches.
  const postHooks = opts.postHooks ?? [];
  let finalDispatch = dispatch;
  if (postHooks.length > 0) {
    const postDecision = await runPostToolUseHooks(
      postHooks,
      { invocation, tool, args, result: finalDispatch },
      (err, idx) => opts.onHookError?.("post", err, idx),
      opts.onHookTiming,
    );
    if (postDecision.kind === "retry") {
      // Runtime-level retry is handled by `runWithAutoFixRetry`; here
      // we just surface the base dispatch as-is with metadata noting
      // that a retry was requested so the caller can decide.
      if (opts.eventLog) {
        emitWarningEvent(
          opts.eventLog,
          subId,
          "post_tool_hook_retry_requested",
          `post-hook requested retry for ${toolNameDisplay(invocation.toolName)}`,
        );
      }
    } else if (postDecision.result) {
      finalDispatch = postDecision.result;
    }
  }

  // Step 4: I-15 result-size cap.
  const maxResultBytes =
    tool.maxResultBytes !== undefined && tool.maxResultBytes > 0
      ? tool.maxResultBytes
      : DEFAULT_MAX_TOOL_RESULT_BYTES;
  const capped = capToolResult(finalDispatch.content, maxResultBytes);
  if (capped.truncated && opts.eventLog) {
    emitWarningEvent(
      opts.eventLog,
      subId,
      "tool_result_truncated",
      `tool ${toolNameDisplay(invocation.toolName)} output ${capped.originalBytes}B truncated to ${maxResultBytes}B (I-15)`,
    );
  }

  cleanupModeSub();
  return functionToolOutput({
    callId: invocation.callId,
    toolName: invocation.toolName,
    payload: invocation.payload,
    content: capped.capped,
    isError: finalDispatch.isError === true,
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

/**
 * T6 gap #119: best-effort preview for the `command` field on
 * `exec_approval_request`. Tools vary — bash stores the command in
 * `args.command`, others may use `args.cmd` / `args.path`. We fall
 * back to the tool name when nothing matches so the event stays valid.
 */
function extractCommandPreview(
  tool: Tool,
  args: Record<string, unknown>,
): string {
  const candidates = ["command", "cmd", "path", "url"];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value.slice(0, 256);
    }
  }
  return tool.name;
}

/**
 * T6 gap #119: surface the tool's declared permissions if the Tool
 * shape exposes them. Today the Tool interface does not include a
 * structured permission field, so we fall back to `["execute"]` — a
 * single coarse permission covering the actual call. When T11 lands
 * the full permission model this should switch to the real scopes.
 */
function deriveToolPermissions(tool: Tool): ReadonlyArray<string> {
  const declared = (tool as unknown as { readonly permissions?: unknown })
    .permissions;
  if (Array.isArray(declared) && declared.every((p) => typeof p === "string")) {
    return declared as ReadonlyArray<string>;
  }
  return ["execute"];
}

export { toolNameDisplay };
export type { ToolName, ToolOutput, ToolPayload };
