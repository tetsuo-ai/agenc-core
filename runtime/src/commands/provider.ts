/**
 * `/provider <name>` — switch the LLM provider for subsequent turns
 * (T11 Wave 2, Agent W2-E).
 *
 * Same semantics as `/model`: enforces I-13 (mid-stream abort + pending
 * switch marker) and I-57 (history compatibility check, stubbed until
 * T13 wires the real provider capability registry).
 *
 * Why provider + model are staged together on `pendingProviderSwitch`:
 * the run-turn loop consumes both atomically at top-of-loop per I-13
 * so a provider-only swap keeps whatever model was previously selected
 * (and vice-versa for `/model`). The `/config profile <name>` path
 * staged by W2 populates the optional `profile` slot for the same
 * reason.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  checkModelHistoryCompat,
  type HistoryCompatResult,
} from "./model.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/**
 * Re-export so callers that only pull in `provider.ts` can still reach
 * the I-57 stub without a second import. Kept as a direct re-export
 * rather than a wrapper so T13's real impl remains a one-liner change.
 */
export { checkModelHistoryCompat };
export type { HistoryCompatResult };

/**
 * Shared helper: stage a pending provider switch and, when a turn is
 * active, abort it so the loop can re-enter with the new provider.
 */
export async function applyProviderSwitch(
  session: Session,
  targetProvider: string,
): Promise<string> {
  // Resolve the currently-active model so we can stage a complete
  // `pendingProviderSwitch` record. The model slot is required by the
  // I-13 consumer even when only provider is changing — the run-turn
  // loop applies both fields atomically.
  const rawState = session.state.unsafePeek() as {
    sessionConfiguration?: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
    };
  };
  const currentProvider =
    rawState?.sessionConfiguration?.provider?.slug ?? "unknown";
  const currentModel =
    rawState?.sessionConfiguration?.collaborationMode?.model ?? "unknown";

  // I-57: the stub checks compatibility against the currently-selected
  // model because the model is what carries capability requirements.
  // T13 will expand this to a provider × model pairing check.
  const compat = checkModelHistoryCompat(session, currentModel, {
    targetProvider,
  });
  if (!compat.compatible) {
    return `Provider switch to "${targetProvider}" blocked: ${
      compat.reason ?? "history incompatible with target provider"
    }`;
  }

  // T11 W3-A: use the typed mutator so the I-13 + I-57 staging site
  // has a single well-typed entry point.
  session.setPendingProviderSwitch({
    provider: targetProvider,
    model: currentModel,
  });

  const activeTurn = session.activeTurn.unsafePeek();
  if (activeTurn !== null) {
    // I-13: abort the current turn with reason `provider_switched`.
    session.abortTerminal("provider_switched");
    return (
      `Provider switch staged: ${currentProvider} → ${targetProvider}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  if (
    typeof (
      session as Session & {
        consumePendingProviderSwitch?: () => Promise<void>;
      }
    ).consumePendingProviderSwitch === "function"
  ) {
    await (
      session as Session & {
        consumePendingProviderSwitch: () => Promise<void>;
      }
    ).consumePendingProviderSwitch();
  }

  return `Provider switched to "${targetProvider}" (was "${currentProvider}").`;
}

export const providerCommand: SlashCommand = {
  name: "provider",
  description: "Switch the LLM provider for subsequent turns",
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const target = ctx.argsRaw.trim();
      if (target.length === 0) {
        return {
          kind: "error",
          message: "Usage: /provider <name>",
        };
      }
      const summary = await applyProviderSwitch(ctx.session, target);
      return { kind: "text", text: summary };
    }),
};

export default providerCommand;
