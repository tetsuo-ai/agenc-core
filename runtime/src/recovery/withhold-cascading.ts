/**
 * Cascading withhold check (two-gate PTL → AgenC collapse routing).
 *
 * Hand-port of agenc `query.ts:834-857`. Two independent gates
 * determine whether a "withheld 413" message should try AgenC collapse.
 *
 * Gates:
 *   1. `isWithheld413(lastMessage)` — message is a prompt-too-long
 *      response the stream withheld from the SDK caller.
 *   2. `transition.reason !== 'collapse_drain_retry'` — we haven't
 *      already tried AgenC collapse this recovery pass.
 *
 * When both gates pass, the caller runs AgenC collapse first. When
 * the 413 persists after that, the gate flips and the caller surfaces
 * the prompt-too-long error.
 *
 * Invariants covered:
 *   I-10 (recovery-trigger priority explicit) — this module is the
 *        first gate in the ordered trigger array.
 *
 * @module
 */

import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import { isWithheld413Message } from "./api-errors.js";

const CONTEXT_COLLAPSE_ATTEMPTED = Symbol("agenc_context_collapse_attempted");

type ContextCollapseAttemptState = TurnState & {
  [CONTEXT_COLLAPSE_ATTEMPTED]?: boolean;
};

export interface WithholdGateResult {
  readonly kind:
    | "not_withheld"
    | "route_to_collapse_drain";
  readonly reason: string;
}

/**
 * Evaluate the two-gate cascade for the last assistant message.
 * Returns the routing decision the post-sample-recovery phase uses
 * to pick between AgenC collapse and reactive recovery.
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

  const alreadyDrained =
    (state as ContextCollapseAttemptState)[CONTEXT_COLLAPSE_ATTEMPTED] === true;
  if (alreadyDrained) {
    return {
      kind: "not_withheld",
      reason: "413_after_collapse_drain",
    };
  }
  return {
    kind: "route_to_collapse_drain",
    reason: "413_first_attempt",
  };
}

export function resetContextCollapseAttempted(state: TurnState): void {
  delete (state as ContextCollapseAttemptState)[CONTEXT_COLLAPSE_ATTEMPTED];
}

export function markContextCollapseAttempted(state: TurnState): void {
  (state as ContextCollapseAttemptState)[CONTEXT_COLLAPSE_ATTEMPTED] = true;
}
