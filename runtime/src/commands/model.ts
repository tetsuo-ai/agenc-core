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
  hasOpaqueAudioReference,
  readAudioPayload,
} from "../llm/wire/shared.js";
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

interface PersistedAudioHistoryAssessment {
  hasReplayableAudio: boolean;
  hasOpaqueAudioReferences: boolean;
}

function assessPersistedAudioHistory(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  assessment: PersistedAudioHistoryAssessment = {
    hasReplayableAudio: false,
    hasOpaqueAudioReferences: false,
  },
): PersistedAudioHistoryAssessment {
  if (value === null || value === undefined) {
    return assessment;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assessPersistedAudioHistory(item, seen, assessment);
    }
    return assessment;
  }
  if (typeof value !== "object") {
    return assessment;
  }
  if (seen.has(value)) {
    return assessment;
  }
  seen.add(value);

  if (readAudioPayload(value)) {
    assessment.hasReplayableAudio = true;
  } else if (hasOpaqueAudioReference(value)) {
    assessment.hasOpaqueAudioReferences = true;
  }

  for (const nested of Object.values(value)) {
    assessPersistedAudioHistory(nested, seen, assessment);
  }
  return assessment;
}

function buildCompatibilityReason(
  targetProvider: string,
  targetModel: string,
  missingCapabilities: readonly string[],
): string {
  return `${targetProvider || "target provider"} / ${targetModel || "target model"} ` +
    `cannot satisfy this session's ${missingCapabilities.join(", ")} requirements`;
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
  const sessionConfig = (session as unknown as {
    config?: {
      providers?: Record<
        string,
        { capability_overrides?: Parameters<typeof resolveProviderModelCapabilities>[0]["overrides"] }
      >;
    };
  }).config;
  const targetProvider =
    opts?.targetProvider ??
    rawState?.sessionConfiguration?.provider?.slug ??
    "unknown";
  const caps = resolveProviderModelCapabilities({
    provider: targetProvider,
    model: targetModel,
    overrides:
      sessionConfig?.providers?.[targetProvider]?.capability_overrides,
  });
  const compat = validateHistoryCompatibility(
    caps,
    analyzeSessionHistoryRequirements(rawState),
  );
  if (
    !compat.compatible &&
    compat.missingCapabilities.includes("audio history") &&
    caps.supportsAudioInput
  ) {
    const audioHistory = assessPersistedAudioHistory(rawState?.history ?? []);
    if (audioHistory.hasOpaqueAudioReferences) {
      return {
        compatible: false,
        missingCapabilities: compat.missingCapabilities,
        reason:
          `${caps.provider || "target provider"} / ${caps.model || "target model"} ` +
          "cannot replay this session's persisted audio history references",
      };
    }
    if (audioHistory.hasReplayableAudio) {
      const remainingMissing = compat.missingCapabilities.filter(
        (capability) => capability !== "audio history",
      );
      if (remainingMissing.length === 0) {
        return { compatible: true };
      }
      return {
        compatible: false,
        missingCapabilities: remainingMissing,
        reason: buildCompatibilityReason(
          caps.provider,
          caps.model,
          remainingMissing,
        ),
      };
    }
  }
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
