/**
 * Repeat-tool advisory — an advisory loop-breaker, not a gate.
 *
 * Watches each session's stream of dispatched tool calls, counts runs of
 * consecutive calls to the same tool with identical canonicalized arguments,
 * and at configured run lengths appends one escalating advisory reminder
 * telling the model to stop repeating itself, re-read the last result, and
 * either change approach or conclude. The decision (retry differently, gather
 * more evidence, or finish) stays entirely with the model: a legitimately
 * repeated call is delayed by nothing and blocked by nothing.
 *
 * Design ported from DeepSeek Harness's `dsh-repeat-tool-reminder` (MIT),
 * adapted to AgenC's phase pipeline: observation happens in execute-tools
 * after the batch drains, and the advisory rides the same user-context
 * channel as hook additionalContexts. Like the continuation nudge
 * (gaphunt3 #34), the injected message is heuristic-driven and therefore
 * excluded from durable history, so a false positive never pollutes the
 * rollout that `--resume` replays.
 *
 * @module
 */

import type { LLMToolCall } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import { emitWarning } from "../session/event-log.js";
import { stableStringify } from "../utils/stableStringify.js";

/**
 * Consecutive-run lengths that trigger a reminder, in escalation order.
 * A run longer than the last threshold stays silent: by then the model has
 * been reminded three times, and repeating the reminder is itself a loop.
 */
export const REPEAT_TOOL_THRESHOLDS = [3, 5, 8] as const;

/**
 * Tools transparent to the chain: they neither extend nor reset a run.
 * TaskList takes no meaningful arguments, so polling it between steps is an
 * ordinary harness pattern, not a loop symptom.
 */
const TRANSPARENT_TOOLS: ReadonlySet<string> = new Set(["TaskList"]);

/** Cap on the argument preview quoted inside the detailed reminder. */
const ARGUMENTS_PREVIEW_CHARS = 500;

interface RepeatRun {
  key: string;
  toolName: string;
  argumentsPreview: string;
  count: number;
}

/**
 * Per-session run state. Keyed weakly so a disposed session never retains
 * advisory bookkeeping — the same idiom as post-sample-recovery's
 * last-discarded-partial tracking.
 */
const repeatRuns = new WeakMap<object, RepeatRun>();

/**
 * Canonical identity of one call: tool name plus arguments with object keys
 * sorted, so `{"a":1,"b":2}` and `{"b":2,"a":1}` belong to the same run.
 * Arguments that fail to parse as JSON participate verbatim — byte-identical
 * malformed arguments are still the same repeated call.
 */
function canonicalCallKey(call: LLMToolCall): string {
  let canonicalArguments = call.arguments;
  try {
    canonicalArguments = stableStringify(JSON.parse(call.arguments));
  } catch {
    // Verbatim fallback keeps unparseable-argument repeats detectable.
  }
  return `${call.name}\n${canonicalArguments}`;
}

function advisoryText(run: RepeatRun): string {
  const preview =
    run.argumentsPreview.length > ARGUMENTS_PREVIEW_CHARS
      ? `${run.argumentsPreview.slice(0, ARGUMENTS_PREVIEW_CHARS)}…`
      : run.argumentsPreview;
  const observation =
    `You have now called the tool "${run.toolName}" ${run.count} times in a ` +
    `row with identical arguments: ${preview}`;
  if (run.count >= REPEAT_TOOL_THRESHOLDS[2]) {
    return (
      `${observation}\nRepeating this exact call again will not produce a ` +
      `different result. Stop, state in one or two sentences what the ` +
      `repeated result actually says, and then either take a genuinely ` +
      `different action or conclude with what you have.`
    );
  }
  if (run.count >= REPEAT_TOOL_THRESHOLDS[1]) {
    return (
      `${observation}\nThe result is not going to change on its own. ` +
      `Re-read the last result carefully; if you are waiting on something ` +
      `external, say so and how long, otherwise change approach.`
    );
  }
  return (
    `${observation}\nIf that was intentional (for example, polling), carry ` +
    `on. Otherwise re-read the last result before calling again — it may ` +
    `already contain the answer.`
  );
}

/**
 * Feed one dispatched batch, in the model's emission order, into the
 * session's run tracking. Returns the advisory for the HIGHEST threshold
 * crossed by this batch, or undefined when none was crossed — at most one
 * reminder per batch, so a burst from 2 to 9 identical calls produces one
 * strong reminder rather than three stacked ones.
 */
export function observeRepeatToolCalls(
  session: object,
  calls: ReadonlyArray<LLMToolCall>,
): string | undefined {
  let crossed: RepeatRun | undefined;
  for (const call of calls) {
    if (TRANSPARENT_TOOLS.has(call.name)) continue;
    const key = canonicalCallKey(call);
    const previous = repeatRuns.get(session);
    const run: RepeatRun =
      previous !== undefined && previous.key === key
        ? previous
        : {
            key,
            toolName: call.name,
            argumentsPreview: call.arguments,
            count: 0,
          };
    run.count += 1;
    repeatRuns.set(session, run);
    if ((REPEAT_TOOL_THRESHOLDS as readonly number[]).includes(run.count)) {
      // Later crossings in the same batch are necessarily higher counts of
      // the same run: a different call in between would have reset it.
      crossed = { ...run };
    }
  }
  return crossed === undefined ? undefined : advisoryText(crossed);
}

/**
 * Observe the batch and, when a threshold was crossed, append the advisory
 * through the same user-context channel hook additionalContexts use, plus a
 * warning event so transcripts and the TUI show why the context grew.
 */
export function appendRepeatToolAdvisory(
  state: TurnState,
  session: Session,
  calls: ReadonlyArray<LLMToolCall>,
): void {
  const advisory = observeRepeatToolCalls(session, calls);
  if (advisory === undefined) return;
  const modelFacingContext = `<system-reminder>\n${advisory}\n</system-reminder>`;
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "repeat_tool_advisory",
    advisory.split("\n", 1)[0] ?? advisory,
  );
  state.toolResults.push({
    uuid: crypto.randomUUID(),
    role: "user",
    kind: "attachment",
    content: modelFacingContext,
  });
  state.messages.push({
    role: "user",
    content: modelFacingContext,
    runtimeOnly: {
      mergeBoundary: "user_context",
      excludeFromDurableHistory: true,
    },
  });
}
