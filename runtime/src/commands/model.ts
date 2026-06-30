/**
 * `/model <model-name>` — switch the model for subsequent turns.
 *
 * Enforces two runtime invariants:
 *
 *   I-13 (mid-stream provider/model switch): if a turn is currently in
 *     flight (`session.activeTurn` non-null), we stage the switch as a
 *     pending marker on the session and abort the current turn with
 *     reason `provider_switched`. The turn loop observes the pending
 *     marker at top-of-loop and applies the switch before the next turn.
 *
 *   I-57 (history compatibility on provider/model switch): before
 *     staging the switch, we run `checkModelHistoryCompat(...)` using
 *     the live provider capability registry and the same history-requirement
 *     scan the provider request shaper uses.
 *
 * Session field access: this command reads `session.activeTurn` (an
 * AsyncLock<ActiveTurn | null> already declared on Session) and stages
 * the pending marker on `session.pendingProviderSwitch` (already
 * declared on Session for I-13). `checkModelHistoryCompat` reads the
 * live provider capability registry before staging the switch.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import {
  buildProviderModelCatalog,
  normalizeProviderSlug,
  readProviderConfig,
  resolveProviderSettings,
  type ProviderSlug,
} from "../config/resolve-provider.js";
import { resolveDisambiguatedModelSelection } from "../config/resolve-model.js";
import { resolveProviderCapabilityEntry } from "../llm/capabilities.js";
import { normalizeProviderName } from "../llm/provider.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import {
  analyzeSessionHistoryRequirements,
  validateHistoryCompatibility,
} from "../llm/shape-request.js";
import { readCommandConfig } from "./config-context.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  modelMenuFallback,
  openModelMenu,
  readModelMenuSnapshot,
} from "./model-menu.js";
import {
  isSubscriptionManagedModel,
  providerHasLiveSubscriptionRoute,
  subscriptionManagedModels,
} from "./subscription-managed-models.js";

export interface HistoryCompatResult {
  readonly compatible: boolean;
  readonly missingCapabilities?: readonly string[];
  readonly reason?: string;
}

type SessionSelection = {
  readonly provider: string;
  readonly model: string;
};

export function readSessionSelection(session: Session): SessionSelection {
  const peekStateForApply = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const rawState = (typeof peekStateForApply === "function"
    ? (peekStateForApply.call((session as unknown as { state?: unknown }).state) as {
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
  const sc = rawState?.sessionConfiguration ?? directConfig;
  return {
    provider: sc?.provider?.slug ?? "unknown",
    model: sc?.collaborationMode?.model ?? "unknown",
  };
}

export function checkModelHistoryCompat(
  session: Session,
  targetModel: string,
  targetProvider?: string,
): HistoryCompatResult {
  // Bridge sessions (TUI client → daemon) don't expose `state`; degrade
  // to "history compatible" when no snapshot is reachable so the model
  // switch path doesn't crash with `Cannot read properties of undefined
  // (reading 'unsafePeek')`. The daemon-side turn loop performs its own
  // capability check before consuming the pending switch.
  const peekState = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const snapshot = (typeof peekState === "function"
    ? (peekState.call((session as unknown as { state?: unknown }).state) as {
        history?: unknown[];
        sessionConfiguration?: {
          provider?: { slug?: string };
          collaborationMode?: { reasoningEffort?: string };
        };
      })
    : null);
  if (snapshot === null) {
    return { compatible: true };
  }
  const provider =
    targetProvider ??
    snapshot.sessionConfiguration?.provider?.slug ??
    "unknown";
  const config = session.services.configStore?.current();
  const overrides =
    config !== undefined
      ? readProviderConfig(config, provider)?.capability_overrides
      : undefined;
  const caps = resolveProviderCapabilityEntry({
    provider,
    model: targetModel,
    overrides,
  });
  const requirements = analyzeSessionHistoryRequirements(snapshot);
  return validateHistoryCompatibility(caps, requirements);
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
  targetProvider?: string,
): Promise<string> {
  const current = readSessionSelection(session);
  const normalizedTargetProvider =
    targetProvider === undefined ? undefined : normalizeProviderName(targetProvider);
  if (targetProvider !== undefined && normalizedTargetProvider === null) {
    return `Model switch to "${targetModel}" blocked: unknown provider "${targetProvider}"`;
  }
  const switchProvider = normalizedTargetProvider ?? current.provider;
  const compat = checkModelHistoryCompat(session, targetModel, switchProvider);
  if (!compat.compatible) {
    return `Model switch to "${targetModel}" blocked: ${
      compat.reason ?? "history incompatible with target model"
    }`;
  }

  // Bridge sessions (TUI client → daemon) declare both
  // setPendingProviderSwitch and abortTerminal as optional
  // (tui/session-types.ts:122,138). Guard the calls so /model on a
  // bridge session fails with a clear message instead of leaking
  // `Error: session.setPendingProviderSwitch is not a function`
  // (the round-2 regression).
  const sessionShim = session as unknown as {
    setPendingProviderSwitch?: (spec: {
      provider: string;
      model: string;
    }) => void;
    abortTerminal?: (reason: string) => void;
  };
  if (typeof sessionShim.setPendingProviderSwitch !== "function") {
    return (
      "Model switching from the TUI is not yet supported when running " +
      "against the daemon. Set `model` in config.toml or use " +
      "`agenc config set model <name>`."
    );
  }
  // Use the typed mutator so the I-13 + I-57 staging site has a single
  // well-typed entry point.
  sessionShim.setPendingProviderSwitch({
    provider: switchProvider,
    model: targetModel,
  });

  // Peek the active-turn lock without taking it — safe for an immediate
  // command because we only branch on "is there a turn" and the session
  // mutex on `activeTurn` serializes actual clearing elsewhere.
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
    // The turn loop sees `signal.reason === "provider_switched"` and
    // re-enters with the new model instead of routing to terminal.
    if (typeof sessionShim.abortTerminal === "function") {
      sessionShim.abortTerminal("provider_switched");
    }
    return (
      `Model switch staged: ${current.provider}/${current.model} → ` +
      `${switchProvider}/${targetModel}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  return (
    `Model switched to "${targetModel}" on "${switchProvider}" ` +
    `(was "${current.provider}/${current.model}").`
  );
}

function modelSwitchApplied(summary: string): boolean {
  return (
    summary.startsWith("Model switched ") ||
    summary.startsWith("Model switch staged:")
  );
}

function resolveCommandSelection(
  ctx: SlashCommandContext,
  target: string,
): { readonly provider?: ProviderSlug; readonly model: string; readonly error?: string } {
  const config = readCommandConfig(ctx);
  const currentProvider =
    normalizeProviderSlug(readSessionSelection(ctx.session).provider) ??
    normalizeProviderSlug(config?.model_provider);
  const catalog = buildProviderModelCatalog(config);
  const explicitSeparator = target.indexOf(":");
  if (explicitSeparator > 0) {
    const provider = normalizeProviderSlug(target.slice(0, explicitSeparator));
    if (provider !== undefined) {
      try {
        const resolved = resolveDisambiguatedModelSelection({ slug: target, config, catalog });
        return {
          provider,
          model: resolved.model,
        };
      } catch {
        const model = target.slice(explicitSeparator + 1);
        if (isSubscriptionManagedModel(provider, model)) {
          return {
            provider,
            model,
          };
        }
        return {
          provider,
          model,
          error: `Model switch blocked: ${target} is not in the ${provider} catalog.`,
        };
      }
    }
  }

  try {
    const resolved = resolveDisambiguatedModelSelection({ slug: target, config, catalog });
    const provider = normalizeProviderSlug(resolved.provider);
    if (provider === undefined) return { model: resolved.model };
    if (currentProvider !== undefined && provider === currentProvider) {
      return { model: resolved.model };
    }
    return { provider, model: resolved.model };
  } catch {
    return { model: target };
  }
}

function modelSwitchAuthError(
  ctx: SlashCommandContext,
  targetProvider: string | undefined,
): string | undefined {
  const provider =
    normalizeProviderSlug(targetProvider) ??
    normalizeProviderSlug(readSessionSelection(ctx.session).provider);
  if (provider === undefined) return undefined;
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const info = resolveBuiltInProviderInfo(provider);
  if (info?.apiKeyEnvVar === undefined) return undefined;
  const apiKey = resolveProviderSettings(provider, config, process.env)?.apiKey;
  if (apiKey !== undefined && apiKey.trim().length > 0) return undefined;
  if (providerHasLiveSubscriptionRoute(provider)) return undefined;
  return (
    `Model switch blocked: subscription-managed access is currently live for ` +
    `grok only. Set ${info.apiKeyEnvVar} for BYOK, or run /model grok:grok-4.3.`
  );
}

function subscriptionManagedModelError(
  ctx: SlashCommandContext,
  targetProvider: string | undefined,
  targetModel: string,
): string | undefined {
  const provider =
    normalizeProviderSlug(targetProvider) ??
    normalizeProviderSlug(readSessionSelection(ctx.session).provider);
  if (provider === undefined) return undefined;
  const config = readCommandConfig(ctx);
  if (config?.auth?.managedKeys?.enabled !== true) return undefined;
  const info = resolveBuiltInProviderInfo(provider);
  if (info?.apiKeyEnvVar === undefined) return undefined;
  const apiKey = resolveProviderSettings(provider, config, process.env)?.apiKey;
  if (apiKey !== undefined && apiKey.trim().length > 0) return undefined;
  if (!providerHasLiveSubscriptionRoute(provider)) return undefined;
  if (isSubscriptionManagedModel(provider, targetModel)) return undefined;
  const liveModels = subscriptionManagedModels(provider)
    .map((model) => `/model ${provider}:${model}`)
    .join(" or ");
  return (
    `Model "${targetModel}" is not enabled for subscription-managed ` +
    `${provider}. Use ${liveModels}.`
  );
}

function updateModelChrome(
  ctx: SlashCommandContext,
  model: string,
  providerChanged: boolean,
): void {
  if (providerChanged && typeof ctx.appState?.setAppState === "function") {
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

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Switch the model — opens a picker (or pass a model name)",
  supportedSurfaces: ["runtime", "daemon-tui"],
  userInvocable: true,
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const target = ctx.argsRaw.trim();
      if (target.length === 0) {
        const snapshot = readModelMenuSnapshot(ctx);
        if (
          openModelMenu(ctx, snapshot, async (provider, model) => {
            const targetProvider =
              provider === snapshot.provider ? undefined : provider;
            const authError = modelSwitchAuthError(ctx, provider);
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
            const summary = await applyModelSwitch(
              ctx.session,
              model,
              targetProvider,
            );
            if (modelSwitchApplied(summary)) {
              updateModelChrome(ctx, model, targetProvider !== undefined);
            }
            return {
              message: summary,
              shouldClose: modelSwitchApplied(summary),
            };
          })
        ) {
          return { kind: "skip" };
        }
        return { kind: "text", text: modelMenuFallback(snapshot) };
      }
      const selection = resolveCommandSelection(ctx, target);
      if (selection.error !== undefined) {
        return { kind: "text", text: selection.error };
      }
      const authError = modelSwitchAuthError(ctx, selection.provider);
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
      const summary = await applyModelSwitch(
        ctx.session,
        selection.model,
        selection.provider,
      );
      // Write through to the React-side store synchronously so the status
      // bar reflects the new model on the next render rather than waiting
      // for `consumePendingProviderSwitch` on the next user turn.
      // Cosmetic-only; the authoritative state still converges through the
      // turn loop.
      if (modelSwitchApplied(summary)) {
        updateModelChrome(ctx, selection.model, selection.provider !== undefined);
      }
      return { kind: "text", text: summary };
    }),
};
