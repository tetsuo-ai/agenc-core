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
import type { ProviderSlug } from "../config/provider-model-authority.js";
import { checkModelHistoryCompat, type HistoryCompatResult } from "./model.js";
import type { ProviderModelSelectionOutcome } from "../contracts/provider-model-selection.js";
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
  formatSessionSelectionError,
  readSessionSelection,
  resolveSessionProviderModelSelection,
} from "../session/provider-model-selection.js";
import {
  createProviderCommandAccessOverlay,
  formatProviderCommandRejection,
} from "./provider-command-access.js";

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
    readonly stage?: (selection: {
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
  if (
    selection.provider === currentProvider &&
    selection.model === currentModel
  ) {
    return {
      applied: false,
      provider: currentProvider,
      model: currentModel,
      summary: `Provider unchanged: ${currentProvider}/${currentModel}.`,
    };
  }
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

  const stagedSelection = {
    provider: selection.provider,
    model: selection.model,
  };
  if (options.stage !== undefined) {
    await options.stage(stagedSelection);
  } else {
    await options.beforeStage?.(stagedSelection);

    // Use the typed mutator so the I-13 + I-57 staging site has a single
    // well-typed entry point.
    sessionShim.setPendingProviderSwitch(stagedSelection);
  }

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

function updateProviderChrome(ctx: SlashCommandContext, model: string): void {
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
            const access = createProviderCommandAccessOverlay(ctx).inspect({
              provider: selection.provider,
              model: selection.model,
            });
            const rejection = formatProviderCommandRejection(
              access,
              "provider",
            );
            if (rejection !== undefined) {
              return {
                message: rejection,
                shouldClose: false,
              };
            }
            if (access.effect === "unchanged") {
              return {
                message: `Provider unchanged: ${selection.provider}/${selection.model}.`,
                shouldClose: true,
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
      let selection = resolveProviderCommandSelection(
        ctx,
        targetProvider,
        targetModel,
      );
      if (!selection.ok) {
        return { kind: "text", text: selection.error };
      }
      const accessOverlay = createProviderCommandAccessOverlay(ctx);
      let access = accessOverlay.inspect({
        provider: selection.provider,
        model: selection.model,
      });
      if (
        targetModel === undefined &&
        access.effect !== "unchanged" &&
        access.directCredential?.status === "missing" &&
        access.managed.defaultModel !== undefined
      ) {
        selection = resolveProviderCommandSelection(
          ctx,
          targetProvider,
          access.managed.defaultModel,
        );
        if (!selection.ok) {
          return { kind: "text", text: selection.error };
        }
        access = accessOverlay.inspect({
          provider: selection.provider,
          model: selection.model,
        });
      }
      const rejection = formatProviderCommandRejection(access, "provider");
      if (rejection !== undefined) {
        return { kind: "text", text: rejection };
      }
      if (access.effect === "unchanged") {
        return {
          kind: "text",
          text: `Provider unchanged: ${selection.provider}/${selection.model}.`,
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
      return { kind: "text", text: outcome.summary };
    }),
};
