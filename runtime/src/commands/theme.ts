/**
 * /theme: choose the TUI color theme.
 *
 * With no argument it opens a picker. Moving the selection previews each
 * theme on the whole screen, Enter saves it and Esc puts back the theme that
 * was showing. `/theme <name>` saves a theme directly. Both save to
 * `tui.theme` in the user's config.toml, the same setting /config shows and
 * first-run setup writes, so the choice holds in new sessions.
 *
 * Color themes only: the lean agent mode started with `--light` is a
 * different setting and this command never touches it.
 */

import type { ConfigLayerSnapshot, ConfigScope } from "../config/repository.js";
import { TUI_THEME_SETTINGS } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import type { ThemeSetting } from "../utils/theme.js";
import {
  defaultThemeSetting,
  parseThemeSetting,
  saveThemeSetting,
  themeSettingFromConfig,
  themeSettingNote,
} from "../utils/themeSetting.js";
import { configStoreFromCommandContext } from "./config-context.js";
import {
  safeExecute,
  type SlashCommand,
} from "./types.js";

interface ThemeChoiceOutcome {
  /** False when the save failed; the message says why. */
  readonly ok: boolean;
  /** False when the theme in effect is not the one chosen. */
  readonly applied: boolean;
  readonly message: string;
}

function validThemeNames(): string {
  return TUI_THEME_SETTINGS.join(", ");
}

const LAYER_NAMES: Readonly<Partial<Record<ConfigScope, string>>> = {
  project: "this project's config",
  local: "this project's local config",
  flag: "the --config file",
  profile: "the active profile",
  environment: "an environment variable",
  cli: "a command-line option",
  managed: "the managed config",
  plugin: "a plugin",
};

function describeLayer(layer: ConfigLayerSnapshot | undefined): string {
  if (layer === undefined) return "another config layer";
  const name = LAYER_NAMES[layer.scope] ?? `the ${layer.scope} config`;
  return layer.path === undefined ? name : `${name} (${layer.path})`;
}

/**
 * Save a theme for this and future sessions, then report the theme now in
 * effect. A project, managed or launch layer that sets its own theme wins
 * over the user's config, and the message names it.
 */
async function applyThemeChoice(
  store: ConfigStore,
  setting: ThemeSetting,
): Promise<ThemeChoiceOutcome> {
  const saved = await saveThemeSetting(setting, store);
  if (saved.error !== null) {
    return {
      ok: false,
      applied: false,
      message: `Could not save the theme: ${saved.error.message}`,
    };
  }
  const { config, layers } = store.authoritySnapshot();
  const effective = themeSettingFromConfig(config, setting);
  if (effective !== setting) {
    const owner = [...layers]
      .reverse()
      .find((layer) => layer.config.tui?.theme !== undefined);
    return {
      ok: true,
      applied: false,
      message: `Saved ${setting} to your config, but ${describeLayer(owner)} sets ${effective}, so ${effective} stays in effect.`,
    };
  }
  return {
    ok: true,
    applied: true,
    message: `Theme set to ${setting} (${themeSettingNote(setting)}).`,
  };
}

/** The plain-text list for surfaces without the picker. */
function describeThemes(current: ThemeSetting): string {
  const width = Math.max(...TUI_THEME_SETTINGS.map((setting) => setting.length)) + 2;
  return [
    `Theme: ${current}`,
    ...TUI_THEME_SETTINGS.map((setting) =>
      `  ${setting.padEnd(width)}${themeSettingNote(setting, current)}`
    ),
    "Use /theme <name> to change it.",
  ].join("\n");
}

export const themeCommand: SlashCommand = {
  name: "theme",
  description: "Choose the color theme (opens a picker)",
  argumentHint: "[name]",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx) =>
    safeExecute(async () => {
      const store = configStoreFromCommandContext(ctx);
      if (store === null) {
        return {
          kind: "error",
          message: "ConfigStore not initialised, so the theme cannot be read or saved.",
        };
      }
      const arg = ctx.argsRaw.trim();
      if (arg === "") {
        if (
          typeof ctx.appState?.setToolJSX === "function" &&
          (await import("./theme-menu.js")).openThemeMenu(ctx, async (setting) => {
            // The picker saves from a key press, after the dispatcher's
            // settings scope ended; bind this invocation's store again.
            const outcome = await runWithCanonicalSettingsAuthority(
              store,
              () => applyThemeChoice(store, setting),
            );
            return outcome.applied
              ? { close: true }
              : { close: false, message: outcome.message };
          })
        ) {
          return { kind: "skip" };
        }
        return {
          kind: "text",
          text: describeThemes(
            themeSettingFromConfig(store.current(), defaultThemeSetting()),
          ),
        };
      }
      const setting = parseThemeSetting(arg);
      if (setting === undefined) {
        return {
          kind: "error",
          message: `Unknown theme "${arg}". Choose one of: ${validThemeNames()}.`,
        };
      }
      const outcome = await applyThemeChoice(store, setting);
      return outcome.ok
        ? { kind: "text", text: outcome.message }
        : { kind: "error", message: outcome.message };
    }),
};
