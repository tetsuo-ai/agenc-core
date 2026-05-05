import {
  extractBashCommand,
  parseShellCommand,
  parseWordOnlyShellSequence,
  stripLeadingSafeEnvVars,
} from "./parser.js";
import { parsePowerShellScriptWithNativeAst } from "./powershell-parser.js";

const SIMPLE_SAFE_EXECUTABLES: ReadonlySet<string> = new Set([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const LINUX_ONLY_SAFE_EXECUTABLES: ReadonlySet<string> = new Set([
  "numfmt",
  "tac",
]);

const POWERSHELL_EXECUTABLES: ReadonlySet<string> = new Set([
  "powershell",
  "pwsh",
]);

const POWERSHELL_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "echo",
  "write-output",
  "write-host",
  "dir",
  "ls",
  "get-childitem",
  "cat",
  "type",
  "get-content",
  "select-string",
  "findstr",
  "measure-object",
  "get-location",
  "pwd",
  "test-path",
  "resolve-path",
  "select-object",
  "get-item",
]);

const POWERSHELL_REMOVE_ITEM_COMMANDS: ReadonlySet<string> = new Set([
  "remove-item",
  "ri",
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
]);

const URL_LAUNCH_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "start-process",
  "saps",
  "invoke-item",
  "ii",
  "mshta",
  "explorer",
  "iexplore",
  "chrome",
  "firefox",
  "msedge",
]);

const URL_RE = /^https?:\/\//i;

export function isKnownSafeCommand(
  command: readonly string[],
  depth = 0,
): boolean {
  if (depth > 8) return false;
  const stripped = stripSafeEnvironment(command);
  if (stripped.length === 0) return false;

  if (process.platform === "win32" && isSafeWindowsCommand(stripped)) {
    return true;
  }

  if (isSafeToCallWithExec(stripped)) return true;

  const bash = extractBashCommand(stripped);
  if (bash !== null) {
    const commands = parseWordOnlyShellSequence(bash.script);
    return (
      commands !== null &&
      commands.length > 0 &&
      commands.every((subcommand) => isKnownSafeCommand(subcommand, depth + 1))
    );
  }

  return false;
}

export function commandMightBeDangerous(
  command: readonly string[],
  depth = 0,
): boolean {
  if (depth > 8 || command.length === 0) return false;
  const stripped = stripSafeEnvironment(command);
  if (stripped.length === 0) return false;

  if (process.platform === "win32" && isDangerousWindowsCommand(stripped)) {
    return true;
  }
  if (isDangerousToCallWithExec(stripped)) return true;

  const bash = extractBashCommand(stripped);
  if (bash !== null) {
    const commands = parseWordOnlyShellSequence(bash.script);
    return (
      commands !== null &&
      commands.some((subcommand) =>
        commandMightBeDangerous(subcommand, depth + 1),
      )
    );
  }

  return false;
}

export function shellCommandIsKnownSafe(commandText: string): boolean {
  const argv = parseShellCommand(commandText);
  return argv !== null && isKnownSafeCommand(argv);
}

export function shellCommandMightBeDangerous(commandText: string): boolean {
  const argv = parseShellCommand(commandText);
  return argv !== null && commandMightBeDangerous(argv);
}

export function isDangerousWindowsCommand(command: readonly string[]): boolean {
  if (command.length === 0) return false;
  const name = executableBasename(command[0]!);
  const args = command.slice(1);

  if (POWERSHELL_EXECUTABLES.has(name)) {
    const invocation = parsePowerShellInvocation(command);
    return invocation !== null && isDangerousPowerShellScript(invocation.script);
  }

  if (name === "cmd") {
    const script = parseCmdScript(args);
    if (script === null) return false;
    return splitShellFragments(script).some((fragment) => {
      const words = splitCommandWords(fragment);
      return words.length > 0 && isDangerousWindowsCommand(words);
    });
  }

  if ((name === "del" || name === "erase") && hasSlashFlag(args, "f")) {
    return true;
  }
  if (
    (name === "rd" || name === "rmdir") &&
    hasSlashFlag(args, "s") &&
    hasSlashFlag(args, "q")
  ) {
    return true;
  }

  if (URL_LAUNCH_COMMANDS.has(name) && containsUrl(args)) return true;
  if (
    name === "rundll32" &&
    args.some((arg) => /url\.dll/i.test(arg)) &&
    args.some((arg) => /fileprotocolhandler/i.test(arg)) &&
    containsUrl(args)
  ) {
    return true;
  }

  return isDangerousPowerShellWords(command);
}

export function isSafeWindowsCommand(command: readonly string[]): boolean {
  const invocation = parsePowerShellInvocation(command);
  if (invocation === null) return false;
  const parsed = parsePowerShellScriptWithNativeAst(
    invocation.executable,
    invocation.script,
  );
  return (
    parsed.ok &&
    parsed.commands.length > 0 &&
    parsed.commands.every((words) => isSafePowerShellWords(words))
  );
}

export function isDangerousPowerShellWords(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const commandName = normalizePowerShellCommandName(words[0]!);
  const args = words.slice(1);

  if (POWERSHELL_REMOVE_ITEM_COMMANDS.has(commandName) && hasDashFlag(args, "force")) {
    return true;
  }
  if (URL_LAUNCH_COMMANDS.has(commandName) && containsUrl(args)) {
    return true;
  }
  if (
    commandName === "rundll32" &&
    args.some((arg) => /url\.dll/i.test(arg)) &&
    args.some((arg) => /fileprotocolhandler/i.test(arg)) &&
    containsUrl(args)
  ) {
    return true;
  }
  if (
    words.some((word) => /shell\.application/i.test(word)) &&
    containsUrl(words)
  ) {
    return true;
  }

  return false;
}

export function isSafePowerShellWords(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  if (words.some((word) => word === ">" || word === ">>" || word === "|>")) {
    return false;
  }
  if (isDangerousPowerShellWords(words)) return false;

  const commandName = normalizePowerShellCommandName(words[0]!);
  if (POWERSHELL_READ_ONLY_COMMANDS.has(commandName)) return true;
  if (commandName === "git") return isSafeGitCommand(words);
  if (commandName === "rg") return isSafeRipgrepCommand(words.slice(1));
  return false;
}

function stripSafeEnvironment(command: readonly string[]): readonly string[] {
  const stripped = stripLeadingSafeEnvVars(command);
  return stripped === null ? [] : stripped;
}

function isSafeToCallWithExec(command: readonly string[]): boolean {
  const name = executableBasename(command[0]!);
  const args = command.slice(1);

  if (SIMPLE_SAFE_EXECUTABLES.has(name)) return true;
  if (process.platform === "linux" && LINUX_ONLY_SAFE_EXECUTABLES.has(name)) {
    return true;
  }

  switch (name) {
    case "base64":
      return isSafeBase64Command(args);
    case "find":
      return isSafeFindCommand(args);
    case "rg":
    case "rga":
    case "ripgrep-all":
      return isSafeRipgrepCommand(args);
    case "git":
      return isSafeGitCommand(command);
    case "sed":
      return isSafeSedCommand(args);
    default:
      return false;
  }
}

function isDangerousToCallWithExec(command: readonly string[]): boolean {
  const name = executableBasename(command[0]!);
  if (name === "sudo" && command.length > 1) {
    return isDangerousToCallWithExec(command.slice(1));
  }
  if (name !== "rm") return false;
  return command.slice(1).some((arg) => {
    const lower = arg.toLowerCase();
    return lower === "--force" || /^-[a-z]*f[a-z]*$/i.test(lower);
  });
}

function isSafeBase64Command(args: readonly string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower === "--output" ||
      lower.startsWith("--output=") ||
      lower === "-o" ||
      (/^-[a-z]+$/i.test(lower) && lower.includes("o"))
    );
  });
}

function isSafeFindCommand(args: readonly string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower === "-exec" ||
      lower === "-execdir" ||
      lower === "-delete" ||
      lower === "-fprint" ||
      lower === "-fprint0" ||
      lower === "-fprintf"
    );
  });
}

function isSafeRipgrepCommand(args: readonly string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower === "--pre" ||
      lower.startsWith("--pre=") ||
      lower === "--hostname-bin" ||
      lower.startsWith("--hostname-bin=") ||
      lower === "--search-zip" ||
      lower === "-z" ||
      (/^-[a-z]+$/i.test(lower) && lower.includes("z"))
    );
  });
}

function isSafeGitCommand(command: readonly string[]): boolean {
  let i = 1;
  while (i < command.length) {
    const arg = command[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-")) break;
    if (isUnsafeGitGlobalOption(arg)) return false;
    i += gitGlobalOptionConsumesValue(arg) ? 2 : 1;
  }

  const subcommand = command[i]?.toLowerCase();
  if (subcommand === undefined) return false;
  const args = command.slice(i + 1);
  if (hasGitOutputFlag(args)) return false;

  switch (subcommand) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "grep":
    case "ls-files":
      return true;
    case "branch":
      return isSafeGitBranch(args);
    default:
      return false;
  }
}

function isUnsafeGitGlobalOption(arg: string): boolean {
  const lower = arg.toLowerCase();
  return (
    lower === "-c" ||
    lower === "--config" ||
    lower === "--config-env" ||
    lower === "--git-dir" ||
    lower === "--work-tree" ||
    lower === "--namespace" ||
    lower === "--exec-path" ||
    lower.startsWith("--config=") ||
    lower.startsWith("--config-env=") ||
    lower.startsWith("--git-dir=") ||
    lower.startsWith("--work-tree=") ||
    lower.startsWith("--namespace=") ||
    lower.startsWith("--exec-path=")
  );
}

function gitGlobalOptionConsumesValue(arg: string): boolean {
  const lower = arg.toLowerCase();
  return [
    "-c",
    "--config",
    "--config-env",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
  ].includes(lower);
}

function hasGitOutputFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return lower === "--output" || lower.startsWith("--output=");
  });
}

function isSafeGitBranch(args: readonly string[]): boolean {
  const mutating = new Set([
    "-d",
    "-m",
    "-c",
    "--delete",
    "--move",
    "--copy",
    "--set-upstream-to",
    "--unset-upstream",
    "--edit-description",
  ]);
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (mutating.has(lower) || lower.startsWith("--set-upstream-to=")) {
      return false;
    }
    if (!arg.startsWith("-")) return false;
  }
  return true;
}

function isSafeSedCommand(args: readonly string[]): boolean {
  let sawNoPrint = false;
  let sawScript = false;
  let expectingScript = false;

  for (const arg of args) {
    if (expectingScript) {
      if (!isSafeSedPrintScript(arg)) return false;
      sawScript = true;
      expectingScript = false;
      continue;
    }
    if (arg === "-n") {
      sawNoPrint = true;
      continue;
    }
    if (arg === "-e") {
      expectingScript = true;
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!sawScript && isSafeSedPrintScript(arg)) {
      sawScript = true;
      continue;
    }
  }

  return sawNoPrint && sawScript && !expectingScript;
}

function isSafeSedPrintScript(value: string): boolean {
  return /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(value);
}

function parsePowerShellInvocation(
  command: readonly string[],
): { readonly executable: string; readonly script: string } | null {
  if (command.length < 2) return null;
  const executable = command[0]!;
  if (!POWERSHELL_EXECUTABLES.has(executableBasename(executable))) return null;

  for (let i = 1; i < command.length; i++) {
    const arg = command[i]!;
    const lower = arg.toLowerCase();
    if (lower === "-command" || lower === "/command" || lower === "-c") {
      const script = command[i + 1];
      return script === undefined ? null : { executable, script };
    }
    if (lower.startsWith("-command:") || lower.startsWith("/command:")) {
      const script = arg.slice(arg.indexOf(":") + 1);
      return script.length === 0 ? null : { executable, script };
    }
    if (
      lower === "-nologo" ||
      lower === "-noprofile" ||
      lower === "-noninteractive"
    ) {
      continue;
    }
    return null;
  }

  return null;
}

function parseCmdScript(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const lower = args[i]!.toLowerCase();
    if (lower === "/c" || lower === "/r" || lower === "-c") {
      return args.slice(i + 1).join(" ");
    }
  }
  return null;
}

function isDangerousPowerShellScript(script: string): boolean {
  return splitShellFragments(script).some((fragment) => {
    const words = splitCommandWords(fragment);
    return words.length > 0 && isDangerousPowerShellWords(words);
  });
}

function splitShellFragments(script: string): readonly string[] {
  const fragments: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "\"") {
      quote = c;
      continue;
    }
    const two = script.slice(i, i + 2);
    const isSeparator = two === "&&" || two === "||" || c === "&" || c === "|" || c === ";";
    if (isSeparator) {
      const fragment = script.slice(start, i).trim();
      if (fragment.length > 0) fragments.push(fragment);
      i += two === "&&" || two === "||" ? 1 : 0;
      start = i + 1;
    }
  }
  const tail = script.slice(start).trim();
  if (tail.length > 0) fragments.push(tail);
  return fragments;
}

function splitCommandWords(command: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (c === "'" || c === "\"") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current.length > 0) words.push(current);
  return words;
}

function hasSlashFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return lower === `/${flag}` || lower.startsWith(`/${flag}:`);
  });
}

function hasDashFlag(args: readonly string[], flag: string): boolean {
  const wanted = flag.toLowerCase();
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    if (wanted === "force" && /^-f(?:o(?:r(?:c(?:e)?)?)?)?$/i.test(lower)) {
      return true;
    }
    return lower === `-${wanted}` || lower === `--${wanted}` || lower.startsWith(`-${wanted}:`);
  });
}

function containsUrl(args: readonly string[]): boolean {
  return args.some((arg) => URL_RE.test(arg.replace(/^["']|["']$/g, "")));
}

function normalizePowerShellCommandName(value: string): string {
  return executableBasename(value);
}

function executableBasename(value: string): string {
  const withoutQuotes = value.replace(/^["']|["']$/g, "");
  const normalized = withoutQuotes.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}
