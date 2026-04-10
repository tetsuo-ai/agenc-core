/**
 * Turn-end stop gate — structural defense against false-success summaries.
 *
 * Detects model fabrications that bypass every other gate in the runtime:
 * the model finishes its tool loop, declines to call any more tools, and
 * emits a final assistant message that claims the work succeeded — but the
 * tool ledger for the same turn shows failed `system.bash` calls, refused
 * `system.writeFile` calls (anti-fab gate), or a suspiciously short
 * truncated message.
 *
 * Built specifically to catch the 2026-04-09 incident where Grok ran 35
 * tool calls (10 of which failed with `cmake` configure errors because
 * `libreadline-dev` was not installed) and then emitted exactly 14 output
 * tokens of `**Phase 0 bootstrap complete. Build succeeded, binary exists
 * at \`` — status `completed`, `incomplete_details: null`, no tool calls,
 * literal text cuts off mid-sentence after a backtick. None of the
 * existing gates fired:
 *
 *   - `validateXaiResponsePostFlight` looks for promise language
 *     ("I will call X", "now executing") but the model wasn't promising,
 *     it was claiming completion.
 *   - The anti-fabrication writeFile gate (`anti_fabrication_harness_overwrite`)
 *     fires on a write over a failing harness, which didn't happen here.
 *   - `assertNoSilentToolDropOnFollowup` only catches the "tools were
 *     stripped at the adapter boundary" case.
 *   - The `Report outcomes faithfully` system prompt rule from PR #300
 *     bans the behavior, but Grok ignored it.
 *
 * Modeled on Claude Code's `query/stopHooks.ts` `handleStopHooks()` flow:
 * the gate runs at turn-end (after the inner tool loop has exited),
 * inspects the final assistant text against the turn's tool ledger, and
 * either lets the turn end normally or pushes a `blockingMessage` into
 * the model's context as a synthetic user message and grants the model
 * one recovery turn. Claude Code calls this `preventContinuation` /
 * `blockingErrors`. AgenC implements one recovery attempt; on the second
 * detection in the same turn the gate yields and lets the model's
 * response through (preventing infinite loops).
 *
 * @module
 */

import type { ToolCallRecord } from "./chat-executor-types.js";

import { extractToolFailureText } from "./chat-executor-tool-utils.js";

// ---------------------------------------------------------------------------
// Detector knobs
// ---------------------------------------------------------------------------

/**
 * Phrases that indicate the model is claiming the turn's work succeeded.
 *
 * Sourced from real failure traces under `~/.agenc/trace-payloads/`
 * captured 2026-04-09. Each verb/phrase is one the model used to wrap up
 * a turn that contained failed tool calls. The pattern matches words at
 * sentence-internal positions (no `^` anchor) so it catches mid-paragraph
 * claims as well as opening sentences.
 */
const FALSE_SUCCESS_RE =
  /\b(?:build\s+(?:succeeded|successful|complete|completed|finished)|build\s+is\s+(?:successful|complete|finished)|phase\s+\d+\s+(?:complete|completed|done|finished|passed|implemented)|phase\s+\d+\s+(?:bootstrap|implementation)\s+(?:complete|completed|finished)|tests?\s+(?:passed|succeeded|all\s+pass(?:ed|ing)?)|all\s+tests?\s+pass(?:ed|ing)?|binary\s+(?:is\s+)?(?:exists|ready|built|compiled)|all\s+phases?\s+(?:complete|completed|done|finished|implemented)|task\s+(?:complete|completed|done|finished)|implementation\s+(?:complete|completed|done|finished)|successfully\s+(?:built|compiled|implemented|completed|finished)|v\d+(?:\.\d+)*\s+complete|ready\s+to\s+ship|done\s+with\s+phase)/i;

/**
 * Honest-acknowledgment phrases. If the final message contains BOTH a
 * success claim AND one of these phrases, the model is being upfront
 * about partial success and the gate does NOT fire.
 *
 * The list intentionally errs on the side of letting honest reports
 * through. False negatives (model fabricated and gate missed it) are
 * less bad than false positives (gate blocks an honest "8 of 10 tests
 * passed, here's what failed" report and forces the model into a
 * recovery loop it doesn't need).
 */
const FAILURE_ACKNOWLEDGMENT_RE =
  /\b(?:but\s+failed|but\s+the.*fail|but\s+\d+.*fail|however[,]?\s+|did\s+not|didn[''']?t|cannot|could\s+not|couldn[''']?t|partial|partially|except\s+for|except\s+that|unfortunately|unable\s+to|encountered\s+(?:errors?|issues?|problems?)|errors?\s+occurred|several\s+(?:errors?|failures?|issues?|problems?)|some\s+(?:errors?|failures?|tests?\s+fail)|incomplete|not\s+yet|not\s+working|missing\s+(?:dependency|dependencies|library|libraries|package))/i;

/**
 * Anti-fab refusal codes that, if present in the turn ledger, count as
 * "the runtime told the model to stop and the model is now claiming
 * success anyway". Sourced from
 * `runtime/src/llm/verification-target-guard.ts` and the chat executor
 * `tool_rejected` reasons emitted by the dispatch loop.
 */
const ANTI_FAB_REFUSAL_REASON_KEYWORDS: readonly string[] = [
  "anti_fabrication_harness_overwrite",
  "Refusing `system.writeFile`",
  "Refusing `system.appendFile`",
  "Refusing `desktop.text_editor`",
  "manufacture a fake pass",
];

/**
 * If the final assistant text is shorter than this many characters AND
 * matches `FALSE_SUCCESS_RE`, treat it as the truncation pattern from the
 * 2026-04-09 incident (Grok emitted exactly 14 output tokens of
 * "**Phase 0 bootstrap complete. Build succeeded, binary exists at `").
 * Real success summaries from Grok are typically 200+ characters.
 */
const TRUNCATED_SUCCESS_MAX_CHARS = 100;

/**
 * Phrases the model emits when it has decided to checkpoint with a
 * narration of future tool work INSTEAD of actually calling those tools.
 *
 * Sourced from real failure traces 2026-04-09 19:33 (session
 * `3e887760...` call_2 final reply at 01:33:34.469Z): the model said
 * "Next tool calls will implement lexer.c from PLAN.md specs." and then
 * stopped, even though the user had explicitly said "do not stop until
 * every single phase has been implemented." The chat-executor's tool
 * loop sees `finishReason !== "tool_calls"` and exits, so the
 * narration becomes a hard turn boundary.
 *
 * This pattern is structurally identical to "Continue to Phase N?" from
 * pre-PR-#309: the model is checkpointing with text instead of doing the
 * work. PR #309 forbade question-form permission asks but did not cover
 * statement-form intent narration. The verbs are intentionally broad —
 * the goal is to catch every flavor of "I'm pausing to talk about the
 * next tool call instead of just calling it" while not interfering with
 * legitimate completion summaries.
 *
 * Examples that should match:
 *   - "Next tool calls will implement lexer.c"
 *   - "Now I will write the parser"
 *   - "Next, I'll create the executor"
 *   - "Going to implement Phase 2 now"
 *   - "I'll continue with the build fix"
 *   - "Next step is to run cmake"
 *   - "Let me run the test now"
 *   - "Continuing with Phase 3"
 *   - "Moving on to lexer implementation"
 *   - "Proceeding to write builtins.c"
 *   - "About to implement parser"
 *
 * Examples that should NOT match (legitimate completion summaries):
 *   - "Phase 0 complete. Tests passed."
 *   - "All phases implemented successfully."
 *   - "Task done. Binary built and tests passing."
 */
const NARRATED_FUTURE_TOOL_WORK_RE =
  /\b(?:next\s+tool\s+calls?\s+(?:will|should|must)|now\s+I\s+(?:will|need\s+to|am\s+going\s+to|am\s+about\s+to)|now\s+I[''']?ll|next,?\s+I\s+(?:will|need\s+to|am\s+going\s+to|am\s+about\s+to)|next,?\s+I[''']?ll|going\s+to\s+(?:call|invoke|run|execute|implement|write|create|continue|start|finish|build|compile|test|fix|add|edit|update|generate|produce|stub|complete)|I[''']?ll\s+(?:call|invoke|run|execute|implement|write|create|continue|start|finish|build|compile|test|fix|add|edit|update|generate|produce|stub|complete)|next\s+step\s+(?:is|will\s+be)\s+to|let\s+me\s+(?:call|invoke|run|execute|implement|write|create|continue|start|finish|build|compile|test|fix|add|edit|update|generate|produce|stub|complete)|I\s+will\s+now\s+(?:call|invoke|run|execute|implement|write|create|continue|start|finish|build|compile|test|fix|add|edit|update|generate|produce|stub|complete)|continuing\s+(?:with|to)\s+\w+|moving\s+on\s+to\s+\w+|proceeding\s+(?:to|with)\s+\w+|about\s+to\s+(?:call|invoke|run|execute|implement|write|create|continue|start|finish|build|compile|test|fix|add|edit|update|generate|produce|stub|complete)|will\s+now\s+(?:implement|write|create|build|compile|test|fix|continue))/i;

/**
 * Phrases that explicitly mark the turn as terminally complete. When the
 * final assistant text contains one of these AND the
 * `NARRATED_FUTURE_TOOL_WORK_RE` would otherwise match, treat the
 * narration as a legitimate "here is what would come next if the user
 * asked for more" closing rather than a checkpoint. The narration
 * detector skips the turn in that case so genuine session-end summaries
 * are not forced into a recovery loop.
 */
const TERMINAL_COMPLETION_RE =
  /\b(?:task\s+(?:complete|completed|done|finished)|all\s+phases?\s+(?:complete|completed|done|finished|implemented)|implementation\s+(?:complete|completed|done|finished)|nothing\s+(?:more|else)\s+to\s+(?:do|implement)|session\s+(?:complete|done|finished)|finished\s+the\s+(?:task|work|implementation|plan)|project\s+(?:complete|completed|done|finished))/i;

/**
 * Tool names whose failures count as "this turn had a failed shell
 * command", which is the strongest signal that a success claim is fake.
 * Reading file errors and lookup failures are excluded to avoid
 * false positives on legitimate "checked, doesn't exist, moving on"
 * patterns.
 */
const SHELL_LIKE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.bash",
  "desktop.bash",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stable reason key emitted on the `stop_gate_intervention` trace event
 * and on `XaiResponseAnomaly`-style observability surfaces. The runtime
 * surfaces this in daemon traces so post-hoc audits can identify which
 * detector fired.
 */
export type StopGateInterventionReason =
  | "false_success_after_failed_bash"
  | "false_success_after_anti_fab_refusal"
  | "truncated_success_claim"
  | "narrated_future_tool_work";

export interface StopGateEvidence {
  /** Number of `system.bash` / `desktop.bash` calls in the turn that returned `isError: true`. */
  readonly failedShellCallCount: number;
  /** Number of tool calls in the turn that the runtime refused (anti-fab, contract, envelope, etc.). */
  readonly refusedToolCallCount: number;
  /** Length of the final assistant text in characters. */
  readonly finalContentLength: number;
  /** Up to 3 truncated failure-text excerpts to surface in the blocking message. */
  readonly failureExcerpts: readonly string[];
  /** Up to 3 refused-call reasons to surface in the blocking message. */
  readonly refusalExcerpts: readonly string[];
}

export interface StopGateInterventionDecision {
  /** True when the gate wants to intervene before the turn ends. */
  readonly shouldIntervene: boolean;
  /** Detector that fired (only set when `shouldIntervene` is true). */
  readonly reason?: StopGateInterventionReason;
  /**
   * Synthetic user-role message the tool loop pushes into the model
   * context when intervening. Tells the model exactly which tool calls
   * failed and what to do next (fix or retract).
   */
  readonly blockingMessage?: string;
  /** Structured evidence for trace events and tests. */
  readonly evidence: StopGateEvidence;
}

export interface EvaluateTurnEndStopGateParams {
  /** The model's about-to-be-final assistant text. */
  readonly finalContent: string;
  /** The full tool ledger for the turn (`ctx.allToolCalls`, turn-scoped). */
  readonly allToolCalls: readonly ToolCallRecord[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isShellLikeTool(toolName: string): boolean {
  return SHELL_LIKE_TOOL_NAMES.has(toolName);
}

function looksLikeRefusal(record: ToolCallRecord): boolean {
  if (!record.isError) return false;
  const result = typeof record.result === "string" ? record.result : "";
  for (const keyword of ANTI_FAB_REFUSAL_REASON_KEYWORDS) {
    if (result.includes(keyword)) return true;
  }
  return false;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function summarizeFailedShellCall(record: ToolCallRecord): string {
  const command =
    typeof record.args?.command === "string"
      ? record.args.command
      : "";
  const failureText = extractToolFailureText(record);
  const headline = command.length > 0 ? `\`${truncate(command, 100)}\`` : record.name;
  return `${headline} → ${truncate(failureText, 200)}`;
}

function summarizeRefusedCall(record: ToolCallRecord): string {
  const target =
    typeof record.args?.path === "string"
      ? record.args.path
      : typeof record.args?.command === "string"
        ? record.args.command
        : "";
  const reason = typeof record.result === "string" ? record.result : "";
  return `${record.name}${target ? ` on \`${truncate(target, 100)}\`` : ""}: ${truncate(reason, 200)}`;
}

function buildBlockingMessage(params: {
  readonly reason: StopGateInterventionReason;
  readonly finalContent: string;
  readonly failedShellCalls: readonly ToolCallRecord[];
  readonly refusedCalls: readonly ToolCallRecord[];
}): string {
  const lines: string[] = [];
  switch (params.reason) {
    case "false_success_after_failed_bash":
      lines.push(
        `Your final reply claims the turn's work succeeded, but ` +
          `${params.failedShellCalls.length} \`system.bash\` / ` +
          `\`desktop.bash\` call(s) in this turn FAILED. The success ` +
          `claim is not consistent with the tool ledger you produced.`,
      );
      break;
    case "false_success_after_anti_fab_refusal":
      lines.push(
        `Your final reply claims success, but the runtime's ` +
          `anti-fabrication gate REFUSED ${params.refusedCalls.length} ` +
          `tool call(s) in this turn. A refused write means the runtime ` +
          `prevented you from masking a prior failure — claiming success ` +
          `now papers over the same failure.`,
      );
      break;
    case "truncated_success_claim":
      lines.push(
        `Your final reply is suspiciously short and looks truncated ` +
          `(${params.finalContent.length} chars). It begins with a ` +
          `success claim but cuts off mid-sentence. Either the model ` +
          `output was truncated client-side, or you intentionally emitted ` +
          `an incomplete summary. Either way, the user cannot act on this.`,
      );
      break;
    case "narrated_future_tool_work":
      lines.push(
        `Your previous reply NARRATED future tool work in plain text ` +
          `instead of actually calling the tools. The runtime's tool ` +
          `loop sees a text-only response as the end of the turn, so ` +
          `your "next, I'll implement X" / "going to call Y" / "next ` +
          `tool calls will Z" sentence is interpreted as "I am stopping ` +
          `here." The user explicitly told you to keep going until the ` +
          `work is done — they have NOT asked for a status update or a ` +
          `preview of upcoming steps.`,
      );
      lines.push("");
      lines.push(`The exact narration that triggered this stop:`);
      lines.push(`  > ${truncate(params.finalContent.trim(), 400)}`);
      break;
  }

  if (params.failedShellCalls.length > 0) {
    lines.push("");
    lines.push(`Failing shell commands (up to 3 shown):`);
    for (const call of params.failedShellCalls.slice(0, 3)) {
      lines.push(`  • ${summarizeFailedShellCall(call)}`);
    }
  }
  if (params.refusedCalls.length > 0) {
    lines.push("");
    lines.push(`Runtime-refused tool calls (up to 3 shown):`);
    for (const call of params.refusedCalls.slice(0, 3)) {
      lines.push(`  • ${summarizeRefusedCall(call)}`);
    }
  }

  lines.push("");
  if (params.reason === "narrated_future_tool_work") {
    lines.push(
      `You have ONE recovery turn. In this turn you MUST:`,
    );
    lines.push(
      `  • Call the tools you said you were going to call. ` +
        `Do NOT preview them, do NOT explain what you are about to do, ` +
        `do NOT ask permission, do NOT checkpoint. Just CALL the tools.`,
    );
    lines.push("");
    lines.push(
      `Do NOT emit another text-only message that talks about future ` +
        `tool calls. The runtime treats text-only as turn-end. If you ` +
        `genuinely cannot proceed (waiting on credentials, blocked by an ` +
        `external decision, hit a hard error you have already fixed and ` +
        `are confident requires human input), say so explicitly with ` +
        `the exact blocker — but only after you have actually attempted ` +
        `the next tool call.`,
    );
  } else {
    lines.push(
      `You have ONE recovery turn. Either:`,
    );
    lines.push(
      `  (a) Make tool calls to actually fix the underlying causes, or`,
    );
    lines.push(
      `  (b) Retract the success claim in plain English, list which steps ` +
        `actually failed, and explain the blockers (e.g. missing system ` +
        `package, configuration error, file permissions). Be specific.`,
    );
    lines.push("");
    lines.push(
      `Do NOT repeat the success claim. Do NOT narrate that "everything ` +
        `worked despite minor issues" — the runtime tool ledger is the ` +
        `source of truth, and it shows failures.`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function findFailedShellCalls(
  allToolCalls: readonly ToolCallRecord[],
): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (const call of allToolCalls) {
    if (call.isError && isShellLikeTool(call.name)) {
      out.push(call);
    }
  }
  return out;
}

function findRefusedCalls(
  allToolCalls: readonly ToolCallRecord[],
): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (const call of allToolCalls) {
    if (looksLikeRefusal(call)) {
      out.push(call);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate the turn-end stop gate against a finished tool loop.
 *
 * Pure function. No side effects. The caller (`executeToolCallLoop` in
 * `chat-executor-tool-loop.ts`) is responsible for emitting the trace
 * event, pushing the blocking message, and calling the model again.
 *
 * Returns `{ shouldIntervene: false, ... }` when the gate has nothing to
 * say. Returns `{ shouldIntervene: true, reason, blockingMessage,
 * evidence }` when the gate wants to give the model one recovery turn.
 *
 * Detection priority (first matching rule wins):
 *
 *   1. `false_success_after_anti_fab_refusal` — at least one tool call
 *      in the turn was refused by the anti-fabrication gate AND the
 *      final text matches `FALSE_SUCCESS_RE` AND does NOT match
 *      `FAILURE_ACKNOWLEDGMENT_RE`.
 *
 *   2. `truncated_success_claim` — final text is shorter than
 *      `TRUNCATED_SUCCESS_MAX_CHARS` AND matches `FALSE_SUCCESS_RE` AND
 *      the turn made at least one tool call (so the turn was substantive,
 *      not a one-line greeting).
 *
 *   3. `false_success_after_failed_bash` — at least one
 *      `system.bash` / `desktop.bash` call returned `isError: true` AND
 *      the final text matches `FALSE_SUCCESS_RE` AND does NOT match
 *      `FAILURE_ACKNOWLEDGMENT_RE`.
 */
export function evaluateTurnEndStopGate(
  params: EvaluateTurnEndStopGateParams,
): StopGateInterventionDecision {
  const finalContent = params.finalContent ?? "";
  const allToolCalls = params.allToolCalls ?? [];
  const failedShellCalls = findFailedShellCalls(allToolCalls);
  const refusedCalls = findRefusedCalls(allToolCalls);

  const evidence: StopGateEvidence = {
    failedShellCallCount: failedShellCalls.length,
    refusedToolCallCount: refusedCalls.length,
    finalContentLength: finalContent.length,
    failureExcerpts: failedShellCalls
      .slice(0, 3)
      .map((c) => truncate(extractToolFailureText(c), 200)),
    refusalExcerpts: refusedCalls
      .slice(0, 3)
      .map((c) =>
        truncate(typeof c.result === "string" ? c.result : "", 200),
      ),
  };

  if (finalContent.trim().length === 0) {
    // No final text — the missingFinalToolFollowupAnswer path in the
    // tool loop already handles this. Don't double-flag.
    return { shouldIntervene: false, evidence };
  }

  const claimsSuccess = FALSE_SUCCESS_RE.test(finalContent);
  if (!claimsSuccess) {
    // Skip the success-claim detectors but still check the
    // narrated-future-tool-work detector below — narration without a
    // false success claim is the post-PR-#309 checkpointing failure
    // mode and is the only thing the gate should fire on for an
    // honest-but-stalling reply.
    return maybeFireNarratedFutureToolWork({
      finalContent,
      allToolCalls,
      failedShellCalls,
      refusedCalls,
      evidence,
    });
  }

  const acknowledgesFailure = FAILURE_ACKNOWLEDGMENT_RE.test(finalContent);

  // Detector 1: anti-fab refusal + success claim. The runtime literally
  // told the model to stop and it's now claiming success — highest signal.
  if (refusedCalls.length > 0 && !acknowledgesFailure) {
    return {
      shouldIntervene: true,
      reason: "false_success_after_anti_fab_refusal",
      blockingMessage: buildBlockingMessage({
        reason: "false_success_after_anti_fab_refusal",
        finalContent,
        failedShellCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // Detector 2: truncated final message + success claim. Catches the
  // 14-token truncation bug from the 2026-04-09 incident.
  if (
    finalContent.length < TRUNCATED_SUCCESS_MAX_CHARS &&
    allToolCalls.length > 0
  ) {
    return {
      shouldIntervene: true,
      reason: "truncated_success_claim",
      blockingMessage: buildBlockingMessage({
        reason: "truncated_success_claim",
        finalContent,
        failedShellCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // Detector 3: failed shell call + success claim + no honest
  // acknowledgment. The classic false-success-after-failure pattern.
  if (failedShellCalls.length > 0 && !acknowledgesFailure) {
    return {
      shouldIntervene: true,
      reason: "false_success_after_failed_bash",
      blockingMessage: buildBlockingMessage({
        reason: "false_success_after_failed_bash",
        finalContent,
        failedShellCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // Detector 4 (lowest priority): the model claimed success but ALSO
  // narrated future tool work. This catches the post-PR-#309 stall
  // pattern even when the model wraps it in success language ("Phase 0
  // complete. Now I will write the lexer.") — the success claim alone
  // might be honest but stopping after it when the user said "do not
  // stop" is the actual failure mode.
  return maybeFireNarratedFutureToolWork({
    finalContent,
    allToolCalls,
    failedShellCalls,
    refusedCalls,
    evidence,
  });
}

/**
 * Helper for the narrated-future-tool-work detector. Called from two
 * branches of `evaluateTurnEndStopGate`: once when there is no false
 * success claim at all (the honest-but-stalling case) and once at the
 * very bottom of the function as the lowest-priority detector after
 * the false-success branches fail to match.
 *
 * The check skips when the text contains a TERMINAL_COMPLETION_RE
 * marker (legitimate end-of-task) or when the turn made zero tool
 * calls (fresh greeting/question, not mid-task checkpointing).
 */
function maybeFireNarratedFutureToolWork(params: {
  readonly finalContent: string;
  readonly allToolCalls: readonly ToolCallRecord[];
  readonly failedShellCalls: readonly ToolCallRecord[];
  readonly refusedCalls: readonly ToolCallRecord[];
  readonly evidence: StopGateEvidence;
}): StopGateInterventionDecision {
  if (
    params.allToolCalls.length > 0 &&
    NARRATED_FUTURE_TOOL_WORK_RE.test(params.finalContent) &&
    !TERMINAL_COMPLETION_RE.test(params.finalContent)
  ) {
    return {
      shouldIntervene: true,
      reason: "narrated_future_tool_work",
      blockingMessage: buildBlockingMessage({
        reason: "narrated_future_tool_work",
        finalContent: params.finalContent,
        failedShellCalls: params.failedShellCalls,
        refusedCalls: params.refusedCalls,
      }),
      evidence: params.evidence,
    };
  }
  return { shouldIntervene: false, evidence: params.evidence };
}

// ---------------------------------------------------------------------------
// Exposed regex constants for tests
// ---------------------------------------------------------------------------

/** Exported for unit tests. */
export const __TESTING__ = {
  FALSE_SUCCESS_RE,
  FAILURE_ACKNOWLEDGMENT_RE,
  NARRATED_FUTURE_TOOL_WORK_RE,
  TERMINAL_COMPLETION_RE,
  TRUNCATED_SUCCESS_MAX_CHARS,
  ANTI_FAB_REFUSAL_REASON_KEYWORDS,
};
