/**
 * Cascading withhold check (two-gate PTL → collapse-drain routing).
 *
 * Hand-port of AgenC `query.ts:834-857`. Two independent gates
 * determine whether a "withheld 413" message escalates to reactive-
 * compact or continues through collapse-drain first.
 *
 * Gates:
 *   1. `isWithheld413(lastMessage)` — message is a prompt-too-long
 *      response the stream withheld from the SDK caller.
 *   2. `transition.reason !== 'collapse_drain_retry'` — we haven't
 *      already tried collapse-drain this recovery pass.
 *
 * When both gates pass, the caller runs collapse-drain first. When
 * the 413 persists after collapse-drain, the gate flips and the next
 * pass goes to reactive-compact.
 *
 * Invariants covered:
 *   I-10 (recovery-trigger priority explicit) — this module is the
 *        first gate in the ordered trigger array.
 *
 * @module
 */

import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import { isWithheld413Message, isMediaTooLargeMessage } from "./api-errors.js";
import { hasAttemptedCollapseDrain } from "./collapse-drain.js";

export interface WithholdGateResult {
  readonly kind:
    | "not_withheld"
    | "route_to_collapse_drain"
    | "route_to_reactive_compact";
  readonly reason: string;
}

/**
 * Evaluate the two-gate cascade for the last assistant message.
 * Returns the routing decision the post-sample-recovery phase uses
 * to pick between collapse-drain and reactive-compact.
 */
export function evaluateWithholdCascade(
  state: TurnState,
  lastMessage: AssistantMessage | undefined,
): WithholdGateResult {
  if (!lastMessage) {
    return { kind: "not_withheld", reason: "no_last_message" };
  }
  if (!isWithheld413Message(lastMessage)) {
    return { kind: "not_withheld", reason: "not_withheld_413" };
  }

  // Gate 2: has collapse-drain already fired this recovery pass?
  const alreadyDrained = hasAttemptedCollapseDrain(state);
  if (alreadyDrained) {
    return {
      kind: "route_to_reactive_compact",
      reason: "413_after_collapse_drain",
    };
  }
  return {
    kind: "route_to_collapse_drain",
    reason: "413_first_attempt",
  };
}

/**
 * Media-only variant: media errors skip collapse-drain (collapse
 * only helps with context-volume PTL; media too-large needs image
 * stripping, which lives in reactive-compact).
 */
export function isMediaWithholdRoute(
  lastMessage: AssistantMessage | undefined,
): boolean {
  return !!lastMessage && isMediaTooLargeMessage(lastMessage);
}
