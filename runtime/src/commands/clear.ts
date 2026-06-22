/**
 * `/clear` — clear session conversation history + runtime caches.
 *
 * Clears the in-memory history array inside `SessionState`, evicts the
 * system-prompt section cache (so subsequent turns rebuild from the
 * current cwd), and resets any memory/cost sidecar counters that
 * expose a `reset()` hook.
 *
 * Like `/compact`, `/clear` refuses to run while a turn is in flight:
 * history is still being appended during streaming, and clearing it
 * mid-turn would corrupt the next request.
 *
 * Aliases: `/reset`, `/new`.
 *
 * @module
 */

import { freshDenialTracking } from "../permissions/denial-tracking.js";
import type { PhaseEvent } from "../phases/events.js";
import { clearSystemPromptSections } from "../prompts/sections.js";
import type { Session } from "../session/session.js";
import { asRecord } from "../utils/record.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

interface ActiveTurnPeek {
  unsafePeek?: () => unknown;
}

interface ClearableApprovalStore {
  clear?: () => void;
}

interface ClearableNetworkApproval {
  clearSessionHosts?: () => void;
}

interface ClearableSessionState {
  history?: unknown;
}

interface ClearableStateLock {
  with?: (fn: (state: ClearableSessionState) => unknown) => Promise<unknown>;
}

interface ClearableSessionShape {
  readonly state?: ClearableStateLock;
  readonly services?: Record<string, unknown> & {
    toolApprovals?: ClearableApprovalStore;
    networkApproval?: ClearableNetworkApproval;
  };
  readonly budgetTracker?: { resetSamplingGate?: () => void } | null;
  readonly denialTracking?: Record<string, unknown> | null;
  clearProviderResponseId?: () => void;
  emitPhaseEvent?: (event: PhaseEvent) => void;
  clearDaemonSession?: () => Promise<void>;
}

/** Best-effort reset of any sidecar instance that exposes `reset()`. */
function maybeReset(cand: unknown): boolean {
  const record = asRecord(cand);
  if (record !== null && typeof record.reset === "function") {
    record.reset.call(cand);
    return true;
  }
  return false;
}

function callServiceMethod(cand: unknown, method: string): void {
  const record = asRecord(cand);
  const fn = record?.[method];
  if (typeof fn === "function") {
    fn.call(cand);
  }
}

function hasActiveTurn(session: Session): boolean {
  const activeTurn = (session as unknown as { activeTurn?: ActiveTurnPeek })
    .activeTurn;
  return typeof activeTurn?.unsafePeek === "function" &&
    activeTurn.unsafePeek() !== null;
}

/**
 * Clear the session's history + caches. Exposed for tests so they can
 * verify behaviour without going through `safeExecute`.
 */
export async function clearSession(session: Session): Promise<void> {
  if (hasActiveTurn(session)) {
    throw new Error(
      "Cannot clear right now: a turn is currently in flight; wait for it to complete before running /clear.",
    );
  }
  const clearable = session as unknown as ClearableSessionShape;
  if (typeof clearable.clearDaemonSession === "function") {
    await clearable.clearDaemonSession();
  } else if (typeof clearable.state?.with === "function") {
    await clearable.state.with((s) => {
      if (Array.isArray(s.history)) {
        // Replace the history array in place so any cached ref the caller
        // holds sees the same object but emptied. The session's history is
        // declared as `unknown[]` — mutate by length.
        s.history.length = 0;
      }
    });
  }

  clearSystemPromptSections();

  // Clearing conversation history must also sever provider continuation
  // ids; otherwise the next Responses turn can be sent with an orphaned
  // previous_response_id that no longer matches the local transcript.
  if (typeof clearable.clearProviderResponseId === "function") {
    clearable.clearProviderResponseId();
  }

  // Reset sidecars if present on services (e.g. memory/cost).
  const svc = asRecord(clearable.services) ?? {};
  for (const key of [
    "memorySidecar",
    "costSidecar",
    "memory",
    "cost",
  ]) {
    if (svc[key]) maybeReset(svc[key]);
  }

  // Session-level approvals are explicitly scoped to the current chat
  // and must not survive `/clear`.
  callServiceMethod(svc.toolApprovals, "clear");
  callServiceMethod(svc.networkApproval, "clearSessionHosts");

  // Budget tracker has no `reset()` but exposes sampling-gate reset.
  callServiceMethod(clearable.budgetTracker, "resetSamplingGate");

  // T11 W4: reset permission denial tracking in place so the evaluator
  // continues to observe a single shared reference across turns.
  const denialTracking = asRecord(clearable.denialTracking);
  if (denialTracking !== null) {
    Object.assign(denialTracking, freshDenialTracking());
  }
}

function clearSessionPublishesHistoryCleared(session: Session): boolean {
  return typeof (session as unknown as ClearableSessionShape)
    .clearDaemonSession === "function";
}

function emitHistoryCleared(session: Session): void {
  try {
    (session as unknown as ClearableSessionShape).emitPhaseEvent?.({
      type: "history_cleared",
      timestamp: Date.now(),
    });
  } catch {
    // Transcript notification is best-effort; the clear itself already succeeded.
  }
}

export const clearCommand: SlashCommand = {
  name: "clear",
  aliases: ["reset", "new"],
  description: "Clear session history and caches",
  immediate: true,
  supportsNonInteractive: false,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      if (hasActiveTurn(ctx.session)) {
        return {
          kind: "error",
          message:
            "Cannot clear right now: a turn is currently in flight; wait for it to complete before running /clear.",
        };
      }
      await clearSession(ctx.session);
      if (!clearSessionPublishesHistoryCleared(ctx.session)) {
        emitHistoryCleared(ctx.session);
      }
      return { kind: "text", text: "Session cleared." };
    }),
};
