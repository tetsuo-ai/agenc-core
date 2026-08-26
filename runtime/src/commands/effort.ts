/**
 * /effort — show or set the reasoning effort level for the current model.
 *
 * Levels are validated against the current model's catalog capabilities
 * (grok-4.3/4.5 accept low/medium/high via xAI reasoning_effort); `default`
 * clears the explicit
 * choice so the level follows the model default again.
 */

import {
  convertEffortValueToLevel,
  getAvailableEffortLevelsForContext,
  getDefaultEffortForModelForContext,
  getDisplayedEffortLevelForContext,
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

export const effortCommand: SlashCommand = {
  name: "effort",
  description: "Show or set reasoning effort (low/medium/high)",
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

      if (arg === "") {
        if (!modelSupportsEffortForContext(model, providerAuthContext)) {
          return {
            kind: "text",
            text: `${model} does not support effort levels.`,
          };
        }
        const displayed = getDisplayedEffortLevelForContext(
          model,
          currentEffortValue(ctx) as never,
          providerAuthContext,
        );
        const persisted = reasoningEffortToEffortLevel(
          getSettingsForSource("userSettings")?.reasoning_effort,
        );
        const levels = getAvailableEffortLevelsForContext(
          model,
          providerAuthContext,
        ).join("/");
        const source =
          persisted !== undefined
            ? "saved"
            : currentEffortValue(ctx) !== undefined
              ? "session"
              : "model default";
        return {
          kind: "text",
          text: [
            `${effortLevelToSymbol(displayed)} ${displayed} effort (${source})`,
            `Available for ${model}: ${levels}`,
            `Use /effort <level> to change it, /effort default to follow the model default.`,
          ].join("\n"),
        };
      }

      if (!modelSupportsEffortForContext(model, providerAuthContext)) {
        return {
          kind: "error",
          message: `${model} does not support effort levels.`,
        };
      }

      if (arg === "default" || arg === "auto" || arg === "unset") {
        await updateSettingsForSource("userSettings", {
          reasoning_effort: undefined,
        });
        ctx.appState?.setAppState?.((prev: unknown) => ({
          ...(prev as Record<string, unknown>),
          effortValue: undefined,
        }));
        return {
          kind: "text",
          text: `Effort reset — ${model} now uses its default (${getDefaultEffortForModelForContext(model, providerAuthContext)}).`,
        };
      }

      const available = getAvailableEffortLevelsForContext(
        model,
        providerAuthContext,
      );
      if (!isAvailableEffortLevel(arg)) {
        const levels = available.join(", ");
        return {
          kind: "error",
          message: `Usage: /effort <${levels}> — or /effort default.`,
        };
      }
      const level: AvailableEffortLevel = arg;
      if (!(available as readonly string[]).includes(level)) {
        return {
          kind: "error",
          message: `${model} does not support '${level}' effort. Available: ${available.join(", ")}.`,
        };
      }

      await updateSettingsForSource("userSettings", {
        reasoning_effort: effortValueToReasoningEffort(level),
      });
      ctx.appState?.setAppState?.((prev: unknown) => ({
        ...(prev as Record<string, unknown>),
        effortValue: level,
      }));
      return {
        kind: "text",
        text: `${effortLevelToSymbol(level)} ${convertEffortValueToLevel(level)} effort set for ${model}.`,
      };
    }),
};
