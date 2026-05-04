/**
 * Ports upstream `src/utils/permissions/dangerousPatterns.ts` constants into
 * the live permission-mode path.
 *
 * The constants are intentionally separate from `mode.ts` so rule stripping
 * uses the same shared Bash/PowerShell interpreter list as the upstream
 * permission setup code instead of an inline subset.
 */

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
 * removal of absolute paths must never be hidden by broad allow rules.
 */
export const DANGEROUS_SHELL_COMMAND_PATTERNS: readonly DangerousShellCommandPattern[] = [
  {
    matches: isRecursiveForceRemoveOfAbsolutePath,
    label: "rm -rf absolute path",
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
    pattern: /\bgit\s+push\s+(--force|-f)\b[^;&|]*\b(main|master)\b/,
    label: "git push --force main",
  },
  {
    pattern: /\bgit\s+push\b[^;&|]*\b(main|master)\b[^;&|]*\s(--force|-f)\b/,
    label: "git push main --force",
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
  for (const entry of DANGEROUS_SHELL_COMMAND_PATTERNS) {
    if (entry.matches?.(command) === true) return entry.label;
    if (entry.pattern?.test(command) === true) return entry.label;
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

function isRecursiveForceRemoveOfAbsolutePath(command: string): boolean {
  const fragments = splitShellFragments(command);
  if (fragments.length > 1) {
    return fragments.some((fragment) =>
      isRecursiveForceRemoveOfAbsolutePath(fragment),
    );
  }

  const words = splitSimpleShellWords(command);
  if (words.length === 0) return false;

  return containsRecursiveForceRemove(words);
}

function containsRecursiveForceRemove(words: readonly string[]): boolean {
  let commandIndex = 0;
  while (
    commandIndex < words.length &&
    /^[A-Za-z_]\w*=/.test(words[commandIndex]!)
  ) {
    commandIndex++;
  }
  if (basename(stripShellQuotes(words[commandIndex] ?? "")) !== "rm") {
    return containsWrappedRecursiveForceRemove(words, commandIndex);
  }

  return rmArgsTargetAbsolutePath(words.slice(commandIndex + 1));
}

function containsWrappedRecursiveForceRemove(
  words: readonly string[],
  commandIndex: number,
): boolean {
  const command = basename(stripShellQuotes(words[commandIndex] ?? ""));
  if (SHELL_SCRIPT_COMMANDS.has(command) && shellScriptContainsDanger(words, commandIndex)) {
    return true;
  }
  if (!RM_WRAPPER_COMMANDS.has(command)) return false;

  for (let i = commandIndex + 1; i < words.length; i++) {
    const candidate = basename(stripShellQuotes(words[i]!));
    if (candidate === "rm" && rmArgsTargetAbsolutePath(words.slice(i + 1))) {
      return true;
    }
    if (SHELL_SCRIPT_COMMANDS.has(candidate) && shellScriptContainsDanger(words, i)) {
      return true;
    }
  }
  return false;
}

function shellScriptContainsDanger(
  words: readonly string[],
  shellIndex: number,
): boolean {
  for (let i = shellIndex + 1; i < words.length - 1; i++) {
    const flag = stripShellQuotes(words[i]!);
    if (flag === "-c" || flag === "-lc") {
      return isRecursiveForceRemoveOfAbsolutePath(stripShellQuotes(words[i + 1]!));
    }
  }
  return false;
}

function rmArgsTargetAbsolutePath(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  let parsingFlags = true;
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
    if (recursive && force && isAbsoluteOrHomeTarget(word)) return true;
  }
  return false;
}

function splitSimpleShellWords(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
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

function isAbsoluteOrHomeTarget(target: string): boolean {
  return target === "~" || target.startsWith("~/") || target.startsWith("/");
}
