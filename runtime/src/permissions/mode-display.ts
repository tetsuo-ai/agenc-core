import type { PermissionMode } from "./types.js";

export type PermissionModeDisplayColor =
  | "text"
  | "planMode"
  | "permission"
  | "autoAccept"
  | "error"
  | "warning";

type PermissionModeDisplay = {
  readonly title: string;
  readonly shortTitle: string;
  readonly symbol: string;
  readonly color: PermissionModeDisplayColor;
};

const PERMISSION_MODE_DISPLAY = Object.freeze({
  default: {
    title: "Default",
    shortTitle: "Default",
    symbol: "",
    color: "text",
  },
  plan: {
    title: "Plan Mode",
    shortTitle: "Plan",
    symbol: "⏸",
    color: "planMode",
  },
  acceptEdits: {
    title: "Accept edits",
    shortTitle: "Accept",
    symbol: "⏵⏵",
    color: "autoAccept",
  },
  bypassPermissions: {
    title: "Bypass Permissions",
    shortTitle: "Bypass",
    symbol: "⏵⏵",
    color: "error",
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: "DontAsk",
    symbol: "⏵⏵",
    color: "error",
  },
  auto: {
    title: "Auto mode",
    shortTitle: "Auto",
    symbol: "⏵⏵",
    color: "warning",
  },
  unattended: {
    title: "Unattended",
    shortTitle: "Unattended",
    symbol: "⏵",
    color: "warning",
  },
  bubble: {
    title: "Bubble",
    shortTitle: "Bubble",
    symbol: "",
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

export function permissionModeSymbol(mode: PermissionMode): string {
  return displayFor(mode).symbol;
}

export function permissionModeDisplayColor(
  mode: PermissionMode,
): PermissionModeDisplayColor {
  return displayFor(mode).color;
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === "default" || mode === undefined;
}
