/**
 * Run deadline for unattended sessions (#2503).
 *
 * Harbor kills an agent at its trial timeout, and two Terminal-Bench trials
 * lost everything to that: one had a passing solution hours before the
 * cutoff, kept optimizing, and was killed with a broken intermediate file on
 * disk. The agent never knew how much time it had. A run started with
 * `agenc -p --deadline` carries the instant it must end by; this module
 * owns what the turn loop does with it:
 *
 * - the remaining budget the model is told about (a reminder at the start of
 *   each turn and `time_remaining_sec` on every tool result, both runtime
 *   only, never in durable history);
 * - the reserve: a window before the deadline in which the model is told to
 *   stop exploring, restore its best verified state and finish, new
 *   subagents are refused, and the completion gate accepts the final answer;
 * - the stop: at the deadline the running turn is aborted with
 *   {@link RunDeadlineReachedError} and ends as the bounded stop
 *   `deadline_reached`.
 *
 * The deadline is a budget input, not a clock the model reasons about
 * (invariant I-82): the model only ever sees durations.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";

export const DEADLINE_REACHED_STOP = "deadline_reached" as const;
export const DEADLINE_REACHED_CAUSE = "deadline_reached" as const;
export const DEADLINE_REACHED_MESSAGE =
  "Run stopped at its deadline. The files on disk are what was saved before it; " +
  "any step still running was interrupted.";

export const DEADLINE_RESERVE_SPAWN_REFUSAL =
  "This run is in its deadline reserve: no new subagents. Finish with what you have: " +
  "restore your best verified state, run the final checks, and write the final message.";

export const DEADLINE_RESERVE_FRACTION = 0.1;
export const DEADLINE_RESERVE_MIN_MS = 5 * 60_000;
export const DEADLINE_RESERVE_MAX_MS = 30 * 60_000;

/**
 * Reserve before the deadline: 10 % of the budget clamped to 5-30 minutes,
 * never more than half of the budget (a two-minute run reserves one minute).
 * An explicit override is still capped at half the budget.
 */
export function resolveDeadlineReserveMs(
  budgetMs: number,
  overrideMs?: number,
): number {
  const policy = Math.min(
    DEADLINE_RESERVE_MAX_MS,
    Math.max(DEADLINE_RESERVE_MIN_MS, Math.round(budgetMs * DEADLINE_RESERVE_FRACTION)),
  );
  const requested = overrideMs ?? policy;
  return Math.max(1, Math.min(requested, Math.floor(budgetMs / 2)));
}

// The flag parsers live in a module with no imports so the launcher startup preflight can
// validate --deadline without bundling this session module; re-exported for existing callers.
export {
  DeadlineFlagError,
  parseDeadlineFlag,
  parseDeadlineReserveFlag,
} from "./deadline-flags.js";

export interface RunDeadline {
  readonly at: number;
  readonly reserveMs: number;
}

interface DeadlineSession {
  readonly services?: {
    readonly runtimeOptions?: {
      readonly deadlineAt?: unknown;
      readonly deadlineReserveMs?: unknown;
    };
  };
}

export function runDeadlineOf(session: object): RunDeadline | undefined {
  const options = (session as DeadlineSession).services?.runtimeOptions;
  const at = options?.deadlineAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const reserve = options?.deadlineReserveMs;
  return {
    at,
    reserveMs: typeof reserve === "number" && reserve > 0 ? reserve : 0,
  };
}

// ── Clock ────────────────────────────────────────────────────────────────

export interface RunDeadlineClock {
  now(): number;
  /** Run `fire` after `delayMs`; returns a canceller. */
  schedule(delayMs: number, fire: () => void): () => void;
}

const SYSTEM_CLOCK: RunDeadlineClock = {
  now: () => Date.now(),
  schedule(delayMs, fire) {
    const timer = setTimeout(fire, Math.max(0, delayMs));
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};

type RunDeadlineClockGlobal = typeof globalThis & {
  __agencRunDeadlineClock?: RunDeadlineClock | null;
};

/** Test seam: replace the clock the deadline logic reads (null restores it). */
export function setRunDeadlineClockForTests(clock: RunDeadlineClock | null): void {
  (globalThis as RunDeadlineClockGlobal).__agencRunDeadlineClock = clock;
}

export function runDeadlineClock(): RunDeadlineClock {
  return (globalThis as RunDeadlineClockGlobal).__agencRunDeadlineClock ?? SYSTEM_CLOCK;
}

export function deadlineRemainingMs(deadline: RunDeadline): number {
  return deadline.at - runDeadlineClock().now();
}

/** The session has a deadline and the reserve window has begun. */
export function inDeadlineReserve(session: object): boolean {
  const deadline = runDeadlineOf(session);
  return deadline !== undefined && deadlineRemainingMs(deadline) <= deadline.reserveMs;
}

// ── Per-session state ─────────────────────────────────────────────────────

interface DeadlineSessionState {
  reserveAnnounced: boolean;
  readonly toolResultRemainingSec: Map<string, number>;
}

const SESSION_STATE = new WeakMap<object, DeadlineSessionState>();

function stateFor(session: object): DeadlineSessionState {
  let state = SESSION_STATE.get(session);
  if (state === undefined) {
    state = { reserveAnnounced: false, toolResultRemainingSec: new Map() };
    SESSION_STATE.set(session, state);
  }
  return state;
}

/** True exactly once per session, the first time the reserve is announced. */
export function claimDeadlineReserveAnnouncement(session: object): boolean {
  const state = stateFor(session);
  if (state.reserveAnnounced) return false;
  state.reserveAnnounced = true;
  return true;
}

/**
 * Record the remaining budget when a tool result completes. The value is
 * fixed for that result, so its projected bytes never change after the first
 * request (prompt-cache stable).
 */
export function stampToolResultRemaining(session: object, callId: string): void {
  const deadline = runDeadlineOf(session);
  if (deadline === undefined) return;
  stateFor(session).toolResultRemainingSec.set(
    callId,
    Math.max(0, Math.floor(deadlineRemainingMs(deadline) / 1000)),
  );
}

export function toolResultRemainingSec(
  session: object,
  callId: string,
): number | undefined {
  return SESSION_STATE.get(session)?.toolResultRemainingSec.get(callId);
}

// ── Abort ────────────────────────────────────────────────────────────────

/** Abort reason for a turn stopped by the run deadline. */
export class RunDeadlineReachedError extends Error {
  constructor(readonly deadlineAt: number) {
    super("run deadline reached");
    this.name = "RunDeadlineReachedError";
  }
}

/**
 * The signal was aborted by the run deadline: the in-process timer, or the
 * one-shot client's backstop (`session.cancelTurn` with reason
 * `deadline_reached`).
 */
export function isDeadlineAbort(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  return reason instanceof RunDeadlineReachedError || reason === DEADLINE_REACHED_STOP;
}

/**
 * Abort `controller` with {@link RunDeadlineReachedError} when the session's
 * deadline passes (immediately if it already has). Returns the disposer.
 */
export function armRunDeadline(
  session: object,
  controller: AbortController,
): () => void {
  const deadline = runDeadlineOf(session);
  if (deadline === undefined) return () => {};
  const fire = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new RunDeadlineReachedError(deadline.at));
    }
  };
  const delayMs = deadlineRemainingMs(deadline);
  if (delayMs <= 0) {
    fire();
    return () => {};
  }
  return runDeadlineClock().schedule(delayMs, fire);
}

// ── What the model reads ─────────────────────────────────────────────────

export function formatRemainingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h ${rest} min`;
}

function reminderMessage(text: string): LLMMessage {
  return {
    role: "user",
    content: `<system-reminder>\n${text}\n</system-reminder>`,
    runtimeOnly: { excludeFromDurableHistory: true },
  };
}

/** Start-of-turn line: the remaining budget. */
export function deadlineTurnReminder(remainingMs: number): LLMMessage {
  return reminderMessage(
    `This run has a fixed time budget and ${formatRemainingDuration(remainingMs)} of it remain. ` +
      "Every tool result reports time_remaining_sec. Keep a working, verified result on disk; " +
      "improve on a copy so the deliverable is never left broken when time runs out.",
  );
}

/** Reserve entry: stop exploring and finish. */
export function deadlineReserveReminder(remainingMs: number): LLMMessage {
  return reminderMessage(
    `Time is nearly up: ${formatRemainingDuration(remainingMs)} remain before this run is stopped. ` +
      "Stop exploring and optimizing now. If the current state on disk is not your best verified " +
      "result, restore that version. Run the final checks the task implies, then write the final " +
      "message listing what is verified and what is not. Do not start new subagents or long " +
      "commands; anything still running at the deadline is interrupted.",
  );
}

const TIME_REMAINING_TRAILER_PREFIX = "[time_remaining_sec=";

function withTrailer(content: LLMMessage["content"], trailer: string): LLMMessage["content"] {
  if (typeof content === "string") return `${content}\n\n${trailer}`;
  return [...content, { type: "text", text: trailer }] as LLMMessage["content"];
}

/**
 * Append `[time_remaining_sec=N]` to each tool result that was stamped when
 * it completed. Projection only: the durable message is never touched.
 */
export function projectToolResultTimeRemaining(
  messages: readonly LLMMessage[],
  session: object,
): LLMMessage[] {
  const stamps = SESSION_STATE.get(session)?.toolResultRemainingSec;
  if (stamps === undefined || stamps.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "tool" || message.toolCallId === undefined) return message;
    const remaining = stamps.get(message.toolCallId);
    if (remaining === undefined) return message;
    return {
      ...message,
      content: withTrailer(message.content, `${TIME_REMAINING_TRAILER_PREFIX}${remaining}]`),
    };
  });
}
