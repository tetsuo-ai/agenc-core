/**
 * `runTools` — concurrency-safe tool dispatch (Cut 5.5).
 *
 * Partitions tool calls into batches of:
 *  - consecutive *concurrency-safe* (read-only) tools, run in parallel
 *  - one *non-concurrency-safe* tool at a time, run serially
 *
 * The runtime decides whether a tool is concurrency-safe by consulting
 * the optional `isConcurrencySafe(args)` method on its `Tool` definition
 * (added by Cut 5.5; defaults to `false` so the change is opt-in per
 * tool). The dispatcher itself is provider-agnostic — callers pass a
 * `runOne` callback that knows how to actually invoke a single tool
 * call against the live tool handler.
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";

/** Predicate the dispatcher uses to decide whether a call can run in parallel. */
export type IsConcurrencySafeFn = (toolCall: LLMToolCall) => boolean;

interface ToolBatch {
  readonly isConcurrencySafe: boolean;
  readonly toolCalls: readonly LLMToolCall[];
}

/**
 * Group `toolCalls` into batches honoring the partition rule:
 *   - a run of consecutive concurrency-safe calls becomes one parallel batch
 *   - any non-concurrency-safe call is its own serial batch (length 1)
 */
export function partitionToolCalls(
  toolCalls: readonly LLMToolCall[],
  isConcurrencySafe: IsConcurrencySafeFn,
): readonly ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const call of toolCalls) {
    const safe = (() => {
      try {
        return Boolean(isConcurrencySafe(call));
      } catch {
        return false;
      }
    })();
    const tail = batches[batches.length - 1];
    if (safe && tail && tail.isConcurrencySafe) {
      (tail.toolCalls as LLMToolCall[]).push(call);
    } else {
      batches.push({
        isConcurrencySafe: safe,
        toolCalls: [call],
      });
    }
  }
  return batches;
}

