/**
 * `/model <model-name>` — switch the model for subsequent turns
 * (T11 Wave 2, Agent W2-E).
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
 *     staging the switch, we run `checkModelHistoryCompat(...)`. Today
 *     this is a stub that always returns `{ compatible: true }`; the
 *     T13 capability registry will replace it with a real comparison of
 *     required capabilities (vision, function-calling shape, etc.) of
 *     pending tool calls and history items against the target model.
 *
 * Session field access: this command reads `session.activeTurn` (an
 * AsyncLock<ActiveTurn | null> already declared on Session) and stages
 * the pending marker on `session.pendingProviderSwitch` (already
 * declared on Session for I-13). When the real ModelsManager/provider
 * capability registry lands (T13), `checkModelHistoryCompat` becomes a
 * call into that surface.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import { resolveProviderModelCapabilities } from "../llm/capabilities.js";
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

/**
 * Result of the I-57 history-compatibility check. A future T13 wire
 * will add `missingCapabilities: string[]` and `incompatibleHistoryIds`
 * so callers can render actionable messages; today the stub never
 * produces them.
 */
export interface HistoryCompatResult {
  readonly compatible: boolean;
  readonly reason?: string;
  readonly missingCapabilities?: readonly string[];
}

/**
 * I-57 stub — always returns compatible. The T13 provider-capability
 * registry will compare the required capabilities (vision,
 * function-calling shape, structured-output, server-side search, etc.)
 * of pending tool calls and history items against the target model's
 * declared capability matrix.
 *
 * @remarks
 * Keep the signature stable so T13 can drop in the real implementation
 * without touching callers. The session parameter is accepted up front
 * so the real impl can peek history/tool-call items without a second
 * round of refactoring.
 */
// TODO T13: wire real provider capability registry
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
  const compat = checkModelHistoryCompat(session, targetModel);
  if (!compat.compatible) {
    // T13 lands the real reason surface. For now the stub never fails,
    // but the code path is wired so future callers get a useful error.
    return `Model switch to "${targetModel}" blocked: ${
      compat.reason ?? "history incompatible with target model"
    }`;
  }

  // Resolve the currently-active provider slug so we can stage a
  // complete `pendingProviderSwitch` record (the turn loop consumes
  // both provider + model atomically per I-13).
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

  // T11 W3-A: use the typed mutator so the I-13 + I-57 staging site
  // has a single well-typed entry point.
  session.setPendingProviderSwitch({
    provider: currentProvider,
    model: targetModel,
  });

  // Peek the active-turn lock without taking it — safe for an immediate
  // command because we only branch on "is there a turn" and the session
  // mutex on `activeTurn` serializes actual clearing elsewhere.
  const activeTurn = session.activeTurn.unsafePeek();
  if (activeTurn !== null) {
    // I-13: abort the current turn with reason `provider_switched`.
    // The turn loop sees `signal.reason === "provider_switched"` and
    // re-enters with the new model instead of routing to terminal.
    session.abortTerminal("provider_switched");
    return (
      `Model switch staged: ${currentModel} → ${targetModel}. ` +
      `Current turn aborted; the switch takes effect on the next turn.`
    );
  }

  if (
    typeof (
      session as Session & {
        consumePendingProviderSwitch?: () => Promise<void>;
      }
    ).consumePendingProviderSwitch === "function"
  ) {
    await (
      session as Session & {
        consumePendingProviderSwitch: () => Promise<void>;
      }
    ).consumePendingProviderSwitch();
  }

  return `Model switched to "${targetModel}" (was "${currentModel}").`;
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
