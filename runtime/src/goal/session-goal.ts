/**
 * Where a session's goal lives.
 *
 * Deliberately outside the conversation: the goal is session state, persisted
 * as the latest durable `goal_changed` event, so compaction cannot drop or
 * paraphrase it (goal drift grows with context length, arXiv:2505.02709) and a
 * resumed session restores it from the rollout alone.
 *
 * Keyed by the session object so no Session field or fixture changes.
 *
 * @module
 */
import type { GoalChangedEvent } from "../session/event-log.js";
import { isGoalRestorable, type SessionGoal } from "./goal.js";

interface GoalEmitter {
  emit(
    event: { readonly id: string; readonly msg: { readonly type: "goal_changed"; readonly payload: GoalChangedEvent } },
    options?: { readonly durable?: boolean },
  ): unknown;
  nextInternalSubId(): string;
}

const goals = new WeakMap<object, SessionGoal>();

export function getSessionGoal(session: object): SessionGoal | undefined {
  return goals.get(session);
}

/** Store the goal and journal the snapshot durably. */
export function commitSessionGoal(
  session: object & GoalEmitter,
  goal: SessionGoal,
  cause: GoalChangedEvent["cause"],
  turnId?: string,
): SessionGoal {
  const frozen = Object.freeze({ ...goal });
  if (goal.status === "cleared") goals.delete(session);
  else goals.set(session, frozen);
  session.emit(
    {
      id: session.nextInternalSubId(),
      msg: {
        type: "goal_changed",
        payload: {
          goal: frozen,
          cause,
          ...(turnId !== undefined ? { turnId } : {}),
        },
      },
    },
    { durable: true },
  );
  return frozen;
}

/** Restore without journaling (resume, cold attach). */
export function restoreSessionGoal(session: object, goal: SessionGoal): void {
  goals.set(session, Object.freeze({ ...goal }));
}

/**
 * The goal a resumed session should carry: the last journaled snapshot, when
 * it is still open. Achieved, impossible and cleared goals stay finished. An
 * `active` goal comes back `paused`: the turn that was driving it is gone, and
 * resuming work is the user's call (`/goal resume`), not a side effect of
 * reopening a session.
 */
export function goalFromRolloutItems(
  items: Iterable<unknown>,
): SessionGoal | undefined {
  let last: SessionGoal | undefined;
  for (const item of items) {
    const payload = (item as { payload?: { msg?: { type?: unknown; payload?: unknown } } })
      ?.payload?.msg;
    if (payload?.type !== "goal_changed") continue;
    const goal = (payload.payload as { goal?: SessionGoal } | undefined)?.goal;
    if (goal !== undefined && typeof goal.objective === "string") last = goal;
  }
  if (last === undefined || !isGoalRestorable(last.status)) return undefined;
  return last.status === "active"
    ? { ...last, status: "paused", pauseReason: "the session was reopened" }
    : last;
}
