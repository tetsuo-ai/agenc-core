/**
 * StreamingToolExecutor — structural port of openclaude
 * `services/tools/StreamingToolExecutor.ts` (530 LOC).
 *
 * Responsibilities:
 *   - Accept tool_use blocks mid-stream via `addTool()` so tool
 *     dispatch can overlap with model streaming (openclaude
 *     `StreamingToolExecutor.ts:114-123`).
 *   - Execute tools serially in T5 (T7 adds concurrency classes:
 *     `Exclusive`, `SharedRead`, `SharedServer(id)`, `BackgroundTerminal`
 *     per codex `parallel.rs`).
 *   - Emit completed results in arrival order via
 *     `getCompletedResults()` (openclaude lines 412-440) and hold the
 *     async loop open on `getRemainingResults()` (lines 453-490).
 *   - Cascade sibling-abort on error (Bash-only in openclaude; T5
 *     honors the surface, T7 gates by ConcurrencyClass).
 *
 * T5 ships a sequential version — each `addTool` runs the prior one
 * to completion before starting, matching execute-tools sequential
 * dispatch. T7 replaces the executor body with parallel dispatch
 * gated by the ConcurrencyClass analyzer.
 *
 * @module
 */

import type { LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { ToolUseBlock } from "../session/turn-state.js";

export type ToolStatus = "queued" | "executing" | "completed" | "yielded";

export interface TrackedTool {
  readonly block: ToolUseBlock;
  readonly toolCall: LLMToolCall;
  status: ToolStatus;
  result?: ToolDispatchResult;
  error?: Error;
}

export interface StreamingToolResult {
  readonly toolCall: LLMToolCall;
  readonly result: ToolDispatchResult;
}

export interface StreamingToolExecutorOptions {
  readonly registry: ToolRegistry;
  /** AbortSignal that aborts ALL queued + in-flight tools. */
  readonly abortSignal?: AbortSignal;
  /** Called when an exception during one tool aborts siblings.
   *  T7 gates this by ConcurrencyClass; T5 fires always. */
  readonly onSiblingAbort?: (reason: string) => void;
}

/**
 * Queue-and-dispatch executor with an arrival-order result iterator.
 *
 * Usage pattern matches openclaude query.ts:572-578:
 *   1. Construct once at phase-2 entry.
 *   2. Call `addTool(block, call)` as tool_use blocks parse out of
 *      the stream.
 *   3. At phase-5 entry, iterate `getRemainingResults()` to drain.
 *
 * Each `addTool` schedules the tool; the internal queue promise chain
 * guarantees FIFO completion order (openclaude enforces this for
 * tools that aren't concurrency-safe by funneling them through the
 * exclusive slot; T5 funnels everything this way).
 */
export class StreamingToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly onSiblingAbort?: (reason: string) => void;
  private readonly siblingAbortController: AbortController;
  private readonly queue: TrackedTool[] = [];
  private readonly completed: StreamingToolResult[] = [];
  private chain: Promise<void> = Promise.resolve();
  private yieldedCount = 0;
  /** Wake-up signal for getRemainingResults. */
  private wakeResolve: (() => void) | null = null;
  private closed = false;

  constructor(opts: StreamingToolExecutorOptions) {
    this.registry = opts.registry;
    this.onSiblingAbort = opts.onSiblingAbort;
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
   * Queue a tool call. Dispatches as soon as the previous tool in
   * the queue finishes (sequential in T5; T7 adds parallelism by
   * concurrency class).
   */
  addTool(block: ToolUseBlock, toolCall: LLMToolCall): void {
    if (this.closed) return;
    const tracked: TrackedTool = {
      block,
      toolCall,
      status: "queued",
    };
    this.queue.push(tracked);
    // Chain onto the serial promise.
    this.chain = this.chain.then(() => this.runOne(tracked));
  }

  /**
   * Mark the stream closed. `getRemainingResults()` will finish after
   * the current chain drains.
   */
  close(): void {
    this.closed = true;
    // Wake the remaining-iterator so it can observe the close.
    this.signalProgress();
  }

  /**
   * Generator over results completed so far, in queue order. Called
   * synchronously by run-turn after each chunk to yield whatever is
   * ready. Mirrors openclaude 412-440.
   */
  *getCompletedResults(): Generator<StreamingToolResult, void> {
    while (this.yieldedCount < this.completed.length) {
      const next = this.completed[this.yieldedCount];
      if (!next) break;
      this.yieldedCount += 1;
      yield next;
    }
  }

  /**
   * Async iterator that yields results as they complete and ends
   * when the queue drains + `close()` is called. Mirrors openclaude
   * 453-490.
   */
  async *getRemainingResults(): AsyncGenerator<StreamingToolResult, void> {
    while (true) {
      // Drain whatever is ready.
      for (const result of this.getCompletedResults()) {
        yield result;
      }
      // Done: all chained work finished AND close() was called OR
      // nothing more will arrive.
      if (
        this.closed &&
        this.queue.every((t) => t.status === "completed" || t.status === "yielded")
      ) {
        return;
      }
      // Wait for progress.
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
      });
    }
  }

  /** Force-abort all in-flight + queued tools. */
  abort(reason = "executor_abort"): void {
    this.siblingAbortController.abort(reason);
    this.closed = true;
    this.signalProgress();
  }

  private signalProgress(): void {
    if (this.wakeResolve) {
      const r = this.wakeResolve;
      this.wakeResolve = null;
      r();
    }
  }

  private async runOne(tracked: TrackedTool): Promise<void> {
    if (tracked.status !== "queued") return;
    if (this.siblingAbortController.signal.aborted) {
      tracked.status = "completed";
      tracked.result = {
        content: JSON.stringify({
          error: `aborted: ${String(this.siblingAbortController.signal.reason ?? "unknown")}`,
        }),
        isError: true,
      };
      this.completed.push({ toolCall: tracked.toolCall, result: tracked.result });
      this.signalProgress();
      return;
    }
    tracked.status = "executing";
    try {
      const result = await this.registry.dispatch(tracked.toolCall);
      tracked.result = result;
      tracked.status = "completed";
      this.completed.push({ toolCall: tracked.toolCall, result });
      if (result.isError) {
        // openclaude Bash-only sibling abort semantics (line 359-362).
        // T5 surfaces the hook; T7 gates by ConcurrencyClass
        // (BackgroundTerminal cascades, other classes don't).
        this.onSiblingAbort?.(`tool_error:${tracked.toolCall.name}`);
      }
    } catch (error) {
      tracked.error = error instanceof Error ? error : new Error(String(error));
      tracked.result = {
        content: JSON.stringify({ error: tracked.error.message }),
        isError: true,
      };
      tracked.status = "completed";
      this.completed.push({ toolCall: tracked.toolCall, result: tracked.result });
      this.onSiblingAbort?.(`tool_threw:${tracked.toolCall.name}`);
    }
    this.signalProgress();
  }
}
