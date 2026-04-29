/**
 * Failed-tool tracking helpers extracted from chat-executor-tool-loop.
 *
 * This module owns the "model keeps retrying the same broken call"
 * detection logic: identify consecutive failed tool calls, build a
 * signature over the (tool name, arguments) pair, and surface a
 * recovery-hint message that tells the model to stop repeating the
 * failing pattern.
 *
 * None of this is Grok-specific or verifier-related — it's a general
 * safety rail that prevents model-driven tool-retry loops from eating
 * the runtime-round budget without making progress. Extracted here so
 * the main tool-loop file stays focused on control flow.
 *
 * @module
 */

import type { LLMResponse, LLMToolCall } from "./types.js";
import type { ToolCallRecord, RecoveryHint } from "./chat-executor-types.js";
import { didToolCallFail } from "./chat-executor-tool-utils.js";

/**
 * Minimum consecutive failed tool calls before the "you're looping on
 * the same broken call" recovery hint fires. Kept at 3 because a
 * two-call streak can be legitimate retry-after-transient behavior;
 * three identical failures is a pattern.
 */
export const FAILED_TOOL_RECOVERY_STREAK = 3;

/**
 * Extract a short, single-line failure description from a ToolCallRecord
 * for display in the recovery hint. Prefers a structured `error` field
 * from a JSON tool result, falls back to a whitespace-collapsed prefix
 * of the raw result text.
 */
export function summarizeToolFailureForRecovery(call: ToolCallRecord): string {
  try {
    const parsed = JSON.parse(call.result) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim().replace(/\s+/g, " ");
    }
  } catch {
    // Fall back to plain text below.
  }
  const compact = call.result.trim().replace(/\s+/g, " ").slice(0, 140);
  return compact.length > 0 ? compact : "tool call failed";
}

/**
 * Build the system-visible recovery hint when the last
 * {@link FAILED_TOOL_RECOVERY_STREAK} tool calls all failed. Returns
 * undefined when the streak threshold has not been reached yet.
 */
export function buildFailedToolRecoveryHint(
  failedCalls: readonly ToolCallRecord[],
): RecoveryHint | undefined {
  if (failedCalls.length < FAILED_TOOL_RECOVERY_STREAK) {
    return undefined;
  }
  const summary = failedCalls
    .slice(-FAILED_TOOL_RECOVERY_STREAK)
    .map((call) => `${call.name}: ${summarizeToolFailureForRecovery(call)}`)
    .join(" | ");
  return {
    key: "failed_tool_streak",
    message:
      `Recent tool failures: ${summary}. Stop repeating the same failing tool pattern. Reassess the errors and continue without tools unless a materially different tool action is clearly justified.`,
  };
}

/**
 * Produce a deterministic serialization of a tool-call argument value
 * with sorted object keys. Used by {@link toolFailureSignature} so that
 * `{a: 1, b: 2}` and `{b: 2, a: 1}` compare equal.
 */
function stableToolFailureValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableToolFailureValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableToolFailureValue(entryValue)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical string signature of a (tool name, arguments) pair.
 * Two calls with the same name + identical args produce the same
 * signature regardless of argument key ordering.
 */
export function toolFailureSignature(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${stableToolFailureValue(args)}`;
}

/**
 * Same as {@link toolFailureSignature} but works directly on an
 * {@link LLMToolCall} whose arguments are a JSON-encoded string. Returns
 * undefined when the arguments fail to parse or aren't a plain object.
 */
export function toolCallSignature(toolCall: LLMToolCall): string | undefined {
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return toolFailureSignature(
      toolCall.name,
      parsed as Record<string, unknown>,
    );
  } catch {
    return undefined;
  }
}

/**
 * True when the last {@link FAILED_TOOL_RECOVERY_STREAK} failed calls
 * all share the same (name, args) signature — i.e. the model is
 * retrying the exact same broken call.
 */
export function isRepeatedSameFailedToolPattern(
  failedCalls: readonly ToolCallRecord[],
): boolean {
  const recentFailures = failedCalls.slice(-FAILED_TOOL_RECOVERY_STREAK);
  if (recentFailures.length < FAILED_TOOL_RECOVERY_STREAK) {
    return false;
  }
  const [first, ...rest] = recentFailures.map((call) =>
    toolFailureSignature(call.name, call.args),
  );
  return rest.every((signature) => signature === first);
}

/**
 * True when the model's response is attempting to re-issue the same
 * tool call pattern that has been failing. Used to force-stop the loop
 * when the model can't break out of its retry rut.
 */
export function responseRepeatsFailedToolPattern(params: {
  readonly response: LLMResponse;
  readonly failedCalls: readonly ToolCallRecord[];
}): boolean {
  if (!isRepeatedSameFailedToolPattern(params.failedCalls)) {
    return false;
  }
  const repeatedFailure = params.failedCalls[params.failedCalls.length - 1];
  if (!repeatedFailure) {
    return false;
  }
  const repeatedSignature = toolFailureSignature(
    repeatedFailure.name,
    repeatedFailure.args,
  );
  return params.response.toolCalls.every(
    (toolCall) => toolCallSignature(toolCall) === repeatedSignature,
  );
}

/**
 * Walk the tool-call ledger backwards and collect the trailing run of
 * consecutive failed calls (skipping entries flagged
 * `failureBudgetExempt`). Used to build the recovery-hint input.
 */
export function collectRecentConsecutiveFailedToolCalls(
  toolCalls: readonly ToolCallRecord[],
): readonly ToolCallRecord[] {
  const collected: ToolCallRecord[] = [];
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call.failureBudgetExempt === true) {
      continue;
    }
    if (!didToolCallFail(call.isError, call.result)) {
      break;
    }
    collected.unshift(call);
  }
  return collected;
}

/**
 * Update the per-turn failed-tool streak counter based on the tool
 * calls from the current round. Resets to zero on any non-exempt
 * successful call; increments by one per non-exempt failure.
 */
export function updateFailedToolStreak(
  currentStreak: number,
  roundCalls: readonly ToolCallRecord[],
): number {
  let nextStreak = currentStreak;
  for (const call of roundCalls) {
    if (call.failureBudgetExempt === true) {
      continue;
    }
    if (didToolCallFail(call.isError, call.result)) {
      nextStreak += 1;
      continue;
    }
    nextStreak = 0;
  }
  return nextStreak;
}

/**
 * Merge a new recovery hint into an existing hint list, replacing any
 * prior hint with the same key. Order-preserving.
 */
export function mergeRecoveryHints(
  recoveryHints: readonly RecoveryHint[],
  extraHint: RecoveryHint | undefined,
): readonly RecoveryHint[] {
  if (!extraHint) return recoveryHints;
  const filtered = recoveryHints.filter((hint) => hint.key !== extraHint.key);
  return [...filtered, extraHint];
}
