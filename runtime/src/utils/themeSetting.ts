/**
 * The saved color theme: `tui.theme` in the user's config.toml.
 *
 * What each theme is for, how a typed name is read, and the single writer
 * that /theme, its picker and first-run setup all use. The list of themes
 * itself stays `TUI_THEME_SETTINGS` in config/schema.ts. These are color
 * themes only: the lean agent mode started with `--light` is an unrelated
 * setting and never reads or writes this one.
 */

import {
  defaultConfig,
  TUI_THEME_SETTINGS,
  type AgenCConfig,
} from "../config/schema.js";
import type { CanonicalSettingsAuthority } from "./settings/canonicalAuthority.js";
import { updateSettingsForSource } from "./settings/settings.js";
import type { ThemeSetting } from "./theme.js";

/** What each theme is for, shown next to its name in pickers. */
const THEME_SETTING_NOTES: Readonly<Record<ThemeSetting, string>> = {
  auto: "olive on dark terminals, light on light ones",
  dark: "black and purple, for dark terminals",
  light: "for light terminals",
  "light-daltonized": "color-blind friendly, light",
  "dark-daltonized": "color-blind friendly, dark",
  "light-ansi": "your terminal's 16 colors, light",
  "dark-ansi": "your terminal's 16 colors, dark",
  olive: "olive, cream and wine, for dark terminals",
};

/** The note for one theme, marking the one that is saved now. */
export function themeSettingNote(
  setting: ThemeSetting,
  current?: ThemeSetting,
): string {
  const note = THEME_SETTING_NOTES[setting];
  return setting === current ? `${note} (current)` : note;
}

/** A typed theme name (any case, surrounding spaces ignored), or undefined. */
export function parseThemeSetting(input: string): ThemeSetting | undefined {
  const name = input.trim().toLowerCase();
  return TUI_THEME_SETTINGS.find((setting) => setting === name);
}

/** The theme a fresh install shows: the built-in `tui.theme` default. */
export function defaultThemeSetting(): ThemeSetting {
  return defaultConfig().tui?.theme ?? "dark";
}

/**
 * The theme a config snapshot asks for. The effective config always carries
 * the built-in default; `fallback` covers partial snapshots in tests and
 * tools that have no defaults applied.
 */
export function themeSettingFromConfig(
  config: Pick<AgenCConfig, "tui"> | null | undefined,
  fallback: ThemeSetting,
): ThemeSetting {
  return config?.tui?.theme ?? fallback;
}

/**
 * Save a theme to `tui.theme` in the user's config.toml and reload the
 * store, so every view following it (the TUI's ThemeProvider, /config)
 * shows the new theme. A project, managed or command-line layer that sets
 * its own theme still wins in the effective config.
 */
export async function saveThemeSetting(
  setting: ThemeSetting,
  authority: CanonicalSettingsAuthority | null,
): Promise<{ readonly error: Error | null }> {
  if (authority === null) {
    return { error: new Error("No settings store is open, so the theme cannot be saved.") };
  }
  return updateSettingsForSource(
    "userSettings",
    { tui: { theme: setting } },
    authority,
  );
}
