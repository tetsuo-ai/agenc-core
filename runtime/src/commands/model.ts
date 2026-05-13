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
import { resolveProviderCapabilityEntry } from "../llm/capabilities.js";
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
): Promise<string> {
  const compat = checkModelHistoryCompat(session, targetModel);
  if (!compat.compatible) {
    return `Model switch to "${targetModel}" blocked: ${
      compat.reason ?? "history incompatible with target model"
    }`;
  }

  // Resolve the currently-active provider slug so we can stage a
  // complete `pendingProviderSwitch` record (the turn loop consumes
  // both provider + model atomically per I-13). Bridge sessions don't
  // expose `state`; fall back to the sessionConfiguration carried
  // directly on the session.
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
  const currentProvider = sc?.provider?.slug ?? "unknown";
  const currentModel = sc?.collaborationMode?.model ?? "unknown";

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
    provider: currentProvider,
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
      `Model switch staged: ${currentModel} → ${targetModel}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  return `Model switched to "${targetModel}" (was "${currentModel}").`;
}

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Switch the model for subsequent turns",
  supportedSurfaces: ["runtime"],
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
      // Mirror AgenC's `setAppState({ ...prev, mainLoopModel: model })`
      // (commands/model/model.tsx:59-63): write through to the React-side
      // store synchronously so the status bar reflects the new model on
      // the next render rather than waiting for `consumePendingProviderSwitch`
      // on the next user turn. Cosmetic-only; the authoritative state still
      // converges through the turn loop.
      ctx.appState?.setModel?.(target);
      return { kind: "text", text: summary };
    }),
};

export default modelCommand;
