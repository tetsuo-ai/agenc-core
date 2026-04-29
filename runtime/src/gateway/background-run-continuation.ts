/**
 * Cross-cycle auto-continuation for background runs.
 *
 * When the actor emits a text-only turn with no tool calls, AgenC's
 * zero-tool completion guard can downgrade the decision from
 * `completed` to `working`. Without a further signal the next cycle's
 * prompt carries the previous cycle's status line only, giving the
 * model no direct reason to change course — which in practice led to
 * the Grok narrate-and-stop failure observed in `bg-mo2unoe5`.
 *
 * This module mirrors the upstream pattern at `query.ts:1282-1341` of
 * injecting a fresh user-turn message into the conversation history
 * before the next model call. Two mechanisms:
 *
 * 1. Zero-tool blocking — emitted when the guard previously downgraded
 *    a `completed` decision. Gives the actor an explicit directive to
 *    keep working, with a hard cap on consecutive nudges so a
 *    misbehaving actor cannot cycle indefinitely.
 *
 * 2. Task-staleness reminder — emitted on a fixed cadence when the
 *    actor has not touched the task tracker in a while, listing the
 *    currently-open tasks so the actor sees them without calling
 *    `task.list` itself. Analogous to the upstream todo-reminder
 *    attachment pattern at `utils/attachments.ts:3300-3316`.
 *
 * Both builders emit plain `{role: "user", content: "..."}` messages
 * with a `[runtime]` text prefix. No `runtimeOnly` tag, no XML
 * wrapping — the prefix alone is enough for the watch surface to
 * recognize the message as runtime-authored without any provider-side
 * interpretation.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";

export const MAX_CONSECUTIVE_NUDGE_CYCLES = 2;
export const TASK_REMINDER_CYCLES_SINCE_WRITE = 6;
export const TASK_REMINDER_SAMPLE_LIMIT = 5;
export const ZERO_TOOL_TASK_SAMPLE_LIMIT = 5;
export const ZERO_TOOL_REQUIREMENT_SAMPLE_LIMIT = 5;

const RUNTIME_PREFIX = "[runtime] ";

export interface OpenTaskSummary {
  readonly id: string;
  readonly status: "pending" | "in_progress";
  readonly subject: string;
}

export interface ZeroToolBlockingParams {
  readonly cycleCount: number;
  readonly consecutiveNudgeCount: number;
  readonly openTaskCount: number;
  readonly openTaskSamples: readonly string[];
  readonly remainingRequirements: readonly string[];
}

export interface TaskStalenessParams {
  readonly cyclesSinceTaskTool: number;
  readonly openTasks: readonly OpenTaskSummary[];
}

/**
 * Build the zero-tool blocking message that lands in the actor's
 * next prompt when the prior cycle emitted a text-only `completed`
 * decision that the guard downgraded.
 */
export function buildZeroToolBlockingMessage(
  params: ZeroToolBlockingParams,
): LLMMessage {
  const lines: string[] = [];
  lines.push(
    `Cycle ${params.cycleCount} ended with no tool calls.`,
  );
  if (params.openTaskCount > 0) {
    lines.push(`Open tasks: ${params.openTaskCount}.`);
    if (params.openTaskSamples.length > 0) {
      const shown = params.openTaskSamples.slice(0, ZERO_TOOL_TASK_SAMPLE_LIMIT);
      lines.push(
        `Examples: ${shown.map((subject) => `"${subject}"`).join(", ")}.`,
      );
    }
  }
  if (params.remainingRequirements.length > 0) {
    const shown = params.remainingRequirements.slice(
      0,
      ZERO_TOOL_REQUIREMENT_SAMPLE_LIMIT,
    );
    lines.push(`Remaining requirements: ${shown.join(", ")}.`);
  }
  lines.push(
    "Keep working — do not summarize. Call the appropriate tool to make progress,",
    "or emit completionProgress with remainingRequirements: [] to confirm you are done.",
  );
  if (params.consecutiveNudgeCount >= MAX_CONSECUTIVE_NUDGE_CYCLES) {
    lines.push(
      `Nudge budget exhausted (${params.consecutiveNudgeCount}/${MAX_CONSECUTIVE_NUDGE_CYCLES}).`,
      "If the objective is genuinely complete, this cycle's completed response will be accepted as terminal.",
    );
  }
  return {
    role: "user",
    content: RUNTIME_PREFIX + lines.join(" "),
  };
}

/**
 * Build the task-staleness reminder message injected on a fixed
 * cadence when the actor hasn't touched the task tracker in a while.
 */
export function buildTaskStalenessReminder(
  params: TaskStalenessParams,
): LLMMessage {
  const lines: string[] = [];
  lines.push(
    `The task tool has not been called in ${params.cyclesSinceTaskTool} cycles.`,
    "Call task.update on any completed items, or task.create to register new work.",
  );
  if (params.openTasks.length > 0) {
    const shown = params.openTasks.slice(0, TASK_REMINDER_SAMPLE_LIMIT);
    const bullets = shown
      .map(
        (task, index) =>
          `${index + 1}. [${task.status}] ${task.subject}`,
      )
      .join("\n  ");
    lines.push(`Open tasks:\n  ${bullets}`);
    if (params.openTasks.length > shown.length) {
      lines.push(
        `(showing first ${shown.length} of ${params.openTasks.length})`,
      );
    }
  } else {
    lines.push("No open tasks recorded.");
  }
  return {
    role: "user",
    content: RUNTIME_PREFIX + lines.join(" "),
  };
}

/** Extract the last message's role from a read-only history array. */
function lastMessageRole(
  history: readonly LLMMessage[],
): LLMMessage["role"] | undefined {
  return history.length === 0 ? undefined : history[history.length - 1]!.role;
}

export interface EvaluateCycleContinuationInjectionsParams {
  readonly cycleCount: number;
  readonly consecutiveNudgeCycles: number;
  readonly cyclesSinceTaskTool: number;
  readonly lastToolEvidencePresent: boolean;
  readonly remainingRequirements: readonly string[];
  readonly history: readonly LLMMessage[];
  readonly openTasks: readonly OpenTaskSummary[];
}

/**
 * Return the continuation messages to prepend to the next cycle's
 * actor history. Evaluates the two mechanisms in order (zero-tool
 * blocking first, then task-staleness). Each mechanism is
 * individually skipped if the last message already has
 * `role: "user"` — never emits consecutive same-role messages.
 */
export function evaluateCycleContinuationInjections(
  params: EvaluateCycleContinuationInjectionsParams,
): readonly LLMMessage[] {
  const injections: LLMMessage[] = [];
  // The consecutive-user-message guard applies to the EXISTING history
  // only — once we decide to inject, we commit to any same-cycle
  // injection sequence. The adapter's normalizeMessagesForAPI handles
  // consecutive user messages if the provider prefers them merged.
  const priorLastRole = lastMessageRole(params.history);
  if (priorLastRole === "user") {
    return injections;
  }

  const shouldEmitZeroToolNudge =
    params.consecutiveNudgeCycles > 0 &&
    params.consecutiveNudgeCycles <= MAX_CONSECUTIVE_NUDGE_CYCLES &&
    params.lastToolEvidencePresent;
  if (shouldEmitZeroToolNudge) {
    injections.push(
      buildZeroToolBlockingMessage({
        cycleCount: params.cycleCount,
        consecutiveNudgeCount: params.consecutiveNudgeCycles,
        openTaskCount: params.openTasks.length,
        openTaskSamples: params.openTasks.map((task) => task.subject),
        remainingRequirements: params.remainingRequirements,
      }),
    );
  }

  const shouldEmitTaskReminder =
    params.cyclesSinceTaskTool > 0 &&
    params.cyclesSinceTaskTool % TASK_REMINDER_CYCLES_SINCE_WRITE === 0;
  if (shouldEmitTaskReminder) {
    injections.push(
      buildTaskStalenessReminder({
        cyclesSinceTaskTool: params.cyclesSinceTaskTool,
        openTasks: params.openTasks,
      }),
    );
  }

  return injections;
}
