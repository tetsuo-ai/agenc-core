/**
 * `/model-provider <name> [model]` — switch the LLM provider for subsequent turns
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  normalizeProviderName,
  prepareProviderSwitch,
  type PreparedProviderSwitch,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
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
  targetModel?: string,
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
  const liveProvider = (session.services as {
    provider?: Parameters<typeof readProviderFactoryOptions>[0];
  }).provider;
  const liveProviderOptions = liveProvider
    ? readProviderFactoryOptions(liveProvider)
    : undefined;
  const currentProvider =
    readProviderIdentity(
      liveProvider,
      rawState?.sessionConfiguration?.provider?.slug,
    ) ??
    rawState?.sessionConfiguration?.provider?.slug ??
    "unknown";
  const currentModel =
    liveProviderOptions?.model ??
    rawState?.sessionConfiguration?.collaborationMode?.model ??
    "unknown";

  let preparedSwitch: PreparedProviderSwitch;
  try {
    const targetNormalizedProvider = normalizeProviderName(targetProvider);
    const liveProviderIdentity = readProviderIdentity(
      liveProvider,
      rawState?.sessionConfiguration?.provider?.slug,
    );
    const snapshotProviderIdentity = normalizeProviderName(
      rawState?.sessionConfiguration?.provider?.slug,
    );
    const reuseLiveProviderOptions =
      liveProviderOptions &&
      liveProviderIdentity !== null &&
      liveProviderIdentity === targetNormalizedProvider;
    const reuseSnapshotModel =
      !reuseLiveProviderOptions &&
      targetNormalizedProvider !== null &&
      snapshotProviderIdentity === targetNormalizedProvider;
    preparedSwitch = prepareProviderSwitch(targetProvider, {
      ...(reuseLiveProviderOptions ? liveProviderOptions : {}),
      ...(targetModel?.trim()
        ? { model: targetModel.trim() }
        : reuseSnapshotModel
          ? { model: currentModel }
          : {}),
      tools: session.services.registry.toLLMTools(),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : `failed to configure provider "${targetProvider.trim()}"`;
    return `Provider switch to "${targetProvider}" blocked: ${message}`;
  }

  const compat = checkModelHistoryCompat(session, preparedSwitch.model, {
    targetProvider: preparedSwitch.provider,
  });
  if (!compat.compatible) {
    return `Provider switch to "${preparedSwitch.provider}" blocked: ${
      compat.reason ?? "history incompatible with target provider"
    }`;
  }

  session.setPendingProviderSwitch({
    provider: preparedSwitch.provider,
    model: preparedSwitch.model,
  });

  const activeTurn = session.activeTurn.unsafePeek();
  if (activeTurn !== null) {
    session.abortTerminal("provider_switched");
    return (
      `Provider switch staged: ${currentProvider}/${currentModel} -> ` +
      `${preparedSwitch.provider}/${preparedSwitch.model}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  const applied = await session.consumePendingProviderSwitch();
  if (!applied.applied) {
    return `Provider switch to "${preparedSwitch.provider}" blocked: ${
      applied.reason ?? "provider rebuild failed"
    }`;
  }

  return (
    `Provider switched to "${applied.provider}" with model "${applied.model}" ` +
    `(was "${currentProvider}" / "${currentModel}").`
  );
}

export const providerCommand: SlashCommand = {
  name: "model-provider",
  aliases: ["provider"],
  description: "Switch the model provider for subsequent turns",
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const parts = ctx.argsRaw
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.length === 0 || parts.length > 2) {
        return {
          kind: "error",
          message: "Usage: /model-provider <provider> [model]",
        };
      }
      const [targetProvider, targetModel] = parts;
      const summary = await applyProviderSwitch(
        ctx.session,
        targetProvider!,
        targetModel,
      );
      return { kind: "text", text: summary };
    }),
};

export default providerCommand;
