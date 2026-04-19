/**
 * Hook dispatcher (Cut 5.2).
 *
 * Walks every hook definition registered for the given event, runs the
 * matching ones in parallel with a per-hook timeout, and folds their
 * outcomes:
 *
 *   - any "deny" → final action is "deny" (first wins for the message)
 *   - any "allow" with `updatedInput` → wins over a no-op
 *   - all "noop" → final action is "noop"
 *
 * Hook execution itself is opaque (shell, callback, http) — the
 * registry stores the target as a string and the executors module
 * dispatches based on `HookKind`.
 *
 * @module
 */

import type { HookContext, HookOutcome, HookEvent } from "./types.js";
import type { HookRegistry } from "./registry.js";
import { matchesHookMatcher } from "./matcher.js";
import type { HookExecutor } from "./executors.js";

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

export interface DispatchInput {
  readonly registry: HookRegistry;
  readonly event: HookEvent;
  readonly context: HookContext;
  /** What the matcher should compare against (tool name, file path, etc). */
  readonly matchKey?: string;
  /** Per-hook execution callback (registry just holds metadata). */
  readonly executor: HookExecutor;
  readonly timeoutMs?: number;
}

export interface DispatchResult {
  readonly action: "allow" | "deny" | "noop";
  readonly message?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly outcomes: readonly HookOutcome[];
}

export async function dispatchHooks(input: DispatchInput): Promise<DispatchResult> {
  const definitions = input.registry.forEvent(input.event);
  const matched = definitions.filter((definition) =>
    matchesHookMatcher(definition.matcher, input.matchKey ?? ""),
  );
  if (matched.length === 0) {
    return { action: "noop", outcomes: [] };
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const outcomes = await Promise.all(
    matched.map((definition) =>
      runWithTimeout(input.executor(definition, input.context), timeoutMs),
    ),
  );
  return foldOutcomes(outcomes);
}

function foldOutcomes(outcomes: readonly HookOutcome[]): DispatchResult {
  let updatedInput: Record<string, unknown> | undefined;
  for (const outcome of outcomes) {
    if (outcome.action === "deny") {
      return {
        action: "deny",
        message: outcome.message,
        outcomes,
      };
    }
    if (outcome.updatedInput) updatedInput = outcome.updatedInput;
  }
  if (updatedInput) {
    return { action: "allow", updatedInput, outcomes };
  }
  return { action: "noop", outcomes };
}

async function runWithTimeout(
  promise: Promise<HookOutcome>,
  timeoutMs: number,
): Promise<HookOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<HookOutcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({ action: "noop", message: `hook timed out after ${timeoutMs}ms` });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
