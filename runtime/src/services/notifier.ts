/**
 * Source-aligned with `src/services/notifier.ts` at donor commit
 * 0ca43335375beec6e58711b797d5b0c4bb5019b8.
 *
 * Shape differences:
 *   - AgenC receives config and hook execution from the caller instead of
 *     importing process-global donor services.
 *   - Apple Terminal profile inspection uses a tiny local parser for the
 *     specific Bell setting instead of adding an eager plist dependency.
 */

import { logForDebugging } from "../utils/debug.js";
import { runCommand } from "../utils/process.js";

export type TerminalNotification = {
  readonly notifyITerm2: (opts: { readonly message: string; readonly title?: string }) => void;
  readonly notifyKitty: (
    opts: { readonly message: string; readonly title: string; readonly id: number },
  ) => void;
  readonly notifyGhostty: (opts: { readonly message: string; readonly title: string }) => void;
  readonly notifyBell: () => void;
  readonly progress?: (state: string | null, percentage?: number) => void;
};

export type NotificationChannel =
  | "auto"
  | "iterm2"
  | "iterm2_with_bell"
  | "kitty"
  | "ghostty"
  | "terminal_bell"
  | "notifications_disabled"
  | (string & {});

export type NotificationOptions = {
  readonly message: string;
  readonly title?: string;
  readonly notificationType: string;
};

export type NotificationHooks = (
  notification: NotificationOptions,
) => void | Promise<void>;

export type ExecFileNoThrow = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;

export interface NotificationRuntime {
  readonly preferredChannel?: NotificationChannel;
  readonly terminalName?: string;
  readonly executeNotificationHooks?: NotificationHooks;
  readonly execFileNoThrow?: ExecFileNoThrow;
  readonly generateKittyId?: () => number;
  readonly logError?: (error: unknown) => void;
}

const DEFAULT_TITLE = "AgenC";

export async function sendNotification(
  notification: NotificationOptions,
  terminal: TerminalNotification,
  runtime: NotificationRuntime = {},
): Promise<void> {
  const channel = runtime.preferredChannel ?? "auto";

  await runtime.executeNotificationHooks?.(notification);

  await sendToChannel(channel, notification, terminal, runtime);
}

export async function sendToChannel(
  channel: NotificationChannel,
  opts: NotificationOptions,
  terminal: TerminalNotification,
  runtime: NotificationRuntime = {},
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE;

  try {
    switch (channel) {
      case "auto":
        return sendAuto(opts, terminal, runtime);
      case "iterm2":
        terminal.notifyITerm2(opts);
        return "iterm2";
      case "iterm2_with_bell":
        terminal.notifyITerm2(opts);
        terminal.notifyBell();
        return "iterm2_with_bell";
      case "kitty":
        terminal.notifyKitty({
          ...opts,
          title,
          id: generateKittyId(runtime),
        });
        return "kitty";
      case "ghostty":
        terminal.notifyGhostty({ ...opts, title });
        return "ghostty";
      case "terminal_bell":
        terminal.notifyBell();
        return "terminal_bell";
      case "notifications_disabled":
        return "disabled";
      default:
        return "none";
    }
  } catch {
    return "error";
  }
}

async function sendAuto(
  opts: NotificationOptions,
  terminal: TerminalNotification,
  runtime: NotificationRuntime,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE;
  const terminalName = resolveTerminalName(runtime);

  switch (terminalName) {
    case "Apple_Terminal": {
      const bellDisabled = await isAppleTerminalBellDisabled(runtime);
      if (bellDisabled) {
        terminal.notifyBell();
        return "terminal_bell";
      }
      return "no_method_available";
    }
    case "iTerm.app":
      terminal.notifyITerm2(opts);
      return "iterm2";
    case "kitty":
      terminal.notifyKitty({ ...opts, title, id: generateKittyId(runtime) });
      return "kitty";
    case "ghostty":
      terminal.notifyGhostty({ ...opts, title });
      return "ghostty";
    default:
      return "no_method_available";
  }
}

export function generateKittyId(runtime: NotificationRuntime = {}): number {
  return runtime.generateKittyId?.() ?? Math.floor(Math.random() * 10_000);
}

export async function isAppleTerminalBellDisabled(
  runtime: NotificationRuntime = {},
): Promise<boolean> {
  try {
    if (resolveTerminalName(runtime) !== "Apple_Terminal") {
      return false;
    }

    const execFileNoThrow = runtime.execFileNoThrow ?? defaultExecFileNoThrow;
    const profileResult = await execFileNoThrow("osascript", [
      "-e",
      'tell application "Terminal" to name of current settings of front window',
    ]);
    const currentProfile = profileResult.stdout.trim();
    if (!currentProfile) {
      return false;
    }

    const defaultsOutput = await execFileNoThrow("defaults", [
      "export",
      "com.apple.Terminal",
      "-",
    ]);
    if (defaultsOutput.code !== 0) {
      return false;
    }

    return parseAppleTerminalBellDisabled(
      defaultsOutput.stdout,
      currentProfile,
    );
  } catch (error) {
    if (runtime.logError) {
      runtime.logError(error);
    } else {
      logForDebugging(`notification profile inspection failed: ${String(error)}`);
    }
    return false;
  }
}

export function parseAppleTerminalBellDisabled(
  defaultsPlist: string,
  profileName: string,
): boolean {
  const windowSettingsBody = extractDictBodyAfterKey(
    defaultsPlist,
    /<key>Window Settings<\/key>/u,
  );
  if (!windowSettingsBody) {
    return false;
  }

  const profileKey = escapeRegExp(escapeXmlText(profileName));
  const profileBody = extractDictBodyAfterKey(
    windowSettingsBody,
    new RegExp(`<key>${profileKey}</key>`, "u"),
  );
  if (!profileBody) {
    return false;
  }
  return /<key>Bell<\/key>\s*<false\s*\/>/u.test(profileBody);
}

function resolveTerminalName(runtime: NotificationRuntime): string {
  return runtime.terminalName ?? process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown";
}

async function defaultExecFileNoThrow(
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }> {
  const result = await runCommand(command, [...args], {
    cwd: process.cwd(),
    maxBuffer: 512 * 1024,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.exitCode,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractDictBodyAfterKey(
  plist: string,
  keyPattern: RegExp,
): string | null {
  const keyMatch = keyPattern.exec(plist);
  if (!keyMatch || keyMatch.index === undefined) {
    return null;
  }
  const searchStart = keyMatch.index + keyMatch[0].length;
  const firstDictIndex = plist.indexOf("<dict>", searchStart);
  if (firstDictIndex < 0) {
    return null;
  }

  const tokenPattern = /<dict>|<\/dict>/gu;
  tokenPattern.lastIndex = firstDictIndex;
  let depth = 0;
  let bodyStart = -1;
  for (let match = tokenPattern.exec(plist); match; match = tokenPattern.exec(plist)) {
    if (match[0] === "<dict>") {
      depth += 1;
      if (bodyStart < 0) {
        bodyStart = tokenPattern.lastIndex;
      }
      continue;
    }
    depth -= 1;
    if (depth === 0 && bodyStart >= 0) {
      return plist.slice(bodyStart, match.index);
    }
  }
  return null;
}
