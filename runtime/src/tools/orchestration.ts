/**
 * Tool-batch orchestration helpers.
 *
 * Subset port of openclaude `services/tools/toolOrchestration.ts`
 * (188 LOC). Provides `partitionToolCalls`, `runToolsConcurrently`,
 * `runToolsSerially` — the utilities used by the phase-5 legacy path
 * (pre-StreamingToolExecutor). After T7's streaming executor lands,
 * these remain as the fallback / sub-agent entry points.
 *
 * @module
 */

import type { ConcurrencyClass } from "./concurrency.js";
import type { ToolCall } from "./router.js";

// ─────────────────────────────────────────────────────────────────────
// Partitioning
// ─────────────────────────────────────────────────────────────────────

/**
 * Split a batch of tool calls into (concurrentSafe, serialTail).
 *
 * Mirrors openclaude `partitionToolCalls` (toolOrchestration.ts:36-68):
 * the concurrency-safe prefix runs in parallel, then everything
 * after the first non-safe call runs sequentially.
 *
 * `classify(call)` returns the ConcurrencyClass for each call.
 * Classes that map to `exclusive` or `background_terminal` break the
 * parallel prefix; `shared_read` and `shared_server(id)` continue it.
 */
export function partitionToolCalls(
  calls: ReadonlyArray<ToolCall>,
  classify: (call: ToolCall) => ConcurrencyClass,
): { readonly concurrent: ToolCall[]; readonly serial: ToolCall[] } {
  const concurrent: ToolCall[] = [];
  const serial: ToolCall[] = [];
  let breakPoint = false;
  for (const call of calls) {
    if (breakPoint) {
      serial.push(call);
      continue;
    }
    const klass = classify(call);
    if (klass.kind === "shared_read" || klass.kind === "shared_server") {
      concurrent.push(call);
    } else {
      breakPoint = true;
      serial.push(call);
    }
  }
  return { concurrent, serial };
}

// ─────────────────────────────────────────────────────────────────────
// Concurrency cap
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10;

export function resolveMaxToolUseConcurrency(): number {
  const raw = process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
  if (!raw) return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────
// runToolsConcurrently / runToolsSerially
// ─────────────────────────────────────────────────────────────────────

/**
 * Run `tools.length` async operations with a bounded concurrency.
 * Preserves in-order results (resolve at index i → result at index
 * i) so callers can splice back into the source list without
 * re-mapping.
 */
export async function runToolsConcurrently<T>(
  tools: ReadonlyArray<ToolCall>,
  run: (call: ToolCall, index: number) => Promise<T>,
  opts: { readonly concurrency?: number } = {},
): Promise<T[]> {
  const concurrency = opts.concurrency ?? resolveMaxToolUseConcurrency();
  const results: T[] = new Array(tools.length);
  let next = 0;

  const workers: Array<Promise<void>> = [];
  const workerCount = Math.min(concurrency, tools.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const idx = next;
          next += 1;
          if (idx >= tools.length) return;
          const call = tools[idx];
          if (!call) continue;
          results[idx] = await run(call, idx);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * Run every tool in order, awaiting each before starting the next.
 * Used for the non-concurrency-safe tail of `partitionToolCalls`.
 */
export async function runToolsSerially<T>(
  tools: ReadonlyArray<ToolCall>,
  run: (call: ToolCall, index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(tools.length);
  for (let i = 0; i < tools.length; i += 1) {
    const call = tools[i];
    if (!call) continue;
    results[i] = await run(call, i);
  }
  return results;
}

/**
 * Convenience: run the concurrent prefix + serial tail of a batch
 * using the supplied classifier. Result array is in original call
 * order.
 */
export async function runTools<T>(
  calls: ReadonlyArray<ToolCall>,
  classify: (call: ToolCall) => ConcurrencyClass,
  run: (call: ToolCall, index: number) => Promise<T>,
  opts: { readonly concurrency?: number } = {},
): Promise<T[]> {
  const { concurrent, serial } = partitionToolCalls(calls, classify);
  const concurrentResults = await runToolsConcurrently(
    concurrent,
    (call) => {
      const originalIdx = calls.indexOf(call);
      return run(call, originalIdx);
    },
    opts,
  );
  const serialResults = await runToolsSerially(serial, (call) => {
    const originalIdx = calls.indexOf(call);
    return run(call, originalIdx);
  });

  const out: T[] = new Array(calls.length);
  for (let i = 0; i < concurrent.length; i += 1) {
    const call = concurrent[i];
    if (!call) continue;
    const idx = calls.indexOf(call);
    out[idx] = concurrentResults[i] as T;
  }
  for (let i = 0; i < serial.length; i += 1) {
    const call = serial[i];
    if (!call) continue;
    const idx = calls.indexOf(call);
    out[idx] = serialResults[i] as T;
  }
  return out;
}
