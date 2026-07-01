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
import { resolveProviderSettings } from "../config/resolve-provider.js";
import { hasEntitledRemoteAuthSessionSync } from "../auth/session-state.js";
import { configuredModelForProvider, defaultModelForProvider } from "../config/resolve-model.js";
import { normalizeProviderName } from "../llm/provider.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import {
  checkModelHistoryCompat,
  type HistoryCompatResult,
} from "./model.js";
import { readCommandConfig } from "./config-context.js";
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
  isSubscriptionManagedModel,
  providerHasLiveSubscriptionRoute,
  subscriptionManagedDefaultModel,
  subscriptionManagedModels,
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
): Promise<string> {
  const normalizedProvider = normalizeProviderName(targetProvider);
  if (normalizedProvider === null) {
    return `Provider switch to "${targetProvider}" blocked: unknown provider`;
  }

  const peekState = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const rawState = (typeof peekState === "function"
    ? (peekState.call((session as unknown as { state?: unknown }).state) as {
        sessionConfiguration?: {
          provider?: { slug?: string };
          collaborationMode?: { model?: string };
        };
      })
    : null);
  const directConfig = (session as unknown as {
    sessionConfiguration?: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
    };
  }).sessionConfiguration;
  const sessionConfig = rawState?.sessionConfiguration ?? directConfig;
  const currentProvider =
    sessionConfig?.provider?.slug ?? "unknown";
  const currentModel =
    sessionConfig?.collaborationMode?.model ?? "unknown";
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

  const sessionShim = session as unknown as {
    setPendingProviderSwitch?: (spec: {
      provider: string;
      model: string;
    }) => void;
    abortTerminal?: (reason: string) => void;
  };
  if (typeof sessionShim.setPendingProviderSwitch !== "function") {
    return (
      "Provider switching from the TUI is not yet supported when running " +
      "against the daemon. Set `model_provider` in config.toml or use " +
      "`agenc config set model_provider <name>`."
    );
  }

  // Use the typed mutator so the I-13 + I-57 staging site has a single
  // well-typed entry point.
  sessionShim.setPendingProviderSwitch({
    provider: normalizedProvider,
    model: resolvedModel,
  });

  const activeTurnPeek = (session as unknown as {
    activeTurn?: { unsafePeek?: () => unknown };
  }).activeTurn?.unsafePeek;
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

function providerSwitchApplied(summary: string): boolean {
  return (
    summary.startsWith("Provider switched ") ||
    summary.startsWith("Provider switch staged:")
  );
}

function resolveCommandModelForProvider(
  session: Session,
  targetProvider: string,
  targetModel?: string,
): string | undefined {
  const normalizedProvider = normalizeProviderName(targetProvider);
  if (normalizedProvider === null) return undefined;
  const config = session.services.configStore?.current();
  return (
    targetModel?.trim() ||
    (config ? configuredModelForProvider(config, normalizedProvider) : undefined) ||
    defaultModelForProvider(normalizedProvider)
  );
}

function managedDefaultForCommand(
  ctx: SlashCommandContext,
  targetProvider: string,
  targetModel: string | undefined,
): string | undefined {
  if (targetModel !== undefined) return targetModel;
  const normalizedProvider = normalizeProviderName(targetProvider);
  if (normalizedProvider === null) return undefined;
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const settings = resolveProviderSettings(
    normalizedProvider,
    config,
    process.env,
  );
  if (!providerHasLiveSubscriptionRoute(normalizedProvider)) return undefined;
  if (settings?.apiKey !== undefined && settings.apiKey.trim().length > 0) {
    return undefined;
  }
  return subscriptionManagedDefaultModel(normalizedProvider);
}

function subscriptionManagedModelError(
  ctx: SlashCommandContext,
  targetProvider: string,
  targetModel: string | undefined,
): string | undefined {
  if (targetModel === undefined) return undefined;
  const normalizedProvider = normalizeProviderName(targetProvider);
  if (normalizedProvider === null) return undefined;
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const settings = resolveProviderSettings(
    normalizedProvider,
    config,
    process.env,
  );
  if (settings?.apiKey !== undefined && settings.apiKey.trim().length > 0) {
    return undefined;
  }
  if (!providerHasLiveSubscriptionRoute(normalizedProvider)) return undefined;
  if (isSubscriptionManagedModel(normalizedProvider, targetModel)) return undefined;
  const liveModels = subscriptionManagedModels(normalizedProvider)
    .map((model) => `/model ${normalizedProvider}:${model}`)
    .join(" or ");
  return (
    `Model "${targetModel}" is not enabled for subscription-managed ` +
    `${normalizedProvider}. Use ${liveModels}.`
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
  targetProvider: string,
): string | undefined {
  const normalizedProvider = normalizeProviderName(targetProvider);
  if (normalizedProvider === null) return undefined;
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const info = resolveBuiltInProviderInfo(normalizedProvider);
  if (info?.apiKeyEnvVar === undefined) return undefined;
  const settings = resolveProviderSettings(
    normalizedProvider,
    config,
    process.env,
  );
  if (isLocalProviderEndpoint(settings?.baseURL ?? info.baseURL)) return undefined;
  const apiKey = settings?.apiKey;
  if (apiKey !== undefined && apiKey.trim().length > 0) return undefined;
  if (
    providerHasLiveSubscriptionRoute(normalizedProvider) &&
    hasEntitledRemoteAuthSessionSync(process.env)
  ) {
    return undefined;
  }
  if (providerHasLiveSubscriptionRoute(normalizedProvider)) {
    return (
      `Provider switch to "${normalizedProvider}" blocked: sign in with a paid ` +
      `AgenC plan using /login, or set ${info.apiKeyEnvVar} for BYOK.`
    );
  }
  return (
    `Provider switch to "${normalizedProvider}" blocked: ` +
    `hosted subscription access is available through OpenRouter. ` +
    `Run /provider openrouter, or set ${info.apiKeyEnvVar} for BYOK.`
  );
}

function updateProviderChrome(
  ctx: SlashCommandContext,
  model: string | undefined,
): void {
  if (model === undefined) return;
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
            const authError = providerSwitchAuthError(ctx, provider);
            if (authError !== undefined) {
              return {
                message: authError,
                shouldClose: false,
              };
            }
            const modelError = subscriptionManagedModelError(ctx, provider, model);
            if (modelError !== undefined) {
              return {
                message: modelError,
                shouldClose: false,
              };
            }
            const summary = await applyProviderSwitch(ctx.session, provider, model);
            if (providerSwitchApplied(summary)) {
              updateProviderChrome(ctx, model);
            }
            return {
              message: summary,
              shouldClose: providerSwitchApplied(summary),
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
      const authError = providerSwitchAuthError(ctx, targetProvider);
      if (authError !== undefined) {
        return { kind: "text", text: authError };
      }
      const modelError = subscriptionManagedModelError(
        ctx,
        targetProvider,
        effectiveTargetModel,
      );
      if (modelError !== undefined) {
        return { kind: "text", text: modelError };
      }
      const resolvedModel = resolveCommandModelForProvider(
        ctx.session,
        targetProvider,
        effectiveTargetModel,
      );
      const summary = await applyProviderSwitch(
        ctx.session,
        targetProvider,
        effectiveTargetModel,
      );
      if (resolvedModel !== undefined && providerSwitchApplied(summary)) {
        updateProviderChrome(ctx, resolvedModel);
      }
      return { kind: "text", text: summary };
    }),
};
