/**
 * Ports upstream `src/utils/permissions/dangerousPatterns.ts` constants into
 * the live permission-mode path.
 *
 * The constants are intentionally separate from `mode.ts` so rule stripping
 * uses the same shared Bash/PowerShell interpreter list as the upstream
 * permission setup code instead of an inline subset.
 */

import { expandTilde, isDangerousRemovalPath } from "./path-validation.js";

/**
 * Cross-platform code-execution entry points present on both Unix and Windows.
 * Shared to prevent the Bash and PowerShell lists drifting apart on
 * interpreter additions.
 */
export const CROSS_PLATFORM_CODE_EXEC = [
  // Interpreters
  "python",
  "python3",
  "python2",
  "node",
  "deno",
  "tsx",
  "ruby",
  "perl",
  "php",
  "lua",
  // Package runners
  "npx",
  "bunx",
  "npm run",
  "yarn run",
  "pnpm run",
  "bun run",
  // Shells reachable from both Git Bash / WSL on Windows and native Unix
  "bash",
  "sh",
  // Remote arbitrary-command wrapper
  "ssh",
] as const;

export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  "zsh",
  "fish",
  "eval",
  "exec",
  "env",
  "xargs",
  "sudo",
  ...(process.env.USER_TYPE === "ant"
    ? [
        "fa run",
        "coo",
        "gh",
        "gh api",
        "curl",
        "wget",
        "git",
        "kubectl",
        "aws",
        "gcloud",
        "gsutil",
      ]
    : []),
];

export interface DangerousShellCommandPattern {
  readonly label: string;
  readonly pattern?: RegExp;
  readonly matches?: (command: string) => boolean;
}

/**
 * Hard-deny shell command patterns used by the permission evaluator.
 *
 * This combines the OC interpreter/pattern lists above with the donor runtime
 * exec-policy safety floor: destructive commands such as recursive forced
 * removal of critical paths must never be hidden by broad allow rules.
 */
export const DANGEROUS_SHELL_COMMAND_PATTERNS: readonly DangerousShellCommandPattern[] = [
  {
    matches: isRecursiveForceRemoveOfCriticalPath,
    label: "rm -rf critical path",
  },
  // Filesystem destruction
  { pattern: /\bmkfs(\.|\s)/, label: "mkfs" },
  { pattern: /\bdd\s+[^|;&]*\bof=\/dev\//, label: "dd of=/dev/..." },
  { pattern: /\b(shred|wipe)\s+[-/]/, label: "shred/wipe" },
  // Fork bomb
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, label: "fork bomb" },
  // Pipe curl/wget to shell
  {
    pattern:
      /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sh|bash|zsh|fish|ksh|csh|tcsh|python|python3|perl|ruby|node)\b/,
    label: "curl|sh",
  },
  // Destructive git publish to default branch
  {
    matches: isDangerousDefaultBranchForcePush,
    label: "git push --force main",
  },
  // Package-registry publishes
  { pattern: /\b(npm|yarn|pnpm|bun)\s+publish\b/, label: "npm publish" },
  { pattern: /\bcargo\s+publish\b/, label: "cargo publish" },
  { pattern: /\bgem\s+push\b/, label: "gem push" },
  { pattern: /\btwine\s+upload\b/, label: "twine upload" },
  // Privilege escalation (top-level, not bare references in docs)
  { pattern: /(^|[;&|]\s*)sudo\b/, label: "sudo" },
  { pattern: /(^|[;&|]\s*)(su|doas|pkexec)\b(\s|$)/, label: "su/doas/pkexec" },
  // chmod / chown on system paths
  {
    pattern: /\b(chmod|chown)\s+[^;&|]*(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/)/,
    label: "chmod/chown on system path",
  },
];

export function isDangerousShellCommand(command: string): boolean {
  return matchedDangerousShellCommandLabel(command) !== null;
}

export function matchedDangerousShellCommandLabel(command: string): string | null {
  const substitutionLabel = matchedDangerousShellSubstitutionLabel(command);
  if (substitutionLabel !== null) return substitutionLabel;

  for (const entry of DANGEROUS_SHELL_COMMAND_PATTERNS) {
    if (entry.matches?.(command) === true) return entry.label;
    if (entry.pattern?.test(command) === true) return entry.label;
  }
  return null;
}

function matchedDangerousShellSubstitutionLabel(command: string): string | null {
  for (const substitution of extractShellSubstitutionCommands(command)) {
    const label = matchedDangerousShellCommandLabel(substitution);
    if (label !== null) return `dangerous command substitution: ${label}`;
  }
  return null;
}

const RM_WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "env",
  "exec",
  "nice",
  "nohup",
  "stdbuf",
  "time",
  "timeout",
  "command",
]);

const SHELL_SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
]);

function isRecursiveForceRemoveOfCriticalPath(command: string): boolean {
  const fragments = splitShellFragments(command);
  if (fragments.length > 1) {
    return fragments.some((fragment) =>
      isRecursiveForceRemoveOfCriticalPath(fragment),
    );
  }

  const words = splitSimpleShellWords(command);
  if (words.length === 0) return false;

  return containsRecursiveForceRemove(words);
}

function isDangerousDefaultBranchForcePush(command: string): boolean {
  const fragments = splitShellFragments(command);
  if (fragments.length > 1) {
    return fragments.some((fragment) =>
      isDangerousDefaultBranchForcePush(fragment),
    );
  }

  const words = splitSimpleShellWords(command);
  const gitIndex = firstCommandIndex(words, 0);
  if (gitIndex === null) return false;
  if (basename(stripShellQuotes(words[gitIndex] ?? "")) !== "git") {
    return false;
  }

  const pushIndex = words.findIndex(
    (word, index) => index > gitIndex && stripShellQuotes(word) === "push",
  );
  if (pushIndex === -1) return false;

  return gitPushArgsForceDefaultBranch(words.slice(pushIndex + 1));
}

function gitPushArgsForceDefaultBranch(args: readonly string[]): boolean {
  let force = false;
  let defaultBranch = false;

  for (const raw of args) {
    const word = stripShellQuotes(raw);
    force ||= isGitForcePushArg(word);
    defaultBranch ||= isDefaultBranchPushTarget(word);
  }

  return force && defaultBranch;
}

function isGitForcePushArg(word: string): boolean {
  if (word.startsWith("+")) return true;
  if (
    word === "--force" ||
    word.startsWith("--force=") ||
    word.startsWith("--force-with-lease") ||
    word.startsWith("--force-if-includes")
  ) {
    return true;
  }
  return /^-[^-]*f/.test(word);
}

function isDefaultBranchPushTarget(word: string): boolean {
  const ref = word.startsWith("+") ? word.slice(1) : word;
  const target = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
  const branch = target.startsWith("refs/heads/")
    ? target.slice("refs/heads/".length)
    : target;
  return branch === "main" || branch === "master";
}

function containsRecursiveForceRemove(words: readonly string[]): boolean {
  const commandIndex = firstCommandIndex(words, 0);
  if (commandIndex === null) return false;

  return commandAtIndexContainsRecursiveForceRemove(words, commandIndex);
}

function commandAtIndexContainsRecursiveForceRemove(
  words: readonly string[],
  commandIndex: number,
): boolean {
  const command = basename(stripShellQuotes(words[commandIndex] ?? ""));
  if (command === "rm") {
    return rmArgsTargetCriticalPath(words.slice(commandIndex + 1));
  }
  if (SHELL_SCRIPT_COMMANDS.has(command) && shellScriptContainsDanger(words, commandIndex)) {
    return true;
  }
  if (!RM_WRAPPER_COMMANDS.has(command)) return false;

  const nestedCommandIndex = commandIndexAfterWrapper(words, commandIndex, command);
  return nestedCommandIndex === null
    ? false
    : commandAtIndexContainsRecursiveForceRemove(words, nestedCommandIndex);
}

function firstCommandIndex(
  words: readonly string[],
  startIndex: number,
): number | null {
  let index = startIndex;
  while (index < words.length && isEnvironmentAssignment(words[index]!)) {
    index++;
  }
  return index < words.length ? index : null;
}

function commandIndexAfterWrapper(
  words: readonly string[],
  wrapperIndex: number,
  wrapper: string,
): number | null {
  switch (wrapper) {
    case "env":
      return envCommandIndex(words, wrapperIndex + 1);
    case "nice":
      return niceCommandIndex(words, wrapperIndex + 1);
    case "timeout":
      return timeoutCommandIndex(words, wrapperIndex + 1);
    case "stdbuf":
      return stdbufCommandIndex(words, wrapperIndex + 1);
    case "time":
      return timeCommandIndex(words, wrapperIndex + 1);
    case "command":
      return commandBuiltinCommandIndex(words, wrapperIndex + 1);
    case "exec":
      return execCommandIndex(words, wrapperIndex + 1);
    case "nohup":
      return wrapperIndex + 1 < words.length ? wrapperIndex + 1 : null;
    default:
      return null;
  }
}

function envCommandIndex(words: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (word === "-" || isEnvironmentAssignment(word)) {
      index++;
      continue;
    }
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    return index;
  }
  return null;
}

function niceCommandIndex(words: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (word === "-n" || word === "--adjustment") {
      index += 2;
      continue;
    }
    if (word.startsWith("--adjustment=") || /^-\d+$/.test(word)) {
      index++;
      continue;
    }
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    return index;
  }
  return null;
}

function timeoutCommandIndex(words: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (word === "--") {
      index++;
      break;
    }
    if (word === "-k" || word === "--kill-after" || word === "-s" || word === "--signal") {
      index += 2;
      continue;
    }
    if (
      word === "--foreground" ||
      word === "--preserve-status" ||
      word.startsWith("--kill-after=") ||
      word.startsWith("--signal=")
    ) {
      index++;
      continue;
    }
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  return index + 1 < words.length ? index + 1 : null;
}

function stdbufCommandIndex(words: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    return index;
  }
  return null;
}

function timeCommandIndex(words: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (word === "-p") {
      index++;
      continue;
    }
    return index;
  }
  return null;
}

function commandBuiltinCommandIndex(
  words: readonly string[],
  startIndex: number,
): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (!word.startsWith("-") || word === "-") return index;
    if (/[vV]/.test(word)) return null;
    index++;
  }
  return null;
}

function execCommandIndex(words: readonly string[], startIndex: number): number | null {
  let index = startIndex;
  while (index < words.length) {
    const word = stripShellQuotes(words[index]!);
    if (word === "-a") {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index++;
      continue;
    }
    return index;
  }
  return null;
}

function shellScriptContainsDanger(
  words: readonly string[],
  shellIndex: number,
): boolean {
  for (let i = shellIndex + 1; i < words.length - 1; i++) {
    const flag = stripShellQuotes(words[i]!);
    if (flag === "--") continue;
    if (isShellCommandStringFlag(flag)) {
      let scriptIndex = i + 1;
      if (stripShellQuotes(words[scriptIndex] ?? "") === "--") {
        scriptIndex++;
      }
      if (scriptIndex >= words.length) return false;
      return isDangerousShellCommand(stripShellQuotes(words[scriptIndex]!));
    }
  }
  return false;
}

function isShellCommandStringFlag(flag: string): boolean {
  if (flag === "-c") return true;
  return flag.startsWith("-") && !flag.startsWith("--") && flag.slice(1).includes("c");
}

function rmArgsTargetCriticalPath(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  let parsingFlags = true;
  const operands: string[] = [];
  for (const raw of args) {
    const word = stripShellQuotes(raw);
    if (parsingFlags && word === "--") {
      parsingFlags = false;
      continue;
    }
    if (parsingFlags && word.startsWith("-") && word !== "-") {
      if (word === "--recursive") recursive = true;
      if (word === "--force") force = true;
      if (!word.startsWith("--")) {
        recursive ||= /[rR]/.test(word);
        force ||= /[fF]/.test(word);
      }
      continue;
    }
    operands.push(word);
  }
  return recursive && force && operands.some(isCriticalRemovalTarget);
}

function splitSimpleShellWords(command: string): string[] {
  const tokens: string[] = [];
  let buffer = "";
  let inToken = false;
  let i = 0;

  const flushToken = (): void => {
    if (!inToken) return;
    tokens.push(buffer);
    buffer = "";
    inToken = false;
  };

  while (i < command.length) {
    const char = command[i]!;
    if (/\s/.test(char)) {
      flushToken();
      i++;
      continue;
    }
    if ("|&;><()".includes(char)) {
      flushToken();
      i++;
      continue;
    }

    inToken = true;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        buffer += command.slice(i + 1);
        break;
      }
      buffer += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (char === '"') {
      i = appendDoubleQuotedShellWord(command, i + 1, (value) => {
        buffer += value;
      });
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= command.length) break;
      buffer += command[i + 1]!;
      i += 2;
      continue;
    }

    buffer += char;
    i++;
  }

  flushToken();
  return tokens;
}

function appendDoubleQuotedShellWord(
  command: string,
  startIndex: number,
  append: (value: string) => void,
): number {
  let i = startIndex;
  while (i < command.length) {
    const char = command[i]!;
    if (char === '"') return i + 1;
    if (char === "\\" && i + 1 < command.length) {
      const next = command[i + 1]!;
      if (next === '"' || next === "\\" || next === "$" || next === "`") {
        append(next);
        i += 2;
        continue;
      }
    }
    append(char);
    i++;
  }
  return command.length;
}

function splitShellFragments(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];

  const fragments: string[] = [];
  let start = 0;
  let i = 0;
  while (i < trimmed.length) {
    const char = trimmed[i]!;
    if (char === "'") {
      const end = trimmed.indexOf("'", i + 1);
      i = end === -1 ? trimmed.length : end + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < trimmed.length) {
        if (trimmed[j] === "\\") {
          j += 2;
          continue;
        }
        if (trimmed[j] === '"') break;
        j++;
      }
      i = j < trimmed.length ? j + 1 : trimmed.length;
      continue;
    }
    if (char === "\\" && i + 1 < trimmed.length) {
      i += 2;
      continue;
    }

    const two = trimmed.slice(i, i + 2);
    const opLen =
      two === "&&" || two === "||"
        ? 2
        : char === ";" || char === "|" || char === "&"
          ? 1
          : 0;
    if (opLen > 0) {
      const fragment = trimmed.slice(start, i).trim();
      if (fragment.length > 0) fragments.push(fragment);
      i += opLen;
      start = i;
      continue;
    }
    i++;
  }

  const last = trimmed.slice(start).trim();
  if (last.length > 0) fragments.push(last);
  return fragments;
}

function extractShellSubstitutionCommands(command: string): string[] {
  const substitutions: string[] = [];
  let inDoubleQuotes = false;
  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    if (char === '"') {
      inDoubleQuotes = !inDoubleQuotes;
      i++;
      continue;
    }
    if (char === "'" && !inDoubleQuotes) {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (char === "$" && command[i + 1] === "(") {
      const end = findCommandSubstitutionEnd(command, i + 1);
      if (end === -1) {
        i += 2;
        continue;
      }
      substitutions.push(command.slice(i + 2, end).trim());
      i = end + 1;
      continue;
    }
    if (char === "`") {
      const end = findBacktickSubstitutionEnd(command, i + 1);
      if (end === -1) {
        i++;
        continue;
      }
      substitutions.push(command.slice(i + 1, end).trim());
      i = end + 1;
      continue;
    }
    i++;
  }
  return substitutions.filter((entry) => entry.length > 0);
}

function findCommandSubstitutionEnd(command: string, openParenIndex: number): number {
  let depth = 1;
  let i = openParenIndex + 1;
  while (i < command.length) {
    const char = command[i]!;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (char === '"' || char === "`") {
      const end = char === '"'
        ? findDoubleQuoteEnd(command, i + 1)
        : findBacktickSubstitutionEnd(command, i + 1);
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (char === "$" && command[i + 1] === "(") {
      depth++;
      i += 2;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function findBacktickSubstitutionEnd(command: string, startIndex: number): number {
  let i = startIndex;
  while (i < command.length) {
    if (command[i] === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (command[i] === "`") return i;
    i++;
  }
  return -1;
}

function findDoubleQuoteEnd(command: string, startIndex: number): number {
  let i = startIndex;
  while (i < command.length) {
    if (command[i] === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (command[i] === '"') return i;
    i++;
  }
  return -1;
}

function stripShellQuotes(word: string): string {
  if (word.length >= 2) {
    const first = word[0];
    const last = word[word.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return word.slice(1, -1);
    }
  }
  return word;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function isEnvironmentAssignment(word: string): boolean {
  return /^[A-Za-z_]\w*=/.test(stripShellQuotes(word));
}

function isCriticalRemovalTarget(target: string): boolean {
  if (isHomeShellExpansionTarget(target)) return true;
  return isDangerousRemovalPath(expandTilde(target));
}

function isHomeShellExpansionTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  return (
    normalized === "$HOME" ||
    normalized === "$HOME/" ||
    normalized === "$HOME/*" ||
    normalized === "${HOME}" ||
    normalized === "${HOME}/" ||
    normalized === "${HOME}/*"
  );
}
