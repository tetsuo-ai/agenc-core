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
