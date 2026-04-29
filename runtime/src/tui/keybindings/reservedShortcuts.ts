export type ReservedShortcut = {
  key: string;
  reason: string;
  severity: "error" | "warning";
};

export const NON_REBINDABLE: ReservedShortcut[] = [
  {
    key: "ctrl+c",
    reason: "Cannot be rebound - used for interrupt/exit",
    severity: "error",
  },
  {
    key: "ctrl+d",
    reason: "Cannot be rebound - used for exit",
    severity: "error",
  },
  {
    key: "ctrl+m",
    reason: "Cannot be rebound - identical to Enter in terminals",
    severity: "error",
  },
];

export const TERMINAL_RESERVED: ReservedShortcut[] = [
  {
    key: "ctrl+z",
    reason: "Unix process suspend (SIGTSTP)",
    severity: "warning",
  },
  {
    key: "ctrl+\\",
    reason: "Terminal quit signal (SIGQUIT)",
    severity: "error",
  },
];

export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: "cmd+c", reason: "macOS system copy", severity: "error" },
  { key: "cmd+v", reason: "macOS system paste", severity: "error" },
  { key: "cmd+x", reason: "macOS system cut", severity: "error" },
  { key: "cmd+q", reason: "macOS quit application", severity: "error" },
  { key: "cmd+w", reason: "macOS close window/tab", severity: "error" },
  { key: "cmd+tab", reason: "macOS app switcher", severity: "error" },
  { key: "cmd+space", reason: "macOS Spotlight", severity: "error" },
];

function currentPlatform(): "macos" | "windows" | "linux" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function getReservedShortcuts(): ReservedShortcut[] {
  const reserved = [...NON_REBINDABLE, ...TERMINAL_RESERVED];
  if (currentPlatform() === "macos") {
    reserved.push(...MACOS_RESERVED);
  }
  return reserved;
}

export function normalizeKeyForComparison(key: string): string {
  return key.trim().split(/\s+/).map(normalizeStep).join(" ");
}

function normalizeStep(step: string): string {
  const parts = step.split("+");
  const modifiers: string[] = [];
  let mainKey = "";

  for (const part of parts) {
    const lower = part.trim().toLowerCase();
    switch (lower) {
      case "control":
        modifiers.push("ctrl");
        break;
      case "option":
      case "opt":
        modifiers.push("alt");
        break;
      case "command":
      case "super":
      case "win":
        modifiers.push("cmd");
        break;
      case "ctrl":
      case "alt":
      case "meta":
      case "cmd":
      case "shift":
        modifiers.push(lower);
        break;
      default:
        mainKey = lower;
        break;
    }
  }

  modifiers.sort();
  return [...modifiers, mainKey].join("+");
}
