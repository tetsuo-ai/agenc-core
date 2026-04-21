/**
 * `/clear` — clear session conversation history + runtime caches.
 *
 * Clears the in-memory history array inside `SessionState`, evicts the
 * system-prompt section cache (so subsequent turns rebuild from the
 * current cwd), and resets any memory/cost sidecar counters that
 * expose a `reset()` hook.
 *
 * Aliases: `/reset`, `/new`.
 *
 * @module
 */

import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { clearSystemPromptSections } from "../prompts/sections.js";
import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

interface ResettableSidecar {
  reset?: () => void;
}

/** Best-effort reset of any sidecar instance that exposes `reset()`. */
function maybeReset(cand: unknown): boolean {
  if (
    cand &&
    typeof cand === "object" &&
    "reset" in (cand as object) &&
    typeof (cand as ResettableSidecar).reset === "function"
  ) {
    (cand as ResettableSidecar).reset!();
    return true;
  }
  return false;
}

/**
 * Clear the session's history + caches. Exposed for tests so they can
 * verify behaviour without going through `safeExecute`.
 */
export async function clearSession(session: Session): Promise<void> {
  await session.state.with((s) => {
    // Replace the history array in place so any cached ref the caller
    // holds sees the same object but emptied. The session's history is
    // declared as `unknown[]` — mutate by length.
    (s.history as unknown[]).length = 0;
  });

  clearSystemPromptSections();

  // Reset sidecars if present on services (e.g. memory/cost).
  const svc = session.services as unknown as Record<string, unknown>;
  for (const key of [
    "memorySidecar",
    "costSidecar",
    "memory",
    "cost",
  ]) {
    if (svc[key]) maybeReset(svc[key]);
  }

  if (
    svc["toolApprovals"] &&
    typeof (svc["toolApprovals"] as { clear?: () => void }).clear === "function"
  ) {
    (svc["toolApprovals"] as { clear: () => void }).clear();
  }
  if (
    svc["networkApproval"] &&
    typeof (
      svc["networkApproval"] as { clearSessionHosts?: () => void }
    ).clearSessionHosts === "function"
  ) {
    (svc["networkApproval"] as { clearSessionHosts: () => void })
      .clearSessionHosts();
  }

  // Budget tracker has no `reset()` but exposes sampling-gate reset.
  if (session.budgetTracker) {
    session.budgetTracker.resetSamplingGate?.();
  }

  // T11 W4: reset permission denial tracking in place so the evaluator
  // continues to observe a single shared reference across turns.
  if (session.denialTracking) {
    Object.assign(session.denialTracking, freshDenialTracking());
  }
}

export const clearCommand: SlashCommand = {
  name: "clear",
  aliases: ["reset", "new"],
  description: "Clear session history and caches",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      await clearSession(ctx.session);
      return { kind: "text", text: "Session cleared." };
    }),
};

export default clearCommand;
