/**
 * What ends a Light busy wait early (unified-exec `waitWhileBusy`) while the
 * command keeps running as a session.
 *
 * A wait that continues while its command is busy can last minutes. Input
 * that the turn hands the model at its next request must not sit behind it:
 * a prompt queued for this conversation, which the turn delivers after the
 * tool phase (run-turn-queued-commands.ts). When one is queued, or was
 * already queued when the wait started, the wait ends and the call returns
 * the command's session_id, as at the end of a yield; the command is not
 * stopped. Session mailbox input is not watched: the turn reads the mailbox
 * only when it starts, so ending the wait for it would hand nothing to the
 * model. A run with a deadline (`agenc -p --deadline`) ends the wait when its
 * reserve starts, so the model learns it must wrap up while there is time.
 *
 * @module
 */

import type { Session } from "../../session/session.js";
import { runDeadlineClock, runDeadlineOf } from "../../session/run-deadline.js";
import type { QueuedCommand } from "../../types/textInputTypes.js";
import type { BusyWaitWake } from "../../unified-exec/types.js";
import {
  hasCommandsInQueue,
  isSlashCommand,
  queuedCommandOwnedByConversation,
  subscribeToCommandQueue,
} from "../../utils/messageQueueManager.js";

/** Why a busy wait was ended early; the abort reason of {@link BusyWaitWake.signal}. */
export type BusyWaitWakeReason = "input" | "deadline_reserve";

type WakeSession = Pick<Session, "conversationId"> & { readonly services?: unknown };

/**
 * A queued command this conversation's turn delivers to the model after its
 * tool phase: a prompt or task notification owned by the conversation, for
 * the main thread, not a slash command, at "now" or "next" priority.
 */
function deliveredAfterTools(command: QueuedCommand, conversationId: string): boolean {
  return queuedCommandOwnedByConversation(command, conversationId) &&
    (command.mode === "prompt" || command.mode === "task-notification") &&
    !isSlashCommand(command) &&
    command.agentId === undefined &&
    (command.priority ?? "next") !== "later";
}

/**
 * The wake for one busy wait of `session`'s call, or undefined without a
 * session (direct tool use). The manager starts it when the wait goes past
 * the yield and disposes of it when the wait ends.
 */
export function busyWaitWakeFor(session: WakeSession | undefined): (() => BusyWaitWake) | undefined {
  if (session === undefined || typeof session.conversationId !== "string") return undefined;
  return () => {
    const controller = new AbortController();
    const wake = (reason: BusyWaitWakeReason): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const queued = (): boolean => hasCommandsInQueue((command) => deliveredAfterTools(command, session.conversationId));
    const unsubscribe = subscribeToCommandQueue(() => {
      if (queued()) wake("input");
    });
    if (queued()) wake("input");
    // The deadline reserve: from then on the model must finish, so a wait
    // that runs into it hands control back at its start.
    let cancelReserveTimer: (() => void) | undefined;
    const deadline = runDeadlineOf(session);
    if (deadline !== undefined) {
      const clock = runDeadlineClock();
      const untilReserve = deadline.at - deadline.reserveMs - clock.now();
      if (untilReserve <= 0) wake("deadline_reserve");
      else cancelReserveTimer = clock.schedule(untilReserve, () => wake("deadline_reserve"));
    }
    return {
      signal: controller.signal,
      dispose: () => {
        unsubscribe();
        cancelReserveTimer?.();
      },
    };
  };
}
