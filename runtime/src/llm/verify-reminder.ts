/**
 * Verification reminder for unverified cumulative edits.
 *
 * Plan-mode-less equivalent of the reference runtime's
 * `verify_plan_reminder` (upstream: plan mode state with
 * `verificationStarted && !verificationCompleted`). AgenC has no plan
 * mode, so the trigger is substituted with a cumulative-edit signal
 * driven by persisted runtime counters on `ActiveBackgroundRun` —
 * compaction-safe by design. Matches the reference runtime's
 * `AppState.pendingPlanVerification` separation of runtime state from
 * model-visible history.
 *
 * Trigger: fires when `execute_with_agent` is in the active toolset
 * AND the run has accumulated at least `VERIFY_REMINDER_EDIT_THRESHOLD`
 * mutating edits since the most recent verifier spawn AND at least
 * `VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS` assistant turns have
 * elapsed since the last verify reminder.
 *
 * Counter updates live on the supervisor side (see
 * `background-run-supervisor.ts`). This module exposes the helpers
 * the supervisor uses to mutate counters (`isMutatingTool`,
 * `isVerifierSpawnFromRecord`, `containsVerdictMarkerInToolResult`,
 * `messageContainsVerifyReminderPrefix`) alongside the trigger
 * predicate itself.
 *
 * The emitted reminder carries `runtimeOnly.anchorPreserve: true`
 * so that the message survives history compaction — its presence in
 * history is not a trigger anchor (that is the supervisor's counter)
 * but preserving it keeps the model's context stable across compact
 * boundaries instead of silently losing a still-live pointer to the
 * verification obligation.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";

export const VERIFY_REMINDER_EDIT_THRESHOLD = 3;
export const VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS = 10;

export const VERIFY_REMINDER_HEADER_PREFIX =
  "You have made unverified file edits.";

const VERIFY_REMINDER_HEADER =
  "You have made unverified file edits. The verification contract " +
  "requires that independent adversarial verification happens before " +
  "you report completion. Spawn the verifier with `execute_with_agent`, " +
  "setting `delegationAdmission.verifierObligations` to the checks you " +
  "want verified (examples: \"build passes\", \"test suite passes\", " +
  "\"end-to-end smoke command returns expected output\"). Your own " +
  "checks, caveats, and a subagent's self-checks do NOT substitute " +
  "\u2014 only the verifier assigns a verdict; you cannot self-assign " +
  "PARTIAL. This is a gentle reminder \u2014 ignore only if all " +
  "changes since the last verification have already been verified " +
  "elsewhere. Make sure that you NEVER mention this reminder to the " +
  "user.";

/**
 * Tool names that count toward the "unverified edits" threshold.
 *
 * Explicitly excludes `system.bash`: shell-sourced mutations are not
 * individually trackable (one `bash` call can create many files or
 * none), so the runtime delegates shell-level verification to the
 * verifier-obligation contract at the run level rather than trying
 * to count shell mutations as equivalent to structured file writes.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.writeFile",
  "system.editFile",
  "system.appendFile",
  "system.mkdir",
  "system.move",
  "system.delete",
]);

const EXECUTE_WITH_AGENT_TOOL_NAME = "execute_with_agent";

const VERDICT_MARKERS: readonly string[] = [
  "VERDICT: PASS",
  "VERDICT: FAIL",
  "VERDICT: PARTIAL",
];

function stringContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function hasVerifierObligations(toolCallArguments: unknown): boolean {
  if (!toolCallArguments || typeof toolCallArguments !== "object") {
    return false;
  }
  const rec = toolCallArguments as Record<string, unknown>;
  const admission = rec["delegationAdmission"];
  if (!admission || typeof admission !== "object") return false;
  const obligations = (admission as Record<string, unknown>)[
    "verifierObligations"
  ];
  return Array.isArray(obligations) && obligations.length > 0;
}

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

/**
 * Detect a verifier spawn from an already-parsed `ToolCallRecord`
 * (supervisor-side shape; `args` is `Record<string, unknown>`).
 * Returns true only for `execute_with_agent` calls whose
 * `delegationAdmission.verifierObligations` is a non-empty array.
 */
export function isVerifierSpawnFromRecord(call: {
  readonly name: string;
  readonly args: Record<string, unknown>;
}): boolean {
  if (call.name !== EXECUTE_WITH_AGENT_TOOL_NAME) return false;
  return hasVerifierObligations(call.args);
}

/**
 * Detect a `VERDICT: PASS|FAIL|PARTIAL` marker in a verifier tool's
 * own tool_result. Scoped to `execute_with_agent` results only so an
 * unrelated tool (e.g. a `grep` hit containing the word "VERDICT")
 * cannot spuriously reset the edit counter.
 */
export function containsVerdictMarkerInToolResult(call: {
  readonly name: string;
  readonly result: string;
}): boolean {
  if (call.name !== EXECUTE_WITH_AGENT_TOOL_NAME) return false;
  return VERDICT_MARKERS.some((marker) => call.result.includes(marker));
}

/**
 * Returns `true` if the message content contains the static verify-
 * reminder header prefix. Used by the supervisor to detect whether
 * a just-emitted reminder came through `collectAttachments` so that
 * the turn counter can be reset on the same tick the reminder fires.
 */
export function messageContainsVerifyReminderPrefix(
  message: LLMMessage,
): boolean {
  const content = stringContent(message);
  return content.includes(VERIFY_REMINDER_HEADER_PREFIX);
}

export interface ShouldInjectVerifyReminderParams {
  readonly activeToolNames: ReadonlySet<string>;
  /**
   * Mutating edits the run has accumulated since the most recent
   * verifier spawn. `undefined` (e.g. webchat / text-channel turns
   * that do not maintain this counter) means "not applicable" —
   * the reminder is unconditionally suppressed on those surfaces.
   */
  readonly mutatingEditsSinceLastVerifierSpawn: number | undefined;
  /**
   * Assistant turns elapsed since the last verify reminder emission.
   * `undefined` means "never emitted on this surface" and the counter
   * is treated as effectively infinite for the gate below.
   */
  readonly assistantTurnsSinceLastVerifyReminder: number | undefined;
}

export function shouldInjectVerifyReminder(
  params: ShouldInjectVerifyReminderParams,
): boolean {
  if (!params.activeToolNames.has(EXECUTE_WITH_AGENT_TOOL_NAME)) return false;
  // Counters are supplied only by background-run surfaces. When
  // undefined, the reminder is off by design — interactive turns are
  // short-horizon and do not accumulate unverified edits the way
  // background runs do.
  if (params.mutatingEditsSinceLastVerifierSpawn === undefined) return false;
  if (
    params.mutatingEditsSinceLastVerifierSpawn < VERIFY_REMINDER_EDIT_THRESHOLD
  ) {
    return false;
  }
  const turns =
    params.assistantTurnsSinceLastVerifyReminder ??
    Number.POSITIVE_INFINITY;
  if (turns < VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS) return false;
  return true;
}

export function buildVerifyReminderMessage(): LLMMessage {
  return {
    role: "user",
    content: `<system-reminder>\n${VERIFY_REMINDER_HEADER}\n</system-reminder>`,
    runtimeOnly: { mergeBoundary: "user_context", anchorPreserve: true },
  };
}
