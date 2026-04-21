/**
 * `/model <model-name>` — switch the model for subsequent turns.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import { resolveProviderModelCapabilities } from "../llm/capabilities.js";
import {
  prepareProviderSwitch,
  type PreparedProviderSwitch,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
import {
  analyzeSessionHistoryRequirements,
  validateHistoryCompatibility,
} from "../llm/shape-request.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface HistoryCompatResult {
  readonly compatible: boolean;
  readonly reason?: string;
  readonly missingCapabilities?: readonly string[];
}

/**
 * Validate whether the target provider/model pairing can carry the
 * session's existing history and collaboration-mode requirements.
 */
export function checkModelHistoryCompat(
  session: Session,
  targetModel: string,
  opts?: { readonly targetProvider?: string },
): HistoryCompatResult {
  const rawState = session.state.unsafePeek() as {
    sessionConfiguration?: {
      provider?: { slug?: string };
    };
    history?: unknown[];
  };
  const targetProvider =
    opts?.targetProvider ??
    rawState?.sessionConfiguration?.provider?.slug ??
    "unknown";
  const caps = resolveProviderModelCapabilities({
    provider: targetProvider,
    model: targetModel,
  });
  const compat = validateHistoryCompatibility(
    caps,
    analyzeSessionHistoryRequirements(rawState),
  );
  return compat.compatible
    ? { compatible: true }
    : {
      compatible: false,
      reason: compat.reason,
      missingCapabilities: compat.missingCapabilities,
    };
}

/**
 * Shared helper: stage a pending model switch and, when a turn is
 * active, abort it so the loop can re-enter with the new model. Returns
 * a human-readable summary string for the caller to wrap in a `text`
 * result.
 */
export async function applyModelSwitch(
  session: Session,
  targetModel: string,
): Promise<string> {
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
    "";
  const currentModel =
    liveProviderOptions?.model ??
    rawState?.sessionConfiguration?.collaborationMode?.model ??
    "unknown";
  let preparedSwitch: PreparedProviderSwitch;
  try {
    preparedSwitch = prepareProviderSwitch(currentProvider, {
      ...(liveProviderOptions ?? {}),
      model: targetModel,
      tools: session.services.registry.toLLMTools(),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : `failed to configure provider "${currentProvider || "unknown"}"`;
    return `Model switch to "${targetModel}" blocked: ${message}`;
  }

  const compat = checkModelHistoryCompat(session, preparedSwitch.model, {
    targetProvider: preparedSwitch.provider,
  });
  if (!compat.compatible) {
    return `Model switch to "${preparedSwitch.model}" blocked: ${
      compat.reason ?? "history incompatible with target model"
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
      `Model switch staged: ${currentModel} → ${preparedSwitch.model}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  const applied = await session.consumePendingProviderSwitch();
  if (!applied.applied) {
    return `Model switch to "${preparedSwitch.model}" blocked: ${
      applied.reason ?? "provider rebuild failed"
    }`;
  }

  return `Model switched to "${applied.model}" (was "${currentModel}").`;
}

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Switch the model for subsequent turns",
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const target = ctx.argsRaw.trim();
      if (target.length === 0) {
        return {
          kind: "error",
          message: "Usage: /model <model-name>",
        };
      }
      const summary = await applyModelSwitch(ctx.session, target);
      return { kind: "text", text: summary };
    }),
};

export default modelCommand;
