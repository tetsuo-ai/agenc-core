/**
 * Canonical shell-command parser for AgenC permission and audit surfaces.
 *
 * This module intentionally fails closed. It exposes conservative
 * single-command tokenization for Bash rule matching, a separate word-only
 * sequence parser for wrapper canonicalization, and compact parsed-command
 * metadata for read/list/search summaries. Syntax this parser cannot prove is
 * literal remains opaque to callers.
 *
 * @module
 */

import path from "node:path";

export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50;

/**
 * Env-var assignment pattern. Matches AgenC's permission env-prefix handling.
 */
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/;

/**
 * Shape check for "this token looks like a subcommand/command name":
 * lowercase, optionally hyphenated (e.g. `git`, `npm`, `run`, `compose`).
 * Rejects flags, paths, numbers, and filenames.
 */
const COMMAND_TOKEN_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Env vars safe to strip from the prefix lookup. These cannot execute code or
 * hijack binary/library resolution by themselves.
 */
export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "GOEXPERIMENT",
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "GO111MODULE",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "CI",
  "DEBUG",
  "GOOGLE_CLOUD_PROJECT",
  "LS_COLORS",
  "LSCOLORS",
  "GREP_COLOR",
  "GREP_COLORS",
]);

/**
 * Bare shell/wrapper names we refuse to turn into prefix rules. A rule like
 * `Bash(bash:*)` would allow arbitrary code via `-c`. `sudo`/`doas` similarly
 * round-trip privilege.
 */
const BARE_SHELL_PREFIXES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "xargs",
  "nice",
  "stdbuf",
  "nohup",
  "timeout",
  "time",
  "sudo",
  "doas",
  "pkexec",
]);

const BASH_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
]);
const BASH_WRAPPER_FLAGS: ReadonlySet<string> = new Set(["-lc", "-c"]);

const POWERSHELL_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  "powershell",
  "pwsh",
]);
const POWERSHELL_FLAGS: ReadonlySet<string> = new Set([
  "-nologo",
  "-noprofile",
  "-command",
  "-c",
]);

export const CANONICAL_BASH_SCRIPT_PREFIX = "__agenc_shell_script__";
export const CANONICAL_POWERSHELL_SCRIPT_PREFIX =
  "__agenc_powershell_script__";

export type ParsedCommand =
  | {
      readonly type: "read";
      readonly cmd: string;
      readonly name: string;
      readonly path: string;
    }
  | {
      readonly type: "list_files";
      readonly cmd: string;
      readonly path: string | null;
    }
  | {
      readonly type: "search";
      readonly cmd: string;
      readonly query: string | null;
      readonly path: string | null;
    }
  | {
      readonly type: "unknown";
      readonly cmd: string;
    };

export interface WordOnlyShellSequence {
  readonly type: "word_only_shell_sequence";
  readonly commands: readonly (readonly string[])[];
}

export interface OpaqueShellScript {
  readonly type: "opaque_shell_script";
  readonly shell: "bash" | "powershell";
  readonly script: string;
  readonly shellMode?: string;
}

export type ParsedCommandArgvTree =
  | {
      readonly type: "raw_argv";
      readonly argv: readonly string[];
    }
  | {
      readonly type: "bash_wrapper";
      readonly shell: string;
      readonly flag: "-c" | "-lc";
      readonly script: string;
      readonly parsed: WordOnlyShellSequence | OpaqueShellScript;
    }
  | {
      readonly type: "powershell_wrapper";
      readonly shell: string;
      readonly commandFlag: "-Command" | "-c" | string;
      readonly script: string;
      readonly parsed: OpaqueShellScript;
    };

export interface ExtractedBashCommand {
  readonly shell: string;
  readonly flag: "-c" | "-lc";
  readonly script: string;
}

export interface ExtractedPowerShellCommand {
  readonly shell: string;
  readonly commandFlag: string;
  readonly script: string;
}

export function extractBashCommand(
  command: readonly string[],
): ExtractedBashCommand | null {
  if (command.length !== 3) return null;
  const [shell, flag, script] = command;
  if (shell === undefined || flag === undefined || script === undefined) {
    return null;
  }
  if (!BASH_WRAPPER_FLAGS.has(flag)) return null;
  if (!BASH_WRAPPER_NAMES.has(basenameNoExt(shell).toLowerCase())) return null;
  return { shell, flag: flag as "-c" | "-lc", script };
}

export function extractPowerShellCommand(
  command: readonly string[],
): ExtractedPowerShellCommand | null {
  if (command.length < 3) return null;

  const shell = command[0];
  if (
    shell === undefined ||
    !POWERSHELL_WRAPPER_NAMES.has(basenameNoExt(shell).toLowerCase())
  ) {
    return null;
  }

  let i = 1;
  while (i + 1 < command.length) {
    const flag = command[i];
    if (flag === undefined) return null;
    const normalized = flag.toLowerCase();
    if (!POWERSHELL_FLAGS.has(normalized)) return null;
    if (normalized === "-command" || normalized === "-c") {
      const script = command[i + 1];
      return script === undefined || i + 2 !== command.length
        ? null
        : { shell, commandFlag: flag, script };
    }
    i++;
  }
  return null;
}

/**
 * Parse argv into the smallest permission-relevant wrapper tree. Shell scripts
 * that are not word-only remain opaque so callers never infer safety from
 * syntax this module cannot prove.
 */
export function parseCommandArgvTree(
  command: readonly string[],
): ParsedCommandArgvTree {
  const bash = extractBashCommand(command);
  if (bash !== null) {
    const commands = parseWordOnlyShellSequence(bash.script);
    return {
      type: "bash_wrapper",
      shell: bash.shell,
      flag: bash.flag,
      script: bash.script,
      parsed:
        commands === null
          ? {
              type: "opaque_shell_script",
              shell: "bash",
              shellMode: bash.flag,
              script: bash.script,
            }
          : { type: "word_only_shell_sequence", commands },
    };
  }

  const powershell = extractPowerShellCommand(command);
  if (powershell !== null) {
    return {
      type: "powershell_wrapper",
      shell: powershell.shell,
      commandFlag: powershell.commandFlag,
      script: powershell.script,
      parsed: {
        type: "opaque_shell_script",
        shell: "powershell",
        script: powershell.script,
      },
    };
  }

  return { type: "raw_argv", argv: command.slice() };
}

/**
 * Canonicalize command argv for approval-cache matching.
 *
 * Shell wrapper path differences collapse. Bash scripts only turn into argv
 * when exactly one word-only command can be recovered; multi-command or
 * syntactically rich scripts use an opaque, AgenC-branded marker that preserves
 * the shell mode and script text.
 */
export function canonicalizeCommandForApproval(
  command: readonly string[],
): readonly string[] {
  const tree = parseCommandArgvTree(command);
  switch (tree.type) {
    case "raw_argv":
      return tree.argv.slice();
    case "bash_wrapper":
      if (
        tree.parsed.type === "word_only_shell_sequence" &&
        tree.parsed.commands.length === 1
      ) {
        return tree.parsed.commands[0]!.slice();
      }
      return [CANONICAL_BASH_SCRIPT_PREFIX, tree.flag, tree.script];
    case "powershell_wrapper":
      return [CANONICAL_POWERSHELL_SCRIPT_PREFIX, tree.script];
    default: {
      const _exhaustive: never = tree;
      return _exhaustive;
    }
  }
}

/**
 * Parse command metadata from argv. Known read/list/search commands become
 * structured variants; if any segment remains unknown, the whole command
 * collapses to a single opaque `unknown` variant.
 */
export function parseCommand(command: readonly string[]): readonly ParsedCommand[] {
  const tree = parseCommandArgvTree(command);

  if (tree.type === "bash_wrapper") {
    if (tree.parsed.type === "opaque_shell_script") {
      return [{ type: "unknown", cmd: tree.script }];
    }
    return collapseUnknownCommands(
      parseCommandSequence(tree.parsed.commands, {
        unknownDisplay: tree.script,
        scriptText: tree.script,
      }),
      tree.script,
    );
  }

  if (tree.type === "powershell_wrapper") {
    return [{ type: "unknown", cmd: tree.script }];
  }

  const normalized = normalizeTokens(command);
  const parts = containsConnectors(normalized)
    ? splitOnConnectors(normalized)
    : [normalized];
  return collapseUnknownCommands(
    parseCommandSequence(parts, { unknownDisplay: shlexJoin(command) }),
    singleUnknownForCommand(command).cmd,
  );
}

/**
 * Parse a single simple command into argv tokens. This intentionally remains a
 * single-command tokenizer: pipes, semicolons, redirection, shell expansions,
 * newlines, comments, and unterminated quotes return `null`.
 */
export function parseShellCommand(command: string): readonly string[] | null {
  const src = command;
  const n = src.length;
  const tokens: string[] = [];
  let i = 0;
  let buf = "";
  let inToken = false;

  const flushToken = (): void => {
    if (inToken) {
      tokens.push(buf);
      buf = "";
      inToken = false;
    }
  };

  while (i < n) {
    const c = src[i]!;

    if (c === " " || c === "\t") {
      flushToken();
      i++;
      continue;
    }

    if (
      c === "|" ||
      c === "&" ||
      c === ";" ||
      c === ">" ||
      c === "<" ||
      c === "(" ||
      c === ")" ||
      c === "`" ||
      c === "$" ||
      c === "#" ||
      c === "{" ||
      c === "}" ||
      c === "\n" ||
      c === "\r"
    ) {
      return null;
    }

    inToken = true;

    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return null;
      buf += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "\\" && j + 1 < n) {
          const e = src[j + 1]!;
          if (e === '"' || e === "\\" || e === "$" || e === "`") {
            buf += e;
            j += 2;
            continue;
          }
          buf += d;
          j++;
          continue;
        }
        if (d === "$") return null;
        if (d === "`") return null;
        buf += d;
        j++;
      }
      if (!closed) return null;
      i = j + 1;
      continue;
    }

    if (c === "\\") {
      if (i + 1 >= n) return null;
      buf += src[i + 1]!;
      i += 2;
      continue;
    }

    buf += c;
    i++;
  }

  flushToken();
  return tokens;
}

/**
 * Split a command string on top-level shell operators: `;`, `&&`, `||`, `|`,
 * `&`, and line breaks. Quote boundaries and escaped separators are honored.
 */
export function splitCommand(command: string): readonly string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];

  const parts: string[] = [];
  const n = trimmed.length;
  let i = 0;
  let start = 0;

  while (i < n) {
    const c = trimmed[i]!;

    if (c === "'") {
      const end = trimmed.indexOf("'", i + 1);
      if (end === -1) {
        i = n;
        continue;
      }
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = trimmed[j]!;
        if (d === '"') break;
        if (d === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        j++;
      }
      i = j < n ? j + 1 : n;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }

    const two = trimmed.substring(i, i + 2);
    let opLen = 0;
    if (two === "&&" || two === "||") {
      opLen = 2;
    } else if (
      c === ";" ||
      c === "|" ||
      c === "&" ||
      c === "\n" ||
      c === "\r"
    ) {
      opLen = 1;
    }

    if (opLen > 0) {
      const segment = trimmed.slice(start, i).trim();
      if (segment.length > 0) parts.push(segment);
      i += opLen;
      start = i;
      continue;
    }

    i++;
  }

  const last = trimmed.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function splitWordOnlyCommandSequence(script: string): readonly string[] | null {
  const trimmed = script.trim();
  if (trimmed.length === 0) return [];

  const parts: string[] = [];
  const n = trimmed.length;
  let i = 0;
  let start = 0;
  let justSawOperator = true;

  while (i < n) {
    const c = trimmed[i]!;

    if (c === "'") {
      const end = trimmed.indexOf("'", i + 1);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        const d = trimmed[j]!;
        if (d === '"') break;
        if (d === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j >= n) return null;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      i += 2;
      justSawOperator = false;
      continue;
    }

    const two = trimmed.substring(i, i + 2);
    let opLen = 0;
    if (two === "&&" || two === "||") {
      opLen = 2;
    } else if (c === ";" || c === "|" || c === "\n" || c === "\r") {
      opLen = 1;
    } else if (c === "&") {
      return null;
    }

    if (opLen > 0) {
      const segment = trimmed.slice(start, i).trim();
      if (justSawOperator || segment.length === 0) return null;
      parts.push(segment);
      i += opLen;
      start = i;
      justSawOperator = true;
      continue;
    }

    if (!/\s/.test(c)) justSawOperator = false;
    i++;
  }

  const last = trimmed.slice(start).trim();
  if (justSawOperator || last.length === 0) return null;
  parts.push(last);
  return parts;
}

/**
 * Parse a shell script that contains only word commands joined by safe
 * sequencing operators. This is intentionally separate from
 * `parseShellCommand`, which must stay conservative for Bash permissions.
 */
export function parseWordOnlyShellSequence(
  script: string,
): readonly (readonly string[])[] | null {
  const parts = splitWordOnlyCommandSequence(script);
  if (parts === null) return null;
  if (parts.length === 0) return null;

  const commands: string[][] = [];
  for (const part of parts) {
    const argv = parseShellCommand(part);
    if (argv === null || argv.length === 0) return null;
    if (ENV_VAR_ASSIGN_RE.test(argv[0]!)) return null;
    commands.push([...argv]);
  }
  return commands;
}

/**
 * Recover the literal argv prefix for a recognized Bash wrapper when the
 * script is exactly one command. Here-doc bodies are intentionally discarded:
 * the executable prefix still matters to the sandbox policy, while the body is
 * data and must not be tokenized as shell syntax.
 */
export function parseShellLcSingleCommandPrefix(
  command: readonly string[],
): readonly string[] | null {
  const bash = extractBashCommand(command);
  if (bash === null) return null;
  return parseBashSingleCommandPrefix(bash.script);
}

function parseBashSingleCommandPrefix(
  script: string,
): readonly string[] | null {
  const trimmed = script.trim();
  if (trimmed.length === 0) return null;

  const commands = parseWordOnlyShellSequence(trimmed);
  if (commands !== null && commands.length === 1) return commands[0]!.slice();

  const hereDoc = findTopLevelHereDocOperator(trimmed);
  if (hereDoc === null) return null;
  if (hasTrailingHereDocConnector(trimmed, hereDoc)) return null;
  const prefix = trimmed.slice(0, hereDoc.index).trim();
  if (prefix.length === 0) return null;
  if (splitWordOnlyCommandSequence(prefix)?.length !== 1) return null;
  const argv = parseShellCommand(prefix);
  if (argv === null || argv.length === 0) return null;
  if (ENV_VAR_ASSIGN_RE.test(argv[0]!)) return null;
  return argv;
}

function findTopLevelHereDocOperator(
  script: string,
): { readonly index: number; readonly operator: "<<" | "<<<" } | null {
  let i = 0;
  while (i < script.length) {
    const c = script[i]!;
    if (c === "'") {
      const end = script.indexOf("'", i + 1);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < script.length) {
        const d = script[j]!;
        if (d === '"') break;
        if (d === "\\" && j + 1 < script.length) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j >= script.length) return null;
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < script.length) {
      i += 2;
      continue;
    }
    if (script.startsWith("<<<", i)) return { index: i, operator: "<<<" };
    if (script.startsWith("<<", i)) return { index: i, operator: "<<" };
    if (c === ">") return null;
    i++;
  }
  return null;
}

function hasTrailingHereDocConnector(
  script: string,
  hereDoc: { readonly index: number; readonly operator: "<<" | "<<<" },
): boolean {
  const lineEnd = script.indexOf("\n", hereDoc.index);
  const redirectionLine = script.slice(
    hereDoc.index + hereDoc.operator.length,
    lineEnd === -1 ? script.length : lineEnd,
  );
  return containsTopLevelConnector(redirectionLine);
}

function containsTopLevelConnector(value: string): boolean {
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "\"") {
      quote = c;
      continue;
    }
    if (c === "\\" && i + 1 < value.length) {
      i++;
      continue;
    }
    const two = value.slice(i, i + 2);
    if (two === "&&" || two === "||") return true;
    if (c === ";" || c === "|" || c === "&") return true;
  }
  return false;
}

/**
 * Return shell-wrapper subcommands for the Bash permission path. Only
 * recognized Bash wrappers with word-only scripts produce subcommands; every
 * opaque script returns null so callers keep their conservative fallback.
 */
export function parseShellWrapperSubcommandsForPermission(
  commandText: string,
): readonly string[] | null {
  const argv = parseShellCommand(commandText);
  if (argv === null) return null;
  const tree = parseCommandArgvTree(argv);
  if (
    tree.type !== "bash_wrapper" ||
    tree.parsed.type !== "word_only_shell_sequence"
  ) {
    return null;
  }
  return tree.parsed.commands.map((command) => shlexJoin(command));
}

/**
 * Extract a stable two-token prefix ("git commit", "npm run"). Returns null
 * when env-var stripping or token shape is not conservative enough.
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const stripped = stripLeadingSafeEnvVars(tokens);
  if (stripped === null) return null;
  if (stripped.length < 2) return null;
  const subcmd = stripped[1]!;
  if (!COMMAND_TOKEN_RE.test(subcmd)) return null;
  return stripped.slice(0, 2).join(" ");
}

/**
 * Return the first command token after stripping safe env vars. Bare shells and
 * privilege wrappers are rejected because they do not describe the real action.
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const stripped = stripLeadingSafeEnvVars(tokens);
  if (stripped === null) return null;
  const cmd = stripped[0];
  if (!cmd) return null;
  if (!COMMAND_TOKEN_RE.test(cmd)) return null;
  if (BARE_SHELL_PREFIXES.has(cmd)) return null;
  return cmd;
}

export function stripLeadingSafeEnvVars(
  tokens: readonly string[],
): readonly string[] | null {
  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split("=")[0]!;
    if (!SAFE_ENV_VARS.has(varName)) return null;
    i++;
  }
  return tokens.slice(i);
}

function parseCommandSequence(
  commandParts: readonly (readonly string[])[],
  opts: {
    readonly unknownDisplay: string;
    readonly scriptText?: string;
  },
): ParsedCommand[] {
  const filtered = dropSmallFormattingCommands(
    commandParts.map((part) => [...part]),
  );
  if (filtered.length === 0) return [{ type: "unknown", cmd: opts.unknownDisplay }];

  const commands: ParsedCommand[] = [];
  let cwd: string | null = null;

  for (const tokens of filtered) {
    const [head, ...tail] = tokens;
    if (head === "cd") {
      const target = cdTarget(tail);
      if (target !== null) {
        cwd = cwd === null ? target : joinPaths(cwd, target);
      }
      continue;
    }

    const parsed = summarizeMainTokens(tokens);
    if (parsed.type === "read" && cwd !== null) {
      commands.push({
        ...parsed,
        path: joinPaths(cwd, parsed.path),
      });
    } else {
      commands.push(parsed);
    }
  }

  let simplified = commands;
  while (true) {
    const next = simplifyOnce(simplified);
    if (next === null) break;
    simplified = next;
  }

  if (simplified.length === 1 && opts.scriptText !== undefined) {
    const only = simplified[0]!;
    if (only.type === "read" || only.type === "list_files" || only.type === "search") {
      return [{ ...only, cmd: commandDisplayForSingleScript(only, opts.scriptText) }];
    }
  }

  return simplified;
}

function collapseUnknownCommands(
  commands: readonly ParsedCommand[],
  unknownDisplay: string,
): readonly ParsedCommand[] {
  const deduped: ParsedCommand[] = [];
  for (const command of commands) {
    const prev = deduped[deduped.length - 1];
    if (prev !== undefined && parsedCommandsEqual(prev, command)) continue;
    deduped.push(command);
  }
  if (deduped.some((command) => command.type === "unknown")) {
    return [{ type: "unknown", cmd: unknownDisplay }];
  }
  return deduped;
}

function parsedCommandsEqual(left: ParsedCommand, right: ParsedCommand): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function singleUnknownForCommand(command: readonly string[]): ParsedCommand {
  const bash = extractBashCommand(command);
  if (bash !== null) return { type: "unknown", cmd: bash.script };
  const powershell = extractPowerShellCommand(command);
  if (powershell !== null) return { type: "unknown", cmd: powershell.script };
  return { type: "unknown", cmd: shlexJoin(command) };
}

function commandDisplayForSingleScript(
  parsed: ParsedCommand,
  scriptText: string,
): string {
  if (parsed.type === "read") return parsed.cmd;
  return parsed.cmd.includes("|") || parsed.cmd.includes("&&") || parsed.cmd.includes(";")
    ? parsed.cmd
    : shlexJoin(parseWordOnlyShellSequence(scriptText)?.[0] ?? [parsed.cmd]);
}

function simplifyOnce(commands: readonly ParsedCommand[]): ParsedCommand[] | null {
  if (commands.length <= 1) return null;

  const first = commands[0];
  if (
    first?.type === "unknown" &&
    parseShellCommand(first.cmd)?.[0] === "echo"
  ) {
    return commands.slice(1);
  }

  const cdIndex = commands.findIndex(
    (command) =>
      command.type === "unknown" && parseShellCommand(command.cmd)?.[0] === "cd",
  );
  if (cdIndex >= 0 && commands.length > cdIndex + 1) {
    return [
      ...commands.slice(0, cdIndex),
      ...commands.slice(cdIndex + 1),
    ];
  }

  const trueIndex = commands.findIndex(
    (command) => command.type === "unknown" && command.cmd === "true",
  );
  if (trueIndex >= 0) {
    return [
      ...commands.slice(0, trueIndex),
      ...commands.slice(trueIndex + 1),
    ];
  }

  const nlIndex = commands.findIndex((command) => {
    if (command.type !== "unknown") return false;
    const tokens = parseShellCommand(command.cmd);
    return (
      tokens !== null &&
      tokens[0] === "nl" &&
      tokens.slice(1).every((token) => token.startsWith("-"))
    );
  });
  if (nlIndex >= 0) {
    return [
      ...commands.slice(0, nlIndex),
      ...commands.slice(nlIndex + 1),
    ];
  }

  return null;
}

function normalizeTokens(command: readonly string[]): string[] {
  const [first, pipe, ...rest] = command;
  if ((first === "yes" || first === "y") && pipe === "|") return rest;
  if ((first === "no" || first === "n") && pipe === "|") return rest;
  return command.slice();
}

function containsConnectors(tokens: readonly string[]): boolean {
  return tokens.some((token) =>
    token === "&&" || token === "||" || token === "|" || token === ";"
  );
}

function splitOnConnectors(tokens: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const token of tokens) {
    if (token === "&&" || token === "||" || token === "|" || token === ";") {
      if (cur.length > 0) {
        out.push(cur);
        cur = [];
      }
    } else {
      cur.push(token);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function trimAtConnector(tokens: readonly string[]): string[] {
  const idx = tokens.findIndex((token) =>
    token === "|" || token === "&&" || token === "||" || token === ";"
  );
  return tokens.slice(0, idx === -1 ? tokens.length : idx);
}

function shortDisplayPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").reverse().filter((part) =>
    part.length > 0 &&
    part !== "build" &&
    part !== "dist" &&
    part !== "node_modules" &&
    part !== "src"
  );
  return parts[0] ?? normalized;
}

function skipFlagValues(
  args: readonly string[],
  flagsWithVals: readonly string[],
): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flagsWithVals.includes(arg)) {
      if (i + 1 < args.length) skipNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function positionalOperands(
  args: readonly string[],
  flagsWithVals: readonly string[],
): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (afterDoubleDash) {
      out.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flagsWithVals.includes(arg)) {
      if (i + 1 < args.length) skipNext = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

function firstNonFlagOperand(
  args: readonly string[],
  flagsWithVals: readonly string[],
): string | null {
  return positionalOperands(args, flagsWithVals)[0] ?? null;
}

function mapNullable<T, R>(value: T | null, fn: (value: T) => R): R | null {
  return value === null ? null : fn(value);
}

function singleNonFlagOperand(
  args: readonly string[],
  flagsWithVals: readonly string[],
): string | null {
  const operands = positionalOperands(args, flagsWithVals);
  return operands.length === 1 ? operands[0]! : null;
}

function summarizeMainTokens(tokens: readonly string[]): ParsedCommand {
  const [head, ...tail] = tokens;
  if (head === undefined) return { type: "unknown", cmd: "" };

  if (head === "ls" || head === "eza" || head === "exa") {
    const flagsWithVals =
      head === "ls"
        ? [
            "-I",
            "-w",
            "--block-size",
            "--format",
            "--time-style",
            "--color",
            "--quoting-style",
          ]
        : ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"];
    return {
      type: "list_files",
      cmd: shlexJoin(tokens),
      path: mapNullable(firstNonFlagOperand(tail, flagsWithVals), shortDisplayPath),
    };
  }

  if (head === "tree") {
    return {
      type: "list_files",
      cmd: shlexJoin(tokens),
      path:
        mapNullable(firstNonFlagOperand(tail, [
          "-L",
          "-P",
          "-I",
          "--charset",
          "--filelimit",
          "--sort",
        ]), shortDisplayPath),
    };
  }

  if (head === "du") {
    return {
      type: "list_files",
      cmd: shlexJoin(tokens),
      path:
        mapNullable(firstNonFlagOperand(tail, [
          "-d",
          "--max-depth",
          "-B",
          "--block-size",
          "--exclude",
          "--time-style",
        ]), shortDisplayPath),
    };
  }

  if (head === "rg" || head === "rga" || head === "ripgrep-all") {
    const argsNoConnector = trimAtConnector(tail);
    const hasFilesFlag = argsNoConnector.includes("--files");
    const candidates = skipFlagValues(argsNoConnector, [
      "-g",
      "--glob",
      "--iglob",
      "-t",
      "--type",
      "--type-add",
      "--type-not",
      "-m",
      "--max-count",
      "-A",
      "-B",
      "-C",
      "--context",
      "--max-depth",
    ]).filter((arg) => !arg.startsWith("-"));
    if (hasFilesFlag) {
      return {
        type: "list_files",
        cmd: shlexJoin(tokens),
        path: candidates[0] === undefined ? null : shortDisplayPath(candidates[0]),
      };
    }
    return {
      type: "search",
      cmd: shlexJoin(tokens),
      query: candidates[0] ?? null,
      path: candidates[1] === undefined ? null : shortDisplayPath(candidates[1]),
    };
  }

  if (head === "git") {
    const [subcmd, ...subTail] = tail;
    if (subcmd === "grep") return parseGrepLike(tokens, subTail);
    if (subcmd === "ls-files") {
      return {
        type: "list_files",
        cmd: shlexJoin(tokens),
        path:
          mapNullable(firstNonFlagOperand(subTail, [
            "--exclude",
            "--exclude-from",
            "--pathspec-from-file",
          ]), shortDisplayPath),
      };
    }
    return { type: "unknown", cmd: shlexJoin(tokens) };
  }

  if (head === "fd") {
    const [query, pathValue] = parseFdQueryAndPath(tail);
    return query === null
      ? { type: "list_files", cmd: shlexJoin(tokens), path: pathValue }
      : { type: "search", cmd: shlexJoin(tokens), query, path: pathValue };
  }

  if (head === "find") {
    const [query, pathValue] = parseFindQueryAndPath(tail);
    return query === null
      ? { type: "list_files", cmd: shlexJoin(tokens), path: pathValue }
      : { type: "search", cmd: shlexJoin(tokens), query, path: pathValue };
  }

  if (head === "grep" || head === "egrep" || head === "fgrep") {
    return parseGrepLike(tokens, tail);
  }

  if (head === "ag" || head === "ack" || head === "pt") {
    const candidates = skipFlagValues(trimAtConnector(tail), [
      "-G",
      "-g",
      "--file-search-regex",
      "--ignore-dir",
      "--ignore-file",
      "--path-to-ignore",
    ]).filter((arg) => !arg.startsWith("-"));
    return {
      type: "search",
      cmd: shlexJoin(tokens),
      query: candidates[0] ?? null,
      path: candidates[1] === undefined ? null : shortDisplayPath(candidates[1]),
    };
  }

  if (head === "cat" || head === "more") {
    return readSingleOperand(tokens, tail, []);
  }

  if (head === "bat" || head === "batcat") {
    return readSingleOperand(tokens, tail, [
      "--theme",
      "--language",
      "--style",
      "--terminal-width",
      "--tabs",
      "--line-range",
      "--map-syntax",
    ]);
  }

  if (head === "less") {
    return readSingleOperand(tokens, tail, [
      "-p",
      "-P",
      "-x",
      "-y",
      "-z",
      "-j",
      "--pattern",
      "--prompt",
      "--tabs",
      "--shift",
      "--jump-target",
    ]);
  }

  if (head === "head" || head === "tail") {
    return parseHeadTail(tokens, head, tail);
  }

  if (head === "awk") {
    const dataPath = awkDataFileOperand(tail);
    if (dataPath !== null) return readPath(tokens, dataPath);
    return { type: "unknown", cmd: shlexJoin(tokens) };
  }

  if (head === "nl") {
    const candidate = skipFlagValues(tail, ["-s", "-w", "-v", "-i", "-b"])
      .find((arg) => !arg.startsWith("-"));
    return candidate === undefined
      ? { type: "unknown", cmd: shlexJoin(tokens) }
      : readPath(tokens, candidate);
  }

  if (head === "sed") {
    const dataPath = sedReadPath(tail);
    if (dataPath !== null) return readPath(tokens, dataPath);
    return { type: "unknown", cmd: shlexJoin(tokens) };
  }

  if (isPythonCommand(head)) {
    return pythonWalksFiles(tail)
      ? { type: "list_files", cmd: shlexJoin(tokens), path: null }
      : { type: "unknown", cmd: shlexJoin(tokens) };
  }

  return { type: "unknown", cmd: shlexJoin(tokens) };
}

function parseGrepLike(
  mainCommand: readonly string[],
  args: readonly string[],
): ParsedCommand {
  const argsNoConnector = trimAtConnector(args);
  const operands: string[] = [];
  let pattern: string | null = null;
  let afterDoubleDash = false;

  for (let i = 0; i < argsNoConnector.length; i++) {
    const arg = argsNoConnector[i]!;
    if (afterDoubleDash) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
      const next = argsNoConnector[i + 1];
      if (next !== undefined && pattern === null) pattern = next;
      i++;
      continue;
    }
    if (
      arg === "-m" ||
      arg === "--max-count" ||
      arg === "-C" ||
      arg === "--context" ||
      arg === "-A" ||
      arg === "--after-context" ||
      arg === "-B" ||
      arg === "--before-context"
    ) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    operands.push(arg);
  }

  const hasPattern = pattern !== null;
  const query = pattern ?? operands[0] ?? null;
  const pathIndex = hasPattern ? 0 : 1;
  return {
    type: "search",
    cmd: shlexJoin(mainCommand),
    query,
    path:
      operands[pathIndex] === undefined
        ? null
        : shortDisplayPath(operands[pathIndex]!),
  };
}

function parseFdQueryAndPath(tail: readonly string[]): readonly [string | null, string | null] {
  const candidates = skipFlagValues(trimAtConnector(tail), [
    "-t",
    "--type",
    "-e",
    "--extension",
    "-E",
    "--exclude",
    "--search-path",
  ]).filter((arg) => !arg.startsWith("-"));
  if (candidates.length === 1) {
    const one = candidates[0]!;
    return isPathish(one) ? [null, shortDisplayPath(one)] : [one, null];
  }
  if (candidates.length >= 2) {
    return [candidates[0]!, shortDisplayPath(candidates[1]!)];
  }
  return [null, null];
}

function parseFindQueryAndPath(tail: readonly string[]): readonly [string | null, string | null] {
  const argsNoConnector = trimAtConnector(tail);
  let pathValue: string | null = null;
  for (const arg of argsNoConnector) {
    if (!arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")") {
      pathValue = shortDisplayPath(arg);
      break;
    }
  }

  let query: string | null = null;
  for (let i = 0; i < argsNoConnector.length; i++) {
    const arg = argsNoConnector[i]!;
    if (arg === "-name" || arg === "-iname" || arg === "-path" || arg === "-regex") {
      query = argsNoConnector[i + 1] ?? null;
      break;
    }
  }
  return [query, pathValue];
}

function readSingleOperand(
  fullCommand: readonly string[],
  args: readonly string[],
  flagsWithVals: readonly string[],
): ParsedCommand {
  const dataPath = singleNonFlagOperand(args, flagsWithVals);
  return dataPath === null
    ? { type: "unknown", cmd: shlexJoin(fullCommand) }
    : readPath(fullCommand, dataPath);
}

function readPath(fullCommand: readonly string[], dataPath: string): ParsedCommand {
  return {
    type: "read",
    cmd: shlexJoin(fullCommand),
    name: shortDisplayPath(dataPath),
    path: dataPath,
  };
}

function parseHeadTail(
  fullCommand: readonly string[],
  head: "head" | "tail",
  tail: readonly string[],
): ParsedCommand {
  const [first, second] = tail;
  let hasValidN = false;

  if (first === "-n" && second !== undefined) {
    const normalized = head === "tail" ? second.replace(/^\+/, "") : second;
    hasValidN = normalized.length > 0 && /^\d+$/.test(normalized);
  } else if (first?.startsWith("-n") === true) {
    const value = first.slice(2);
    const normalized = head === "tail" ? value.replace(/^\+/, "") : value;
    hasValidN = normalized.length > 0 && /^\d+$/.test(normalized);
  }

  if (hasValidN) {
    const candidates: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      if (i === 0 && tail[i] === "-n" && tail[i + 1] !== undefined) {
        const normalized = head === "tail"
          ? tail[i + 1]!.replace(/^\+/, "")
          : tail[i + 1]!;
        if (/^\d+$/.test(normalized)) {
          i++;
          continue;
        }
      }
      candidates.push(tail[i]!);
    }
    const dataPath = candidates.find((candidate) => !candidate.startsWith("-"));
    if (dataPath !== undefined) return readPath(fullCommand, dataPath);
  }

  if (tail.length === 1 && tail[0] !== undefined && !tail[0].startsWith("-")) {
    return readPath(fullCommand, tail[0]);
  }

  return { type: "unknown", cmd: shlexJoin(fullCommand) };
}

function sedReadPath(args: readonly string[]): string | null {
  const argsNoConnector = trimAtConnector(args);
  if (!argsNoConnector.includes("-n")) return null;

  let hasRangeScript = false;
  for (let i = 0; i < argsNoConnector.length; i++) {
    const arg = argsNoConnector[i]!;
    if (arg === "-e" || arg === "--expression") {
      if (isValidSedNArg(argsNoConnector[i + 1])) hasRangeScript = true;
      i++;
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      i++;
    }
  }
  if (!hasRangeScript) {
    hasRangeScript = argsNoConnector.some(
      (arg) => !arg.startsWith("-") && isValidSedNArg(arg),
    );
  }
  if (!hasRangeScript) return null;

  const nonFlags = skipFlagValues(argsNoConnector, [
    "-e",
    "-f",
    "--expression",
    "--file",
  ]).filter((arg) => !arg.startsWith("-"));
  const [first, ...rest] = nonFlags;
  if (first === undefined) return null;
  return isValidSedNArg(first) ? rest[0] ?? null : first;
}

function isValidSedNArg(value: string | undefined): boolean {
  if (value === undefined || !value.endsWith("p")) return false;
  const core = value.slice(0, -1);
  const parts = core.split(",");
  return (
    (parts.length === 1 || parts.length === 2) &&
    parts.every((part) => part.length > 0 && /^\d+$/.test(part))
  );
}

function awkDataFileOperand(args: readonly string[]): string | null {
  const argsNoConnector = trimAtConnector(args);
  const hasScriptFile = argsNoConnector.some(
    (arg) => arg === "-f" || arg === "--file",
  );
  const nonFlags = skipFlagValues(argsNoConnector, [
    "-F",
    "-v",
    "-f",
    "--field-separator",
    "--assign",
    "--file",
  ]).filter((arg) => !arg.startsWith("-"));
  if (hasScriptFile) return nonFlags[0] ?? null;
  return nonFlags.length >= 2 ? nonFlags[1]! : null;
}

function pythonWalksFiles(args: readonly string[]): boolean {
  const argsNoConnector = trimAtConnector(args);
  for (let i = 0; i < argsNoConnector.length; i++) {
    if (argsNoConnector[i] === "-c") {
      const script = argsNoConnector[i + 1];
      return script === undefined
        ? false
        : script.includes("os.walk") ||
            script.includes("os.listdir") ||
            script.includes("os.scandir") ||
            script.includes("glob.glob") ||
            script.includes("glob.iglob") ||
            script.includes("pathlib.Path") ||
            script.includes(".rglob(");
    }
  }
  return false;
}

function isPythonCommand(command: string): boolean {
  return (
    command === "python" ||
    command === "python2" ||
    command === "python3" ||
    command.startsWith("python2.") ||
    command.startsWith("python3.")
  );
}

function isPathish(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function cdTarget(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1] ?? null;
    if (arg === "-L" || arg === "-P" || arg.startsWith("-")) continue;
    target = arg;
  }
  return target;
}

function joinPaths(base: string, rel: string): string {
  if (isAbsLike(rel)) return rel;
  if (base.length === 0) return rel;
  return path.join(base, rel);
}

function isAbsLike(value: string): boolean {
  if (path.isAbsolute(value)) return true;
  return /^[A-Za-z]:\\/.test(value) || value.startsWith("\\\\");
}

function dropSmallFormattingCommands(commands: string[][]): string[][] {
  return commands.filter((tokens) => !isSmallFormattingCommand(tokens));
}

function isSmallFormattingCommand(tokens: readonly string[]): boolean {
  const command = tokens[0];
  if (command === undefined) return false;
  switch (command) {
    case "wc":
    case "tr":
    case "cut":
    case "sort":
    case "uniq":
    case "tee":
    case "column":
    case "yes":
    case "printf":
      return true;
    case "xargs":
      return !isMutatingXargsCommand(tokens);
    case "awk":
      return awkDataFileOperand(tokens.slice(1)) === null;
    case "head":
      return isHeadTailFormatting(tokens, "head");
    case "tail":
      return isHeadTailFormatting(tokens, "tail");
    case "sed":
      return sedReadPath(tokens.slice(1)) === null;
    default:
      return false;
  }
}

function isHeadTailFormatting(
  tokens: readonly string[],
  command: "head" | "tail",
): boolean {
  if (tokens.length === 1) return true;
  if (tokens.length === 2) return tokens[1]?.startsWith("-") === true;
  const [, flag, count] = tokens;
  if (flag === "-n" && count !== undefined) {
    const normalized = command === "tail" ? count.replace(/^\+/, "") : count;
    return /^\d+$/.test(normalized);
  }
  if (command === "head" && flag === "-c" && count !== undefined) {
    return /^\d+$/.test(count);
  }
  if (command === "tail" && flag === "-c" && count !== undefined) {
    return /^\+?\d+$/.test(count);
  }
  return false;
}

function isMutatingXargsCommand(tokens: readonly string[]): boolean {
  const subcommand = xargsSubcommand(tokens);
  if (subcommand === null) return false;
  const [head, ...tail] = subcommand;
  if (head === "perl" || head === "ruby") return hasInPlaceFlag(tail);
  if (head === "sed") {
    return hasInPlaceFlag(tail) || tail.includes("--in-place");
  }
  if (head === "rg") return tail.includes("--replace");
  return false;
}

function xargsSubcommand(tokens: readonly string[]): readonly string[] | null {
  if (tokens[0] !== "xargs") return null;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "--") return tokens.slice(i + 1);
    if (!token.startsWith("-")) return tokens.slice(i);
    const takesValue =
      token === "-E" ||
      token === "-e" ||
      token === "-I" ||
      token === "-L" ||
      token === "-n" ||
      token === "-P" ||
      token === "-s";
    i += takesValue && token.length === 2 ? 2 : 1;
  }
  return null;
}

function hasInPlaceFlag(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) =>
      token === "-i" ||
      token.startsWith("-i") ||
      token === "-pi" ||
      token.startsWith("-pi"),
  );
}

function shlexJoin(tokens: readonly string[]): string {
  if (tokens.length === 0) return "";
  return tokens.map(shellQuote).join(" ");
}

function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  if (token.length === 0) return "''";
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function basenameNoExt(value: string): string {
  const idx = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const name = idx >= 0 ? value.slice(idx + 1) : value;
  return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
}
