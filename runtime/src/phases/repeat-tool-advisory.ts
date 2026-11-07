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
 * explanation telling the model to change approach. The first refusal lets
 * the turn continue, because an unattended session can only act on that
 * advice by sampling again; a second refusal of the same call means the
 * advice did not land, and the turn ends after the batch. Only failures and
 * refusals since the turn's last real progress count: a result that could
 * change the failing call's outcome, such as a file change, a shell command
 * that is not read-only or stdin input that reached a session (see
 * `lastProgressIndex`). A test rerun after a real code change runs again; a
 * retry between reads is still refused. A command or input restarts a failing
 * call once per error: if the call then fails the same way, a later command
 * does not restart it again (see `failureRunOf`).
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
import { classifyReadOnlyShellIntent } from "../permissions/read-only-shell-intent.js";
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

/**
 * Model sample the refusal belongs to. The turn ends on a refusal that
 * repeats one from an EARLIER sample, so the opportunity to change approach
 * is one sampling generation, not one result row: a model output carrying
 * the same failing call twice is refused twice inside the same generation
 * and still gets its sample.
 */
export const REPEATED_FAILURE_SAMPLE_METADATA_KEY = "repeatedFailingCallSample";

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
const VOLATILE_RESULT_FIELDS =
  /(^| )(?:wall_time=\d+(?:\.\d+)?s|session_id=\d+|process_id=\d+)(?= |$)/g;

/**
 * Runtime formatters put their compact footer at the end, separated from
 * output by a blank line (or alone when there is no output). Require that
 * framing so application diagnostics containing the same field names stay
 * meaningful. Unknown or incomplete footer formats are compared verbatim.
 * The final lookahead requires the actual end, unlike `$`, which also
 * accepts a position before a trailing newline. The one runtime text that
 * may follow the footer is a `[sandbox]` notice after a blank line, which
 * exec_command appends to a blocked local server, network access or .git
 * write; the notice itself is compared verbatim. Without it, a repeat of a
 * sandbox-blocked failure differed only in its wall time and looked new. A
 * footer with no later footer is the real one: a footer and a notice printed
 * in the command's own output are output. The pattern is applied from the
 * last footer only ({@link lastFooterStart}).
 */
const RUNTIME_RESULT_FOOTER =
  /^((?:\n\n)?\[(?:exec|mcp|code_mode) )([^\r\n[\]]+)(\])(?=(?:\n\n\[sandbox\] [\s\S]*)?(?![\s\S]))/u;

const RUNTIME_FOOTER_STARTS = ["\n\n[exec ", "\n\n[mcp ", "\n\n[code_mode "] as const;

/**
 * Where the last runtime footer can start: the last footer after a blank
 * line, or else the start of the text. A footer holds no newline, so no later
 * footer starts inside it, and only the last one can be the real footer.
 * Found once: a lookahead for "no later footer" rescanned the rest of the
 * output at every footer and notice the command printed, and 2.2 MiB of them
 * took 8.4 s (fix32s review rv3).
 */
function lastFooterStart(content: string): number {
  return Math.max(0, ...RUNTIME_FOOTER_STARTS.map((start) => content.lastIndexOf(start)));
}

/** Elide volatile fields only in the final runtime footer, never the body. */
export function failureSignature(content: string): string {
  const start = lastFooterStart(content);
  return content.slice(0, start) + content.slice(start).replace(
    RUNTIME_RESULT_FOOTER,
    (_footer, prefix: string, fields: string, suffix: string) =>
      `${prefix}${fields.replace(VOLATILE_RESULT_FIELDS, "$1")}${suffix}`,
  );
}

function completedRecordKey(record: CompletedToolResultRecord): string {
  return canonicalCallKey({
    id: record.callId,
    name: record.toolName,
    arguments: record.arguments,
  });
}

/**
 * Tools whose successful result changed files. An edit that would change
 * nothing is refused as an error, so it never counts.
 */
const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * The identity of a successful result that could change the outcome of a call
 * that keeps failing, or undefined: a file change, an exec_command that
 * classifyReadOnlyShellIntent does not classify as read-only, or write_stdin
 * input that reached a live session and is not a read-only command line.
 * Reads (FileRead, `cat`, `ls`, `grep`), polls, and input the exited-session
 * answer did not send change nothing the failing call depends on.
 */
function progressKey(record: CompletedToolResultRecord): string | undefined {
  if (record.isError) return undefined;
  if (FILE_CHANGING_TOOLS.has(record.toolName)) return completedRecordKey(record);
  if (record.toolName !== "exec_command" && record.toolName !== "write_stdin") return undefined;
  if (record.metadata?.sessionExited === true) return undefined;
  let line: unknown;
  try {
    const parsed = JSON.parse(record.arguments) as Record<string, unknown> | null;
    line = record.toolName === "exec_command" ? parsed?.cmd : parsed?.chars;
  } catch {
    return undefined;
  }
  if (typeof line !== "string" || line.length === 0) return undefined;
  return classifyReadOnlyShellIntent(line).allowed ? undefined : completedRecordKey(record);
}

/**
 * Position in `completedToolResults` of the turn's last real progress, or -1:
 * the first success of a result that could change a failing call's outcome
 * ({@link progressKey}). Failures and refusals of a repeated call count only
 * after that point ({@link failureRunOf} adds one limit for commands and
 * input), so a test rerun after a real code change runs instead of
 * being refused as an error that "is not going to change". The same edit or
 * command again is not new progress, and nothing read-only is progress at
 * all, so a loop that only looks busy is still refused and then stopped as on
 * 0.19.30: in the fix31s review (2026-11-06), a new `cat` between retries of
 * one failing `npm start` reset a first version of this rule 40 times. The
 * stale polls of tb4h music-harmony never count: an exited session's answer
 * is not a failure.
 */
export function lastProgressIndex(state: TurnState): number {
  const seen = new Set<string>();
  let last = -1;
  for (const [index, record] of state.completedToolResults.entries()) {
    const key = progressKey(record);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    last = index;
  }
  return last;
}

interface FailureRun {
  /** Identical failures in a row since the call's last restart. */
  readonly count: number;
  readonly lastError: string;
  /** Position of the call's last restart: its failures and refusals up to it do not count. */
  readonly since: number;
}

/**
 * The run of identical failures of one exact call, read from the turn's
 * completed results. Real progress ({@link progressKey}) restarts the run, with
 * one limit: a command or stdin input restarts a failing call once per error.
 * When the call fails the same way after such a restart, the command did not
 * change its outcome, and a later command does not restart it again; a file
 * change, a success of the call or a different error does. In the fix31s
 * review, a new `touch f-N` between retries of one failing `npm start`
 * restarted the run every cycle, and a new diagnostic command after each
 * failure (`lsof -i :3001`, `python3 -c ...`, anything not read-only) kept the
 * count from ever reaching the threshold. The same command again is no
 * progress at all, so a new command each time now stops where the same
 * command does.
 */
function failureRunOf(state: TurnState, call: LLMToolCall): FailureRun {
  const key = canonicalCallKey(call);
  const progressSeen = new Set<string>();
  let count = 0;
  let lastError = "";
  let lastSignature = "";
  let since = -1;
  // The error of the failure run a command or input already restarted.
  let restartedByCommand: string | undefined;
  for (const [index, record] of state.completedToolResults.entries()) {
    const progress = progressKey(record);
    if (progress !== undefined && !progressSeen.has(progress)) {
      progressSeen.add(progress);
      const fileChange = FILE_CHANGING_TOOLS.has(record.toolName);
      if (fileChange || count === 0 || restartedByCommand !== lastSignature) {
        if (fileChange) restartedByCommand = undefined;
        else if (count > 0) restartedByCommand = lastSignature;
        count = 0;
        lastError = "";
        lastSignature = "";
        since = index;
      }
    }
    if (record.metadata?.[REPEATED_FAILURE_BLOCKED_METADATA_KEY] === true) {
      continue;
    }
    if (completedRecordKey(record) !== key) continue;
    if (!record.isError) {
      count = 0;
      lastError = "";
      lastSignature = "";
      restartedByCommand = undefined;
      continue;
    }
    const signature = failureSignature(record.content);
    if (count > 0 && signature === lastSignature) {
      count += 1;
    } else {
      count = 1;
    }
    if (restartedByCommand !== undefined && signature !== restartedByCommand) {
      restartedByCommand = undefined;
    }
    // The model is shown the raw error; only the comparison is normalized.
    lastError = record.content;
    lastSignature = signature;
  }
  return { count, lastError, since };
}

/**
 * How many times this exact call (same tool, same canonical arguments) has
 * failed in a row with the same error result since its last restart by real
 * progress, read from the turn's completed results. A success or a different
 * error for the same call resets the run; the synthetic refusal records this
 * module writes are skipped so they never stand in for the original error.
 */
export function identicalFailureRun(
  state: TurnState,
  call: LLMToolCall,
): { readonly count: number; readonly lastError: string } {
  const { count, lastError } = failureRunOf(state, call);
  return { count, lastError };
}

function blockedCallMessage(
  call: LLMToolCall,
  count: number,
  lastError: string,
  endsTurn: boolean,
  nonRetryable: boolean,
): string {
  const preview =
    lastError.length > LAST_ERROR_PREVIEW_CHARS
      ? `${lastError.slice(0, LAST_ERROR_PREVIEW_CHARS)}…`
      : lastError;
  const consequence = endsTurn
    ? "This is the second refusal of the same call, so the turn stops here."
    : "Take a different action now: change the arguments, use another tool, " +
      "work around what is failing, or finish with what you have. Issuing " +
      "this same call again stops the turn.";
  if (nonRetryable) {
    return (
      `This exact ${call.name} call was refused as not retryable with the same arguments. ` +
      `${consequence} Last error: ${preview}`
    );
  }
  return (
    `This exact ${call.name} call already failed ${count} times with the ` +
    "same error in this turn and will not run again. The error is not going " +
    `to change. ${consequence} Last error: ${preview}`
  );
}

function lastFailureIsNonRetryable(state: TurnState, call: LLMToolCall, since: number): boolean {
  const key = canonicalCallKey(call);
  for (let index = state.completedToolResults.length - 1; index > since; index -= 1) {
    const record = state.completedToolResults[index]!;
    if (completedRecordKey(record) !== key) continue;
    if (record.metadata?.[REPEATED_FAILURE_BLOCKED_METADATA_KEY] === true) continue;
    return record.isError && record.metadata?.retryable === false;
  }
  return false;
}

/**
 * Whether this exact call was already refused in an EARLIER model sample.
 * The first refusal hands the model the message above and lets it sample
 * again, which is the only way an unattended session can act on the advice.
 * A refusal recorded before the current sample means the advice did not
 * land, so the turn ends. Refusals from the current sample do not count:
 * `executeTools` records each refusal as it goes, so a model output that
 * repeats the same failing call twice would otherwise consume the
 * opportunity inside the batch that created it, before the model could read
 * anything. A refusal without a recorded sample predates this turn's
 * batch (a resumed turn, a legacy record) and counts as earlier. A refusal
 * before the call's last restart by real progress does not count: the model
 * acted on it ({@link failureRunOf}).
 */
function refusedInEarlierSample(state: TurnState, call: LLMToolCall, since: number): boolean {
  const key = canonicalCallKey(call);
  const currentSample = state.modelSampleOrdinal;
  for (const [index, record] of state.completedToolResults.entries()) {
    if (index <= since) continue;
    if (record.metadata?.[REPEATED_FAILURE_BLOCKED_METADATA_KEY] !== true) {
      continue;
    }
    if (completedRecordKey(record) !== key) continue;
    if (record.metadata?.[REPEATED_FAILURE_SAMPLE_METADATA_KEY] !== currentSample) {
      return true;
    }
  }
  return false;
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
 * Whether `blockRepeatedFailingCall` would refuse this call, decided without
 * emitting anything. The streaming dispatch path asks this before it queues a
 * call, so a call that is about to be refused never runs, and the refusal is
 * recorded once by the post-stream pass as the call's only result.
 */
export function isRepeatedFailingCall(
  state: TurnState,
  call: LLMToolCall,
): boolean {
  const { count, since } = failureRunOf(state, call);
  return count >= (lastFailureIsNonRetryable(state, call, since) ? 1 : REPEATED_FAILURE_BLOCK_THRESHOLD);
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
  const { count, lastError, since } = failureRunOf(state, call);
  const nonRetryable = lastFailureIsNonRetryable(state, call, since);
  if (count < (nonRetryable ? 1 : REPEATED_FAILURE_BLOCK_THRESHOLD)) return null;
  const endsTurn = refusedInEarlierSample(state, call, since);
  const message = blockedCallMessage(call, count, lastError, endsTurn, nonRetryable);
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "repeated_failing_call_blocked",
    `${call.name} refused: identical call failed ${count} times with the same error in this turn` +
      (endsTurn ? "; refused twice, stopping the turn" : "; the model may change approach"),
  );
  return {
    content: JSON.stringify({ error: message, ...(nonRetryable ? { retryable: false } : {}) }),
    isError: true,
    metadata: {
      [REPEATED_FAILURE_BLOCKED_METADATA_KEY]: true,
      [REPEATED_FAILURE_SAMPLE_METADATA_KEY]: state.modelSampleOrdinal,
      repeatedFailures: count,
      ...(nonRetryable ? { retryable: false } : {}),
    },
    ...(endsTurn ? { preventContinuation: true } : {}),
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
