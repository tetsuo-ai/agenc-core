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
 *   - The legacy silent-tool-drop detector only caught the "tools were
 *     stripped at the adapter boundary" case (removed with stateless
 *     transport migration).
 *   - The `Report outcomes faithfully` system prompt rule from PR #300
 *     bans the behavior, but Grok ignored it.
 *
 * The gate runs at turn-end (after the inner tool loop has exited),
 * inspects the final assistant text against the turn's tool ledger, and
 * either lets the turn end normally or pushes a `blockingMessage` into
 * the model's context as a synthetic user message and grants the model
 * one recovery turn. AgenC implements one recovery attempt; on the
 * second detection in the same turn the gate yields and lets the
 * model's response through (preventing infinite loops).
 *
 * @module
 */

import type { ChatExecuteParams, ToolCallRecord } from "./chat-executor-types.js";

import {
  didToolCallFail,
  extractToolFailureText,
} from "./chat-executor-tool-utils.js";
import type { DelegationOutputValidationCode } from "../utils/delegation-validation.js";
import { areDocumentationOnlyArtifacts } from "../workflow/artifact-paths.js";
import {
  isPathWithinRoot,
  normalizeArtifactPaths,
} from "../workflow/path-normalization.js";
import { resolveWorkflowEvidenceFromRequiredToolEvidence } from "./turn-execution-contract.js";

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
  /\b(?:build\s+(?:succeeded|successful|complete|completed|finished)|build\s+is\s+(?:successful|complete|finished)|phase\s+\d+\s+(?:complete|completed|done|finished|passed|implemented)|phase\s+\d+\s+(?:bootstrap|implementation)\s+(?:complete|completed|finished)|tests?\s+(?:passed|succeeded|all\s+pass(?:ed|ing)?)|all\s+tests?\s+pass(?:ed|ing)?|binary\s+(?:is\s+)?(?:exists|ready|built|compiled)|all\s+phases?\s+(?:complete|completed|done|finished|implemented)|all\s+phases?\s+of\s+[^\n]{0,120}?\s+have\s+been\s+(?:complete|completed|done|finished|implemented)|all\s+phases?\b(?:[^.!?\n]{0,80})\b(?:complete|completed|done|finished|implemented)|task\s+(?:complete|completed|done|finished)|implementation\s+(?:complete|completed|done|finished)|implementation\s+of\s+[^\n]{0,160}?\s+(?:is\s+)?(?:complete|completed|done|finished)|(?:fully|successfully)\s+verified|successfully\s+(?:built|compiled|implemented|completed|finished)|v\d+(?:\.\d+)*\s+complete|ready\s+to\s+ship|done\s+with\s+phase)/i;

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
// NARRATED_FUTURE_TOOL_WORK_RE removed in Phase 3. The detector and
// its softeners (MID_TASK_PERMISSION_QUESTION_RE, REPORT_REQUEST_RE,
// looksLikeStructuredReport) chased false positives on legitimate
// gap enumerations, plan-mode answers, and structured reports. The
// balanced system prompt (Phase 1) now instructs the model to end
// the turn when the answer is ready and not to narrate future tool
// work; the hard MAX_ADAPTIVE_TOOL_ROUNDS cap (Phase 6) is the
// structural backstop.

/**
 * Phrases that explicitly mark the turn as terminally complete. Used by
 * the remaining success-claim detectors (false_success_after_*) to tell
 * "task complete" apart from a success claim that contradicts the tool
 * ledger.
 */
const TERMINAL_COMPLETION_RE =
  /\b(?:task\s+(?:complete|completed|done|finished)|all\s+phases?\s+(?:complete|completed|done|finished|implemented)|all\s+phases?\s+of\s+[^\n]{0,120}?\s+have\s+been\s+(?:complete|completed|done|finished|implemented)|all\s+phases?\b(?:[^.!?\n]{0,80})\b(?:complete|completed|done|finished|implemented)|implementation\s+(?:complete|completed|done|finished)|implementation\s+of\s+[^\n]{0,160}?\s+(?:is\s+)?(?:complete|completed|done|finished)|nothing\s+(?:more|else)\s+to\s+(?:do|implement)|session\s+(?:complete|done|finished)|finished\s+the\s+(?:task|work|implementation|plan)|project\s+(?:complete|completed|done|finished))/i;

/**
 * REPORT_REQUEST_RE + looksLikeStructuredReport removed in Phase 3 —
 * they were softeners for NARRATED_FUTURE_TOOL_WORK_RE, which is
 * also gone.
 */

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
  | "false_success_after_failed_verification"
  | "false_success_after_anti_fab_refusal"
  | "truncated_success_claim";

export interface StopGateEvidence {
  /** Number of `system.bash` / `desktop.bash` calls in the turn that returned `isError: true`. */
  readonly failedShellCallCount: number;
  /** Number of verification/probe calls whose latest observed result is still failing. */
  readonly failedVerificationCallCount: number;
  /** Number of tool calls in the turn that the runtime refused (anti-fab, contract, envelope, etc.). */
  readonly refusedToolCallCount: number;
  /** Length of the final assistant text in characters. */
  readonly finalContentLength: number;
  /** Up to 3 truncated failure-text excerpts to surface in the blocking message. */
  readonly failureExcerpts: readonly string[];
  /** Up to 3 verification/probe failure excerpts to surface in the blocking message. */
  readonly verificationFailureExcerpts: readonly string[];
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

export interface ArtifactEvidenceGateEvidence {
  readonly successfulToolCallCount: number;
  readonly requiredTargetArtifacts: readonly string[];
  readonly mutatedArtifacts: readonly string[];
  readonly inspectedArtifacts: readonly string[];
  readonly missingArtifacts: readonly string[];
}

export interface ArtifactEvidenceGateDecision {
  readonly shouldIntervene: boolean;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly stopReasonDetail?: string;
  readonly blockingMessage?: string;
  readonly evidence: ArtifactEvidenceGateEvidence;
}

export interface EvaluateTurnEndStopGateParams {
  /** The model's about-to-be-final assistant text. */
  readonly finalContent: string;
  /** The full tool ledger for the turn (`ctx.allToolCalls`, turn-scoped). */
  readonly allToolCalls?: readonly ToolCallRecord[];
  /** Optional precomputed unresolved execution snapshot for stop-hook evaluation. */
  readonly snapshot?: TurnEndStopGateSnapshot;
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
  /**
   * The user's most recent inbound message text for this turn. When the
   * user explicitly asked for a report/list/gap-analysis the narration
   * detector is suppressed because the answer is the requested output,
   * not a checkpoint.
   */
  readonly userMessageText?: string;
}

export interface TurnEndStopGateSnapshot {
  readonly unresolvedShellFailures: readonly ToolCallRecord[];
  readonly unresolvedVerificationFailures: readonly ToolCallRecord[];
  readonly unresolvedRefusals: readonly ToolCallRecord[];
  readonly toolCallCount: number;
}

export interface EvaluateArtifactEvidenceGateParams {
  readonly requiredToolEvidence?: ChatExecuteParams["requiredToolEvidence"];
  readonly runtimeContext?: ChatExecuteParams["runtimeContext"];
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

// shouldAllowWorkflowCheckpoint removed in Phase 3 — was a softener
// for the narrated-future-tool-work detector, which is also gone.

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

function getRefusalTargetPath(record: ToolCallRecord): string | undefined {
  if (typeof record.args?.path === "string" && record.args.path.trim().length > 0) {
    return record.args.path;
  }
  if (
    typeof record.args?.destination === "string" &&
    record.args.destination.trim().length > 0
  ) {
    return record.args.destination;
  }
  return undefined;
}

function isSuccessfulMutationForPath(
  record: ToolCallRecord,
  targetPath: string,
): boolean {
  if (didToolCallFail(record.isError, record.result)) {
    return false;
  }
  if (record.name === "desktop.text_editor") {
    const command =
      typeof record.args?.command === "string"
        ? record.args.command.trim().toLowerCase()
        : "";
    if (command === "view") {
      return false;
    }
  }
  const candidatePaths = [
    typeof record.args?.path === "string" ? record.args.path : undefined,
    typeof record.args?.destination === "string"
      ? record.args.destination
      : undefined,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidatePaths.includes(targetPath);
}

function isVerificationLikeToolCall(record: ToolCallRecord): boolean {
  if (record.name === "verification.runProbe") {
    return true;
  }
  if (record.args?.__runtimeAcceptanceProbe === true) {
    return true;
  }
  try {
    const parsed = JSON.parse(record.result) as Record<string, unknown>;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "__agencVerification" in parsed
    );
  } catch {
    return false;
  }
}

function isSuccessfulWorkspaceMutation(record: ToolCallRecord): boolean {
  if (didToolCallFail(record.isError, record.result)) {
    return false;
  }
  if (!(record.name in MUTATION_PATH_ARG_BY_TOOL)) {
    return false;
  }
  if (record.name === "desktop.text_editor") {
    const command =
      typeof record.args?.command === "string"
        ? record.args.command.trim().toLowerCase()
        : "";
    return command !== "view";
  }
  return true;
}

function findUnresolvedVerificationFailures(
  allToolCalls: readonly ToolCallRecord[],
): ToolCallRecord[] {
  for (let index = allToolCalls.length - 1; index >= 0; index -= 1) {
    const call = allToolCalls[index];
    if (!isVerificationLikeToolCall(call)) {
      continue;
    }
    if (!didToolCallFail(call.isError, call.result)) {
      return [];
    }
    const laterMutationResolved = allToolCalls
      .slice(index + 1)
      .some(isSuccessfulWorkspaceMutation);
    return laterMutationResolved ? [] : [call];
  }
  return [];
}

function summarizeVerificationFailureCall(record: ToolCallRecord): string {
  let label =
    typeof record.args?.probeId === "string" && record.args.probeId.trim().length > 0
      ? record.args.probeId.trim()
      : record.name;
  try {
    const parsed = JSON.parse(record.result) as Record<string, unknown>;
    const verification =
      typeof parsed.__agencVerification === "object" &&
      parsed.__agencVerification !== null
        ? parsed.__agencVerification as Record<string, unknown>
        : null;
    if (verification && typeof verification.command === "string") {
      label = verification.command.trim();
    }
  } catch {
    // Fall back to probe id / tool name when result is not structured JSON.
  }
  return `\`${truncate(label, 100)}\` → ${truncate(extractToolFailureText(record), 200)}`;
}

function buildBlockingMessage(params: {
  readonly reason: StopGateInterventionReason;
  readonly finalContent: string;
  readonly failedShellCalls: readonly ToolCallRecord[];
  readonly failedVerificationCalls: readonly ToolCallRecord[];
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
    case "false_success_after_failed_verification":
      lines.push(
        `Your final reply claims the work is complete, but the latest ` +
          `verification/probe step in this turn still FAILED. Completion ` +
          `cannot pass while the most recent grounded verification result ` +
          `is red.`,
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
  }

  if (params.failedShellCalls.length > 0) {
    lines.push("");
    lines.push(`Failing shell commands (up to 3 shown):`);
    for (const call of params.failedShellCalls.slice(0, 3)) {
      lines.push(`  • ${summarizeFailedShellCall(call)}`);
    }
  }
  if (params.failedVerificationCalls.length > 0) {
    lines.push("");
    lines.push(`Failing verification/probe steps (up to 3 shown):`);
    for (const call of params.failedVerificationCalls.slice(0, 3)) {
      lines.push(`  • ${summarizeVerificationFailureCall(call)}`);
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
  lines.push(
    `You are in a bounded recovery loop. In each recovery turn, either:`,
  );
  lines.push(
    `  • Resume directly. No apology, no recap, no summary of prior work.`,
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

  return lines.join("\n");
}

const MUTATION_PATH_ARG_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  "system.writeFile": ["path"],
  "system.appendFile": ["path"],
  "system.editFile": ["path"],
  "system.mkdir": ["path"],
  "system.move": ["destination"],
  "desktop.text_editor": ["path"],
};

const INSPECTION_PATH_ARG_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  "system.readFile": ["path"],
  "system.stat": ["path"],
  "system.listDir": ["path"],
  "desktop.text_editor": ["path"],
};

function normalizeToolPath(
  rawPath: unknown,
  workspaceRoot?: string,
): string | undefined {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return undefined;
  }
  return normalizeArtifactPaths([rawPath], workspaceRoot)[0];
}

function collectToolPaths(params: {
  readonly toolCall: ToolCallRecord;
  readonly workspaceRoot?: string;
  readonly pathKeys: Readonly<Record<string, readonly string[]>>;
  readonly includeDesktopEditorViews?: boolean;
}): readonly string[] {
  const keys = params.pathKeys[params.toolCall.name] ?? [];
  if (keys.length === 0) return [];

  if (params.toolCall.name === "desktop.text_editor") {
    const command =
      typeof params.toolCall.args.command === "string"
        ? params.toolCall.args.command.trim().toLowerCase()
        : "";
    const isView = command === "view";
    if (params.includeDesktopEditorViews === true && !isView) {
      return [];
    }
    if (params.includeDesktopEditorViews !== true && isView) {
      return [];
    }
  }

  const paths = new Set<string>();
  for (const key of keys) {
    const normalized = normalizeToolPath(
      params.toolCall.args[key],
      params.workspaceRoot,
    );
    if (normalized) {
      paths.add(normalized);
    }
  }
  return [...paths];
}

function artifactHasEvidence(
  artifactPath: string,
  evidencePaths: readonly string[],
): boolean {
  return evidencePaths.some((evidencePath) =>
    evidencePath === artifactPath ||
    isPathWithinRoot(evidencePath, artifactPath)
  );
}

function buildMissingArtifactDetail(params: {
  readonly code: Extract<
    DelegationOutputValidationCode,
    | "missing_successful_tool_evidence"
    | "missing_file_mutation_evidence"
    | "missing_file_artifact_evidence"
  >;
  readonly missingArtifacts: readonly string[];
}): string {
  if (params.code === "missing_successful_tool_evidence") {
    return "Workflow-owned execution requires successful tool-grounded evidence before completion, but this turn recorded no successful tool calls.";
  }
  const joined = params.missingArtifacts.join(", ");
  if (params.code === "missing_file_artifact_evidence") {
    return `Missing file artifact evidence for ${joined}.`;
  }
  return `Missing file mutation evidence for ${joined}.`;
}

function buildArtifactEvidenceBlockingMessage(params: {
  readonly validationCode: Extract<
    DelegationOutputValidationCode,
    | "missing_successful_tool_evidence"
    | "missing_file_mutation_evidence"
    | "missing_file_artifact_evidence"
  >;
  readonly missingArtifacts: readonly string[];
  readonly mutatedArtifacts: readonly string[];
  readonly inspectedArtifacts: readonly string[];
}): string {
  const missingLines = params.missingArtifacts.length > 0
    ? `Missing artifacts:\n${params.missingArtifacts.map((path) => `- ${path}`).join("\n")}\n\n`
    : "";
  const mutatedLines = params.mutatedArtifacts.length > 0
    ? `Observed file mutations:\n${params.mutatedArtifacts.map((path) => `- ${path}`).join("\n")}\n\n`
    : "";
  const inspectedLines = params.inspectedArtifacts.length > 0
    ? `Observed file inspection evidence:\n${params.inspectedArtifacts.map((path) => `- ${path}`).join("\n")}\n\n`
    : "";

  if (params.validationCode === "missing_successful_tool_evidence") {
    return (
      "Runtime validation blocked completion because this workflow-owned turn has no successful tool-grounded evidence.\n\n" +
      "Call real tools to continue the work or report the blocker grounded in tool output. Do not claim completion without successful tool results."
    );
  }

  if (params.validationCode === "missing_file_artifact_evidence") {
    return (
      "Runtime validation blocked completion because the workflow contract only allows a no-op when the target artifacts are proven with tool evidence.\n\n" +
      missingLines +
      mutatedLines +
      inspectedLines +
      "Call real file-inspection or file-mutation tools on every missing artifact before claiming completion."
    );
  }

  return (
    "Runtime validation blocked completion because the workflow contract requires actual file mutations for every target artifact.\n\n" +
    missingLines +
    mutatedLines +
    inspectedLines +
    "Call real file-mutation tools (`system.writeFile`, `system.editFile`, `system.appendFile`, `desktop.text_editor`, `system.move`, `system.mkdir`) on every missing artifact before claiming completion."
  );
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function findUnresolvedShellFailures(
  allToolCalls: readonly ToolCallRecord[],
): ToolCallRecord[] {
  const shellCalls = allToolCalls.filter(
    (call) =>
      call.args.__runtimeAcceptanceProbe !== true &&
      isShellLikeTool(call.name),
  );
  if (shellCalls.length === 0) {
    return [];
  }
  const lastShellCall = shellCalls.at(-1);
  if (
    !lastShellCall ||
    !didToolCallFail(lastShellCall.isError, lastShellCall.result)
  ) {
    return [];
  }
  return [lastShellCall];
}

function findRefusedCalls(
  allToolCalls: readonly ToolCallRecord[],
): ToolCallRecord[] {
  for (let index = allToolCalls.length - 1; index >= 0; index -= 1) {
    const call = allToolCalls[index];
    if (!looksLikeRefusal(call)) {
      continue;
    }
    const targetPath = getRefusalTargetPath(call);
    if (!targetPath) {
      return [call];
    }
    const resolved = allToolCalls
      .slice(index + 1)
      .some((laterCall) => isSuccessfulMutationForPath(laterCall, targetPath));
    if (!resolved) {
      return [call];
    }
  }
  return [];
}

export function buildTurnEndStopGateSnapshot(
  allToolCalls: readonly ToolCallRecord[],
): TurnEndStopGateSnapshot {
  return {
    unresolvedShellFailures: findUnresolvedShellFailures(allToolCalls),
    unresolvedVerificationFailures:
      findUnresolvedVerificationFailures(allToolCalls),
    unresolvedRefusals: findRefusedCalls(allToolCalls),
    toolCallCount: allToolCalls.length,
  };
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
 *   3. `false_success_after_failed_bash` — the latest shell-like call in
 *      the turn is still failing AND the final text matches
 *      `FALSE_SUCCESS_RE` AND does NOT match
 *      `FAILURE_ACKNOWLEDGMENT_RE`.
 */
export function evaluateTurnEndStopGate(
  params: EvaluateTurnEndStopGateParams,
): StopGateInterventionDecision {
  const finalContent = params.finalContent ?? "";
  const allToolCalls = params.allToolCalls ?? [];
  const snapshot = params.snapshot ?? buildTurnEndStopGateSnapshot(allToolCalls);
  const failedShellCalls = snapshot.unresolvedShellFailures;
  const failedVerificationCalls = snapshot.unresolvedVerificationFailures;
  const refusedCalls = snapshot.unresolvedRefusals;

  const evidence: StopGateEvidence = {
    failedShellCallCount: failedShellCalls.length,
    failedVerificationCallCount: failedVerificationCalls.length,
    refusedToolCallCount: refusedCalls.length,
    finalContentLength: finalContent.length,
    failureExcerpts: failedShellCalls
      .slice(0, 3)
      .map((c) => truncate(extractToolFailureText(c), 200)),
    verificationFailureExcerpts: failedVerificationCalls
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
  const claimsTerminalCompletion = TERMINAL_COMPLETION_RE.test(finalContent);
  if (!claimsSuccess) {
    // No success claim and no unresolved failures means the model is
    // answering honestly. Nothing to intervene on. The narration /
    // permission-question detectors that used to live here (PR #481,
    // #482) were removed in Phase 3 of the architectural rework —
    // the balanced system prompt from Phase 1 tells the model to
    // end the turn when the answer is ready, and the hard
    // MAX_ADAPTIVE_TOOL_ROUNDS cap from Phase 6 is the structural
    // backstop. The regex monolith was producing more false
    // positives (truncating legitimate gap enumerations, killing
    // plan-mode answers) than the failure mode it was meant to
    // catch.
    return { shouldIntervene: false, evidence };
  }

  const acknowledgesFailure = FAILURE_ACKNOWLEDGMENT_RE.test(finalContent);
  const shouldBlockClaimAgainstCurrentState =
    claimsTerminalCompletion || !acknowledgesFailure;

  // Detector 1: anti-fab refusal + success claim. The runtime literally
  // told the model to stop and it's now claiming success — highest signal.
  if (refusedCalls.length > 0 && shouldBlockClaimAgainstCurrentState) {
    return {
      shouldIntervene: true,
      reason: "false_success_after_anti_fab_refusal",
      blockingMessage: buildBlockingMessage({
        reason: "false_success_after_anti_fab_refusal",
        finalContent,
        failedShellCalls,
        failedVerificationCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // Detector 1.5: the latest verification/probe step in the turn still
  // failed, but the model is now claiming completion anyway.
  if (
    failedVerificationCalls.length > 0 &&
    shouldBlockClaimAgainstCurrentState
  ) {
    return {
      shouldIntervene: true,
      reason: "false_success_after_failed_verification",
      blockingMessage: buildBlockingMessage({
        reason: "false_success_after_failed_verification",
        finalContent,
        failedShellCalls,
        failedVerificationCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // Detector 2: truncated final message + success claim. Catches the
  // 14-token truncation bug from the 2026-04-09 incident.
  if (
    finalContent.length < TRUNCATED_SUCCESS_MAX_CHARS &&
    snapshot.toolCallCount > 0
  ) {
    return {
      shouldIntervene: true,
      reason: "truncated_success_claim",
      blockingMessage: buildBlockingMessage({
        reason: "truncated_success_claim",
        finalContent,
        failedShellCalls,
        failedVerificationCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // Detector 3: failed shell call + success claim + no honest
  // acknowledgment. The classic false-success-after-failure pattern.
  if (failedShellCalls.length > 0 && shouldBlockClaimAgainstCurrentState) {
    return {
      shouldIntervene: true,
      reason: "false_success_after_failed_bash",
      blockingMessage: buildBlockingMessage({
        reason: "false_success_after_failed_bash",
        finalContent,
        failedShellCalls,
        failedVerificationCalls,
        refusedCalls,
      }),
      evidence,
    };
  }

  // No active failure pattern AND the success claim is consistent
  // with the tool ledger — accept the turn. The narrated-future-
  // tool-work softener that used to live here (PR #481/#482) was
  // removed with the rest of the narration regex in Phase 3: it
  // was producing false positives on legitimate gap enumerations
  // and plan-mode answers.
  return { shouldIntervene: false, evidence };
}

export function evaluateArtifactEvidenceGate(
  params: EvaluateArtifactEvidenceGateParams,
): ArtifactEvidenceGateDecision {
  const emptyEvidence: ArtifactEvidenceGateEvidence = {
    successfulToolCallCount: 0,
    requiredTargetArtifacts: [],
    mutatedArtifacts: [],
    inspectedArtifacts: [],
    missingArtifacts: [],
  };

  if (params.requiredToolEvidence?.unsafeBenchmarkMode === true) {
    return {
      shouldIntervene: false,
      evidence: emptyEvidence,
    };
  }

  const workflowEvidence = resolveWorkflowEvidenceFromRequiredToolEvidence({
    requiredToolEvidence: params.requiredToolEvidence,
    runtimeContext: params.runtimeContext,
  });
  const targetArtifacts = workflowEvidence.targetArtifacts;
  if (targetArtifacts.length === 0) {
    return {
      shouldIntervene: false,
      evidence: emptyEvidence,
    };
  }

  const successfulToolCalls = params.allToolCalls.filter((toolCall) =>
    !didToolCallFail(toolCall.isError, toolCall.result)
  );
  if (successfulToolCalls.length === 0) {
    const validationCode = "missing_successful_tool_evidence" as const;
    return {
      shouldIntervene: true,
      validationCode,
      stopReasonDetail: buildMissingArtifactDetail({
        code: validationCode,
        missingArtifacts: targetArtifacts,
      }),
      blockingMessage: buildArtifactEvidenceBlockingMessage({
        validationCode,
        missingArtifacts: targetArtifacts,
        mutatedArtifacts: [],
        inspectedArtifacts: [],
      }),
      evidence: {
        successfulToolCallCount: 0,
        requiredTargetArtifacts: targetArtifacts,
        mutatedArtifacts: [],
        inspectedArtifacts: [],
        missingArtifacts: targetArtifacts,
      },
    };
  }

  const workspaceRoot = workflowEvidence.workspaceRoot;
  const mutatedArtifacts = new Set<string>();
  const inspectedArtifacts = new Set<string>();
  for (const toolCall of successfulToolCalls) {
    for (const path of collectToolPaths({
      toolCall,
      workspaceRoot,
      pathKeys: MUTATION_PATH_ARG_BY_TOOL,
    })) {
      mutatedArtifacts.add(path);
      inspectedArtifacts.add(path);
    }
    for (const path of collectToolPaths({
      toolCall,
      workspaceRoot,
      pathKeys: INSPECTION_PATH_ARG_BY_TOOL,
      includeDesktopEditorViews: true,
    })) {
      inspectedArtifacts.add(path);
    }
  }

  const mutatedArtifactList = [...mutatedArtifacts];
  const inspectedArtifactList = [...inspectedArtifacts];
  const missingMutationArtifacts = targetArtifacts.filter((artifactPath) =>
    !artifactHasEvidence(artifactPath, mutatedArtifactList)
  );
  if (missingMutationArtifacts.length === 0) {
    return {
      shouldIntervene: false,
      evidence: {
        successfulToolCallCount: successfulToolCalls.length,
        requiredTargetArtifacts: targetArtifacts,
        mutatedArtifacts: mutatedArtifactList,
        inspectedArtifacts: inspectedArtifactList,
        missingArtifacts: [],
      },
    };
  }

  const verificationMode =
    workflowEvidence.executionEnvelope?.verificationMode ??
    workflowEvidence.verificationContract?.verificationMode;
  const groundedReadAllowed = verificationMode === "grounded_read";
  const conditionalMutationAllowed =
    verificationMode === "conditional_mutation" ||
    areDocumentationOnlyArtifacts(targetArtifacts);
  const missingArtifactEvidence = targetArtifacts.filter((artifactPath) =>
    !artifactHasEvidence(artifactPath, inspectedArtifactList)
  );
  if (
    (groundedReadAllowed || conditionalMutationAllowed) &&
    missingArtifactEvidence.length === 0
  ) {
    return {
      shouldIntervene: false,
      evidence: {
        successfulToolCallCount: successfulToolCalls.length,
        requiredTargetArtifacts: targetArtifacts,
        mutatedArtifacts: mutatedArtifactList,
        inspectedArtifacts: inspectedArtifactList,
        missingArtifacts: [],
      },
    };
  }

  const validationCode = groundedReadAllowed || conditionalMutationAllowed
    ? "missing_file_artifact_evidence" as const
    : "missing_file_mutation_evidence" as const;
  const missingArtifacts =
    validationCode === "missing_file_artifact_evidence"
      ? missingArtifactEvidence
      : missingMutationArtifacts;

  return {
    shouldIntervene: true,
    validationCode,
    stopReasonDetail: buildMissingArtifactDetail({
      code: validationCode,
      missingArtifacts,
    }),
    blockingMessage: buildArtifactEvidenceBlockingMessage({
      validationCode,
      missingArtifacts,
      mutatedArtifacts: mutatedArtifactList,
      inspectedArtifacts: inspectedArtifactList,
    }),
    evidence: {
      successfulToolCallCount: successfulToolCalls.length,
      requiredTargetArtifacts: targetArtifacts,
      mutatedArtifacts: mutatedArtifactList,
      inspectedArtifacts: inspectedArtifactList,
      missingArtifacts,
    },
  };
}

// maybeFireNarratedFutureToolWork removed in Phase 3. See the comment
// at the top of this file where NARRATED_FUTURE_TOOL_WORK_RE used
// to live for the full rationale.

// ---------------------------------------------------------------------------
// Exposed regex constants for tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Filesystem artifact verification (async — runs on claimed completion)
// ---------------------------------------------------------------------------

import { stat as fsStat } from "node:fs/promises";

/**
 * Tool names whose `path` arg represents a file mutation (the model
 * intended to create or modify a file at that path).
 */
const FILE_WRITE_TOOL_NAMES = new Set([
  "system.writeFile",
  "system.editFile",
  "system.appendFile",
  "desktop.text_editor",
]);

/**
 * Tool names whose `path` arg represents a file deletion. Files that
 * were written AND subsequently deleted in the same turn are excluded
 * from the empty-file check (legitimate create→use→clean-up workflow).
 */
const FILE_DELETE_TOOL_NAMES = new Set([
  "system.delete",
]);

export interface FilesystemArtifactCheckResult {
  readonly shouldIntervene: boolean;
  readonly emptyFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly checkedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly blockingMessage?: string;
}

/**
 * Async post-gate that checks OBSERVED file mutations from the turn's
 * tool ledger against the actual filesystem. Runs only when the model's
 * final text matches `TERMINAL_COMPLETION_RE` (claims task complete).
 *
 * For each `system.writeFile` / `system.editFile` / `system.appendFile`
 * call in the turn that had non-empty content, checks that the target
 * file:
 *   (a) exists on disk (stat does not throw ENOENT)
 *   (b) is non-zero bytes
 *
 * Files that were explicitly deleted in the same turn (via
 * `system.delete` or `system.bash` with `rm`) are excluded.
 *
 * Returns `shouldIntervene: true` with a blocking message listing the
 * empty/missing files if any are found. The caller injects the message
 * and forces a recovery turn, same as the existing stop gate pattern.
 *
 * This catches the exact fabrication case from 2026-04-10: the model
 * claimed "all 14 files implemented" but 8 were 0 bytes on disk. The
 * gate checks the filesystem, not the model's text.
 */
export async function checkFilesystemArtifacts(params: {
  readonly finalContent: string;
  readonly allToolCalls: readonly ToolCallRecord[];
  readonly workspaceRoot?: string;
}): Promise<FilesystemArtifactCheckResult> {
  const noIntervention: FilesystemArtifactCheckResult = {
    shouldIntervene: false,
    emptyFiles: [],
    missingFiles: [],
    checkedFiles: [],
    deletedFiles: [],
  };

  // Only run when the model claims terminal completion.
  if (!TERMINAL_COMPLETION_RE.test(params.finalContent)) {
    return noIntervention;
  }

  // Collect all file paths the model wrote/edited with non-empty content.
  const writtenPaths = new Set<string>();
  const rawWrittenPathsByNormalizedPath = new Map<string, Set<string>>();
  for (const call of params.allToolCalls) {
    if (!FILE_WRITE_TOOL_NAMES.has(call.name)) continue;
    if (call.isError) continue; // failed writes don't count

    const path = normalizeToolPath(call.args?.path, params.workspaceRoot);
    if (!path) continue;

    // For writeFile/appendFile: check if content was non-empty.
    // For editFile: check if new_string was non-empty.
    // For desktop.text_editor: always check (content varies).
    const contentArg =
      call.name === "system.editFile"
        ? call.args?.new_string
        : call.args?.content;
    if (typeof contentArg === "string" && contentArg.length === 0) {
      continue; // intentionally empty write — skip
    }

    writtenPaths.add(path);
    const rawPath =
      typeof call.args?.path === "string" ? call.args.path : undefined;
    if (rawPath) {
      const rawPaths = rawWrittenPathsByNormalizedPath.get(path) ?? new Set<string>();
      rawPaths.add(rawPath);
      rawWrittenPathsByNormalizedPath.set(path, rawPaths);
    }
  }

  if (writtenPaths.size === 0) {
    return noIntervention;
  }

  // Collect deleted paths so we can exclude them.
  const deletedPaths = new Set<string>();
  for (const call of params.allToolCalls) {
    if (FILE_DELETE_TOOL_NAMES.has(call.name) && !call.isError) {
      const path = normalizeToolPath(call.args?.path, params.workspaceRoot);
      if (path) deletedPaths.add(path);
    }
    // Also check for `rm` in bash commands.
    if (call.name === "system.bash" || call.name === "desktop.bash") {
      const cmd =
        typeof call.args?.command === "string" ? call.args.command : "";
      // Simple heuristic: if bash command contains `rm` and a written
      // path, exclude that path. Not perfect but catches the common case.
      for (const writtenPath of writtenPaths) {
        const rawWrittenPaths = rawWrittenPathsByNormalizedPath.get(writtenPath);
        const matchesRawPath = rawWrittenPaths
          ? [...rawWrittenPaths].some((rawPath) => cmd.includes(rawPath))
          : false;
        if (cmd.includes("rm") && (cmd.includes(writtenPath) || matchesRawPath)) {
          deletedPaths.add(writtenPath);
        }
      }
    }
  }

  // Check each written file on disk.
  const checkedFiles: string[] = [];
  const emptyFiles: string[] = [];
  const missingFiles: string[] = [];

  for (const filePath of writtenPaths) {
    if (deletedPaths.has(filePath)) continue;
    checkedFiles.push(filePath);
    try {
      const stats = await fsStat(filePath);
      if (stats.isFile() && stats.size === 0) {
        emptyFiles.push(filePath);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        missingFiles.push(filePath);
      }
      // Other errors (EACCES, etc.) — skip, don't flag.
    }
  }

  const problems = [...emptyFiles, ...missingFiles];
  if (problems.length === 0) {
    return {
      shouldIntervene: false,
      emptyFiles,
      missingFiles,
      checkedFiles,
      deletedFiles: [...deletedPaths],
    };
  }

  const emptyList = emptyFiles.length > 0
    ? `Empty files (0 bytes on disk):\n${emptyFiles.map((p) => `  • ${p}`).join("\n")}\n\n`
    : "";
  const missingList = missingFiles.length > 0
    ? `Missing files (not found on disk):\n${missingFiles.map((p) => `  • ${p}`).join("\n")}\n\n`
    : "";

  const blockingMessage =
    `Your final reply claims the task is complete, but the runtime ` +
    `verified the filesystem and found ${problems.length} file(s) that ` +
    `you wrote during this turn are now empty or missing on disk.\n\n` +
    emptyList +
    missingList +
    `You called system.writeFile / system.editFile on these paths with ` +
    `non-empty content, but the files are now 0 bytes or absent. This ` +
    `means either:\n` +
    `  (a) The write silently failed (check the tool result for errors)\n` +
    `  (b) A later operation overwrote the file with empty content\n` +
    `  (c) The file was never actually written despite the tool call\n\n` +
    `You are in a bounded recovery loop. Resume directly with tool calls. ` +
    `No apology, no recap, no summary of prior work. Re-read each empty/missing ` +
    `file with system.readFile, then use system.writeFile or ` +
    `system.editFile to write the actual implementation. Do NOT claim ` +
    `completion again until every file has real content verified via ` +
    `tool results.`;

  return {
    shouldIntervene: true,
    emptyFiles,
    missingFiles,
    checkedFiles,
    deletedFiles: [...deletedPaths],
    blockingMessage,
  };
}

/** Exported for unit tests. */
export const __TESTING__ = {
  FALSE_SUCCESS_RE,
  FAILURE_ACKNOWLEDGMENT_RE,
  TERMINAL_COMPLETION_RE,
  TRUNCATED_SUCCESS_MAX_CHARS,
  ANTI_FAB_REFUSAL_REASON_KEYWORDS,
};
