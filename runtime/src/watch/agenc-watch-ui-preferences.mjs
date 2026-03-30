function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

export const WATCH_INPUT_MODE_PROFILES = Object.freeze([
  "default",
  "vim",
]);

export const WATCH_KEYBINDING_PROFILES = Object.freeze([
  "default",
  "vim",
]);

export const WATCH_THEME_NAMES = Object.freeze([
  "default",
  "aurora",
  "ember",
  "matrix",
]);

export function normalizeWatchInputModeProfile(value, fallback = "default") {
  const normalized = normalizeToken(value);
  if (normalized === "vim") {
    return "vim";
  }
  return WATCH_INPUT_MODE_PROFILES.includes(normalized) ? normalized : fallback;
}

export function normalizeWatchKeybindingProfile(value, fallback = "default") {
  const normalized = normalizeToken(value);
  if (normalized === "vim") {
    return "vim";
  }
  return WATCH_KEYBINDING_PROFILES.includes(normalized) ? normalized : fallback;
}

export function normalizeWatchThemeName(value, fallback = "default") {
  const normalized = normalizeToken(value);
  if (normalized === "sunset") {
    return "ember";
  }
  if (normalized === "cool") {
    return "aurora";
  }
  if (normalized === "green" || normalized === "neo") {
    return "matrix";
  }
  return WATCH_THEME_NAMES.includes(normalized) ? normalized : fallback;
}

export function createWatchUiPreferences(input = {}) {
  const inputModeProfile = normalizeWatchInputModeProfile(
    input.inputModeProfile ?? input.modeProfile,
  );
  const keybindingProfile = normalizeWatchKeybindingProfile(
    input.keybindingProfile,
    inputModeProfile === "vim" ? "vim" : "default",
  );
  return {
    inputModeProfile,
    keybindingProfile,
    themeName: normalizeWatchThemeName(input.themeName),
  };
}

export function serializeWatchUiPreferences(preferences = {}) {
  const normalized = createWatchUiPreferences(preferences);
  return {
    inputModeProfile: normalized.inputModeProfile,
    keybindingProfile: normalized.keybindingProfile,
    themeName: normalized.themeName,
  };
}

export function buildWatchUiPreferencesReport({
  preferences = {},
  composerMode = "insert",
} = {}) {
  const normalized = createWatchUiPreferences(preferences);
  const modeLabel =
    normalized.inputModeProfile === "vim"
      ? `vim (${String(composerMode ?? "insert").trim() || "insert"})`
      : normalized.inputModeProfile;
  return [
    "Watch Input Preferences",
    `Input mode: ${modeLabel}`,
    `Keybindings: ${normalized.keybindingProfile}`,
    `Theme: ${normalized.themeName}`,
    "",
    "Profiles",
    `- Input modes: ${WATCH_INPUT_MODE_PROFILES.join(", ")}`,
    `- Keybindings: ${WATCH_KEYBINDING_PROFILES.join(", ")}`,
    `- Themes: ${WATCH_THEME_NAMES.join(", ")}`,
  ].join("\n");
}

export function buildWatchLocalConfigReport({
  preferences = {},
  composerMode = "insert",
  statuslineEnabled = false,
} = {}) {
  const normalized = createWatchUiPreferences(preferences);
  const modeLabel =
    normalized.inputModeProfile === "vim"
      ? `vim (${String(composerMode ?? "insert").trim() || "insert"})`
      : normalized.inputModeProfile;
  return [
    "Watch Local Config",
    `Input mode: ${modeLabel}`,
    `Keybindings: ${normalized.keybindingProfile}`,
    `Theme: ${normalized.themeName}`,
    `Statusline: ${statuslineEnabled === true ? "on" : "off"}`,
    "",
    "Quick Commands",
    "- /config",
    "- /vim [show|on|off|toggle]",
    "- /input-mode [show|default|vim]",
    "- /keybindings [show|default|vim]",
    "- /theme [show|default|aurora|ember|matrix]",
    "- /statusline [show|on|off|toggle]",
  ].join("\n");
}
