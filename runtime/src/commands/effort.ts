/**
 * /effort — show or set the reasoning effort level for the current model.
 *
 * The spinner already advertises "◐ <level> · /effort" during thinking, but
 * the command itself did not exist — the only way to change effort was the
 * ModelPicker's ←/→ cycling. This closes that gap. Levels are validated
 * against the current model's catalog capabilities (grok-4.3/4.5 accept
 * low/medium/high via xAI reasoning_effort); `default` clears the explicit
 * choice so the level follows the model default again.
 */

import {
  convertEffortValueToLevel,
  getAvailableEffortLevels,
  getDefaultEffortForModel,
  getDisplayedEffortLevel,
  isEffortLevel,
  modelSupportsEffort,
  type EffortLevel,
} from "../utils/effort.js";
import { getMainLoopModel } from "../utils/model/model.js";
import { readSessionSelection } from "./model.js";
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
      // settings.json `model` (what getMainLoopModel reads) can diverge
      // from what the daemon session actually runs (e.g. grok-4.5 from the
      // provider switch), and effort support must be judged against the
      // model that will receive the parameter.
      const sessionModel = readSessionSelection(ctx.session).model;
      const model =
        sessionModel !== "unknown" ? sessionModel : getMainLoopModel();
      const arg = ctx.argsRaw.trim().toLowerCase();

      if (arg === "") {
        if (!modelSupportsEffort(model)) {
          return {
            kind: "text",
            text: `${model} does not support effort levels.`,
          };
        }
        const displayed = getDisplayedEffortLevel(
          model,
          currentEffortValue(ctx) as never,
        );
        const persisted = getSettingsForSource("userSettings")?.effortLevel;
        const levels = getAvailableEffortLevels(model).join("/");
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

      if (!modelSupportsEffort(model)) {
        return {
          kind: "error",
          message: `${model} does not support effort levels.`,
        };
      }

      if (arg === "default" || arg === "auto" || arg === "unset") {
        updateSettingsForSource("userSettings", {
          effortLevel: undefined,
        });
        ctx.appState?.setAppState?.((prev: unknown) => ({
          ...(prev as Record<string, unknown>),
          effortValue: undefined,
        }));
        return {
          kind: "text",
          text: `Effort reset — ${model} now uses its default (${getDefaultEffortForModel(model)}).`,
        };
      }

      if (!isEffortLevel(arg)) {
        const levels = getAvailableEffortLevels(model).join(", ");
        return {
          kind: "error",
          message: `Usage: /effort <${levels}> — or /effort default.`,
        };
      }
      const level: EffortLevel = arg;
      const available = getAvailableEffortLevels(model);
      if (!(available as readonly string[]).includes(level)) {
        return {
          kind: "error",
          message: `${model} does not support '${level}' effort. Available: ${available.join(", ")}.`,
        };
      }

      updateSettingsForSource("userSettings", { effortLevel: level });
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
