/**
 * `/provider <name>` — switch the LLM provider for subsequent turns.
 *
 * Same semantics as `/model`: enforces I-13 (mid-stream abort + pending
 * switch marker) and I-57 (history compatibility check using the live
 * provider capability registry).
 *
 * Provider and model are always staged as one canonical pair. Provider-only
 * requests resolve through the configured provider/default model authority
 * before that pair reaches the session.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import { resolveProviderSettings } from "../config/resolve-provider.js";
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
} from "../auth/session-state.js";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import {
  resolveBuiltInProviderInfo,
  resolveBuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import {
  missingProviderCredentialEnvironmentLabel,
} from "../llm/registry/provider-ingress.js";
import {
  checkModelHistoryCompat,
  type HistoryCompatResult,
} from "./model.js";
import type { ProviderModelSelectionOutcome } from "../contracts/provider-model-selection.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  remoteAuthContextFromCommandContext,
} from "./config-context.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  openProviderMenu,
  providerMenuFallback,
  readProviderMenuSnapshot,
} from "./provider-menu.js";
import {
  formatSessionSelectionError,
  readSessionSelection,
  resolveSessionProviderModelSelection,
} from "../session/provider-model-selection.js";
import {
  isFreeSubscriptionManagedModel,
  isSubscriptionManagedModel,
  hasHostedManagedAccess,
  providerHasLiveSubscriptionRoute,
  resolveSubscriptionManagedModelRequest,
  visibleSubscriptionManagedModelsForTier,
} from "./subscription-managed-models.js";

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
  options: {
    readonly beforeStage?: (selection: {
      readonly provider: string;
      readonly model: string;
    }) => Promise<void> | void;
  } = {},
): Promise<ProviderModelSelectionOutcome> {
  const current = readSessionSelection(session);
  let selection;
  try {
    selection = resolveSessionProviderModelSelection(
      session,
      {
        model_provider: targetProvider,
        ...(targetModel === undefined ? {} : { model: targetModel }),
      },
      { includePending: true },
    );
  } catch (error) {
    const message = formatSessionSelectionError(error);
    return {
      applied: false,
      provider: current.provider,
      model: current.model,
      summary: `Provider switch to "${targetProvider}" blocked: ${message}`,
    };
  }

  const currentProvider = current.provider;
  const currentModel = current.model;
  const compat = checkModelHistoryCompat(
    session,
    selection.model,
    selection.provider,
  );
  if (!compat.compatible) {
    return {
      applied: false,
      provider: current.provider,
      model: current.model,
      summary: `Provider switch to "${targetProvider}" blocked: ${
        compat.reason ?? "history incompatible with target provider"
      }`,
    };
  }

  const sessionShim = session as unknown as {
    applyProviderModelSelection?: (spec: {
      provider: string;
      model: string;
    }) => Promise<ProviderModelSelectionOutcome>;
    setPendingProviderSwitch?: (spec: {
      provider: string;
      model: string;
    }) => void;
    abortTerminal?: (reason: string) => void;
  };

  if (typeof sessionShim.applyProviderModelSelection === "function") {
    return sessionShim.applyProviderModelSelection({
      provider: selection.provider,
      model: selection.model,
    });
  }

  if (typeof sessionShim.setPendingProviderSwitch !== "function") {
    return {
      applied: false,
      provider: current.provider,
      model: current.model,
      summary:
        "Provider switching is not supported by this session. Set " +
        "`model_provider` in config.toml or use `agenc config set " +
        "model_provider <name>`.",
    };
  }

  await options.beforeStage?.({
    provider: selection.provider,
    model: selection.model,
  });

  // Use the typed mutator so the I-13 + I-57 staging site has a single
  // well-typed entry point.
  sessionShim.setPendingProviderSwitch({
    provider: selection.provider,
    model: selection.model,
  });

  const activeTurnPeek = (
    session as unknown as {
      activeTurn?: { unsafePeek?: () => unknown };
    }
  ).activeTurn?.unsafePeek;
  const activeTurn =
    typeof activeTurnPeek === "function"
      ? activeTurnPeek.call(
          (session as unknown as { activeTurn?: unknown }).activeTurn,
        )
      : null;
  if (activeTurn !== null) {
    // I-13: abort the current turn with reason `provider_switched`.
    if (typeof sessionShim.abortTerminal === "function") {
      sessionShim.abortTerminal("provider_switched");
    }
    return {
      applied: true,
      provider: selection.provider,
      model: selection.model,
      summary:
        `Provider switch staged: ${currentProvider} → ${selection.provider}; ` +
        `model ${currentModel} → ${selection.model}. ` +
        "Current turn aborted; the switch takes effect on the next turn.",
    };
  }

  return {
    applied: true,
    provider: selection.provider,
    model: selection.model,
    summary:
      `Provider switched to "${selection.provider}" (was "${currentProvider}"); ` +
      `model "${selection.model}" selected.`,
  };
}

function resolveProviderCommandSelection(
  ctx: SlashCommandContext,
  targetProvider: string,
  targetModel?: string,
):
  | {
      readonly ok: true;
      readonly provider: ProviderSlug;
      readonly model: string;
    }
  | { readonly ok: false; readonly error: string } {
  try {
    const config = readCommandConfig(ctx);
    const selection = resolveSessionProviderModelSelection(
      ctx.session,
      {
        model_provider: targetProvider,
        ...(targetModel === undefined ? {} : { model: targetModel }),
      },
      {
        includePending: true,
        ...(config === undefined ? {} : { fallbackConfig: config }),
      },
    );
    return {
      ok: true,
      provider: selection.provider,
      model: selection.model,
    };
  } catch (error) {
    const message = formatSessionSelectionError(error);
    return {
      ok: false,
      error: `Provider switch to "${targetProvider}" blocked: ${message}`,
    };
  }
}

function managedDefaultForCommand(
  ctx: SlashCommandContext,
  targetProvider: string,
  targetModel: string | undefined,
): string | undefined {
  if (targetModel !== undefined) return targetModel;
  const normalizedProvider = resolveBuiltInProviderSlug(targetProvider);
  if (normalizedProvider === undefined) return undefined;
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const settings = resolveProviderSettings(
    normalizedProvider,
    config,
    providerEnvironmentFromCommandContext(ctx),
  );
  const authContext = remoteAuthContextFromCommandContext(ctx);
  return resolveSubscriptionManagedModelRequest({
    provider: normalizedProvider,
    managedAccess: hasHostedManagedAccess(config, authContext),
    ...(settings?.apiKey === undefined
      ? {}
      : { providerApiKey: settings.apiKey }),
    tier: remoteAuthSessionSubscriptionTierSync(authContext),
  });
}

function subscriptionManagedModelError(
  ctx: SlashCommandContext,
  targetProvider: ProviderSlug,
  targetModel: string,
): string | undefined {
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const settings = resolveProviderSettings(
    targetProvider,
    config,
    providerEnvironmentFromCommandContext(ctx),
  );
  if (settings?.apiKey !== undefined && settings.apiKey.trim().length > 0) {
    return undefined;
  }
  if (!providerHasLiveSubscriptionRoute(targetProvider)) return undefined;
  if (isSubscriptionManagedModel(targetProvider, targetModel))
    return undefined;
  const liveModels = visibleSubscriptionManagedModelsForTier(
    targetProvider,
    remoteAuthSessionSubscriptionTierSync(
      remoteAuthContextFromCommandContext(ctx),
    ),
  )
    .map((model) => `/model ${targetProvider}:${model}`)
    .join(" or ");
  return (
    `Model "${targetModel}" is not enabled for subscription-managed ` +
    `${targetProvider}. Use ${liveModels}.`
  );
}

function isLocalProviderEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false;
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function providerSwitchAuthError(
  ctx: SlashCommandContext,
  targetProvider: ProviderSlug,
  targetModel: string,
): string | undefined {
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const info = resolveBuiltInProviderInfo(targetProvider);
  if (info === undefined) return undefined;
  const environment = providerEnvironmentFromCommandContext(ctx);
  const settings = resolveProviderSettings(
    targetProvider,
    config,
    environment,
  );
  const authContext = remoteAuthContextFromCommandContext(ctx);
  if (
    info.onboarding.access !== "environment" &&
    isLocalProviderEndpoint(settings?.baseURL ?? info.baseURL)
  ) {
    return undefined;
  }
  const apiKey = settings?.apiKey;
  if (apiKey !== undefined && apiKey.trim().length > 0) return undefined;
  const missingCredentialLabel = missingProviderCredentialEnvironmentLabel(
    targetProvider,
    environment,
  );
  if (missingCredentialLabel === undefined) return undefined;
  if (
    providerHasLiveSubscriptionRoute(targetProvider) &&
    hasEntitledRemoteAuthSessionSync(authContext)
  ) {
    return undefined;
  }
  if (
    providerHasLiveSubscriptionRoute(targetProvider) &&
    hasRemoteAuthSessionSync(authContext) &&
    isFreeSubscriptionManagedModel(targetProvider, targetModel)
  ) {
    return undefined;
  }
  if (info.onboarding.access === "environment") {
    return (
      `Provider switch to "${targetProvider}" blocked: ` +
      `set ${missingCredentialLabel}.`
    );
  }
  if (providerHasLiveSubscriptionRoute(targetProvider)) {
    return (
      `Provider switch to "${targetProvider}" blocked: sign in with AgenC ` +
      `using /login for free hosted models, upgrade for paid hosted models, ` +
      `or set ${missingCredentialLabel} for BYOK.`
    );
  }
  return (
    `Provider switch to "${targetProvider}" blocked: ` +
    `hosted subscription access is available through OpenRouter. ` +
    `Run /provider openrouter, or set ${missingCredentialLabel} for BYOK.`
  );
}

function updateProviderChrome(
  ctx: SlashCommandContext,
  model: string,
): void {
  if (typeof ctx.appState?.setAppState === "function") {
    ctx.appState.setAppState((prev: unknown): unknown => {
      if (typeof prev !== "object" || prev === null) return prev;
      return {
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: model,
      };
    });
    return;
  }
  ctx.appState?.setModel?.(model);
}

export const providerCommand: SlashCommand = {
  name: "provider",
  description: "Switch the LLM provider for subsequent turns",
  supportedSurfaces: ["runtime", "daemon-tui"],
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const trimmed = ctx.argsRaw.trim();
      if (trimmed.length === 0) {
        const snapshot = readProviderMenuSnapshot(ctx);
        if (
          openProviderMenu(ctx, snapshot, async (provider, model) => {
            const selection = resolveProviderCommandSelection(
              ctx,
              provider,
              model,
            );
            if (!selection.ok) {
              return {
                message: selection.error,
                shouldClose: false,
              };
            }
            const authError = providerSwitchAuthError(
              ctx,
              selection.provider,
              selection.model,
            );
            if (authError !== undefined) {
              return {
                message: authError,
                shouldClose: false,
              };
            }
            const modelError = subscriptionManagedModelError(
              ctx,
              selection.provider,
              selection.model,
            );
            if (modelError !== undefined) {
              return {
                message: modelError,
                shouldClose: false,
              };
            }
            const outcome = await applyProviderSwitch(
              ctx.session,
              selection.provider,
              selection.model,
            );
            if (outcome.applied) {
              updateProviderChrome(ctx, outcome.model);
            }
            return {
              message: outcome.summary,
              shouldClose: outcome.applied,
            };
          })
        ) {
          return { kind: "skip" };
        }
        return { kind: "text", text: providerMenuFallback(snapshot) };
      }
      const [targetProvider = "", ...modelParts] = trimmed.split(/\s+/);
      const targetModel =
        modelParts.length > 0 ? modelParts.join(" ").trim() : undefined;
      const effectiveTargetModel =
        managedDefaultForCommand(ctx, targetProvider, targetModel) ??
        targetModel;
      const selection = resolveProviderCommandSelection(
        ctx,
        targetProvider,
        effectiveTargetModel,
      );
      if (!selection.ok) {
        return { kind: "text", text: selection.error };
      }
      const authError = providerSwitchAuthError(
        ctx,
        selection.provider,
        selection.model,
      );
      if (authError !== undefined) {
        return { kind: "text", text: authError };
      }
      const modelError = subscriptionManagedModelError(
        ctx,
        selection.provider,
        selection.model,
      );
      if (modelError !== undefined) {
        return { kind: "text", text: modelError };
      }
      const outcome = await applyProviderSwitch(
        ctx.session,
        selection.provider,
        selection.model,
      );
      if (outcome.applied) {
        updateProviderChrome(ctx, outcome.model);
      }
      return { kind: "text", text: outcome.summary };
    }),
};
