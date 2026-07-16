import {
  extractBashCommand,
  parseShellCommand,
  parseWordOnlyShellSequence,
  stripLeadingSafeEnvVars,
} from "./parser.js";

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

const POWERSHELL_ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  ["gci", "get-childitem"],
  ["gc", "get-content"],
  ["sls", "select-string"],
  ["measure", "measure-object"],
  ["gl", "get-location"],
  ["tp", "test-path"],
  ["rvpa", "resolve-path"],
  ["select", "select-object"],
  ["gi", "get-item"],
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

const POWERSHELL_UNSAFE_COMMANDS: ReadonlySet<string> = new Set([
  "set-content",
  "add-content",
  "out-file",
  "new-item",
  "move-item",
  "copy-item",
  "rename-item",
  "start-process",
  "stop-process",
  ...POWERSHELL_REMOVE_ITEM_COMMANDS,
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

const URL_RE = /https?:\/\/[^\s"'`)]+/i;

export function isKnownSafeCommand(
  command: readonly string[],
  depth = 0,
): boolean {
  return isKnownSafeCommandForPlatform(command, process.platform, depth);
}

export function isKnownSafeCommandForPlatform(
  command: readonly string[],
  platform: NodeJS.Platform,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  const stripped = stripSafeEnvironment(command);
  if (stripped.length === 0) return false;

  if (platform === "win32") {
    return isSafeWindowsCommand(stripped);
  }

  if (isSafeToCallWithExec(stripped, platform)) return true;

  const bash = extractBashCommand(stripped);
  if (bash !== null) {
    const commands = parseWordOnlyShellSequence(bash.script);
    return (
      commands !== null &&
      commands.length > 0 &&
      commands.every((subcommand) =>
        isKnownSafeCommandForPlatform(subcommand, platform, depth + 1),
      )
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
    const invocation = parsePowerShellInvocation(command, "dangerous");
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
  const invocation = parsePowerShellInvocation(command, "safe");
  if (invocation === null) return false;
  // Native AST parsing starts a PowerShell process. This synchronous safety
  // classifier has no authenticated session broker, so it must conservatively
  // decline auto-allow instead of executing a parser outside the sandbox.
  return false;
}

export function isDangerousPowerShellWords(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const commandName = normalizePowerShellCommandName(words[0]!);
  const args = words.slice(1);

  const joined = words.join(" ");
  if (containsPowerShellForcedDelete(words)) {
    return true;
  }
  if (containsPowerShellUrlLaunch(words)) {
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
    /shell\.application/i.test(joined) &&
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
  if (containsPowerShellCommand(words, POWERSHELL_UNSAFE_COMMANDS)) {
    return false;
  }

  const commandName = normalizePowerShellCommandName(words[0]!);
  if (POWERSHELL_READ_ONLY_COMMANDS.has(commandName)) return true;
  if (commandName === "git") return isSafeWindowsPowerShellGitCommand(words);
  if (commandName === "rg") return isSafeRipgrepCommand(words.slice(1));
  return false;
}

function stripSafeEnvironment(command: readonly string[]): readonly string[] {
  const stripped = stripLeadingSafeEnvVars(command);
  return stripped === null ? [] : stripped;
}

function isSafeToCallWithExec(
  command: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const name = executableBasename(command[0]!);
  const args = command.slice(1);

  if (SIMPLE_SAFE_EXECUTABLES.has(name)) return true;
  if (platform === "linux" && LINUX_ONLY_SAFE_EXECUTABLES.has(name)) {
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
      lower === "-ok" ||
      lower === "-okdir" ||
      lower === "-delete" ||
      lower === "-fls" ||
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
      return true;
    case "branch":
      return isSafeGitBranch(args);
    default:
      return false;
  }
}

function isSafeWindowsPowerShellGitCommand(command: readonly string[]): boolean {
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
    case "branch":
    case "cat-file":
      return subcommand === "branch" ? isSafeGitBranch(args) : true;
    default:
      return false;
  }
}

function isUnsafeGitGlobalOption(arg: string): boolean {
  const lower = arg.toLowerCase();
  return (
    lower === "-c" ||
    lower.startsWith("-c") ||
    lower === "--config" ||
    lower === "--config-env" ||
    lower === "--git-dir" ||
    lower === "--work-tree" ||
    lower === "--namespace" ||
    lower === "--exec-path" ||
    lower === "--super-prefix" ||
    lower === "--paginate" ||
    lower === "-p" ||
    lower.startsWith("--config=") ||
    lower.startsWith("--config-env=") ||
    lower.startsWith("--git-dir=") ||
    lower.startsWith("--work-tree=") ||
    lower.startsWith("--namespace=") ||
    lower.startsWith("--exec-path=") ||
    lower.startsWith("--super-prefix=")
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
    "--super-prefix",
  ].includes(lower);
}

function hasGitOutputFlag(args: readonly string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower === "--output" ||
      lower.startsWith("--output=") ||
      lower === "--ext-diff" ||
      lower === "--textconv" ||
      lower === "--exec" ||
      lower.startsWith("--exec=") ||
      lower === "--paginate"
    );
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
  mode: "safe" | "dangerous",
): { readonly executable: string; readonly script: string } | null {
  if (command.length < 2) return null;
  const executable = command[0]!;
  if (!POWERSHELL_EXECUTABLES.has(executableBasename(executable))) return null;

  for (let i = 1; i < command.length; i++) {
    const arg = command[i]!;
    const lower = arg.toLowerCase();
    if (lower === "-command" || lower === "/command" || lower === "-c") {
      const rest = command.slice(i + 1);
      if (rest.length === 0) return null;
      return mode === "safe" && rest.length !== 1
        ? null
        : { executable, script: rest.join(" ") };
    }
    if (lower.startsWith("-command:") || lower.startsWith("/command:")) {
      const script = arg.slice(arg.indexOf(":") + 1);
      return script.length === 0 ? null : { executable, script };
    }
    if (
      lower === "-nologo" ||
      lower === "-noprofile" ||
      lower === "-noninteractive" ||
      lower === "-mta" ||
      lower === "-sta"
    ) {
      continue;
    }
    if (mode === "dangerous" && lower.startsWith("-")) {
      if (powershellFlagConsumesValue(lower)) i++;
      continue;
    }
    if (mode === "dangerous") {
      return { executable, script: command.slice(i).join(" ") };
    }
    if (mode === "safe" && !lower.startsWith("-")) {
      return { executable, script: command.slice(i).join(" ") };
    }
    return null;
  }

  return null;
}

function powershellFlagConsumesValue(flag: string): boolean {
  return [
    "-executionpolicy",
    "-ep",
    "-inputformat",
    "-outputformat",
    "-windowstyle",
    "-workingdirectory",
    "-wd",
    "-file",
    "-f",
    "-encodedcommand",
    "-enc",
  ].includes(flag);
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
  const name = executableBasename(
    value
      .replace(/^[\s("'`&]+/g, "")
      .replace(/[\s)"'`,;]+$/g, "")
      .split("(")[0] ?? value,
  );
  return POWERSHELL_ALIAS_MAP.get(name) ?? name;
}

function containsPowerShellForcedDelete(words: readonly string[]): boolean {
  const expanded = expandPowerShellSoftTokens(words);
  return (
    containsPowerShellCommand(expanded, POWERSHELL_REMOVE_ITEM_COMMANDS) &&
    expanded.some((word) => hasDashFlag([normalizePowerShellToken(word)], "force"))
  );
}

function containsPowerShellUrlLaunch(words: readonly string[]): boolean {
  if (!containsUrl(words)) return false;
  const joined = words.join(" ");
  return (
    containsPowerShellCommand(words, URL_LAUNCH_COMMANDS) ||
    /(?:^|[\s(;])(?:start-process|saps|invoke-item|ii|mshta|explorer|iexplore|chrome|firefox|msedge)\s*\(/i.test(joined) ||
    /(?:shellexecute|shell\.application|fileprotocolhandler)/i.test(joined)
  );
}

function containsPowerShellCommand(
  words: readonly string[],
  commands: ReadonlySet<string>,
): boolean {
  return expandPowerShellSoftTokens(words).some((word) =>
    commands.has(normalizePowerShellCommandName(word)),
  );
}

function normalizePowerShellToken(value: string): string {
  return value.replace(/^[\s("'`]+/g, "").replace(/[\s)"'`,;]+$/g, "");
}

function expandPowerShellSoftTokens(words: readonly string[]): readonly string[] {
  return words.flatMap((word) =>
    word
      .split(/[,\[\]()]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

function executableBasename(value: string): string {
  const withoutQuotes = value.replace(/^["']|["']$/g, "");
  const normalized = withoutQuotes.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}
