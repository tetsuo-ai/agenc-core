/**
 * AgenC terminal detection utilities.
 *
 * The detector feeds terminal metadata into user-agent logging and TUI
 * behavior without taking a dependency on UI modules. Donor citations for
 * the source behavior live in `parity/terminal-detection-parity.json`.
 */

import { execFileSync } from "node:child_process";

export const TerminalName = {
  AppleTerminal: "apple-terminal",
  Ghostty: "ghostty",
  Iterm2: "iterm2",
  WarpTerminal: "warp-terminal",
  VsCode: "vscode",
  WezTerm: "wezterm",
  Kitty: "kitty",
  Alacritty: "alacritty",
  Konsole: "konsole",
  GnomeTerminal: "gnome-terminal",
  Vte: "vte",
  WindowsTerminal: "windows-terminal",
  Dumb: "dumb",
  Unknown: "unknown",
} as const;

export type TerminalName =
  (typeof TerminalName)[keyof typeof TerminalName];

export type Multiplexer =
  | { readonly type: "tmux"; readonly version?: string }
  | { readonly type: "zellij" };

export interface TerminalInfo {
  readonly name: TerminalName;
  readonly termProgram?: string;
  readonly version?: string;
  readonly term?: string;
  readonly multiplexer?: Multiplexer;
}

export interface TmuxClientInfo {
  readonly termtype?: string;
  readonly termname?: string;
}

export interface TerminalDetectionEnvironment {
  get(name: string): string | undefined;
  tmuxClientInfo?(): TmuxClientInfo;
}

const processTerminalEnvironment: TerminalDetectionEnvironment = {
  get(name: string): string | undefined {
    return process.env[name];
  },
  tmuxClientInfo,
};

let cachedTerminalInfo: TerminalInfo | undefined;

export function userAgent(): string {
  return terminalUserAgentToken(terminalInfo());
}

export function terminalInfo(): TerminalInfo {
  if (cachedTerminalInfo === undefined) {
    cachedTerminalInfo = detectTerminalInfoFromEnv(processTerminalEnvironment);
  }
  return cloneTerminalInfo(cachedTerminalInfo);
}

export function resetTerminalInfoForTests(): void {
  cachedTerminalInfo = undefined;
}

export function detectTerminalInfoFromEnv(
  env: TerminalDetectionEnvironment = processTerminalEnvironment,
): TerminalInfo {
  const multiplexer = detectMultiplexer(env);
  const termProgram = envVarNonEmpty(env, "TERM_PROGRAM");

  if (termProgram !== undefined) {
    if (
      isTmuxTermProgram(termProgram) &&
      multiplexer?.type === "tmux"
    ) {
      const fromTmux = terminalFromTmuxClientInfo(
        env.tmuxClientInfo?.() ?? {},
        multiplexer,
      );
      if (fromTmux !== undefined) return fromTmux;
    }

    return terminalInfoFromTermProgram(
      terminalNameFromTermProgram(termProgram) ?? TerminalName.Unknown,
      termProgram,
      envVarNonEmpty(env, "TERM_PROGRAM_VERSION"),
      multiplexer,
    );
  }

  if (envHas(env, "WEZTERM_VERSION")) {
    return terminalInfoFromName(
      TerminalName.WezTerm,
      envVarNonEmpty(env, "WEZTERM_VERSION"),
      multiplexer,
    );
  }

  if (
    envHas(env, "ITERM_SESSION_ID") ||
    envHas(env, "ITERM_PROFILE") ||
    envHas(env, "ITERM_PROFILE_NAME")
  ) {
    return terminalInfoFromName(TerminalName.Iterm2, undefined, multiplexer);
  }

  if (envHas(env, "TERM_SESSION_ID")) {
    return terminalInfoFromName(
      TerminalName.AppleTerminal,
      undefined,
      multiplexer,
    );
  }

  const term = readEnv(env, "TERM");
  if (envHas(env, "KITTY_WINDOW_ID") || term?.includes("kitty") === true) {
    return terminalInfoFromName(TerminalName.Kitty, undefined, multiplexer);
  }

  if (envHas(env, "ALACRITTY_SOCKET") || term === "alacritty") {
    return terminalInfoFromName(
      TerminalName.Alacritty,
      undefined,
      multiplexer,
    );
  }

  if (envHas(env, "KONSOLE_VERSION")) {
    return terminalInfoFromName(
      TerminalName.Konsole,
      envVarNonEmpty(env, "KONSOLE_VERSION"),
      multiplexer,
    );
  }

  if (envHas(env, "GNOME_TERMINAL_SCREEN")) {
    return terminalInfoFromName(
      TerminalName.GnomeTerminal,
      undefined,
      multiplexer,
    );
  }

  if (envHas(env, "VTE_VERSION")) {
    return terminalInfoFromName(
      TerminalName.Vte,
      envVarNonEmpty(env, "VTE_VERSION"),
      multiplexer,
    );
  }

  if (envHas(env, "WT_SESSION")) {
    return terminalInfoFromName(
      TerminalName.WindowsTerminal,
      undefined,
      multiplexer,
    );
  }

  const nonEmptyTerm = envVarNonEmpty(env, "TERM");
  if (nonEmptyTerm !== undefined) {
    return terminalInfoFromTerm(nonEmptyTerm, multiplexer);
  }

  return unknownTerminalInfo(multiplexer);
}

export function terminalUserAgentToken(info: TerminalInfo): string {
  let raw: string;
  if (info.termProgram !== undefined) {
    raw = formatTerminalVersion(info.termProgram, info.version);
  } else if (info.term !== undefined && info.term.length > 0) {
    raw = info.term;
  } else {
    switch (info.name) {
      case TerminalName.AppleTerminal:
        raw = formatTerminalVersion("Apple_Terminal", info.version);
        break;
      case TerminalName.Ghostty:
        raw = formatTerminalVersion("Ghostty", info.version);
        break;
      case TerminalName.Iterm2:
        raw = formatTerminalVersion("iTerm.app", info.version);
        break;
      case TerminalName.WarpTerminal:
        raw = formatTerminalVersion("WarpTerminal", info.version);
        break;
      case TerminalName.VsCode:
        raw = formatTerminalVersion("vscode", info.version);
        break;
      case TerminalName.WezTerm:
        raw = formatTerminalVersion("WezTerm", info.version);
        break;
      case TerminalName.Kitty:
        raw = "kitty";
        break;
      case TerminalName.Alacritty:
        raw = "Alacritty";
        break;
      case TerminalName.Konsole:
        raw = formatTerminalVersion("Konsole", info.version);
        break;
      case TerminalName.GnomeTerminal:
        raw = "gnome-terminal";
        break;
      case TerminalName.Vte:
        raw = formatTerminalVersion("VTE", info.version);
        break;
      case TerminalName.WindowsTerminal:
        raw = "WindowsTerminal";
        break;
      case TerminalName.Dumb:
        raw = "dumb";
        break;
      case TerminalName.Unknown:
        raw = "unknown";
        break;
    }
  }

  return sanitizeHeaderValue(raw);
}

export function isZellijTerminal(info: TerminalInfo): boolean {
  return info.multiplexer?.type === "zellij";
}

export function terminalNameFromTermProgram(
  value: string,
): TerminalName | undefined {
  const normalized = [...value.trim()]
    .filter((char) => ![" ", "-", "_", "."].includes(char))
    .map((char) => char.toLowerCase())
    .join("");

  switch (normalized) {
    case "appleterminal":
      return TerminalName.AppleTerminal;
    case "ghostty":
      return TerminalName.Ghostty;
    case "iterm":
    case "iterm2":
    case "itermapp":
      return TerminalName.Iterm2;
    case "warp":
    case "warpterminal":
      return TerminalName.WarpTerminal;
    case "vscode":
      return TerminalName.VsCode;
    case "wezterm":
      return TerminalName.WezTerm;
    case "kitty":
      return TerminalName.Kitty;
    case "alacritty":
      return TerminalName.Alacritty;
    case "konsole":
      return TerminalName.Konsole;
    case "gnometerminal":
      return TerminalName.GnomeTerminal;
    case "vte":
      return TerminalName.Vte;
    case "windowsterminal":
      return TerminalName.WindowsTerminal;
    case "dumb":
      return TerminalName.Dumb;
    default:
      return undefined;
  }
}

function terminalInfoFromTermProgram(
  name: TerminalName,
  termProgram: string,
  version: string | undefined,
  multiplexer: Multiplexer | undefined,
): TerminalInfo {
  return {
    name,
    termProgram,
    ...(version !== undefined ? { version } : {}),
    ...(multiplexer !== undefined ? { multiplexer: cloneMultiplexer(multiplexer) } : {}),
  };
}

function terminalInfoFromTermProgramAndTerm(
  name: TerminalName,
  termProgram: string,
  version: string | undefined,
  term: string | undefined,
  multiplexer: Multiplexer | undefined,
): TerminalInfo {
  return {
    name,
    termProgram,
    ...(version !== undefined ? { version } : {}),
    ...(term !== undefined ? { term } : {}),
    ...(multiplexer !== undefined ? { multiplexer: cloneMultiplexer(multiplexer) } : {}),
  };
}

function terminalInfoFromName(
  name: TerminalName,
  version: string | undefined,
  multiplexer: Multiplexer | undefined,
): TerminalInfo {
  return {
    name,
    ...(version !== undefined ? { version } : {}),
    ...(multiplexer !== undefined ? { multiplexer: cloneMultiplexer(multiplexer) } : {}),
  };
}

function terminalInfoFromTerm(
  term: string,
  multiplexer: Multiplexer | undefined,
): TerminalInfo {
  let name: TerminalName = TerminalName.Unknown;
  if (term === "dumb") name = TerminalName.Dumb;
  if (term === "wezterm" || term === "wezterm-mux") {
    name = TerminalName.WezTerm;
  }
  return {
    name,
    term,
    ...(multiplexer !== undefined ? { multiplexer: cloneMultiplexer(multiplexer) } : {}),
  };
}

function unknownTerminalInfo(
  multiplexer: Multiplexer | undefined,
): TerminalInfo {
  return {
    name: TerminalName.Unknown,
    ...(multiplexer !== undefined ? { multiplexer: cloneMultiplexer(multiplexer) } : {}),
  };
}

function detectMultiplexer(
  env: TerminalDetectionEnvironment,
): Multiplexer | undefined {
  if (envHasNonEmpty(env, "TMUX") || envHasNonEmpty(env, "TMUX_PANE")) {
    const version = tmuxVersionFromEnv(env);
    return {
      type: "tmux",
      ...(version !== undefined ? { version } : {}),
    };
  }

  if (
    envHasNonEmpty(env, "ZELLIJ") ||
    envHasNonEmpty(env, "ZELLIJ_SESSION_NAME") ||
    envHasNonEmpty(env, "ZELLIJ_VERSION")
  ) {
    return { type: "zellij" };
  }

  return undefined;
}

function terminalFromTmuxClientInfo(
  clientInfo: TmuxClientInfo,
  multiplexer: Multiplexer,
): TerminalInfo | undefined {
  const termtype = noneIfWhitespace(clientInfo.termtype);
  const termname = noneIfWhitespace(clientInfo.termname);

  if (termtype !== undefined) {
    const { program, version } = splitTermProgramAndVersion(termtype);
    return terminalInfoFromTermProgramAndTerm(
      terminalNameFromTermProgram(program) ?? TerminalName.Unknown,
      program,
      version,
      termname,
      multiplexer,
    );
  }

  if (termname !== undefined) {
    return terminalInfoFromTerm(termname, multiplexer);
  }

  return undefined;
}

function tmuxVersionFromEnv(
  env: TerminalDetectionEnvironment,
): string | undefined {
  const termProgram = readEnv(env, "TERM_PROGRAM");
  if (termProgram === undefined || !isTmuxTermProgram(termProgram)) {
    return undefined;
  }
  return envVarNonEmpty(env, "TERM_PROGRAM_VERSION");
}

function isTmuxTermProgram(value: string): boolean {
  return value.toLowerCase() === "tmux";
}

function splitTermProgramAndVersion(value: string): {
  readonly program: string;
  readonly version?: string;
} {
  const parts = value.trim().split(/\s+/);
  const program = parts[0] ?? "";
  const version = parts[1];
  return {
    program,
    ...(version !== undefined ? { version } : {}),
  };
}

function tmuxClientInfo(): TmuxClientInfo {
  const termtype = tmuxDisplayMessage("#{client_termtype}");
  const termname = tmuxDisplayMessage("#{client_termname}");
  return {
    ...(termtype !== undefined ? { termtype } : {}),
    ...(termname !== undefined ? { termname } : {}),
  };
}

function tmuxDisplayMessage(format: string): string | undefined {
  try {
    const output = execFileSync("tmux", ["display-message", "-p", format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    return noneIfWhitespace(output.trim());
  } catch {
    return undefined;
  }
}

function formatTerminalVersion(
  name: string,
  version: string | undefined,
): string {
  return version !== undefined && version.length > 0
    ? `${name}/${version}`
    : name;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "_");
}

function readEnv(
  env: TerminalDetectionEnvironment,
  name: string,
): string | undefined {
  return env.get(name);
}

function envHas(env: TerminalDetectionEnvironment, name: string): boolean {
  return readEnv(env, name) !== undefined;
}

function envVarNonEmpty(
  env: TerminalDetectionEnvironment,
  name: string,
): string | undefined {
  return noneIfWhitespace(readEnv(env, name));
}

function envHasNonEmpty(
  env: TerminalDetectionEnvironment,
  name: string,
): boolean {
  return envVarNonEmpty(env, name) !== undefined;
}

function noneIfWhitespace(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}

function cloneTerminalInfo(info: TerminalInfo): TerminalInfo {
  return {
    name: info.name,
    ...(info.termProgram !== undefined ? { termProgram: info.termProgram } : {}),
    ...(info.version !== undefined ? { version: info.version } : {}),
    ...(info.term !== undefined ? { term: info.term } : {}),
    ...(info.multiplexer !== undefined
      ? { multiplexer: cloneMultiplexer(info.multiplexer) }
      : {}),
  };
}

function cloneMultiplexer(multiplexer: Multiplexer): Multiplexer {
  return multiplexer.type === "tmux"
    ? {
      type: "tmux",
      ...(multiplexer.version !== undefined
        ? { version: multiplexer.version }
        : {}),
    }
    : { type: "zellij" };
}
