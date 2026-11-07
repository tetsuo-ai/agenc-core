/**
 * What ends a Light busy wait early (unified-exec `waitWhileBusy`) while the
 * command keeps running as a session.
 *
 * A wait that continues while its command is busy can last minutes. Input
 * that the turn would hand the model at its next request must not sit behind
 * it: a prompt queued for this conversation (the turn delivers those after
 * the tool phase, run-turn-queued-commands.ts) or input in the session
 * mailbox (what wait_agent wakes on). When either arrives, or was already
 * there when the wait started, the wait ends and the call returns the
 * command's session_id, as at the end of a yield; the command is not stopped.
 *
 * @module
 */

import type { Session } from "../../session/session.js";
import type { QueuedCommand } from "../../types/textInputTypes.js";
import type { BusyWaitWake } from "../../unified-exec/types.js";
import {
  hasCommandsInQueue,
  isSlashCommand,
  queuedCommandOwnedByConversation,
  subscribeToCommandQueue,
} from "../../utils/messageQueueManager.js";

/** Why a busy wait was ended early; the abort reason of {@link BusyWaitWake.signal}. */
export type BusyWaitWakeReason = "input";

/** The longest a busy wait can run; the mailbox watch never needs to outlive it. */
const MAILBOX_WATCH_MS = 10 * 60_000;

type WakeSession = Pick<Session, "conversationId"> & Partial<Pick<Session, "hasPendingInput" | "waitForMailboxChange">>;

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
    const watchEnded = new AbortController();
    const wake = (reason: BusyWaitWakeReason): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const queued = (): boolean => hasCommandsInQueue((command) => deliveredAfterTools(command, session.conversationId));
    const unsubscribe = subscribeToCommandQueue(() => {
      if (queued()) wake("input");
    });
    if (queued()) wake("input");
    if (typeof session.waitForMailboxChange === "function") {
      void session.waitForMailboxChange(MAILBOX_WATCH_MS, undefined, watchEnded.signal)
        .then((changed) => { if (changed) wake("input"); }, () => {});
    }
    return {
      signal: controller.signal,
      dispose: () => {
        unsubscribe();
        watchEnded.abort();
      },
    };
  };
}
