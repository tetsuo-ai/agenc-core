/**
 * Verification reminder for unverified cumulative edits.
 *
 * Plan-mode-less equivalent of the reference runtime's
 * `verify_plan_reminder` (upstream: plan mode state with
 * `verificationStarted && !verificationCompleted`). AgenC has no plan
 * mode, so the trigger is substituted with a cumulative-edit signal:
 * fires when the model has issued at least `VERIFY_REMINDER_EDIT_THRESHOLD`
 * mutating file-modification tool calls since the most recent verifier
 * spawn, and at least `VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS`
 * assistant turns have elapsed since the last verify reminder.
 *
 * The counter resets when EITHER:
 *   (a) The model spawns `execute_with_agent` with a non-empty
 *       `delegationAdmission.verifierObligations` array. This is the
 *       structured contract the model cannot synthesize without an
 *       actual verifier spawn round-trip.
 *   (b) A `role === "tool"` message contains `VERDICT: PASS|FAIL|PARTIAL`.
 *       Scoping to `role === "tool"` prevents the model from gaming
 *       the reset by typing the string itself — tool messages are
 *       runtime-controlled, not model-authored.
 *
 * Counter model mirrors `todo-reminder.ts` — scan-derived, no
 * persisted fields, compaction/crash/resume safe.
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

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

/**
 * Detect a verifier spawn from an already-parsed `ToolCallRecord`
 * (supervisor-side shape; args is `Record<string, unknown>`). The
 * corresponding `LLMMessage`/raw-JSON-arguments path used by the
 * history scan functions below is intentionally separate to avoid
 * type ambiguity across two parsing models in the same module.
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
 * unrelated tool (e.g. a `grep` hit that happens to contain the word
 * "VERDICT") cannot spuriously reset the edit counter.
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
 * a just-emitted reminder came through `collectAttachments` so the
 * turn counter can be reset.
 */
export function messageContainsVerifyReminderPrefix(
  message: LLMMessage,
): boolean {
  const content = stringContent(message);
  return content.includes(VERIFY_REMINDER_HEADER_PREFIX);
}

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

function countAssistantTurnsBetween(
  history: readonly LLMMessage[],
  startExclusive: number,
  endExclusive: number,
): number {
  let count = 0;
  for (let index = startExclusive + 1; index < endExclusive; index += 1) {
    if (history[index]?.role === "assistant") count += 1;
  }
  return count;
}

function parseToolCallArguments(raw: string | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
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

function messageIsVerifierSpawn(message: LLMMessage): boolean {
  if (message.role !== "assistant") return false;
  const calls = message.toolCalls ?? [];
  return calls.some((call) => {
    if (call.name !== EXECUTE_WITH_AGENT_TOOL_NAME) return false;
    return hasVerifierObligations(parseToolCallArguments(call.arguments));
  });
}

function messageIsVerifierVerdict(message: LLMMessage): boolean {
  if (message.role !== "tool") return false;
  const content = stringContent(message);
  return VERDICT_MARKERS.some((marker) => content.includes(marker));
}

/**
 * Count mutating tool-use invocations in assistant history, scanning
 * backwards, stopping at the most recent verifier-spawn or verdict
 * terminator. If no terminator is encountered, returns the count
 * across the full visible history.
 */
export function getMutatingEditsSinceLastVerifierSpawn(
  history: readonly LLMMessage[],
): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (messageIsVerifierSpawn(message) || messageIsVerifierVerdict(message)) {
      return count;
    }
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (MUTATING_TOOL_NAMES.has(call.name)) count += 1;
    }
  }
  return count;
}

export function getTurnsSinceLastVerifyReminder(
  history: readonly LLMMessage[],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "user") continue;
    const content = stringContent(message);
    if (content.includes(VERIFY_REMINDER_HEADER_PREFIX)) {
      return countAssistantTurnsBetween(history, index, history.length);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface ShouldInjectVerifyReminderParams {
  readonly history: readonly LLMMessage[];
  readonly activeToolNames: ReadonlySet<string>;
}

export function shouldInjectVerifyReminder(
  params: ShouldInjectVerifyReminderParams,
): boolean {
  if (!params.activeToolNames.has(EXECUTE_WITH_AGENT_TOOL_NAME)) return false;
  const edits = getMutatingEditsSinceLastVerifierSpawn(params.history);
  if (edits < VERIFY_REMINDER_EDIT_THRESHOLD) return false;
  const turnsSinceReminder = getTurnsSinceLastVerifyReminder(params.history);
  if (turnsSinceReminder < VERIFY_REMINDER_TURNS_BETWEEN_REMINDERS) {
    return false;
  }
  return true;
}

export function buildVerifyReminderMessage(): LLMMessage {
  return {
    role: "user",
    content: `<system-reminder>\n${VERIFY_REMINDER_HEADER}\n</system-reminder>`,
    runtimeOnly: { mergeBoundary: "user_context", anchorPreserve: true },
  };
}
