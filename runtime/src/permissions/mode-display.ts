import type { PermissionMode } from "./types.js";

type PermissionModeDisplayColor =
  | "text"
  | "planMode"
  | "permission"
  | "autoAccept"
  | "error"
  | "warning";

type PermissionModeDisplay = {
  readonly title: string;
  readonly shortTitle: string;
  readonly symbol: PermissionModeDisplaySymbol;
  readonly color: PermissionModeDisplayColor;
};

type PermissionModeDisplaySymbol = {
  readonly unicode: string;
  readonly ascii: string;
};

type PermissionModeSymbolEnv = {
  readonly AGENC_TUI_GLYPHS?: string;
};

function symbol(unicode: string, ascii: string): PermissionModeDisplaySymbol {
  return { unicode, ascii };
}

const PERMISSION_MODE_DISPLAY = Object.freeze({
  default: {
    title: "Default",
    shortTitle: "Default",
    symbol: symbol("", ""),
    color: "text",
  },
  plan: {
    title: "Plan Mode",
    shortTitle: "Plan",
    symbol: symbol("⏸", "||"),
    color: "planMode",
  },
  acceptEdits: {
    title: "Accept edits",
    shortTitle: "Accept",
    symbol: symbol("⏵⏵", ">>"),
    color: "autoAccept",
  },
  bypassPermissions: {
    title: "Bypass Permissions",
    shortTitle: "Bypass",
    symbol: symbol("⏵⏵", ">>"),
    color: "error",
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: "DontAsk",
    symbol: symbol("⏵⏵", ">>"),
    color: "error",
  },
  auto: {
    title: "Auto mode",
    shortTitle: "Auto",
    symbol: symbol("⏵⏵", ">>"),
    color: "warning",
  },
  unattended: {
    title: "Unattended",
    shortTitle: "Unattended",
    symbol: symbol("⏵", ">"),
    color: "warning",
  },
  bubble: {
    title: "Bubble",
    shortTitle: "Bubble",
    symbol: symbol("", ""),
    color: "text",
  },
} satisfies Record<PermissionMode, PermissionModeDisplay>);

function displayFor(mode: PermissionMode): PermissionModeDisplay {
  return PERMISSION_MODE_DISPLAY[mode];
}

export function permissionModeTitle(mode: PermissionMode): string {
  return displayFor(mode).title;
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  return displayFor(mode).shortTitle;
}

export function permissionModeSymbol(
  mode: PermissionMode,
  env: PermissionModeSymbolEnv = process.env,
): string {
  const modeSymbol = displayFor(mode).symbol;
  return env.AGENC_TUI_GLYPHS === "ascii"
    ? modeSymbol.ascii
    : modeSymbol.unicode;
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === "default" || mode === undefined;
}

/**
 * Plain words for a permission mode, shared by the status line, the
 * Shift+Tab switcher and the /permissions panel so all three read the same.
 * Command and config names (default, acceptEdits, ...) do not change.
 */
const PERMISSION_MODE_PLAIN: Record<PermissionMode, { readonly label: string; readonly description: string }> = {
  default: { label: "asks first", description: "Asks before it edits files or runs commands." },
  acceptEdits: { label: "edits freely", description: "Edits without asking. Asks before commands." },
  plan: { label: "plan only", description: "Reads and plans. Changes nothing." },
  bypassPermissions: { label: "never asks", description: "Never asks for approval. Use with care." },
  dontAsk: { label: "rules only", description: "Runs only what your rules allow. Denies the rest." },
  auto: { label: "auto approve", description: "A safety check decides instead of asking you." },
  unattended: { label: "unattended", description: "Runs as a background agent." },
  bubble: { label: "nested", description: "Passes approvals up to the parent agent." },
};

export function permissionModePlainLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_PLAIN[mode]?.label ?? permissionModeShortTitle(mode).toLowerCase();
}

export function permissionModePlainDescription(mode: PermissionMode): string {
  return PERMISSION_MODE_PLAIN[mode]?.description ?? "";
}
