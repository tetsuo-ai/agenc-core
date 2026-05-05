/**
 * `/provider <name>` — switch the LLM provider for subsequent turns.
 *
 * Same semantics as `/model`: enforces I-13 (mid-stream abort + pending
 * switch marker) and I-57 (history compatibility check using the live
 * provider capability registry).
 *
 * Why provider + model are staged together on `pendingProviderSwitch`:
 * the run-turn loop consumes both atomically at top-of-loop per I-13
 * so a provider-only swap keeps whatever model was previously selected
 * (and vice-versa for `/model`). The `/config profile <name>` path
 * populates the optional `profile` slot for the same reason.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import { configuredModelForProvider, defaultModelForProvider } from "../config/resolve-model.js";
import { normalizeProviderName } from "../llm/provider.js";
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
 * the I-57 implementation without a second import.
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
  targetModel?: string,
): Promise<string> {
  const normalizedProvider = normalizeProviderName(targetProvider);
  if (normalizedProvider === null) {
    return `Provider switch to "${targetProvider}" blocked: unknown provider`;
  }

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
  const config = session.services.configStore?.current();
  const resolvedModel =
    targetModel?.trim() ||
    (config
      ? configuredModelForProvider(config, normalizedProvider)
      : undefined) ||
    defaultModelForProvider(normalizedProvider);

  const compat = checkModelHistoryCompat(
    session,
    resolvedModel,
    normalizedProvider,
  );
  if (!compat.compatible) {
    return `Provider switch to "${targetProvider}" blocked: ${
      compat.reason ?? "history incompatible with target provider"
    }`;
  }

  // Use the typed mutator so the I-13 + I-57 staging site has a single
  // well-typed entry point.
  session.setPendingProviderSwitch({
    provider: normalizedProvider,
    model: resolvedModel,
  });

  const activeTurn = session.activeTurn.unsafePeek();
  if (activeTurn !== null) {
    // I-13: abort the current turn with reason `provider_switched`.
    session.abortTerminal("provider_switched");
    return (
      `Provider switch staged: ${currentProvider} → ${normalizedProvider}; ` +
      `model ${currentModel} → ${resolvedModel}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  return (
    `Provider switched to "${normalizedProvider}" (was "${currentProvider}"); ` +
    `model "${resolvedModel}" selected.`
  );
}

export const providerCommand: SlashCommand = {
  name: "model-provider",
  aliases: ["provider"],
  description: "Switch the LLM provider for subsequent turns",
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const trimmed = ctx.argsRaw.trim();
      if (trimmed.length === 0) {
        return {
          kind: "error",
          message: "Usage: /model-provider <provider> [model]",
        };
      }
      const [targetProvider = "", ...modelParts] = trimmed.split(/\s+/);
      const targetModel =
        modelParts.length > 0 ? modelParts.join(" ").trim() : undefined;
      const summary = await applyProviderSwitch(
        ctx.session,
        targetProvider,
        targetModel,
      );
      return { kind: "text", text: summary };
    }),
};

export default providerCommand;
