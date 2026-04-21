/**
 * StreamingToolExecutor — full openclaude port (530 LOC).
 *
 * Hand-port of openclaude `services/tools/StreamingToolExecutor.ts`.
 * Dispatches tools as they stream in from the model, with four-class
 * concurrency control (via the T7 `classify` analyzer) + sibling-
 * abort cascade on Bash errors + order-preserving yield of completed
 * results.
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

export interface StreamingToolResult {
  readonly toolCall: LLMToolCall;
  readonly result: ToolDispatchResult;
  readonly status: "completed" | "synthetic_error";
  readonly durationMs: number;
}

export type SyntheticErrorReason =
  | "sibling_error"
  | "user_interrupted"
  | "streaming_fallback";

// ─────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────

export interface StreamingToolExecutorOptions {
  readonly registry: ToolRegistry;
  /** Session-scoped AbortSignal (user Ctrl+C, provider switch). */
  readonly abortSignal?: AbortSignal;
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
  private readonly tools: TrackedTool[] = [];
  private closed = false;
  /** I-41 abort re-entrance guard. Second `discard()` while already
   *  aborting returns immediately so cleanup handlers that emit
   *  abort-like errors don't cause infinite synthesis. */
  private isAborting = false;
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
   */
  addTool(block: ToolUseBlock, toolCall: LLMToolCall): void {
    if (this.closed || this.isAborting) return;
    const classifiable = this.resolveClassifiable(toolCall);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
    } catch {
      parsedArgs = {};
    }
    const tracked: TrackedTool = {
      id: toolCall.id,
      block,
      toolCall,
      classifiable,
      classification: classify(classifiable, parsedArgs),
      status: "queued",
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
   * I-41: guarded by `isAborting` so a tool cleanup handler that
   * emits another abort-like error doesn't recurse.
   */
  discard(reason = "discarded"): void {
    if (this.isAborting) return;
    this.isAborting = true;
    this.siblingAbortController.abort(reason);
    this.closed = true;
    // Synthesize error results for any non-completed tools.
    for (const tool of this.tools) {
      if (tool.status === "queued") {
        tool.status = "completed";
        tool.result = this.createSyntheticError(tool.id, "streaming_fallback");
      }
    }
    this.signalProgress();
  }

  /**
   * Iterator over results completed since the last call. Yields in
   * submission order (I-65). Calling this repeatedly is safe;
   * already-yielded tools are skipped.
   */
  *getCompletedResults(): Generator<StreamingToolResult, void> {
    if (this.isAborting) return;
    for (const tool of this.tools) {
      if (tool.status === "yielded") continue;
      // Drain pending progress events first (non-blocking path).
      while (tool.pendingProgress.length > 0) {
        const ev = tool.pendingProgress.shift();
        if (ev) this.onProgress?.(ev);
      }
      if (tool.status === "completed" && tool.result) {
        tool.status = "yielded";
        yield {
          toolCall: tool.toolCall,
          result: tool.result,
          status: tool.error ? "synthetic_error" : "completed",
          durationMs: 0,
        };
      }
    }
  }

  /**
   * Async iterator that yields results as they complete. Ends when
   * the queue is closed AND every tool has reached `yielded`.
   */
  async *getRemainingResults(): AsyncGenerator<StreamingToolResult, void> {
    while (true) {
      for (const result of this.getCompletedResults()) {
        yield result;
      }
      if (
        this.closed &&
        this.tools.every(
          (t) => t.status === "yielded" || t.status === "completed",
        )
      ) {
        // Drain any newly-completed ones the above loop might have missed.
        for (const result of this.getCompletedResults()) yield result;
        if (this.tools.every((t) => t.status === "yielded")) return;
      }
      if (this.isAborting) return;
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
      });
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

  private async processQueue(): Promise<void> {
    for (let i = 0; i < this.tools.length; i += 1) {
      const tool = this.tools[i]!;
      if (tool.status !== "queued") continue;
      if (this.canExecuteTool(tool)) {
        // Fire but don't await — multiple safe tools can start.
        void this.executeTool(tool);
        // Track progress marker for optional fast-forward.
        if (i > this.lastDispatchedIndex) this.lastDispatchedIndex = i;
      } else if (
        tool.classification.kind === "exclusive" ||
        tool.classification.kind === "background_terminal"
      ) {
        // Exclusive-class tools block the queue until all running
        // safe tools finish. BackgroundTerminal (bash) also blocks
        // so a queued bash call serializes after a running read.
        break;
      }
      // Shared-read + shared-server tools continue scanning — they
      // can start in parallel if canExecuteTool is true next iter.
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

    // If aborted before we start, synthesize the error + return.
    if (this.siblingAbortController.signal.aborted) {
      tool.result = this.createSyntheticError(
        tool.id,
        this.hasBashErrored ? "sibling_error" : "user_interrupted",
      );
      tool.status = "completed";
      return;
    }

    const childAbort = new AbortController();
    const onParentAbort = () => {
      if (!childAbort.signal.aborted) {
        childAbort.abort(this.siblingAbortController.signal.reason);
      }
    };
    this.siblingAbortController.signal.addEventListener("abort", onParentAbort, {
      once: true,
    });

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
      tool.result = {
        content: JSON.stringify({ error: tool.error.message }),
        isError: true,
      };
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
    }

    const durationMs = performance.now() - startedAtMs;
    void durationMs;
  }

  // ─────────────────────────────────────────────────────────────────
  // Synthetic error message — openclaude parity
  // ─────────────────────────────────────────────────────────────────

  private createSyntheticError(
    toolCallId: string,
    reason: SyntheticErrorReason,
  ): ToolDispatchResult {
    const messageByReason: Record<SyntheticErrorReason, string> = {
      sibling_error:
        "Sibling Bash command errored; this tool was not run to avoid cascading side effects.",
      user_interrupted: "User interrupted — tool was not run.",
      streaming_fallback:
        "Streaming fallback occurred — results from this batch were discarded.",
    };
    return {
      content: JSON.stringify({
        tool_use_id: toolCallId,
        is_error: true,
        content: messageByReason[reason],
      }),
      isError: true,
    };
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

  /** External fire-drill for `discard()` from tests / error paths. */
  abort(reason = "executor_abort"): void {
    this.discard(reason);
  }
}
