/**
 * The volatile inputs of the session tail, kept for the whole conversation.
 *
 * Base instructions end with the current UTC date and, in standard and
 * simple mode, the git branch. They are assembled once per session object
 * (bin/bootstrap.ts), so a live session keeps the date and branch it started
 * with. A resume builds a new session object, and it used to read both again:
 * after midnight UTC, after a branch switch, or when the git read failed, the
 * resumed request changed at its first input item and the provider's prompt
 * cache read none of the earlier conversation. The conversation now records
 * the values once, in its own small session_state line, and every later
 * assembly for it (a resume, a provider switch) uses the recorded values, so a
 * resumed session sends what a live one would. A new date still reaches the
 * model through the date_change reminder.
 *
 * @module
 */

import type { RolloutItem } from "./rollout-item.js";

export interface PromptEnvironment {
  /** UTC calendar date (YYYY-MM-DD) of the `Current date (UTC)` line. */
  readonly currentDate: string;
  /**
   * The `Git branch` line's branch; null prints `<not a git repository>`.
   * Absent when the session's prompt prints no branch line (Light, compact):
   * an assembly that prints one reads it then.
   */
  readonly gitBranch?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
// One line of plain text; a branch name never holds a control character.
const BRANCH_RE = /^[^\u0000-\u001f\u007f]{1,4096}$/u;

/**
 * The rollout schema's check (state/recovery-journal-schema.ts) and the
 * reader's. A value it refuses is never written (see promptEnvironmentItem):
 * the schema would make the whole rollout unreadable.
 */
export function isPromptEnvironment(value: unknown): value is PromptEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const environment = value as Record<string, unknown>;
  return typeof environment.currentDate === "string" && DATE_RE.test(environment.currentDate) &&
    (environment.gitBranch === undefined || environment.gitBranch === null ||
      (typeof environment.gitBranch === "string" && BRANCH_RE.test(environment.gitBranch)));
}

export function samePromptEnvironment(left: PromptEnvironment, right: PromptEnvironment): boolean {
  return left.currentDate === right.currentDate && left.gitBranch === right.gitBranch;
}

/** The record line, or undefined for values the rollout schema would refuse. */
export function promptEnvironmentItem(environment: PromptEnvironment): RolloutItem | undefined {
  const record = { currentDate: environment.currentDate,
    ...(environment.gitBranch !== undefined ? { gitBranch: environment.gitBranch } : {}) };
  return isPromptEnvironment(record) ? { type: "session_state", payload: { promptEnvironment: record } } : undefined;
}

/**
 * The values the conversation's base instructions were first built with: the
 * first valid record. A conversation written before records existed has none.
 */
export function recordedPromptEnvironment(items: readonly RolloutItem[]): PromptEnvironment | undefined {
  for (const item of items) {
    if (item?.type !== "session_state" || !Object.hasOwn(item.payload, "promptEnvironment")) continue;
    const environment = item.payload.promptEnvironment;
    if (isPromptEnvironment(environment)) {
      return { currentDate: environment.currentDate,
        ...(environment.gitBranch !== undefined ? { gitBranch: environment.gitBranch } : {}) };
    }
  }
  return undefined;
}

const sessionEnvironments = new WeakMap<object, PromptEnvironment>();

/** Bind the conversation's values to its session object, for later assemblies. */
export function setSessionPromptEnvironment(session: object, environment: PromptEnvironment): void {
  sessionEnvironments.set(session, environment);
}

export function sessionPromptEnvironment(session: object): PromptEnvironment | undefined {
  return sessionEnvironments.get(session);
}
