/**
 * StreamingToolExecutor — full AgenC port.
 *
 * Hand-port of the reference streaming tool executor.
 * Dispatches tools as they stream in from the model, with four-class
 * concurrency control (via the T7 `classify` analyzer) + sibling-
 * abort cascade on Bash errors + order-preserving yield of completed
 * results + AgenC-compatible progress interleaving, unknown-tool
 * short-circuit, head-of-line break, per-tool `interruptBehavior`
 * gating, and child → parent abort bubble-up.
 *
 * T6 closure parity pointers (direct code references):
 *   - `discard()` flips a boolean only, no synthesis:
 *     reference `StreamingToolExecutor.ts:69-71`.
 *   - Yield paths early-return on `discarded`:
 *     reference `StreamingToolExecutor.ts:412-415, :454-456`.
 *   - Unknown-tool pre-synthesis:
 *     reference `StreamingToolExecutor.ts:77-102`.
 *   - `createChildAbortController` + bubble-up on non-`sibling_error`:
 *     reference `StreamingToolExecutor.ts:301-318`.
 *   - Head-of-line stop (non-safe executing tool blocks downstream):
 *     reference `StreamingToolExecutor.ts:436-438`.
 *   - `Promise.race` wake-up (executingPromises + progressPromise):
 *     reference `StreamingToolExecutor.ts:453-490`.
 *   - Progress interleaved into result stream:
 *     reference `StreamingToolExecutor.ts:366-378, :419-422`.
 *   - `interruptBehavior()` per-tool interrupt gating:
 *     reference `StreamingToolExecutor.ts:219-241, :254-260`.
 *
 * Invariants wired here:
 *   I-8  (every error site emits a typed event) — synthetic error
 *        results include a `tool_result` marker the caller surfaces.
 *   I-9  (per-tool execution timeout) — delegated to `execution.ts`
 *        via the supplied `runToolUseFn`.
 *   I-15 (tool result size cap) — delegated to `execution.ts`.
 *   I-21 (approval modal abort race) — `execution.ts` wraps modal +
 *        the per-tool AbortController is a child of the session signal.
 *   I-41 (abort re-entrance guard) — `isAborting` flag; second
 *        `discard()` call while already aborting returns immediately.
 *   I-65 (tool result completion ordering) — yields in submission
 *        order via `getCompletedResults`.
 *
 * State machine:
 *   queued   → executeTool → executing
 *   executing → collectResults → completed
 *   completed → getCompletedResults → yielded
 *
 * @module
 */

import type { LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type {
  ConcurrencyClass,
  ConcurrencyClassifiable,
  ToolCallRuntime,
} from "./concurrency.js";
import {
  EXCLUSIVE,
  classify,
  defaultConcurrencyClassFor,
  sharedServer,
} from "./concurrency.js";
import {
  toolCallFromLLMToolCall,
  type LiveToolDispatchOptions,
  type ToolRouter,
} from "./router.js";
import { canonicalModelToolName } from "./model-tool-aliases.js";
import { resolveTimeoutMs } from "./execution.js";
import type { ToolUseBlock } from "../session/turn-state.js";
import type { Tool } from "./types.js";
import {
  buildTerminalToolResult,
  terminalToolCauseFromAbortReason,
  terminalToolCauseFromError,
  type TerminalToolCause,
} from "../recovery/terminal-tool-result.js";
import {
  runtimeKindForPayload,
  type ToolRuntimeCallContext,
} from "./runtimes/context.js";
import {
  runToolRuntimeCall,
  type ToolRuntimeScheduler,
} from "./runtimes/parallel.js";
import { asRecord } from "../utils/record.js";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type ToolStatus = "queued" | "executing" | "completed" | "yielded";

export interface TrackedTool {
  readonly id: string;
  readonly block: ToolUseBlock;
  readonly toolCall: LLMToolCall;
  readonly classifiable: ConcurrencyClassifiable;
  readonly classification: ConcurrencyClass;
  status: ToolStatus;
  isConcurrencySafe: boolean;
  hasDispatched: boolean;
  cancelBeforeDispatch?: SyntheticErrorReason;
  promise?: Promise<void>;
  result?: ToolDispatchResult;
  additionalContexts?: readonly string[];
  error?: Error;
  /**
   * Monotonic timestamp (performance.now) captured when the tool
   * transitioned to `executing`. Used by the drain watchdog to bound how
   * long a single tool may sit `executing` before the executor synthesizes
   * a terminal `timeout` result so the turn can finalize even if the tool's
   * dispatch promise never settles.
   */
  executingSinceMs?: number;
  /**
   * Per-tool, listener-free cancel controller created in runOne. Composed into
   * the dispatch signal via `AbortSignal.any`. The drain backstop fires THIS
   * (never childAbort, never siblingAbortController) to cancel exactly one
   * wedged tool's dispatch without bubbling to the turn or cascading to
   * siblings. Set in runOne immediately after childAbort.
   */
  drainCancel?: AbortController;
  /**
   * First-settle-wins latch. Set true by `finalizeOnce`. Once true, every later
   * terminal write (the wedged runOne's late settle) is a no-op: no result
   * overwrite, no status flip-back, no sibling-cascade revival.
   */
  finalized?: boolean;
  /**
   * Reclaim outcome for a force-finalized tool. "running" until force-final;
   * "reclaimed" if the dispatch unwound within the cleanup grace (lock/permit
   * released by its own finally); "leaked" if the grace expired (uncooperative
   * work — lock/permit may still be held). Observability only.
   */
  outcome?: "running" | "reclaimed" | "leaked";
  /**
   * Detach closure for this tool's onParentAbort + onChildAbort listeners.
   * runOne's finally calls it on normal settle; force-finalize calls it on a
   * wedged tool so a never-settling runOne does not leak its two listeners.
   * Idempotent.
   */
  detachAbortListeners?: () => void;
  /** Progress events buffered for immediate streaming. */
  readonly pendingProgress: ProgressEvent[];
}

export interface ProgressEvent {
  readonly toolCallId: string;
  readonly message: string;
  readonly at: number;
}

/**
 * A single value yielded from the executor's terminal result streams.
 * Terminal outcomes only — progress is yielded separately via
 * `StreamingToolUpdate` from the unified `getCompletedUpdates` /
 * `getRemainingUpdates` iterators.
 */
export interface StreamingToolResult {
  readonly toolCall: LLMToolCall;
  readonly result: ToolDispatchResult;
  readonly additionalContexts?: readonly string[];
  readonly status: "completed" | "synthetic_error";
  readonly durationMs: number;
}

/**
 * AgenC behavior union: either a terminal tool result or an inline
 * progress event. Mirrors `MessageUpdate` in
 * `services/tools/StreamingToolExecutor.ts`. Used by the "updates"
 * iterators that yield progress + results interleaved in submission
 * order.
 */
export type StreamingToolUpdate =
  | { readonly kind: "result"; readonly result: StreamingToolResult }
  | {
      readonly kind: "progress";
      readonly toolCall: LLMToolCall;
      readonly progress: ProgressEvent;
    };

export type SyntheticErrorReason =
  | TerminalToolCause
  | "sibling_error"
  | "streaming_fallback";

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(value);
}

/**
 * Default drain FLOOR. The effective per-tool drain deadline is
 * `max(this.maxToolDrainMs, toolEffectiveTimeoutMs + DRAIN_GRACE_MS)`, so this
 * value is only the lower bound applied to tools with an explicit timeout.
 * Tools that resolve to a LARGER own timeout (a long `bash` with
 * `args.timeoutMs`, or a `tool.timeoutMs` > floor) raise their deadline above
 * this floor, and tools with `timeoutBehavior:"tool"` (request-user-input,
 * wait, monitor, background — intentionally unbounded) are EXEMPT from the
 * backstop entirely and rely on the abort signal as their only stop.
 *
 * Chosen well above ordinary explicit tool timeouts so the normal path is
 * never tripped—only a timed dispatch that never settles. Override via env `AGENC_MAX_TOOL_DRAIN_MS`
 * (positive integer) or the `maxToolDrainMs` constructor option. `0` /
 * non-positive disables the backstop (restores the prior unbounded behavior).
 */
const DEFAULT_MAX_TOOL_DRAIN_MS = 180_000;

/**
 * Headroom added to a tool's own effective timeout when deriving its drain
 * deadline. Covers the tool's own timeout-abort settling plus pre/post-hook,
 * permission/guardian, and concurrency-lock latency that sit OUTSIDE the
 * `tool.execute` timed region. So a 600s `bash` gets a 660s drain deadline,
 * not a 600s one — the backstop only fires once the tool is past its own
 * deadline AND the surrounding pipeline has also had time to settle.
 */
const DRAIN_GRACE_MS = 60_000;

function normalizeMaxToolDrainMs(value: number | undefined): number {
  if (value !== undefined) {
    if (!Number.isFinite(value) || value <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(value);
  }
  const raw = process.env.AGENC_MAX_TOOL_DRAIN_MS;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
    return n;
  }
  return DEFAULT_MAX_TOOL_DRAIN_MS;
}

// ─────────────────────────────────────────────────────────────────────
// Adaptive drain-deadline knobs (Goal #4a). All follow the
// `normalizeMaxToolDrainMs` precedent: explicit constructor option →
// `AGENC_*` env override → default; invalid input falls back to the default.
// Off-by-default for the first ship (`AGENC_ADAPTIVE_DRAIN` unset == OFF), so
// the deadline is byte-identical to today while the store warms up silently.
// ─────────────────────────────────────────────────────────────────────

/** Master enable; OFF unless explicitly opted in. Default false. */
const DEFAULT_ADAPTIVE_DRAIN_ENABLED = false;
/** `candidate = estimate * margin + grace`. Default 1.5. */
const DEFAULT_ADAPTIVE_DRAIN_MARGIN_MULT = 1.5;
/** Absolute hard floor; `lo = max(own + grace, this)`. Default 30s. */
const DEFAULT_ADAPTIVE_DRAIN_SAFE_MIN_MS = 30_000;
/** Runaway-raise ceiling; `hi = max(maxDrain, own + grace) * this`. Default 4. */
const DEFAULT_ADAPTIVE_DRAIN_RAISE_CAP = 4;

function normalizeAdaptiveDrainEnabled(value: boolean | undefined): boolean {
  if (value !== undefined) return value;
  const raw = process.env.AGENC_ADAPTIVE_DRAIN;
  if (raw === undefined) return DEFAULT_ADAPTIVE_DRAIN_ENABLED;
  const t = raw.trim().toLowerCase();
  if (t === "1" || t === "true" || t === "yes" || t === "on") return true;
  if (t === "0" || t === "false" || t === "no" || t === "off" || t === "") {
    return false;
  }
  return DEFAULT_ADAPTIVE_DRAIN_ENABLED;
}

function normalizePositiveNumber(
  value: number | undefined,
  envRaw: string | undefined,
  fallback: number,
): number {
  if (value !== undefined) {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return value;
  }
  if (envRaw !== undefined) {
    const n = Number.parseFloat(envRaw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  }
  return fallback;
}

/**
 * Reason string fired on a wedged tool's per-tool `drainCancel` when the drain
 * backstop force-finalizes it. Chosen so the EXISTING mapper resolves it to the
 * SAME terminal cause the backstop synthesizes:
 * `terminalToolCauseFromAbortReason` (recovery/terminal-tool-result.ts) matches
 * any reason starting with "tool timeout:" → TerminalToolCause "timeout". Keeping
 * the cancel reason and the synthesized cause identical means the cancel-driven
 * rejection (if it ever reached the dispatch's own catch) and the backstop's
 * synthetic result agree on cause. A drain overrun IS a timeout — the active
 * cancel is the mechanism, not a new cause.
 */
const DRAIN_CANCEL_REASON = "tool timeout: drain exceeded" as const;

/**
 * Bounded window to wait for cooperative teardown (lock/permit/hook release)
 * AFTER firing `drainCancel`, before declaring a hard leak. DISTINCT from
 * `maxToolDrainMs` (which decides "this tool is wedged"). Conflating them
 * either denies cleanup a chance or re-hangs the turn. Override via the
 * `cleanupGraceMs` constructor option.
 */
const DRAIN_CLEANUP_GRACE_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────

export interface StreamingToolExecutorOptions {
  readonly registry: ToolRegistry;
  /** Maximum number of simultaneously executing tool calls. */
  readonly maxConcurrency?: number;
  /**
   * Hard upper bound (ms) on how long a single tool may sit `executing`
   * inside the drain before the executor gives up waiting on it and
   * synthesizes a terminal `timeout` result so the turn can finalize.
   *
   * This is a LAST-RESORT backstop for a dispatch promise that never
   * settles — e.g. a wedged pre/post-hook, a runtime-lock that is never
   * released, or any await OUTSIDE the per-tool `tool.execute` timeout
   * (execution.ts `withTimeoutAndAbort`). Without it, a single hung
   * dispatch pins `executeTools` -> `getRemainingResults` forever and the
   * turn never emits `turn_complete` (observed: a Read `tool_call_started`
   * with no `tool_call_completed`, the turn "still generating" for minutes).
   *
   * Defaults well above the per-tool execute timeout so the normal path is
   * never affected; only a genuinely stuck tool trips it.
   */
  readonly maxToolDrainMs?: number;
  /**
   * Adaptive per-tool drain deadline (Goal #4a). When enabled, the drain
   * deadline for a finite-own, locally-defined tool is derived from the
   * session's `ToolLatencyStore` tail estimate (clamped to never drop below
   * `own + DRAIN_GRACE_MS` / `adaptiveDrainSafeMinMs`). Default OFF: the
   * deadline is byte-identical to today's flat formula. Mirrors env
   * `AGENC_ADAPTIVE_DRAIN`.
   */
  readonly adaptiveDrainEnabled?: boolean;
  /** `candidate = estimate * this + grace`. Default 1.5 / `AGENC_DRAIN_MARGIN_MULT`. */
  readonly adaptiveDrainMarginMult?: number;
  /** Absolute hard floor; `lo = max(own + grace, this)`. Default 30000 / `AGENC_DRAIN_SAFE_MIN_MS`. */
  readonly adaptiveDrainSafeMinMs?: number;
  /** Runaway-raise ceiling multiplier. Default 4 / `AGENC_DRAIN_RAISE_CAP`. */
  readonly adaptiveDrainRaiseCap?: number;
  /** Session-scoped AbortSignal (user Ctrl+C, provider switch). */
  readonly abortSignal?: AbortSignal;
  /**
   * Parent tool-use context abort controller. When provided, the
   * executor wires the AgenC child-abort bubble-up (AgenC
   * `StreamingToolExecutor.ts:301-318`): permission-dialog reject /
   * ExitPlanMode "clear+auto" aborts the per-tool child controller
   * for a non-`sibling_error` reason, which bubbles up and aborts
   * this parent so the turn loop ends cleanly instead of sending
   * REJECT_MESSAGE back to the model (#21056 regression).
   */
  readonly parentAbortController?: AbortController;
  /** Optional runtime; when present, dispatch is wrapped by the
   *  per-call runtime scheduler (concurrency guard + call context). */
  readonly runtime?: ToolCallRuntime | ToolRuntimeScheduler;
  /**
   * Invoked once per force-finalized tool that did NOT release within the
   * cleanup grace (outcome="leaked"). Observability only; must not throw.
   */
  readonly onLeakedTool?: (info: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly concurrencyKind: ConcurrencyClass["kind"];
    readonly reason: string;
    readonly msSinceExecuting: number;
  }) => void;
  /** Override DRAIN_CLEANUP_GRACE_MS (ms). Non-positive falls back to the default. */
  readonly cleanupGraceMs?: number;
  /** Fires on Bash sibling-abort cascade or other diagnostic events. */
  readonly onSiblingAbort?: (reason: string) => void;
  /** Fired per progress event (TUI rendering hook). */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Name of the Bash tool in this registry — matches AgenC
   *  `BASH_TOOL_NAME`. Only this tool's error triggers the sibling-
   *  abort cascade (AgenC rationale: Bash has implicit
   *  dependency chains; independent tools don't). */
  readonly bashToolName?: string;
  /**
   * Optional per-tool dispatch override. Test and compatibility integration
   * seam for callers that already provide a guarded dispatch pipeline.
   * Production model-tool dispatchers must prefer `liveToolDispatch`.
   */
  readonly runToolUseFn?: (
    toolCall: LLMToolCall,
    signal: AbortSignal,
  ) => Promise<ToolDispatchResult>;
  /** Live runtime cutover path: executor owns router/orchestrator/execution dispatch. */
  readonly liveToolDispatch?: {
    readonly router: ToolRouter;
    readonly options: Omit<LiveToolDispatchOptions, "signal" | "onProgress">;
  };
}

// ─────────────────────────────────────────────────────────────────────
// StreamingToolExecutor
// ─────────────────────────────────────────────────────────────────────

export class StreamingToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly onSiblingAbort?: (reason: string) => void;
  private readonly onProgress?: (event: ProgressEvent) => void;
  private readonly maxConcurrency: number;
  private readonly maxToolDrainMs: number;
  /** Goal #4a adaptive drain knobs (resolved once at construction). */
  private readonly adaptiveDrainEnabled: boolean;
  private readonly adaptiveDrainMarginMult: number;
  private readonly adaptiveDrainSafeMinMs: number;
  private readonly adaptiveDrainRaiseCap: number;
  private readonly siblingAbortController: AbortController;
  private readonly bashToolName: string;
  private readonly runtime?: ToolCallRuntime | ToolRuntimeScheduler;
  private readonly onLeakedTool?: StreamingToolExecutorOptions["onLeakedTool"];
  private readonly cleanupGraceMs: number;
  private leakedToolCount = 0;
  private readonly runToolUseFn?: (
    toolCall: LLMToolCall,
    signal: AbortSignal,
  ) => Promise<ToolDispatchResult>;
  private readonly liveToolDispatch?: {
    readonly router: ToolRouter;
    readonly options: Omit<LiveToolDispatchOptions, "signal" | "onProgress">;
  };
  /**
   * Parent tool-use context abort controller. When present, represents
   * the session/query-level controller. Child-abort bubble-up
   * (AgenC :304-318) re-aborts this controller for non
   * `sibling_error` reasons so the turn loop ends instead of sending
   * REJECT_MESSAGE back to the model.
   */
  private readonly parentAbortController: AbortController | null;
  private readonly tools: TrackedTool[] = [];
  private closed = false;
  /** I-41 abort re-entrance guard. Second `discard()` while already
   *  aborting returns immediately so cleanup handlers that emit
   *  abort-like errors don't cause infinite synthesis. */
  private isAborting = false;
  /**
   * AgenC behavior (`StreamingToolExecutor.ts:49`): `discard()`
   * flips this flag. All result iterators (`getCompletedResults`,
   * `getRemainingResults`, `*Updates` variants) early-return when
   * true. The executor does NOT synthesize fallback results — the
   * caller abandons the output stream instead.
   */
  private discarded = false;
  private discardReason: string | null = null;
  private hasBashErrored = false;
  /** Wake-up signal for getRemainingResults. */
  private wakeResolve: (() => void) | null = null;
  private lastDispatchedIndex = -1;
  private readonly abortSignalCleanups = new Map<AbortSignal, () => void>();

  constructor(opts: StreamingToolExecutorOptions) {
    this.registry = opts.registry;
    this.onSiblingAbort = opts.onSiblingAbort;
    this.onProgress = opts.onProgress;
    this.maxConcurrency = normalizeMaxConcurrency(opts.maxConcurrency);
    this.maxToolDrainMs = normalizeMaxToolDrainMs(opts.maxToolDrainMs);
    this.adaptiveDrainEnabled = normalizeAdaptiveDrainEnabled(
      opts.adaptiveDrainEnabled,
    );
    this.adaptiveDrainMarginMult = normalizePositiveNumber(
      opts.adaptiveDrainMarginMult,
      process.env.AGENC_DRAIN_MARGIN_MULT,
      DEFAULT_ADAPTIVE_DRAIN_MARGIN_MULT,
    );
    this.adaptiveDrainSafeMinMs = normalizePositiveNumber(
      opts.adaptiveDrainSafeMinMs,
      process.env.AGENC_DRAIN_SAFE_MIN_MS,
      DEFAULT_ADAPTIVE_DRAIN_SAFE_MIN_MS,
    );
    this.adaptiveDrainRaiseCap = normalizePositiveNumber(
      opts.adaptiveDrainRaiseCap,
      process.env.AGENC_DRAIN_RAISE_CAP,
      DEFAULT_ADAPTIVE_DRAIN_RAISE_CAP,
    );
    this.bashToolName = opts.bashToolName ?? "system.bash";
    this.runtime = opts.runtime;
    this.onLeakedTool = opts.onLeakedTool;
    this.cleanupGraceMs =
      opts.cleanupGraceMs && opts.cleanupGraceMs > 0
        ? opts.cleanupGraceMs
        : DRAIN_CLEANUP_GRACE_MS;
    this.runToolUseFn = opts.runToolUseFn;
    this.liveToolDispatch = opts.liveToolDispatch;
    this.parentAbortController = opts.parentAbortController ?? null;
    this.siblingAbortController = new AbortController();
    this.attachAbortSignal(opts.abortSignal);
  }

  attachAbortSignal(signal?: AbortSignal): void {
    if (
      !signal ||
      this.siblingAbortController.signal.aborted ||
      this.abortSignalCleanups.has(signal)
    ) {
      return;
    }
    if (signal.aborted) {
      this.siblingAbortController.abort(signal.reason);
      this.signalProgress();
      return;
    }
    const onAbort = () => {
      this.abortSignalCleanups.delete(signal);
      if (!this.siblingAbortController.signal.aborted) {
        this.siblingAbortController.abort(signal.reason);
        this.signalProgress();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.abortSignalCleanups.set(signal, () => {
      signal.removeEventListener("abort", onAbort);
    });
  }

  private detachAbortSignals(): void {
    for (const cleanup of this.abortSignalCleanups.values()) {
      cleanup();
    }
    this.abortSignalCleanups.clear();
  }

  /**
   * Queue a tool call. Dispatches as soon as the concurrency gate
   * allows. Non-concurrent-safe tools block the queue until all
   * running safe tools finish (AgenC semantics).
   *
   * AgenC behavior: when the tool name is unknown (not in the
   * registry AND no `concurrencyClassOverride` set for tests), we
   * pre-synthesize a deterministic `No such tool available` terminal
   * result and mark the tracked tool `completed`. That guarantees
   * every `tool_use` block receives a paired `tool_result` and keeps
   * the model from seeing orphaned tool calls on the next turn.
   */
  addTool(block: ToolUseBlock, toolCall: LLMToolCall): void {
    if (this.closed || this.isAborting) {
      // Defensive: a `tool_call_started` event has already been emitted
      // by `queueStreamingToolCall` upstream by the time we reach
      // `addTool`. Returning silently here orphans that event — the
      // TUI shows a tool_call line, no tool_result line ever follows,
      // the model on the next iteration sees no result for the call,
      // and re-emits it. That was the pwd-storm bug. Push a synthetic
      // `completed` tracked entry so the upstream result-emission
      // contract holds: every tool_call_started gets a paired
      // tool_call_completed, even if the executor is closed.
      const reason = this.isAborting ? "aborting" : "closed";
      const syntheticResult: ToolDispatchResult = {
        content: JSON.stringify({
          tool_use_id: toolCall.id,
          is_error: true,
          content: `<tool_use_error>Internal error: tool dispatch attempted on a ${reason} executor for ${toolCall.name}. The runtime did not run the tool. This is a runtime bug; please report it.</tool_use_error>`,
        }),
        isError: true,
      };
      const classifiable = this.resolveClassifiable(toolCall);
      const tracked: TrackedTool = {
        id: toolCall.id,
        block,
        toolCall,
        classifiable,
        classification: classify(classifiable, {}),
        status: "completed",
        isConcurrencySafe: true,
        hasDispatched: false,
        result: syntheticResult,
        error: new Error(
          `addTool called on ${reason} executor for ${toolCall.name}`,
        ),
        pendingProgress: [],
      };
      this.tools.push(tracked);
      this.signalProgress();
      return;
    }

    // Unknown-tool short-circuit (AgenC StreamingToolExecutor.ts:77-102).
    const isKnown = this.isKnownToolCall(toolCall);
    if (!isKnown) {
      const syntheticResult: ToolDispatchResult = {
        content: JSON.stringify({
          tool_use_id: toolCall.id,
          is_error: true,
          content: `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`,
        }),
        isError: true,
      };
      const classifiable = this.resolveClassifiable(toolCall);
      const tracked: TrackedTool = {
        id: toolCall.id,
        block,
        toolCall,
        classifiable,
        classification: classify(classifiable, {}),
        status: "completed",
        isConcurrencySafe: true,
        hasDispatched: false,
        result: syntheticResult,
        error: new Error(`No such tool available: ${toolCall.name}`),
        pendingProgress: [],
      };
      this.tools.push(tracked);
      this.signalProgress();
      return;
    }

    const classifiable = this.resolveClassifiable(toolCall);
    const parsedArgs = parseToolCallArguments(toolCall.arguments);
    const classification = classify(classifiable, parsedArgs);
    // AgenC tracks a per-call `isConcurrencySafe` boolean derived
    // from the tool's `isConcurrencySafe(args)` hook. We keep the T7
    // classification model but also cache the boolean so the
    // head-of-line-break logic in `getCompletedResults` matches
    // reference `:436-438` semantics exactly.
    const resolvedName = this.resolveModelToolName(toolCall.name);
    const tool = this.registry.tools.find((t) => t.name === resolvedName);
    let concurrencySafe = false;
    if (tool?.isConcurrencySafe) {
      try {
        concurrencySafe = Boolean(tool.isConcurrencySafe(parsedArgs));
      } catch {
        concurrencySafe = false;
      }
    } else {
      concurrencySafe =
        classification.kind === "shared_read" ||
        classification.kind === "shared_server" ||
        classification.kind === "background_terminal";
    }
    const tracked: TrackedTool = {
      id: toolCall.id,
      block,
      toolCall,
      classifiable,
      classification,
      status: "queued",
      isConcurrencySafe: concurrencySafe,
      hasDispatched: false,
      pendingProgress: [],
    };
    this.tools.push(tracked);
  }

  /**
   * Close the queue — no further `addTool` accepted. Running tools
   * finish; `getRemainingResults` ends after drain.
   */
  close(): void {
    this.closed = true;
    this.signalProgress();
  }

  /**
   * Discard all pending + in-progress tools. Called when streaming
   * fallback fires and the whole batch should be abandoned.
   *
   * AgenC behavior (`StreamingToolExecutor.ts:69-71`): `discard()`
   * flips `this.discarded = true` and does NOT synthesize results —
   * the caller (query.ts-equivalent) is responsible for abandoning
   * the output stream. All yield paths (`getCompletedResults`,
   * `getRemainingResults`, updates variants) early-return when
   * `discarded` is true.
   *
   * Recovery cleanup still needs to interrupt running handlers. Mark
   * the executor discarded before aborting the sibling controller so
   * child abort listeners do not bubble this recovery cleanup into the
   * parent turn controller.
   *
   * I-41 re-entrance guard: a second `discard()` while already
   * discarding is a no-op.
   */
  discard(reason = "discarded"): void {
    if (this.isAborting) return;
    this.isAborting = true;
    this.discarded = true;
    this.discardReason = reason;
    this.closed = true;
    if (!this.siblingAbortController.signal.aborted) {
      this.siblingAbortController.abort(reason);
    }
    this.signalProgress();
  }

  /**
   * Iterator over results completed since the last call. Yields in
   * submission order (I-65). Calling this repeatedly is safe;
   * already-yielded tools are skipped.
   *
   * AgenC behavior (`StreamingToolExecutor.ts:412-440`):
   *   - Early-return if `discarded`.
   *   - Drain pending progress via `onProgress` before yielding results.
   *   - Head-of-line stop: if the current tool is still `executing`
   *     and not concurrency-safe, break to preserve submission order.
   */
  *getCompletedResults(): Generator<StreamingToolResult, void> {
    if (this.discarded) return;
    for (const tool of this.tools) {
      // Always flush pending progress first (AgenC :418-422).
      while (tool.pendingProgress.length > 0) {
        const ev = tool.pendingProgress.shift();
        if (ev) this.onProgress?.(ev);
      }
      if (tool.status === "yielded") continue;
      if (tool.status === "completed" && tool.result) {
        tool.status = "yielded";
        yield {
          toolCall: tool.toolCall,
          result: tool.result,
          additionalContexts: tool.additionalContexts ?? [],
          status: tool.error ? "synthetic_error" : "completed",
          durationMs: 0,
        };
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        // Head-of-line break (AgenC :436-438). A still-running
        // exclusive tool blocks every downstream yield to preserve
        // submission order.
        break;
      }
    }
  }

  /**
   * Unified update iterator: yields progress events AND completed
   * results interleaved in submission order. Mirrors the reference
   * `MessageUpdate` yield shape from `getCompletedResults` (AgenC
   * :412-440). The plain `getCompletedResults` generator remains the
   * compat surface for callers that only want terminal results.
   */
  *getCompletedUpdates(): Generator<StreamingToolUpdate, void> {
    if (this.discarded) return;
    for (const tool of this.tools) {
      while (tool.pendingProgress.length > 0) {
        const ev = tool.pendingProgress.shift();
        if (!ev) continue;
        this.onProgress?.(ev);
        yield { kind: "progress", toolCall: tool.toolCall, progress: ev };
      }
      if (tool.status === "yielded") continue;
      if (tool.status === "completed" && tool.result) {
        tool.status = "yielded";
        yield {
          kind: "result",
          result: {
            toolCall: tool.toolCall,
            result: tool.result,
            additionalContexts: tool.additionalContexts ?? [],
            status: tool.error ? "synthetic_error" : "completed",
            durationMs: 0,
          },
        };
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        break;
      }
    }
  }

  /**
   * Async iterator that yields results as they complete. Ends when
   * the queue is closed AND every tool has reached `yielded`.
   *
   * AgenC behavior (`StreamingToolExecutor.ts:453-490`): wake-up
   * uses `Promise.race([...executingPromises, progressPromise])` so a
   * progress event from any running tool unblocks the drain loop
   * without waiting for the tool to complete.
   */
  async *getRemainingResults(): AsyncGenerator<StreamingToolResult, void> {
    try {
      while (!this.discarded && this.hasUnfinishedTools()) {
        // Re-run processQueue in case close() unblocked anything.
        await this.processQueue();
        if (this.discarded) return;

        for (const result of this.getCompletedResults()) {
          if (this.discarded) return;
          yield result;
        }
        if (this.discarded) return;

        if (
          this.hasExecutingTools() &&
          !this.hasCompletedResults() &&
          !this.hasPendingProgress()
        ) {
          await this.waitForExecutingToolOrProgress();
        }
      }
      // Final drain: flush any last-completed tools post-loop.
      if (this.discarded) return;
      for (const result of this.getCompletedResults()) {
        yield result;
      }
    } finally {
      if (this.discarded || !this.hasUnfinishedTools()) {
        this.detachAbortSignals();
      }
    }
  }

  /**
   * Async iterator that yields terminal results AND progress events
   * interleaved in submission order. Matches AgenC's
   * `getRemainingResults` shape. Callers that want progress messages
   * woven into their output channel consume this; callers that want
   * only terminal results continue to use `getRemainingResults`.
   */
  async *getRemainingUpdates(): AsyncGenerator<StreamingToolUpdate, void> {
    try {
      while (!this.discarded && this.hasUnfinishedTools()) {
        await this.processQueue();
        if (this.discarded) return;

        for (const update of this.getCompletedUpdates()) {
          if (this.discarded) return;
          yield update;
        }
        if (this.discarded) return;

        if (
          this.hasExecutingTools() &&
          !this.hasCompletedResults() &&
          !this.hasPendingProgress()
        ) {
          await this.waitForExecutingToolOrProgress();
        }
      }
      if (this.discarded) return;
      for (const update of this.getCompletedUpdates()) {
        yield update;
      }
    } finally {
      if (this.discarded || !this.hasUnfinishedTools()) {
        this.detachAbortSignals();
      }
    }
  }

  /** Introspection: current queue state. */
  getToolStates(): ReadonlyArray<{
    readonly id: string;
    readonly status: ToolStatus;
    readonly toolName: string;
    readonly hasDispatched: boolean;
    readonly toolCall: LLMToolCall;
  }> {
    return this.tools.map((t) => ({
      id: t.id,
      status: t.status,
      toolName: t.toolCall.name,
      hasDispatched: t.hasDispatched,
      toolCall: { ...t.toolCall },
    }));
  }

  dispatchPending(opts: { readonly safeOnly?: boolean } = {}): void {
    void this.processQueue(opts);
  }

  inflightCount(): number {
    return this.tools.filter((tool) => tool.status === "executing").length;
  }

  /**
   * Count of force-finalized tools whose dispatch did NOT release within the
   * cleanup grace (outcome="leaked"). Observability/telemetry only.
   */
  get leakedTools(): number {
    return this.leakedToolCount;
  }

  /**
   * Convert not-yet-dispatched queued tools into terminal errors without
   * starting them. Used when a provider stream drops after tool_use blocks
   * but before the model response is safe to replay: already-executing work
   * must drain, but queued side-effecting work must not be launched solely
   * because the error path is closing the executor.
   */
  cancelQueued(reason: SyntheticErrorReason = "connection_lost"): void {
    for (const tool of this.tools) {
      if (tool.status === "queued") {
        tool.error = new Error(reason);
        tool.result = this.createSyntheticError(tool.toolCall, reason);
        tool.status = "completed";
      } else if (tool.status === "executing" && !tool.hasDispatched) {
        tool.cancelBeforeDispatch = reason;
      }
    }
    this.signalProgress();
  }

  /** External dispatch override for tests / phase-5 integration. */
  setConcurrencyClassFor(
    toolName: string,
    klass: ConcurrencyClass | undefined,
  ): void {
    this.concurrencyClassOverrides.set(toolName, klass ?? EXCLUSIVE);
  }

  private readonly concurrencyClassOverrides = new Map<string, ConcurrencyClass>();

  private resolveModelToolName(toolName: string): string {
    if (
      this.concurrencyClassOverrides.has(toolName) ||
      this.registry.tools.some((t) => t.name === toolName) ||
      this.liveToolDispatch?.router.findSpec(toolName) !== undefined
    ) {
      return toolName;
    }
    return canonicalModelToolName(toolName);
  }

  private isKnownToolCall(toolCall: LLMToolCall): boolean {
    const resolvedName = this.resolveModelToolName(toolCall.name);
    if (
      this.concurrencyClassOverrides.has(toolCall.name) ||
      this.concurrencyClassOverrides.has(resolvedName)
    ) {
      return true;
    }
    if (this.registry.tools.some((t) => t.name === resolvedName)) return true;
    return this.liveToolDispatch?.router.findSpec(resolvedName) !== undefined;
  }

  private resolveClassifiable(toolCall: LLMToolCall): ConcurrencyClassifiable {
    const resolvedName = this.resolveModelToolName(toolCall.name);
    const override =
      this.concurrencyClassOverrides.get(toolCall.name) ??
      this.concurrencyClassOverrides.get(resolvedName);
    const tool = this.registry.tools.find((candidate) => candidate.name === resolvedName);
    const routedToolCall =
      resolvedName === toolCall.name ? toolCall : { ...toolCall, name: resolvedName };
    const routed = this.liveToolDispatch
      ? toolCallFromLLMToolCall(routedToolCall, {
          session: this.liveToolDispatch.options.session,
        })
      : null;
    const resolvedServerId =
      tool?.serverId ??
      (routed?.payload.kind === "mcp" ? routed.payload.server : undefined);
    const resolvedClass =
      override ??
      tool?.concurrencyClass ??
      (resolvedServerId !== undefined
        ? sharedServer(resolvedServerId)
        : defaultConcurrencyClassFor(resolvedName));
    return {
      name: resolvedName,
      concurrencyClass: resolvedClass,
      isConcurrencySafe: (tool as Tool | undefined)?.isConcurrencySafe,
      ...(resolvedServerId !== undefined ? { serverId: resolvedServerId } : {}),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal — process queue + execute
  // ─────────────────────────────────────────────────────────────────

  private signalProgress(): void {
    if (this.wakeResolve) {
      const r = this.wakeResolve;
      this.wakeResolve = null;
      r();
    }
  }

  private hasUnfinishedTools(): boolean {
    return this.tools.some((t) => t.status !== "yielded");
  }

  private hasExecutingTools(): boolean {
    return this.tools.some((t) => t.status === "executing");
  }

  private hasCompletedResults(): boolean {
    return this.tools.some((t) => t.status === "completed");
  }

  private hasPendingProgress(): boolean {
    return this.tools.some((t) => t.pendingProgress.length > 0);
  }

  /**
   * Effective drain deadline (ms since `executingSinceMs`) for one tool, or
   * `Infinity` when this tool is EXEMPT from the backstop and may only be
   * stopped by the abort signal.
   *
   *   - backstop disabled (maxToolDrainMs non-finite) → Infinity (no bound)
   *   - no local tool def (test override / MCP-router path) → the flat
   *     `maxToolDrainMs` floor (preserves the never-settling-dispatch repro)
   *   - `resolveTimeoutMs(def, args) === null` (timeoutBehavior:"tool" —
   *     request-user-input / wait / monitor / background, intentionally
   *     unbounded) → Infinity (EXEMPT; the abort signal is the only stop)
   *   - finite own timeout `t` → `max(maxToolDrainMs, t + DRAIN_GRACE_MS)`
   *     so a long bash (`args.timeoutMs`/`tool.timeoutMs` > floor) is never
   *     killed before its own timeout + settling headroom.
   */
  private toolDrainDeadlineMs(tool: TrackedTool): number {
    if (!Number.isFinite(this.maxToolDrainMs)) return Number.POSITIVE_INFINITY;
    const resolvedName = this.resolveModelToolName(tool.toolCall.name);
    const def = this.registry.tools.find((t) => t.name === resolvedName);
    if (def === undefined) {
      // No local def to read a timeout from (test concurrency-override path,
      // or an MCP/router-only tool). Fall back to the flat floor.
      return this.maxToolDrainMs;
    }
    const parsedArgs = parseToolCallArguments(tool.toolCall.arguments);
    const own = resolveTimeoutMs(def, parsedArgs);
    if (own === null) {
      // timeoutBehavior:"tool" — intentionally unbounded; exempt entirely.
      return Number.POSITIVE_INFINITY;
    }

    // ── adaptive refinement (Goal #4a) — reachable ONLY for a finite-own,
    //    locally-defined, non-exempt tool. Everything above is untouched. ──
    const flat = Math.max(this.maxToolDrainMs, own + DRAIN_GRACE_MS);
    if (!this.adaptiveDrainEnabled) return flat; // OFF → byte-identical to today
    const store =
      this.liveToolDispatch?.options.session?.services.toolLatencyStore;
    if (store === undefined) return flat; // crash-safe (minimal/test executor)

    const estimate = store.estimateLatencyMs(resolvedName);
    if (estimate === null) return flat; // cold start (per-tool < K AND global < K)

    // estimate -> candidate deadline: multiplicative + additive margin.
    const candidate = estimate * this.adaptiveDrainMarginMult + DRAIN_GRACE_MS;

    // CLAMP — the SAFE-MINIMUM floor is the non-negotiable never-kill guard.
    const ownFloor = own + DRAIN_GRACE_MS; // contractual timeout + pipeline grace
    const lo = Math.max(ownFloor, this.adaptiveDrainSafeMinMs); // never below this
    const hi = Math.max(this.maxToolDrainMs, ownFloor) * this.adaptiveDrainRaiseCap;
    return Math.min(hi, Math.max(lo, candidate));
  }

  /**
   * Remaining ms until the soonest-to-expire `executing` tool crosses its own
   * drain deadline, or `null` when nothing executing is subject to the
   * backstop (bound disabled, no executing tools, or every executing tool is
   * exempt). A non-null value installs a timer on the drain wait so the loop
   * wakes to force-finalize a stuck tool even if its `promise` never settles
   * and no progress ever arrives.
   */
  private nextDrainTimeoutMs(): number | null {
    if (!Number.isFinite(this.maxToolDrainMs)) return null;
    const now = performance.now();
    let soonest: number | null = null;
    for (const tool of this.tools) {
      if (tool.status !== "executing") continue;
      const since = tool.executingSinceMs;
      if (since === undefined) continue;
      const deadline = this.toolDrainDeadlineMs(tool);
      if (!Number.isFinite(deadline)) continue; // exempt tool
      const remaining = Math.max(0, deadline - (now - since));
      if (soonest === null || remaining < soonest) soonest = remaining;
    }
    return soonest;
  }

  /**
   * First-settle-wins terminal write. The SINGLE funnel for every terminal
   * write (runOne success/catch AND the drain backstop). Returns TRUE iff THIS
   * call is the one that transitioned the tool to its terminal state (so the
   * caller may run one-time side effects like the sibling-abort cascade);
   * returns FALSE if the tool was already finalized (late settle — caller must
   * do nothing: no result overwrite, no status flip-back, no cascade revival).
   */
  private finalizeOnce(
    tool: TrackedTool,
    result: ToolDispatchResult,
    error?: Error,
  ): boolean {
    if (tool.finalized) return false;
    tool.finalized = true;
    if (error !== undefined) tool.error = error;
    tool.result = result;
    tool.status = "completed";
    return true;
  }

  /**
   * After firing `drainCancel`, race the wedged tool's promise against an
   * unref'd cleanup-grace timer. If the dispatch unwinds in the window, its own
   * fn()-keyed `finally` already released the lock/permit ⇒ outcome
   * "reclaimed". If the grace expires, the work ignored the signal (sync loop /
   * unwired await / signal-blind hook) ⇒ outcome "leaked": count it, fire the
   * observability callback, and swallow the orphan promise's eventual late
   * rejection. We NEVER claim it was killed.
   */
  private startReclaimAccounting(
    tool: TrackedTool,
    msSinceExecuting: number,
  ): void {
    tool.outcome = "running";
    const orphan = tool.promise ?? Promise.resolve();
    // Prevent the eventual late rejection from becoming an unhandledRejection.
    // (runOne never rethrows today, but this is defensive against future paths
    // and the separately-created grace race promise.)
    orphan.catch(() => {});

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"leaked">((resolve) => {
      graceTimer = setTimeout(() => resolve("leaked"), this.cleanupGraceMs);
      graceTimer.unref?.();
    });

    void Promise.race([orphan.then(() => "reclaimed" as const), grace]).then(
      (result) => {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (tool.outcome !== "running") return; // already classified
        tool.outcome = result;
        if (result === "leaked") {
          this.leakedToolCount++;
          try {
            this.onLeakedTool?.({
              toolCallId: tool.toolCall.id,
              toolName: tool.toolCall.name,
              concurrencyKind: tool.classification.kind,
              reason: DRAIN_CANCEL_REASON,
              msSinceExecuting,
            });
          } catch {
            /* observability must never throw into the drain loop */
          }
        }
      },
    );
  }

  /**
   * Backstop for a dispatch promise that never settles: any tool that has
   * been `executing` longer than ITS OWN drain deadline is force-completed
   * with a terminal `timeout` result so the drain proceeds and the turn
   * finalizes. Returns true if it finalized at least one tool. Tools with a
   * `timeoutBehavior:"tool"` (unbounded) deadline are exempt and never forced
   * here. The per-tool `tool.execute` timeout (execution.ts) is the first
   * line of defense; this only fires for hangs OUTSIDE that timed region.
   *
   * Beyond synthesizing the terminal result (#1318), this also actively
   * CANCELS exactly the wedged tool's dispatch via its listener-free
   * `drainCancel` so the underlying ToolCallRuntime lock / Semaphore permit /
   * hook can release through its OWN existing `finally` — without aborting
   * siblings (siblingAbortController) or bubbling to the parent turn
   * (childAbort). It then accounts honestly for what it could not reclaim.
   */
  private forceTimeoutOverdueExecutingTools(): boolean {
    if (!Number.isFinite(this.maxToolDrainMs)) return false;
    const now = performance.now();
    let forced = false;
    for (const tool of this.tools) {
      if (tool.status !== "executing") continue;
      const since = tool.executingSinceMs;
      if (since === undefined) continue;
      // NOTE: toolDrainDeadlineMs does NOT consult interruptBehavior — a drain
      // kill is unconditional. The only exemption is timeoutBehavior:"tool"
      // (deadline → Infinity), filtered out below.
      const deadline = this.toolDrainDeadlineMs(tool);
      if (!Number.isFinite(deadline)) continue; // exempt tool
      if (now - since < deadline) continue;

      const msSince = Math.round(now - since);
      // (1) LATCH FIRST so any concurrent late settle becomes a no-op.
      //     Synthesize a terminal timeout so this tool_use block still gets a
      //     paired tool_result (conversation invariant) and the drain can end.
      const error = new Error(
        `tool ${tool.toolCall.name} drain timeout after ${msSince}ms`,
      );
      const synthetic = this.createSyntheticError(tool.toolCall, "timeout");
      this.finalizeOnce(tool, synthetic, error);

      // (2) Detach the wedged tool's abort listeners (runOne's finally will not
      //     run while it stays parked).
      tool.detachAbortListeners?.();

      // (3) ACTIVELY cancel exactly this tool's dispatch. One-way into the
      //     derived dispatch signal; does NOT touch childAbort (no turn kill)
      //     or siblingAbortController (no sibling cascade).
      tool.drainCancel?.abort(DRAIN_CANCEL_REASON);

      // (4) Bounded reclaim accounting (reclaimed vs leaked).
      this.startReclaimAccounting(tool, msSince);

      forced = true;
    }
    if (forced) this.signalProgress();
    return forced;
  }

  private async waitForExecutingToolOrProgress(): Promise<void> {
    const executingPromises = this.tools
      .filter((t) => t.status === "executing" && t.promise)
      .map((t) => t.promise!);
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const progressPromise = new Promise<void>((resolve) => {
      this.wakeResolve = resolve;
      // Last-resort drain bound: if a tool has been executing past the
      // deadline, wake the loop so `forceTimeoutOverdueExecutingTools` can
      // finalize it even when its `promise` never settles and no progress
      // ever fires (the unbounded-wait that hangs the turn).
      const timeoutMs = this.nextDrainTimeoutMs();
      if (timeoutMs !== null) {
        drainTimer = setTimeout(() => {
          drainTimer = null;
          this.signalProgress();
        }, timeoutMs);
        if (typeof (drainTimer as { unref?: () => void }).unref === "function") {
          (drainTimer as { unref: () => void }).unref();
        }
      }
    });
    const clearDrainTimer = (): void => {
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    };
    try {
      if (executingPromises.length > 0) {
        await Promise.race([...executingPromises, progressPromise]);
      } else {
        // No executing promises are attached yet: wait for a progress/close
        // signal. signalProgress wakes us when status transitions, including
        // on discard() and the drain-timeout above.
        await progressPromise;
      }
    } finally {
      clearDrainTimer();
    }
    // After any wake, finalize tools that overran the drain bound.
    this.forceTimeoutOverdueExecutingTools();
  }

  /**
   * AgenC behavior (`StreamingToolExecutor.ts:233-241`): look up
   * the tool's optional `interruptBehavior()` hook. Returns `'block'`
   * when the tool is missing the hook or throws — matches AgenC
   * conservative default. Only tools that explicitly opt into
   * `'cancel'` get cancelled on `interrupt` aborts; `'block'` tools
   * finish their work even while a user message is queued.
   */
  private getToolInterruptBehavior(tool: TrackedTool): "cancel" | "block" {
    const resolvedName = this.resolveModelToolName(tool.toolCall.name);
    const def = this.registry.tools.find((t) => t.name === resolvedName);
    if (!def?.interruptBehavior) return "block";
    try {
      return def.interruptBehavior();
    } catch {
      return "block";
    }
  }

  private canExecuteTool(tool: TrackedTool): boolean {
    const executing = this.tools.filter((t) => t.status === "executing");
    if (executing.length === 0) return true;
    if (executing.length >= this.maxConcurrency) return false;
    const selfSafe =
      tool.classification.kind === "shared_read" ||
      tool.classification.kind === "shared_server" ||
      tool.classification.kind === "background_terminal";
    if (!selfSafe) return false;
    return executing.every(
      (t) =>
        t.classification.kind === "shared_read" ||
        t.classification.kind === "shared_server" ||
        t.classification.kind === "background_terminal",
    );
  }

  /**
   * Process the queue, starting tools when concurrency conditions
   * allow. AgenC behavior (`StreamingToolExecutor.ts:140-151`):
   * iterates queued tools in submission order; non-concurrent-safe
   * tools that cannot yet execute break the loop (submission-order
   * invariant). AgenC retains the `void this.executeTool(tool)` fire-
   * and-forget pattern rather than AgenC's `await`: the
   * AgenC executeTool completes synchronously after kicking off
   * `collectResults` + attaching `promise.finally`, so the two
   * patterns are observably equivalent for concurrency — the explicit
   * `void` makes the non-blocking dispatch intent clear and preserves
   * AgenC's whole-queue parallel-dispatch model.
   */
  private async processQueue(opts: { readonly safeOnly?: boolean } = {}): Promise<void> {
    if (this.discarded) return;
    for (let i = 0; i < this.tools.length; i += 1) {
      const tool = this.tools[i]!;
      if (tool.status !== "queued") continue;
      if (opts.safeOnly === true && !tool.isConcurrencySafe) {
        // During provider streaming, only concurrency-safe tools may
        // pre-dispatch. Mutating/default tools wait for the normal
        // close/drain path so a dropped stream can cancel them first.
        break;
      }
      if (this.canExecuteTool(tool)) {
        // Fire but don't await — multiple safe tools can start.
        tool.status = "executing";
        if (tool.executingSinceMs === undefined) {
          tool.executingSinceMs = performance.now();
        }
        void this.executeTool(tool);
        // Track progress marker for optional fast-forward.
        if (i > this.lastDispatchedIndex) this.lastDispatchedIndex = i;
      } else if (!tool.isConcurrencySafe) {
        // Head-of-line: a non-concurrency-safe tool cannot yet run;
        // preserve submission order by stopping here (AgenC
        // :148 `if (!tool.isConcurrencySafe) break`). Downstream
        // concurrency-safe tools wait their turn.
        break;
      }
      // Concurrency-safe tools continue scanning — they can start in
      // parallel if canExecuteTool is true next iter.
    }
  }

  private async executeTool(tool: TrackedTool): Promise<void> {
    if (tool.status === "completed" || tool.status === "yielded") return;
    tool.status = "executing";
    if (tool.executingSinceMs === undefined) {
      tool.executingSinceMs = performance.now();
    }
    tool.promise = this.runOne(tool);
    try {
      await tool.promise;
    } finally {
      // Re-process the queue after each finish — queued non-safe
      // tools become dispatchable.
      void this.processQueue();
      this.signalProgress();
    }
  }

  private async runOne(tool: TrackedTool): Promise<void> {
    const startedAtMs = performance.now();

    // Reference `getAbortReason` + `collectResults` pre-check
    // (AgenC :278-292). If the sibling / parent controllers are
    // already aborted when we start, synthesize the terminal result
    // and return. For `interrupt`-class aborts, honor the tool's
    // `interruptBehavior()` hook: `'block'` tools proceed; `'cancel'`
    // tools get user_interrupted.
    const preStartAbortReason = this.getAbortReasonForTool(tool);
    if (preStartAbortReason) {
      tool.error = new Error(preStartAbortReason);
      tool.result = this.createSyntheticError(tool.toolCall, preStartAbortReason);
      tool.status = "completed";
      return;
    }

    // Per-tool child of the sibling controller. Aborts when:
    //   - sibling aborts (sibling_error cascade or parent abort)
    //   - permission dialog reject (PermissionContext.cancelAndAbort)
    //   - ExitPlanMode "clear+auto" rejection
    //
    // AgenC (`StreamingToolExecutor.ts:301-318`) wires a bubble-
    // up listener: if the child was aborted for a non-`sibling_error`
    // reason AND the parent tool-use-context controller is not
    // already aborted AND we are not discarding, re-abort the parent
    // so the turn loop ends cleanly instead of sending REJECT_MESSAGE
    // back to the model (#21056 regression).
    const childAbort = new AbortController();
    const onParentAbort = () => {
      if (!childAbort.signal.aborted) {
        childAbort.abort(this.siblingAbortController.signal.reason);
      }
    };
    this.siblingAbortController.signal.addEventListener("abort", onParentAbort, {
      once: true,
    });
    const onChildAbort = () => {
      const reason = childAbort.signal.reason;
      if (
        reason !== "sibling_error" &&
        this.parentAbortController !== null &&
        !this.parentAbortController.signal.aborted &&
        !this.discarded
      ) {
        this.parentAbortController.abort(reason);
      }
    };
    childAbort.signal.addEventListener("abort", onChildAbort, { once: true });

    // Dedicated, LISTENER-FREE per-tool cancel controller. Nothing subscribes
    // to drainCancel.signal's "abort", so firing it triggers NO bubble-up of
    // its own and (per the WHATWG AbortSignal.any algorithm) propagates ONE-WAY
    // into the derived dispatch signal only — never to childAbort, never upward.
    const drainCancel = new AbortController();
    tool.drainCancel = drainCancel;

    // Idempotent listener detach so a wedged (never-settling) runOne does not
    // leak its two abort listeners. runOne's finally and force-finalize both
    // call it.
    let listenersDetached = false;
    tool.detachAbortListeners = () => {
      if (listenersDetached) return;
      listenersDetached = true;
      this.siblingAbortController.signal.removeEventListener(
        "abort",
        onParentAbort,
      );
      childAbort.signal.removeEventListener("abort", onChildAbort);
    };

    // Derived dispatch signal. We use raw `AbortSignal.any` (NOT the house
    // createCombinedAbortSignal helper) because that helper aborts its internal
    // controller with NO reason (utils/combinedAbortSignal.ts) and would drop
    // the "timeout" cause; AbortSignal.any PRESERVES the source reason, so the
    // drain cancel reason maps to TerminalToolCause "timeout". Do NOT "clean
    // this up" to the helper without re-checking the cause mapping. We DO honor
    // the helper's Bun rationale by not using AbortSignal.timeout anywhere
    // here. A strong ref is retained for the dispatch lifetime (it is the
    // dispatch's `signal` arg below), avoiding the Node #57736 weak-GC pitfall.
    const dispatchSignal = AbortSignal.any([
      childAbort.signal,
      drainCancel.signal,
    ]);

    try {
      const dispatch = async (): Promise<ToolDispatchResult> => {
        if (tool.cancelBeforeDispatch) {
          tool.error = new Error(tool.cancelBeforeDispatch);
          return this.createSyntheticError(
            tool.toolCall,
            tool.cancelBeforeDispatch,
          );
        }
        tool.hasDispatched = true;
        if (this.liveToolDispatch) {
          return await this.liveToolDispatch.router.dispatchModelToolCall(
            tool.toolCall,
            {
              ...this.liveToolDispatch.options,
              // Derived signal (childAbort + drainCancel). The router's
              // forwardAbort subscribes to opts.signal and propagates its
              // reason into its internal toolAbortController, so a drainCancel
              // abort cancels exactly this dispatch.
              signal: dispatchSignal,
              // UNCHANGED — the permission-reject / ExitPlanMode bubble-up
              // channel must stay on childAbort (router reads abortController
              // only in the ApprovalRejectedError catch).
              abortController: childAbort,
              onProgress: (event) =>
                this.emitProgress(tool.toolCall.id, event.chunk),
              onHookAdditionalContext: (contexts) => {
                tool.additionalContexts = [
                  ...(tool.additionalContexts ?? []),
                  ...contexts,
                ];
                this.liveToolDispatch?.options.onHookAdditionalContext?.(
                  contexts,
                );
              },
            },
          );
        }
        if (this.runToolUseFn) {
          // Derived signal so a drainCancel abort cancels this dispatch.
          return await this.runToolUseFn(tool.toolCall, dispatchSignal);
        }
        return {
          content: JSON.stringify({
            tool_use_id: tool.toolCall.id,
            is_error: true,
            content:
              "<tool_use_error>guarded tool dispatch is unavailable for this execution path</tool_use_error>",
          }),
          isError: true,
        };
      };

      const runtimeContext = this.buildRuntimeCallContext(
        tool,
        startedAtMs,
        dispatchSignal,
      );
      const result = this.runtime
        ? await runToolRuntimeCall(this.runtime, runtimeContext, dispatch)
        : await dispatch();

      // Late settle of an already force-finalized tool: didFinalize === false ⇒
      // no result overwrite, no status flip-back, no sibling cascade.
      const didFinalize = this.finalizeOnce(tool, result);

      // Sibling-abort cascade for shell-style tools.
      if (
        didFinalize &&
        result.isError === true &&
        this.isSiblingAbortShellTool(tool.toolCall.name) &&
        !this.discarded &&
        !this.hasBashErrored
      ) {
        this.hasBashErrored = true;
        this.onSiblingAbort?.(`bash_error:${tool.toolCall.name}`);
        this.siblingAbortController.abort("sibling_error");
      }
    } catch (err) {
      // The self-induced rejection from our own drainCancel.abort(...) lands
      // here, produces a synthetic result, and is swallowed by the finalized
      // no-op (force-finalize already latched the terminal write).
      const error = err instanceof Error ? err : new Error(String(err));
      const syntheticReason = this.resolveSyntheticErrorReason(error);
      const didFinalize = this.finalizeOnce(
        tool,
        this.createSyntheticError(tool.toolCall, syntheticReason),
        error,
      );
      // Thrown shell-tool errors also trigger sibling abort.
      if (
        didFinalize &&
        this.isSiblingAbortShellTool(tool.toolCall.name) &&
        !this.discarded &&
        !this.hasBashErrored
      ) {
        this.hasBashErrored = true;
        this.onSiblingAbort?.(`bash_threw:${tool.toolCall.name}`);
        this.siblingAbortController.abort("sibling_error");
      }
    } finally {
      // Idempotent — force-finalize may have already detached on a wedged tool.
      tool.detachAbortListeners?.();
    }

    // Adaptive drain latency sample (Goal #4a). Recompute against
    // `executingSinceMs` for clock-consistency with the watchdog (which
    // measures `now - executingSinceMs`); fall back to `startedAtMs` only if
    // the tool was never stamped executing.
    const since = tool.executingSinceMs ?? startedAtMs;
    const durationMs = performance.now() - since;
    // Record ONLY a clean completion. The two gates are the LOAD-BEARING
    // anti-ratchet guard:
    //   - tool.error === undefined   → no thrown / synthetic-timeout error
    //     (finalizeOnce sets it).
    //   - tool.outcome === undefined → not on the drain/reclaim path
    //     (startReclaimAccounting sets it).
    // A force-finalized late-settle has BOTH set, so it is excluded — feeding a
    // ~deadline-ms killed run back in would ratchet the deadline up on every
    // wedge.
    if (
      tool.error === undefined &&
      tool.outcome === undefined &&
      Number.isFinite(durationMs) &&
      durationMs >= 0
    ) {
      const store =
        this.liveToolDispatch?.options.session?.services.toolLatencyStore;
      store?.record(this.resolveModelToolName(tool.toolCall.name), durationMs);
    }
  }

  private isSiblingAbortShellTool(toolName: string): boolean {
    return toolName === this.bashToolName || toolName === "exec_command";
  }

  private buildRuntimeCallContext(
    tool: TrackedTool,
    submittedAtMs: number,
    acquireSignal?: AbortSignal,
  ): ToolRuntimeCallContext {
    const routed = toolCallFromLLMToolCall(tool.toolCall, {
      session: this.liveToolDispatch?.options.session,
    });
    const definition = this.registry.tools.find(
      (candidate) => candidate.name === tool.toolCall.name,
    );
    const supportsParallelToolCalls = this.liveToolDispatch
      ? this.liveToolDispatch.router.toolSupportsParallel(routed)
      : definition?.supportsParallelToolCalls ?? tool.isConcurrencySafe;
    return {
      callId: tool.toolCall.id,
      toolName: tool.toolCall.name,
      runtimeKind: runtimeKindForPayload(routed.payload),
      classification: tool.classification,
      supportsParallelToolCalls,
      source: this.liveToolDispatch?.options.source ?? "direct",
      submittedAtMs,
      ...(acquireSignal ? { acquireSignal } : {}),
    };
  }

  /**
   * Reference `getAbortReason` (`StreamingToolExecutor.ts:209-231`):
   * resolve the reason a tool should be cancelled based on the
   * current executor state. Returns `null` when the tool may proceed.
   *
   *   - `discarded` → streaming_fallback (but only if sibling abort
   *     has not fired, which takes priority)
   *   - sibling abort → takes its reason from the abort signal
   *   - `interrupt` abort reason → honor `interruptBehavior()` —
   *     `'block'` tools are allowed to run; `'cancel'` tools get
   *     `user_interrupted`.
   */
  private getAbortReasonForTool(tool: TrackedTool): SyntheticErrorReason | null {
    if (!this.siblingAbortController.signal.aborted) {
      if (this.discarded) return "streaming_fallback";
      return null;
    }
    const rawReason = this.siblingAbortController.signal.reason;
    if (rawReason === "sibling_error" || this.hasBashErrored) {
      return "sibling_error";
    }
    // For the AgenC 'interrupt' case, check per-tool behavior
    // before cancelling. Block-behavior tools continue executing
    // (AgenC :219-228).
    const interruptLike =
      rawReason === "interrupt" ||
      (typeof rawReason === "string" &&
        rawReason.toLowerCase() === "interrupt");
    if (interruptLike) {
      return this.getToolInterruptBehavior(tool) === "cancel"
        ? "user_interrupted"
        : null;
    }
    // Other abort reasons → resolve via the full error-reason
    // pipeline (mode_changed, timeout, auth_failed, etc.).
    return this.resolveSyntheticErrorReason(
      rawReason instanceof Error ? rawReason : new Error(String(rawReason ?? "aborted")),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Synthetic error message — AgenC behavior
  // ─────────────────────────────────────────────────────────────────

  private createSyntheticError(
    toolCall: LLMToolCall,
    reason: SyntheticErrorReason,
  ): ToolDispatchResult {
    if (
      reason === "timeout" ||
      reason === "connection_lost" ||
      reason === "aborted" ||
      reason === "sibling_error" ||
      reason === "mode_changed" ||
      reason === "user_interrupted" ||
      reason === "auth_failed" ||
      reason === "provider_switched" ||
      reason === "process_killed"
    ) {
      const terminal = buildTerminalToolResult({
        toolCall,
        cause: reason,
      });
      return {
        content: terminal.content,
        isError: true,
      };
    }
    const messageByReason: Record<"streaming_fallback", string> = {
      streaming_fallback:
        "Streaming fallback occurred — results from this batch were discarded.",
    };
    return {
      content: JSON.stringify({
        tool_use_id: toolCall.id,
        is_error: true,
        content: messageByReason.streaming_fallback,
      }),
      isError: true,
    };
  }

  private resolveSyntheticErrorReason(err?: unknown): SyntheticErrorReason {
    if (this.discardReason !== null) {
      const discardCause = terminalToolCauseFromAbortReason(this.discardReason);
      if (discardCause) return discardCause;
      return this.discardReason === "sibling_error"
        ? "sibling_error"
        : "streaming_fallback";
    }

    const signalReason = this.siblingAbortController.signal.reason;
    if (this.hasBashErrored || signalReason === "sibling_error") {
      return "sibling_error";
    }

    const terminalCause = terminalToolCauseFromError(err, signalReason);
    if (terminalCause) return terminalCause;

    return this.siblingAbortController.signal.aborted ? "aborted" : "streaming_fallback";
  }

  // ─────────────────────────────────────────────────────────────────
  // Progress event API
  // ─────────────────────────────────────────────────────────────────

  /**
   * Record a progress event for a running tool. The event is queued
   * on the tool's `pendingProgress` buffer and flushed via the
   * `onProgress` hook on the next `getCompletedResults` pass.
   */
  emitProgress(toolCallId: string, message: string): void {
    const tool = this.tools.find((t) => t.id === toolCallId);
    if (!tool) return;
    tool.pendingProgress.push({
      toolCallId,
      message,
      at: performance.now(),
    });
    this.signalProgress();
  }

  /**
   * External fire-drill for aborting in-flight tool dispatches. Unlike
   * `discard()` (which only flips the result-stream flag), `abort()`
   * also aborts the internal `siblingAbortController` so the per-tool
   * child controllers fire. That lets the AgenC-compatible bubble-up
   * listener re-abort the parent `parentAbortController` when the
   * abort reason is not `sibling_error`. Tests and recovery paths
   * invoke this to simulate permission-dialog reject / ExitPlanMode
   * clear+auto.
   */
  abort(reason = "executor_abort"): void {
    // Abort the sibling controller FIRST — this propagates to any
    // per-tool child controllers currently in flight and, via their
    // bubble-up listeners, may re-abort the parent controller for
    // non-`sibling_error` reasons.
    if (!this.siblingAbortController.signal.aborted) {
      this.siblingAbortController.abort(reason);
    }
    this.discard(reason);
  }
}

function parseToolCallArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}
