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
import { readProviderConfig } from "../config/resolve-provider.js";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import { resolveProviderCapabilityEntry } from "../llm/capabilities.js";
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
  formatSessionSelectionError,
  readSessionSelection,
  resolveSessionProviderModelSelection,
} from "../session/provider-model-selection.js";
import type { ProviderModelSelectionOutcome } from "../contracts/provider-model-selection.js";
import {
  createProviderCommandAccessOverlay,
  formatProviderCommandRejection,
} from "./provider-command-access.js";

export interface HistoryCompatResult {
  readonly compatible: boolean;
  readonly missingCapabilities?: readonly string[];
  readonly reason?: string;
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
  const peekState = (
    session as unknown as {
      state?: { unsafePeek?: () => unknown };
    }
  ).state?.unsafePeek;
  const snapshot =
    typeof peekState === "function"
      ? (peekState.call((session as unknown as { state?: unknown }).state) as {
          history?: unknown[];
          sessionConfiguration?: {
            collaborationMode?: { reasoningEffort?: string };
          };
        })
      : null;
  if (snapshot === null) {
    return { compatible: true };
  }
  const provider =
    targetProvider ??
    readSessionSelection(session, { includePending: true }).provider;
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
 * the authoritative outcome for the caller to surface and project.
 */
export async function applyModelSwitch(
  session: Session,
  targetModel: string,
  targetProvider?: string,
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
        ...(targetProvider === undefined
          ? {}
          : { model_provider: targetProvider }),
        model: targetModel,
      },
      { includePending: true },
    );
  } catch (error) {
    const message = formatSessionSelectionError(error);
    return {
      applied: false,
      provider: current.provider,
      model: current.model,
      summary: `Model switch to "${targetModel}" blocked: ${message}`,
    };
  }
  if (
    selection.provider === current.provider &&
    selection.model === current.model
  ) {
    return {
      applied: false,
      provider: current.provider,
      model: current.model,
      summary: `Model unchanged: ${current.provider}/${current.model}.`,
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
      summary: `Model switch to "${targetModel}" blocked: ${
        compat.reason ?? "history incompatible with target model"
      }`,
    };
  }

  // Bridge sessions (TUI client → daemon) declare both
  // setPendingProviderSwitch and abortTerminal as optional
  // (tui/session-types.ts:122,138). Guard the calls so /model on a
  // bridge session fails with a clear message instead of leaking
  // `Error: session.setPendingProviderSwitch is not a function`
  // (the round-2 regression).
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
        "Model switching is not supported by this session. Set `model` " +
        "in config.toml or use `agenc config set model <name>`.",
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

  // Peek the active-turn lock without taking it — safe for an immediate
  // command because we only branch on "is there a turn" and the session
  // mutex on `activeTurn` serializes actual clearing elsewhere.
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
    // The turn loop sees `signal.reason === "provider_switched"` and
    // re-enters with the new model instead of routing to terminal.
    if (typeof sessionShim.abortTerminal === "function") {
      sessionShim.abortTerminal("provider_switched");
    }
    return {
      applied: true,
      provider: selection.provider,
      model: selection.model,
      summary:
        `Model switch staged: ${current.provider}/${current.model} → ` +
        `${selection.provider}/${selection.model}. ` +
        "Current turn aborted; the switch takes effect on the next turn.",
    };
  }

  return {
    applied: true,
    provider: selection.provider,
    model: selection.model,
    summary:
      `Model switched to "${selection.model}" on "${selection.provider}" ` +
      `(was "${current.provider}/${current.model}").`,
  };
}

function resolveCommandSelection(
  ctx: SlashCommandContext,
  request: {
    readonly model_provider?: string;
    readonly model: string;
  },
):
  | {
      readonly ok: true;
      readonly provider: ProviderSlug;
      readonly model: string;
      readonly providerChanged: boolean;
    }
  | { readonly ok: false; readonly error: string } {
  try {
    const config = readCommandConfig(ctx);
    const resolved = resolveSessionProviderModelSelection(
      ctx.session,
      request,
      {
        includePending: true,
        ...(config === undefined ? {} : { fallbackConfig: config }),
      },
    );
    return {
      ok: true,
      provider: resolved.provider,
      model: resolved.model,
      providerChanged: resolved.providerChanged,
    };
  } catch (error) {
    const message = formatSessionSelectionError(error);
    return { ok: false, error: `Model switch blocked: ${message}` };
  }
}

function updateModelChrome(ctx: SlashCommandContext, model: string): void {
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
            const selection = resolveCommandSelection(ctx, {
              model_provider: provider,
              model,
            });
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
            const rejection = formatProviderCommandRejection(access, "model");
            if (rejection !== undefined) {
              return {
                message: rejection,
                shouldClose: false,
              };
            }
            if (access.effect === "unchanged") {
              return {
                message: `Model unchanged: ${selection.provider}/${selection.model}.`,
                shouldClose: true,
              };
            }
            const outcome = await applyModelSwitch(
              ctx.session,
              selection.model,
              selection.provider,
            );
            if (outcome.applied) {
              updateModelChrome(ctx, outcome.model);
            }
            return {
              message: outcome.summary,
              shouldClose: outcome.applied,
            };
          })
        ) {
          return { kind: "skip" };
        }
        return { kind: "text", text: modelMenuFallback(snapshot) };
      }
      const selection = resolveCommandSelection(ctx, { model: target });
      if (!selection.ok) {
        return { kind: "text", text: selection.error };
      }
      const access = createProviderCommandAccessOverlay(ctx).inspect({
        provider: selection.provider,
        model: selection.model,
      });
      const rejection = formatProviderCommandRejection(access, "model");
      if (rejection !== undefined) {
        return { kind: "text", text: rejection };
      }
      if (access.effect === "unchanged") {
        return {
          kind: "text",
          text: `Model unchanged: ${selection.provider}/${selection.model}.`,
        };
      }
      const outcome = await applyModelSwitch(
        ctx.session,
        selection.model,
        selection.provider,
      );
      // Write through to the React-side store synchronously so the status
      // bar reflects the new model on the next render rather than waiting
      // for `consumePendingProviderSwitch` on the next user turn.
      // Cosmetic-only; the authoritative state still converges through the
      // turn loop.
      if (outcome.applied) {
        updateModelChrome(ctx, outcome.model);
      }
      return { kind: "text", text: outcome.summary };
    }),
};
