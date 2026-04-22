/**
 * StreamingToolExecutor — full openclaude port.
 *
 * Hand-port of openclaude `services/tools/StreamingToolExecutor.ts`.
 * Dispatches tools as they stream in from the model, with four-class
 * concurrency control (via the T7 `classify` analyzer) + sibling-
 * abort cascade on Bash errors + order-preserving yield of completed
 * results + openclaude-parity progress interleaving, unknown-tool
 * short-circuit, head-of-line break, per-tool `interruptBehavior`
 * gating, and child → parent abort bubble-up.
 *
 * T6 closure parity pointers (direct code references):
 *   - `discard()` flips a boolean only, no synthesis:
 *     openclaude `StreamingToolExecutor.ts:69-71`.
 *   - Yield paths early-return on `discarded`:
 *     openclaude `StreamingToolExecutor.ts:412-415, :454-456`.
 *   - Unknown-tool pre-synthesis:
 *     openclaude `StreamingToolExecutor.ts:77-102`.
 *   - `createChildAbortController` + bubble-up on non-`sibling_error`:
 *     openclaude `StreamingToolExecutor.ts:301-318`.
 *   - Head-of-line stop (non-safe executing tool blocks downstream):
 *     openclaude `StreamingToolExecutor.ts:436-438`.
 *   - `Promise.race` wake-up (executingPromises + progressPromise):
 *     openclaude `StreamingToolExecutor.ts:453-490`.
 *   - Progress interleaved into result stream:
 *     openclaude `StreamingToolExecutor.ts:366-378, :419-422`.
 *   - `interruptBehavior()` per-tool interrupt gating:
 *     openclaude `StreamingToolExecutor.ts:219-241, :254-260`.
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
import type { ToolUseBlock } from "../session/turn-state.js";
import type { Tool } from "./types.js";
import {
  buildTerminalToolResult,
  terminalToolCauseFromAbortReason,
  terminalToolCauseFromError,
  type TerminalToolCause,
} from "../recovery/terminal-tool-result.js";

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
  promise?: Promise<void>;
  result?: ToolDispatchResult;
  error?: Error;
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
  readonly status: "completed" | "synthetic_error";
  readonly durationMs: number;
}

/**
 * Openclaude parity union: either a terminal tool result or an inline
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

// ─────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────

export interface StreamingToolExecutorOptions {
  readonly registry: ToolRegistry;
  /** Session-scoped AbortSignal (user Ctrl+C, provider switch). */
  readonly abortSignal?: AbortSignal;
  /**
   * Parent tool-use context abort controller. When provided, the
   * executor wires the openclaude child-abort bubble-up (openclaude
   * `StreamingToolExecutor.ts:301-318`): permission-dialog reject /
   * ExitPlanMode "clear+auto" aborts the per-tool child controller
   * for a non-`sibling_error` reason, which bubbles up and aborts
   * this parent so the turn loop ends cleanly instead of sending
   * REJECT_MESSAGE back to the model (#21056 regression).
   */
  readonly parentAbortController?: AbortController;
  /** Optional ToolCallRuntime; when present, dispatch is wrapped by
   *  the concurrency gate (RwLock / SharedServer semaphore). */
  readonly runtime?: ToolCallRuntime;
  /** Fires on Bash sibling-abort cascade or other diagnostic events. */
  readonly onSiblingAbort?: (reason: string) => void;
  /** Fired per progress event (TUI rendering hook). */
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Name of the Bash tool in this registry — matches openclaude
   *  `BASH_TOOL_NAME`. Only this tool's error triggers the sibling-
   *  abort cascade (openclaude rationale: Bash has implicit
   *  dependency chains; independent tools don't). */
  readonly bashToolName?: string;
  /**
   * Optional per-tool dispatch override. Allows the caller to inject
   * the full `runToolUse` pipeline from `execution.ts` (with
   * approval + timeout + size cap wrapped). When absent, falls back
   * to `registry.dispatch(toolCall)` directly.
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
  private readonly siblingAbortController: AbortController;
  private readonly bashToolName: string;
  private readonly runtime?: ToolCallRuntime;
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
   * (openclaude :304-318) re-aborts this controller for non
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
   * Openclaude parity (`StreamingToolExecutor.ts:49`): `discard()`
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

  constructor(opts: StreamingToolExecutorOptions) {
    this.registry = opts.registry;
    this.onSiblingAbort = opts.onSiblingAbort;
    this.onProgress = opts.onProgress;
    this.bashToolName = opts.bashToolName ?? "system.bash";
    this.runtime = opts.runtime;
    this.runToolUseFn = opts.runToolUseFn;
    this.liveToolDispatch = opts.liveToolDispatch;
    this.parentAbortController = opts.parentAbortController ?? null;
    this.siblingAbortController = new AbortController();
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        this.siblingAbortController.abort(opts.abortSignal.reason);
      } else {
        opts.abortSignal.addEventListener(
          "abort",
          () => this.siblingAbortController.abort(opts.abortSignal?.reason),
          { once: true },
        );
      }
    }
  }

  /**
   * Queue a tool call. Dispatches as soon as the concurrency gate
   * allows. Non-concurrent-safe tools block the queue until all
   * running safe tools finish (openclaude semantics).
   *
   * Openclaude parity: when the tool name is unknown (not in the
   * registry AND no `concurrencyClassOverride` set for tests), we
   * pre-synthesize a deterministic `No such tool available` terminal
   * result and mark the tracked tool `completed`. That guarantees
   * every `tool_use` block receives a paired `tool_result` and keeps
   * the model from seeing orphaned tool calls on the next turn.
   */
  addTool(block: ToolUseBlock, toolCall: LLMToolCall): void {
    if (this.closed || this.isAborting) return;

    // Unknown-tool short-circuit (openclaude StreamingToolExecutor.ts:77-102).
    const isKnown =
      this.concurrencyClassOverrides.has(toolCall.name) ||
      this.registry.tools.some((t) => t.name === toolCall.name);
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
        result: syntheticResult,
        error: new Error(`No such tool available: ${toolCall.name}`),
        pendingProgress: [],
      };
      this.tools.push(tracked);
      this.signalProgress();
      return;
    }

    const classifiable = this.resolveClassifiable(toolCall);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
    } catch {
      parsedArgs = {};
    }
    const classification = classify(classifiable, parsedArgs);
    // Openclaude tracks a per-call `isConcurrencySafe` boolean derived
    // from the tool's `isConcurrencySafe(args)` hook. We keep the T7
    // classification model but also cache the boolean so the
    // head-of-line-break logic in `getCompletedResults` matches
    // openclaude `:436-438` semantics exactly.
    const tool = this.registry.tools.find((t) => t.name === toolCall.name);
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
      pendingProgress: [],
    };
    this.tools.push(tracked);
    void this.processQueue();
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
   * Openclaude parity (`StreamingToolExecutor.ts:69-71`): `discard()`
   * ONLY flips `this.discarded = true`. It does NOT synthesize
   * results — the caller (query.ts-equivalent) is responsible for
   * abandoning the output stream. All yield paths (`getCompletedResults`,
   * `getRemainingResults`, updates variants) early-return when
   * `discarded` is true.
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
    this.signalProgress();
  }

  /**
   * Iterator over results completed since the last call. Yields in
   * submission order (I-65). Calling this repeatedly is safe;
   * already-yielded tools are skipped.
   *
   * Openclaude parity (`StreamingToolExecutor.ts:412-440`):
   *   - Early-return if `discarded`.
   *   - Drain pending progress via `onProgress` before yielding results.
   *   - Head-of-line stop: if the current tool is still `executing`
   *     and not concurrency-safe, break to preserve submission order.
   */
  *getCompletedResults(): Generator<StreamingToolResult, void> {
    if (this.discarded) return;
    for (const tool of this.tools) {
      // Always flush pending progress first (openclaude :418-422).
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
          status: tool.error ? "synthetic_error" : "completed",
          durationMs: 0,
        };
      } else if (tool.status === "executing" && !tool.isConcurrencySafe) {
        // Head-of-line break (openclaude :436-438). A still-running
        // exclusive tool blocks every downstream yield to preserve
        // submission order.
        break;
      }
    }
  }

  /**
   * Unified update iterator: yields progress events AND completed
   * results interleaved in submission order. Mirrors openclaude's
   * `MessageUpdate` yield shape from `getCompletedResults` (openclaude
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
   * Openclaude parity (`StreamingToolExecutor.ts:453-490`): wake-up
   * uses `Promise.race([...executingPromises, progressPromise])` so a
   * progress event from any running tool unblocks the drain loop
   * without waiting for the tool to complete.
   */
  async *getRemainingResults(): AsyncGenerator<StreamingToolResult, void> {
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
        const executingPromises = this.tools
          .filter((t) => t.status === "executing" && t.promise)
          .map((t) => t.promise!);
        const progressPromise = new Promise<void>((resolve) => {
          this.wakeResolve = resolve;
        });
        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise]);
        } else {
          // No executing tools but unfinished queued tools: wait for
          // progress/close signal. signalProgress wakes us when
          // status transitions, including on discard().
          await progressPromise;
        }
      }
    }
    // Final drain: flush any last-completed tools post-loop.
    if (this.discarded) return;
    for (const result of this.getCompletedResults()) {
      yield result;
    }
  }

  /**
   * Async iterator that yields terminal results AND progress events
   * interleaved in submission order. Matches openclaude's
   * `getRemainingResults` shape. Callers that want progress messages
   * woven into their output channel consume this; callers that want
   * only terminal results continue to use `getRemainingResults`.
   */
  async *getRemainingUpdates(): AsyncGenerator<StreamingToolUpdate, void> {
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
        const executingPromises = this.tools
          .filter((t) => t.status === "executing" && t.promise)
          .map((t) => t.promise!);
        const progressPromise = new Promise<void>((resolve) => {
          this.wakeResolve = resolve;
        });
        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise]);
        } else {
          await progressPromise;
        }
      }
    }
    if (this.discarded) return;
    for (const update of this.getCompletedUpdates()) {
      yield update;
    }
  }

  /** Introspection: current queue state. */
  getToolStates(): ReadonlyArray<{
    readonly id: string;
    readonly status: ToolStatus;
    readonly toolName: string;
  }> {
    return this.tools.map((t) => ({
      id: t.id,
      status: t.status,
      toolName: t.toolCall.name,
    }));
  }

  /** External dispatch override for tests / phase-5 integration. */
  setConcurrencyClassFor(
    toolName: string,
    klass: ConcurrencyClass | undefined,
  ): void {
    this.concurrencyClassOverrides.set(toolName, klass ?? EXCLUSIVE);
  }

  private readonly concurrencyClassOverrides = new Map<string, ConcurrencyClass>();

  private resolveClassifiable(toolCall: LLMToolCall): ConcurrencyClassifiable {
    const override = this.concurrencyClassOverrides.get(toolCall.name);
    const tool = this.registry.tools.find((candidate) => candidate.name === toolCall.name);
    const routed = this.liveToolDispatch
      ? toolCallFromLLMToolCall(toolCall, {
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
        : defaultConcurrencyClassFor(toolCall.name));
    return {
      name: toolCall.name,
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
   * Openclaude parity (`StreamingToolExecutor.ts:233-241`): look up
   * the tool's optional `interruptBehavior()` hook. Returns `'block'`
   * when the tool is missing the hook or throws — matches openclaude
   * conservative default. Only tools that explicitly opt into
   * `'cancel'` get cancelled on `interrupt` aborts; `'block'` tools
   * finish their work even while a user message is queued.
   */
  private getToolInterruptBehavior(tool: TrackedTool): "cancel" | "block" {
    const def = this.registry.tools.find((t) => t.name === tool.toolCall.name);
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
   * allow. Openclaude parity (`StreamingToolExecutor.ts:140-151`):
   * iterates queued tools in submission order; non-concurrent-safe
   * tools that cannot yet execute break the loop (submission-order
   * invariant). AgenC retains the `void this.executeTool(tool)` fire-
   * and-forget pattern rather than openclaude's `await`: the
   * openclaude executeTool completes synchronously after kicking off
   * `collectResults` + attaching `promise.finally`, so the two
   * patterns are observably equivalent for concurrency — the explicit
   * `void` makes the non-blocking dispatch intent clear and preserves
   * AgenC's whole-queue parallel-dispatch model.
   */
  private async processQueue(): Promise<void> {
    if (this.discarded) return;
    for (let i = 0; i < this.tools.length; i += 1) {
      const tool = this.tools[i]!;
      if (tool.status !== "queued") continue;
      if (this.canExecuteTool(tool)) {
        // Fire but don't await — multiple safe tools can start.
        void this.executeTool(tool);
        // Track progress marker for optional fast-forward.
        if (i > this.lastDispatchedIndex) this.lastDispatchedIndex = i;
      } else if (!tool.isConcurrencySafe) {
        // Head-of-line: a non-concurrency-safe tool cannot yet run;
        // preserve submission order by stopping here (openclaude
        // :148 `if (!tool.isConcurrencySafe) break`). Downstream
        // concurrency-safe tools wait their turn.
        break;
      }
      // Concurrency-safe tools continue scanning — they can start in
      // parallel if canExecuteTool is true next iter.
    }
  }

  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = "executing";
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

    // Openclaude `getAbortReason` + `collectResults` pre-check
    // (openclaude :278-292). If the sibling / parent controllers are
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
    // Openclaude (`StreamingToolExecutor.ts:301-318`) wires a bubble-
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

    try {
      const dispatch = async (): Promise<ToolDispatchResult> => {
        if (this.liveToolDispatch) {
          return await this.liveToolDispatch.router.dispatchModelToolCall(
            tool.toolCall,
            {
              ...this.liveToolDispatch.options,
              signal: childAbort.signal,
              onProgress: (event) =>
                this.emitProgress(tool.toolCall.id, event.chunk),
            },
          );
        }
        if (this.runToolUseFn) {
          return await this.runToolUseFn(tool.toolCall, childAbort.signal);
        }
        return await this.registry.dispatch(tool.toolCall);
      };

      const result = this.runtime
        ? await this.runtime.run(tool.classification, dispatch)
        : await dispatch();

      tool.result = result;
      tool.status = "completed";

      // Sibling-abort cascade — Bash-only.
      if (
        result.isError === true &&
        tool.toolCall.name === this.bashToolName &&
        !this.hasBashErrored
      ) {
        this.hasBashErrored = true;
        this.onSiblingAbort?.(`bash_error:${tool.toolCall.name}`);
        this.siblingAbortController.abort("sibling_error");
      }
    } catch (err) {
      tool.error = err instanceof Error ? err : new Error(String(err));
      const syntheticReason = this.resolveSyntheticErrorReason(tool.error);
      tool.result = this.createSyntheticError(tool.toolCall, syntheticReason);
      tool.status = "completed";
      // Bash-thrown errors also trigger sibling abort (parity with
      // openclaude line 354-363 behaviour when a Bash run throws).
      if (
        tool.toolCall.name === this.bashToolName &&
        !this.hasBashErrored
      ) {
        this.hasBashErrored = true;
        this.onSiblingAbort?.(`bash_threw:${tool.toolCall.name}`);
        this.siblingAbortController.abort("sibling_error");
      }
    } finally {
      this.siblingAbortController.signal.removeEventListener(
        "abort",
        onParentAbort,
      );
      childAbort.signal.removeEventListener("abort", onChildAbort);
    }

    const durationMs = performance.now() - startedAtMs;
    void durationMs;
  }

  /**
   * Openclaude `getAbortReason` (`StreamingToolExecutor.ts:209-231`):
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
    // For the openclaude 'interrupt' case, check per-tool behavior
    // before cancelling. Block-behavior tools continue executing
    // (openclaude :219-228).
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
  // Synthetic error message — openclaude parity
  // ─────────────────────────────────────────────────────────────────

  private createSyntheticError(
    toolCall: LLMToolCall,
    reason: SyntheticErrorReason,
  ): ToolDispatchResult {
    if (
      reason === "timeout" ||
      reason === "connection_lost" ||
      reason === "aborted" ||
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
   * child controllers fire. That lets the openclaude-parity bubble-up
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
