import path from "node:path";
import {
  SAFE_ENV_VARS,
  extractShellWrapperScripts,
  parseShellCommand,
  shlexJoin,
  splitCommand,
} from "../shell-command/parser.js";
import { parseShellWrapperOptions } from "../utils/shell/wrapper-options.js";

const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const OPAQUE_LAUNCHERS = /^(?:python[\d.]*|node|nodejs|perl|ruby|lua|eval|source|\.|busybox|pkexec|su|runuser|ssh|chroot|chrt|taskset|parallel|cmd|powershell|pwsh)$/;

/** Restriction-only parsing. Never use this to grant a shell command. */
export function shellRestrictionParts(text: string): {
  readonly commands: readonly string[];
  readonly opaque: boolean;
} {
  const parts = splitCommand(text);
  if (parts.length > 1) return { commands: parts, opaque: false };
  const words = parseShellCommand(text);
  if (words === null || words.length === 0) return { commands: [], opaque: true };
  let at = 0;
  while (ASSIGNMENT.test(words[at] ?? "")) {
    if (!SAFE_ENV_VARS.has(words[at]!.split("=")[0]!)) return { commands: [], opaque: true };
    at++;
  }
  const argv = words.slice(at);
  const name = path.posix.basename(argv[0] ?? "").toLowerCase();
  if (SHELLS.has(name)) {
    if (parseShellWrapperOptions(name, argv.slice(1)).kind !== "code") return { commands: [], opaque: true };
    const scripts = extractShellWrapperScripts(argv);
    return { commands: scripts ?? [], opaque: scripts === null || scripts.length === 0 };
  }
  const scripts = extractShellWrapperScripts(argv);
  if (scripts !== null) return { commands: scripts, opaque: scripts.length === 0 || scripts.some(s => s.startsWith("-")) };
  if (OPAQUE_LAUNCHERS.test(name)) return { commands: [], opaque: true };
  const launch = launcherCommand(name, argv);
  if (launch !== undefined) {
    return { commands: launch === null ? [] : [shlexJoin(launch)], opaque: launch === null || name === "xargs" };
  }
  // Literal quoting and executable paths cannot hide the same command.
  const normalized = [name, ...argv.slice(1)];
  return { commands: [shlexJoin(normalized)], opaque: name.length === 0 };
}

/** undefined = ordinary executable, null = launcher whose action is unknown. */
function launcherCommand(name: string, argv: readonly string[]): readonly string[] | null | undefined {
  let at = 1;
  let flags: readonly string[];
  let values: readonly string[];
  switch (name) {
    case "env":
      flags = ["-i", "--ignore-environment", "--debug", "-v"];
      values = ["-u", "--unset", "-C", "--chdir", "-a", "--argv0"];
      break;
    case "command": flags = ["-p"]; values = []; break;
    case "builtin": flags = []; values = []; break;
    case "exec": flags = ["-c", "-l"]; values = ["-a"]; break;
    case "nice": flags = []; values = ["-n", "--adjustment"]; break;
    case "nohup": flags = []; values = []; break;
    case "timeout":
      flags = ["--preserve-status", "--foreground", "-v", "--verbose"];
      values = ["-s", "--signal", "-k", "--kill-after"];
      break;
    case "sudo":
      flags = ["-n", "--non-interactive", "-E", "--preserve-env", "-H", "--set-home", "-S", "--stdin", "-k", "-K", "-b", "--background"];
      values = ["-u", "--user", "-g", "--group", "-D", "--chdir", "-R", "--chroot", "-p", "--prompt", "-h", "--host", "-r", "--role", "-t", "--type", "-T", "--command-timeout"];
      break;
    case "doas": flags = ["-n", "-L"]; values = ["-u", "-C"]; break;
    case "xargs":
      flags = ["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x", "--exit"];
      values = ["-I", "--replace", "-n", "--max-args", "-L", "--max-lines", "-s", "--max-chars", "-P", "--max-procs", "-E", "--eof", "-d", "--delimiter", "-a", "--arg-file"];
      break;
    case "stdbuf": flags = []; values = ["-i", "--input", "-o", "--output", "-e", "--error"]; break;
    case "setsid": flags = ["-c", "--ctty", "-f", "--fork", "-w", "--wait"]; values = []; break;
    case "time": flags = ["-p", "-v", "--verbose", "-a", "--append", "-q", "--quiet"]; values = ["-f", "--format", "-o", "--output"]; break;
    case "ionice": flags = ["-t", "--ignore"]; values = ["-c", "--class", "-n", "--classdata"]; break;
    default: return undefined;
  }
  while (at < argv.length) {
    const word = argv[at]!;
    if (word === "--") { at++; break; }
    if (!word.startsWith("-")) break;
    if (name === "nice" && /^-\d+$/.test(word)) { at++; continue; }
    if (flags.includes(word)) { at++; continue; }
    if (values.includes(word)) {
      if (argv[at + 1] === undefined) return null;
      at += 2;
      continue;
    }
    if (values.some(option => option.startsWith("--") ? word.startsWith(option + "=") : word.startsWith(option) && word.length > option.length)) {
      at++; continue;
    }
    // Unknown flag arity, env -S parsing and shell-selection flags must not
    // turn a restriction into a grant. xargs input is also inherently opaque.
    return null;
  }
  if (name === "timeout") {
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(argv[at] ?? "")) return null;
    at++;
  }
  if (name === "env" || name === "sudo") {
    while (ASSIGNMENT.test(argv[at] ?? "")) {
      if (!SAFE_ENV_VARS.has(argv[at]!.split("=")[0]!)) return null;
      at++;
    }
  }
  return at < argv.length ? argv.slice(at) : null;
}
