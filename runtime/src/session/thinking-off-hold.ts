/**
 * Thinking-off hold after a productive reasoning-only recovery (harness
 * learning candidate, experimental, off by default).
 *
 * On native DeepSeek the recovery for a reasoning-only output cap sends one
 * sample with thinking disabled. When that sample returns a tool call or a
 * final answer, commit clears the override and the next request goes back to
 * the configured thinking. In the Light measurement runs about half of those
 * next requests capped on reasoning again, so each cycle paid for a whole
 * capped sample (its full output budget spent on reasoning) and one more
 * recovery request before the turn moved on.
 *
 * With `AGENC_HL_THINKING_OFF_HOLD` set in a Light session, a productive
 * thinking-off recovery starts a hold: the following samples of the same turn
 * also run with thinking disabled. The hold is bounded. It starts at two
 * samples; when it ends, the next sample is a probe with the configured
 * thinking. A probe that completes without an output cap clears the hold. A
 * probe that caps on reasoning again goes through the ordinary recovery, and
 * the productive recovery that follows starts a longer hold (double the
 * previous length, up to the ceiling). The hold is turn state: a new user turn
 * starts without one, and so does a turn resumed from a checkpoint.
 *
 * Only the thinking switch of the request changes. Output limits, the retry
 * budgets, tool validation and permissions are untouched, and unsupported
 * routes never see a disabled-thinking request.
 *
 * @module
 */

import { isEnvTruthy } from "../utils/envBoolean.js";
import type { Session } from "./session.js";
import type { TurnState } from "./turn-state.js";

export const THINKING_OFF_HOLD_ENV = "AGENC_HL_THINKING_OFF_HOLD";

/** Samples a first hold keeps thinking off for. */
export const INITIAL_THINKING_OFF_HOLD = 2;
/** The longest hold a turn can reach by repeated probe caps. */
export const MAX_THINKING_OFF_HOLD = 16;

export interface ThinkingOffHoldState {
  /** Thinking-off samples left before the next thinking-on probe. */
  remaining: number;
  /** Length of the current hold; doubles when a probe caps again. */
  length: number;
}

/** The request-level facts the hold accounting needs about one completed sample. */
export interface ThinkingOffHoldSampleRequest {
  readonly reasoningOnlyRecovery?: true;
  readonly thinkingOffHold?: true;
}

type SessionLike = Pick<Session, "services"> | {
  readonly services?: {
    readonly runtimeOptions?: { readonly lightMode?: boolean };
    readonly userShell?: { readonly childEnvironment?: Readonly<Record<string, string | undefined>> };
    readonly providerEnvironment?: Readonly<Record<string, string | undefined>>;
  };
};

/**
 * Whether this session runs the hold: a Light session whose captured
 * environment sets the switch. The environment is the one the prompt reads
 * (the shell's child environment, else the provider snapshot), captured once
 * per session, so a client turns it on per session.
 */
export function thinkingOffHoldEnabled(session: SessionLike | undefined): boolean {
  const services = session?.services as SessionLike["services"] | undefined;
  if (services?.runtimeOptions?.lightMode !== true) return false;
  const environment = services.userShell?.childEnvironment ?? services.providerEnvironment ?? {};
  return isEnvTruthy(environment[THINKING_OFF_HOLD_ENV]);
}

/** A hold with samples left: the next ordinary sample runs with thinking off. */
export function thinkingOffHoldActive(state: Pick<TurnState, "thinkingOffHold">): boolean {
  return (state.thinkingOffHold?.remaining ?? 0) > 0;
}

/**
 * A productive thinking-off recovery completed. A first hold is short; a hold
 * that follows a capped probe (the previous hold ran out and the configured
 * thinking capped again) doubles, up to the ceiling.
 */
export function startThinkingOffHold(state: Pick<TurnState, "thinkingOffHold">): ThinkingOffHoldState {
  const previous = state.thinkingOffHold;
  const length = previous === undefined
    ? INITIAL_THINKING_OFF_HOLD
    : Math.min(previous.length * 2, MAX_THINKING_OFF_HOLD);
  const hold: ThinkingOffHoldState = { remaining: length, length };
  state.thinkingOffHold = hold;
  return hold;
}

/**
 * One sample completed (a response arrived; transport failures never reach
 * this). A hold sample spends one of the hold's samples. A thinking-on sample
 * after the hold ran out is the probe: when it completes without an output
 * cap the hold is over; when it caps, the hold stays so the recovery that
 * follows can lengthen it. Recovery samples are accounted by
 * {@link startThinkingOffHold}.
 */
export function completeThinkingOffHoldSample(
  state: Pick<TurnState, "thinkingOffHold">,
  request: ThinkingOffHoldSampleRequest,
  outcome: { readonly capped: boolean },
): void {
  const hold = state.thinkingOffHold;
  if (hold === undefined) return;
  if (request.thinkingOffHold === true) {
    hold.remaining = Math.max(0, hold.remaining - 1);
    return;
  }
  if (request.reasoningOnlyRecovery === true) return;
  if (hold.remaining === 0 && !outcome.capped) state.thinkingOffHold = undefined;
}
