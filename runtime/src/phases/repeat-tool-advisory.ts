/**
 * Repeat-tool advisory — an advisory loop-breaker, plus one hard gate.
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
 * The one exception is `blockRepeatedFailingCall`: a byte-identical call
 * that has already failed with the same error result three times in this
 * turn is not executed again. Nothing about the call or the runtime has
 * changed, so the result cannot change either; re-running it only burns a
 * model round trip. That case is refused before dispatch with a plain
 * explanation and ends the turn after the batch.
 *
 * @module
 */

import type { LLMToolCall } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type {
  CompletedToolResultRecord,
  TurnState,
} from "../session/turn-state.js";
import type { ToolDispatchResult } from "../tool-registry.js";
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

/**
 * Identical failures of one exact call, within one turn, after which the
 * call is refused instead of executed. Observed motivation: a model that
 * repeated the same two failing Write calls 12 times across 14 model calls
 * (about 2.5 minutes), narrating each time that the denial would clear.
 */
export const REPEATED_FAILURE_BLOCK_THRESHOLD = 3;

/** Metadata marker on the synthetic refusal so it never counts as a failure. */
export const REPEATED_FAILURE_BLOCKED_METADATA_KEY = "repeatedFailingCallBlocked";

/** Cap on the last error quoted inside the refusal. */
const LAST_ERROR_PREVIEW_CHARS = 300;

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
 * Argument fields that do not change what a call DOES. Two calls differing
 * only in these are the same repeated call, so they are dropped from the
 * identity key. `justification` is free text addressed to a human and
 * `prefix_rule` is a suggested approval rule: neither reaches the command.
 * Live shape: a model retried one denied `npm start` 13 times, rewording the
 * justification and nudging the timeouts each round, and the guard saw 13
 * different calls.
 */
const NON_SEMANTIC_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  "justification",
  "prefix_rule",
]);

/** Per-tool additions to {@link NON_SEMANTIC_ARGUMENT_KEYS}. */
const TOOL_NON_SEMANTIC_ARGUMENT_KEYS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  // How long the runtime waits for the process, not what it runs.
  ["exec_command", new Set(["timeoutMs", "yield_time_ms"])],
  ["write_stdin", new Set(["yield_time_ms"])],
]);

function semanticArguments(
  toolName: string,
  parsed: unknown,
): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const perTool = TOOL_NON_SEMANTIC_ARGUMENT_KEYS.get(toolName);
  const semantic: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (NON_SEMANTIC_ARGUMENT_KEYS.has(name)) continue;
    if (perTool?.has(name) === true) continue;
    semantic[name] = value;
  }
  return semantic;
}

/**
 * Canonical identity of one call: tool name plus arguments with object keys
 * sorted and non-semantic fields dropped, so `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` belong to the same run, and so do two calls that differ
 * only in their justification or timeout. Arguments that fail to parse as
 * JSON participate verbatim — byte-identical malformed arguments are still
 * the same repeated call.
 */
function canonicalCallKey(call: LLMToolCall): string {
  let canonicalArguments = call.arguments;
  try {
    canonicalArguments = stableStringify(
      semanticArguments(call.name, JSON.parse(call.arguments)),
    );
  } catch {
    // Verbatim fallback keeps unparseable-argument repeats detectable.
  }
  return `${call.name}\n${canonicalArguments}`;
}

/**
 * Values a runtime writes into every tool result that differ between two
 * otherwise identical runs. Compared raw, they make every failure look new:
 * `exec_command` closes each result with
 * `[exec exit_code=1 wall_time=0.2630s tokens=212]`, and the live incident's
 * 14 identical `npm start` denials produced 13 distinct bodies, differing
 * only in that wall time. Used for comparison only; the model is always
 * shown the raw error.
 */
const VOLATILE_RESULT_PATTERNS: readonly RegExp[] = [
  /\bwall_time=\d+(?:\.\d+)?s/g,
  /\bsession_id=\d+/g,
  /\bprocess_id=\d+/g,
];

/** Comparison form of a failing result: volatile runtime values elided. */
export function failureSignature(content: string): string {
  let signature = content;
  for (const pattern of VOLATILE_RESULT_PATTERNS) {
    signature = signature.replace(pattern, "");
  }
  return signature;
}

function completedRecordKey(record: CompletedToolResultRecord): string {
  return canonicalCallKey({
    id: record.callId,
    name: record.toolName,
    arguments: record.arguments,
  });
}

/**
 * How many times this exact call (same tool, same canonical arguments) has
 * failed in a row with the same error result earlier in this turn, read
 * from the turn's completed results. A success or a different error for the
 * same call resets the run; the synthetic refusal records this module
 * writes are skipped so they never stand in for the original error.
 */
export function identicalFailureRun(
  state: TurnState,
  call: LLMToolCall,
): { readonly count: number; readonly lastError: string } {
  const key = canonicalCallKey(call);
  let count = 0;
  let lastError = "";
  let lastSignature = "";
  for (const record of state.completedToolResults) {
    if (record.metadata?.[REPEATED_FAILURE_BLOCKED_METADATA_KEY] === true) {
      continue;
    }
    if (completedRecordKey(record) !== key) continue;
    if (!record.isError) {
      count = 0;
      lastError = "";
      lastSignature = "";
      continue;
    }
    const signature = failureSignature(record.content);
    if (count > 0 && signature === lastSignature) {
      count += 1;
    } else {
      count = 1;
    }
    // The model is shown the raw error; only the comparison is normalized.
    lastError = record.content;
    lastSignature = signature;
  }
  return { count, lastError };
}

function blockedCallMessage(
  call: LLMToolCall,
  count: number,
  lastError: string,
): string {
  const preview =
    lastError.length > LAST_ERROR_PREVIEW_CHARS
      ? `${lastError.slice(0, LAST_ERROR_PREVIEW_CHARS)}…`
      : lastError;
  return (
    `This exact ${call.name} call already failed ${count} times with the ` +
    "same error in this turn and will not run again. The error is not going " +
    "to change; stop retrying, and if you cannot proceed without it, tell " +
    `the user. Last error: ${preview}`
  );
}

/**
 * The transcript explanation for a turn the refusal ends. Worded like the
 * behavioral backstop's own stop message because it is the same stop,
 * detected early: the model kept issuing one call that kept failing the
 * same way.
 */
export function repeatedFailingCallStopExplanation(
  call: LLMToolCall,
  blocked: ToolDispatchResult,
): string {
  const recorded = blocked.metadata?.repeatedFailures;
  const count =
    typeof recorded === "number" ? recorded : REPEATED_FAILURE_BLOCK_THRESHOLD;
  return (
    `Turn stopped by the no-progress backstop: the exact ${call.name} call ` +
    `failed ${count} times with the same error and was refused (count=${count}). ` +
    "No further progress was being made. No task was completed."
  );
}

/**
 * Refuse a call that has already failed identically
 * `REPEATED_FAILURE_BLOCK_THRESHOLD` times in this turn. Returns the
 * synthetic error result to record in place of a dispatch, or null when the
 * call may run. The result carries `preventContinuation` so the turn ends
 * after the batch; the caller records a `noProgressStop` so that end is
 * reported as the bounded `no_progress` terminal the behavioral backstop
 * uses, not as a completed turn. Successful repeats (re-reading a file,
 * polling) are never affected: only an unbroken run of identical error
 * results counts.
 */
export function blockRepeatedFailingCall(
  state: TurnState,
  session: Session,
  call: LLMToolCall,
): ToolDispatchResult | null {
  const { count, lastError } = identicalFailureRun(state, call);
  if (count < REPEATED_FAILURE_BLOCK_THRESHOLD) return null;
  const message = blockedCallMessage(call, count, lastError);
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "repeated_failing_call_blocked",
    `${call.name} refused: identical call failed ${count} times with the same error in this turn`,
  );
  return {
    content: JSON.stringify({ error: message }),
    isError: true,
    metadata: {
      [REPEATED_FAILURE_BLOCKED_METADATA_KEY]: true,
      repeatedFailures: count,
    },
    preventContinuation: true,
  };
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
