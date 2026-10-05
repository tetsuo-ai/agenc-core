/**
 * /effort: choose the reasoning effort level for the current model. With
 * no argument it opens a picker of the levels the model supports.
 *
 * Levels are validated against the current model's catalog capabilities
 * (including the exact Meta Muse and Grok model enums); `default`
 * clears the explicit
 * choice so the level follows the model default again.
 */

import {
  convertEffortValueToLevel,
  getAvailableEffortLevelsForContext,
  getDefaultEffortForModelForContext,
  getDisplayedEffortLevelForContext,
  getEffortLevelLabel,
  isAvailableEffortLevel,
  modelSupportsEffortForContext,
  effortValueToReasoningEffort,
  reasoningEffortToEffortLevel,
  type AvailableEffortLevel,
} from "../utils/effort.js";
import { readSessionSelection } from "../session/provider-model-selection.js";
import { remoteAuthContextFromCommandContext } from "./config-context.js";
import {
  getSettingsForSource,
  updateSettingsForSource,
} from "../utils/settings/settings.js";
import { effortLevelToSymbol } from "../tui/components/EffortIndicator.js";
import { asRecord } from "../utils/record.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import type { EffortMenuRow, EffortMenuSnapshot } from "./effort-menu.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
} from "./types.js";

function currentEffortValue(ctx: SlashCommandContext): unknown {
  const state = ctx.appState?.getAppState?.() as
    | { effortValue?: unknown }
    | undefined;
  return state?.effortValue;
}

type ProviderAuthContext = Parameters<typeof getAvailableEffortLevelsForContext>[1];

/**
 * Save the choice as the default for new sessions, mirror it in app state,
 * and apply it to the running daemon session so the next turn already runs
 * at the chosen level.
 */
async function applyEffortChoice(
  ctx: SlashCommandContext,
  model: string,
  providerAuthContext: ProviderAuthContext,
  choice: AvailableEffortLevel | "default",
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const available = getAvailableEffortLevelsForContext(model, providerAuthContext);
  const saved = await updateSettingsForSource("userSettings", {
    reasoning_effort:
      choice === "default"
        ? undefined
        : effortValueToReasoningEffort(choice, available),
  });
  if (saved.error !== null) {
    return { ok: false, message: `Could not save effort: ${saved.error.message}` };
  }
  ctx.appState?.setAppState?.((prev: unknown) => ({
    ...(prev as Record<string, unknown>),
    effortValue: choice === "default" ? undefined : choice,
  }));
  // Apply only the effort to the live session. A full config reload would
  // also re-read model and provider and undo a session-only /model switch.
  // "default" sends the level the model uses when none is set.
  const liveLevel = choice === "default"
    ? getDefaultEffortForModelForContext(model, providerAuthContext)
    : choice;
  const applyDaemonConfig = asRecord(ctx.session)?.applyDaemonConfig;
  if (typeof applyDaemonConfig === "function" && typeof liveLevel === "string") {
    try {
      const result = (await applyDaemonConfig.call(ctx.session, {
        reasoningEffort: effortValueToReasoningEffort(liveLevel as AvailableEffortLevel, available),
      })) as {
        readonly sessionId?: string;
        readonly applied?: boolean;
        readonly summary?: string;
      };
      // Before the first turn there is no live session yet; the saved
      // setting is what the first conversation starts with.
      if (result?.applied === false && result.sessionId !== "pending" && result.summary) {
        return {
          ok: false,
          message: `Saved for new sessions. This session did not take it: ${result.summary}`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        message: `Saved for new sessions. This session did not take it: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (choice === "default") {
    const fallback = getDefaultEffortForModelForContext(model, providerAuthContext);
    return {
      ok: true,
      message: `Effort follows the ${model} default${fallback !== undefined ? ` (${convertEffortValueToLevel(fallback)})` : ""}.`,
    };
  }
  return {
    ok: true,
    message: `${effortLevelToSymbol(choice)} ${convertEffortValueToLevel(choice)} effort for ${model}.`,
  };
}

function effortMenuSnapshot(
  ctx: SlashCommandContext,
  model: string,
  providerAuthContext: ProviderAuthContext,
): EffortMenuSnapshot {
  const levels = getAvailableEffortLevelsForContext(model, providerAuthContext);
  const explicit = currentEffortValue(ctx) ??
    reasoningEffortToEffortLevel(getSettingsForSource("userSettings")?.reasoning_effort);
  const current =
    typeof explicit === "string" && (levels as readonly string[]).includes(explicit)
      ? explicit
      : "default";
  const modelDefault = getDefaultEffortForModelForContext(model, providerAuthContext);
  const rows: EffortMenuRow[] = [
    {
      choice: "default",
      label: "Default",
      detail: modelDefault !== undefined
        ? `follows the model (${convertEffortValueToLevel(modelDefault)})`
        : "follows the model",
      current: current === "default",
    },
    ...levels.map((level): EffortMenuRow => ({
      choice: level,
      label: getEffortLevelLabel(level),
      detail: level === modelDefault ? "model default" : "",
      current: current === level,
    })),
  ];
  const activeIndex = Math.max(0, rows.findIndex(row => row.current));
  return { model, rows, activeIndex };
}

export const effortCommand: SlashCommand = {
  name: "effort",
  description: "Choose the reasoning effort for the current model",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) =>
    safeExecute(async () => {
      // The session's configured model is authoritative: a stale
      // canonical config `model` (what getMainLoopModel reads) can diverge
      // from what the daemon session actually runs (e.g. grok-4.5 from the
      // provider switch), and effort support must be judged against the
      // model that will receive the parameter.
      const sessionSelection = readSessionSelection(ctx.session, {
        includePending: true,
      });
      const sessionModel = sessionSelection.model;
      if (
        sessionSelection.provider === "unknown" ||
        sessionModel === "unknown"
      ) {
        return {
          kind: "error",
          message: "Unable to determine the current session provider and model.",
        };
      }
      const model = sessionModel;
      const providerAuthContext = Object.freeze({
        ...remoteAuthContextFromCommandContext(ctx),
        provider: sessionSelection.provider,
      });
      const arg = ctx.argsRaw.trim().toLowerCase();

      if (!modelSupportsEffortForContext(model, providerAuthContext)) {
        return arg === ""
          ? { kind: "text", text: `${model} does not support effort levels.` }
          : { kind: "error", message: `${model} does not support effort levels.` };
      }

      if (arg === "") {
        const snapshot = effortMenuSnapshot(ctx, model, providerAuthContext);
        if (
          typeof ctx.appState?.setToolJSX === "function" &&
          (await import("./effort-menu.js")).openEffortMenu(ctx, snapshot, async (choice) => {
            // The picker applies from a key press, after the dispatcher's
            // settings scope ended; bind this invocation's store again.
            const apply = () =>
              applyEffortChoice(
                ctx,
                model,
                providerAuthContext,
                choice as AvailableEffortLevel | "default",
              );
            const outcome = ctx.configStore === undefined
              ? await apply()
              : await runWithCanonicalSettingsAuthority(ctx.configStore, apply);
            return { message: outcome.message, shouldClose: outcome.ok };
          })
        ) {
          return { kind: "skip" };
        }
        const displayed = getDisplayedEffortLevelForContext(
          model,
          currentEffortValue(ctx) as never,
          providerAuthContext,
        );
        const levels = getAvailableEffortLevelsForContext(
          model,
          providerAuthContext,
        ).join(", ");
        return {
          kind: "text",
          text: [
            `${effortLevelToSymbol(displayed)} ${displayed} effort`,
            `Available for ${model}: ${levels}`,
            `Use /effort <level> to change it, or /effort default to follow the model.`,
          ].join("\n"),
        };
      }

      if (arg === "default" || arg === "auto" || arg === "unset") {
        const outcome = await applyEffortChoice(ctx, model, providerAuthContext, "default");
        return outcome.ok
          ? { kind: "text", text: outcome.message }
          : { kind: "error", message: outcome.message };
      }

      const available = getAvailableEffortLevelsForContext(
        model,
        providerAuthContext,
      );
      if (!isAvailableEffortLevel(arg)) {
        return {
          kind: "error",
          message: `Usage: /effort <${available.join(", ")}>, or /effort default.`,
        };
      }
      const level: AvailableEffortLevel = arg;
      if (!(available as readonly string[]).includes(level)) {
        return {
          kind: "error",
          message: `${model} does not support '${level}' effort. Available: ${available.join(", ")}.`,
        };
      }
      const outcome = await applyEffortChoice(ctx, model, providerAuthContext, level);
      return outcome.ok
        ? { kind: "text", text: outcome.message }
        : { kind: "error", message: outcome.message };
    }),
};
