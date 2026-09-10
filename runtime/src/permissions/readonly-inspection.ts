import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lexShellCommand, isDirectExecEligible } from "../utils/shell/command-line.js";
import { validateFlags, type ExternalCommandConfig, type FlagArgType } from "../utils/shell/readOnlyCommandValidation.js";
import type { UnifiedExecRuntimeSandbox } from "../unified-exec/types.js";
import { networkPolicyEnabled } from "../sandbox/engine/index.js";

export interface ReadOnlyInspectionCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly readPaths: readonly string[];
}

export interface ReadOnlyInspectionInvocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly runtimeSandbox: UnifiedExecRuntimeSandbox;
}

export type ReadOnlyInspectionResult =
  | { readonly allowed: true; readonly invocation: ReadOnlyInspectionCommand }
  | { readonly allowed: false; readonly reason: string };

const FLAGS = (none: string[], values: Record<string, FlagArgType> = {}): ExternalCommandConfig => ({
  safeFlags: Object.fromEntries([...none.map((name) => [name, "none"]), ...Object.entries(values)]),
});

const INSPECTION_COMMANDS: Readonly<Record<string, ExternalCommandConfig>> = Object.freeze({
  pwd: FLAGS(["-L", "-P"]),
  ls: FLAGS(["-a", "-A", "-l", "-h", "-n", "-d", "-R", "-t", "-r", "-S", "-1", "--all", "--almost-all", "--directory", "--recursive", "--human-readable"]),
  cat: FLAGS(["-n", "-b", "-s", "-v", "-E", "-T", "-A", "--number", "--show-all"]),
  head: FLAGS(["-q", "-v", "--quiet", "--verbose"], { "-n": "number", "--lines": "number", "-c": "number", "--bytes": "number" }),
  tail: FLAGS(["-q", "-v", "--quiet", "--verbose"], { "-n": "number", "--lines": "number", "-c": "number", "--bytes": "number" }),
  wc: FLAGS(["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"]),
  grep: FLAGS(["-r", "-R", "-n", "-i", "-v", "-l", "-L", "-c", "-w", "-x", "-F", "-E", "-H", "-h", "-o", "-s", "--recursive", "--line-number", "--ignore-case", "--fixed-strings", "--files-with-matches"], { "-e": "string", "--regexp": "string", "-A": "number", "-B": "number", "-C": "number", "-m": "number", "--include": "string", "--exclude": "string", "--exclude-dir": "string" }),
  rg: FLAGS(["-n", "-i", "-S", "-v", "-l", "-c", "-w", "-x", "-F", "-H", "-o", "-u", "--files", "--hidden", "--no-ignore", "--no-ignore-vcs", "--line-number", "--ignore-case", "--fixed-strings", "--files-with-matches", "--files-without-match", "--count", "--json", "--no-heading", "--heading", "--column", "--no-config"], { "-e": "string", "--regexp": "string", "-g": "string", "--glob": "string", "-t": "string", "--type": "string", "-T": "string", "-A": "number", "-B": "number", "-C": "number", "-m": "number", "--max-count": "number", "--max-depth": "number" }),
  "git status": FLAGS(["--short", "-s", "--branch", "-b", "--porcelain", "--long", "--untracked-files", "--ignored"]),
  "git diff": FLAGS(["--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--check", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", "--exit-code", "--quiet", "-p", "-u", "-w", "--ignore-all-space"]),
  "git log": FLAGS(["--oneline", "--graph", "--all", "--decorate", "--no-decorate", "--stat", "--name-only", "--name-status", "--no-color", "--no-ext-diff", "--no-textconv", "--reverse", "--first-parent", "-p"], { "-n": "number", "--max-count": "number", "--since": "string", "--until": "string", "--author": "string", "--grep": "string" }),
  "git show": FLAGS(["--stat", "--name-only", "--name-status", "--oneline", "--no-color", "--no-ext-diff", "--no-textconv", "-p", "-s"]),
  "git ls-files": FLAGS(["--cached", "--deleted", "--modified", "--others", "--ignored", "--exclude-standard", "--stage", "-s", "-z"]),
  "git branch": FLAGS(["--list", "-l", "--all", "-a", "--remotes", "-r", "--show-current", "-v", "-vv", "--no-color"]),
  "git merge-base": FLAGS(["--all", "--is-ancestor", "--octopus", "--independent", "--fork-point"]),
  "git rev-parse": FLAGS(["--show-toplevel", "--show-prefix", "--git-dir", "--absolute-git-dir", "--is-inside-work-tree", "--verify", "--short", "--abbrev-ref", "--symbolic-full-name"]),
});

const invocationByArgs = new WeakMap<object, ReadOnlyInspectionInvocation>();
const identityByInvocation = new WeakMap<object, string>();

function refusal(reason: string): ReadOnlyInspectionResult {
  return { allowed: false, reason: `Read-only inspection: ${reason}` };
}

function inside(target: string, root: string): boolean {
  const suffix = relative(root, target);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function positionalArguments(args: readonly string[], config: ExternalCommandConfig): string[] {
  const positional: string[] = [];
  let operandsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (operandsOnly) { positional.push(argument); continue; }
    if (argument === "--") { operandsOnly = true; continue; }
    if (!argument.startsWith("-") || argument === "-") { positional.push(argument); continue; }
    const flag = argument.split("=", 1)[0]!;
    const kind = config.safeFlags[flag];
    if (kind !== undefined && kind !== "none" && !argument.includes("=")) index += 1;
  }
  return positional;
}

export function inspectReadOnlyCommand(toolName: string, input: unknown, cwd: string, options: { readonly enforceWorkspaceBoundary?: boolean; readonly allowWorktreeGitInspection?: boolean } = {}): ReadOnlyInspectionResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return refusal("arguments must be an object");
  const record = input as Record<string, unknown>;
  if (record.shell !== undefined || record.login === true || record.tty === true || record.run_in_background === true || record.sandbox_permissions === "require_escalated" || record.additional_permissions !== undefined) {
    return refusal("shell profiles, interactive execution, background flags, and wider permissions are unavailable");
  }
  const raw = toolName === "exec_command" ? record.cmd : record.command;
  if (typeof raw !== "string" || raw.length > 32_768) return refusal("a bounded literal command is required");
  const parsed = lexShellCommand(raw);
  if (!isDirectExecEligible(parsed)) return refusal("use one literal command without expansion, pipes, redirects, or chaining");
  const words = parsed.tokens.map((token) => token.value);
  if (toolName === "system.bash" && record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) return refusal("direct arguments must be literal strings");
    words.push(...record.args as string[]);
  }
  const command = words.shift();
  if (!command || !/^[a-z][a-z-]*$/u.test(command)) return refusal("use a supported installed command name, not a path or wrapper");
  const configKey = command === "git" ? `git ${words[0] ?? ""}` : command;
  const config = INSPECTION_COMMANDS[configKey];
  if (config === undefined) return refusal(`${configKey} is not a supported inspection command`);
  if (options.allowWorktreeGitInspection !== true && ["git status", "git diff"].includes(configKey)) return refusal("worktree Git inspection can invoke repository-defined filters; use native file inspection or object-only Git log/show");
  const operands = command === "git" ? words.slice(1) : words;
  if (!validateFlags([...operands], 0, config, { commandName: command })) return refusal("an option is unsupported or can change state");
  const positional = positionalArguments(operands, config);
  const commandOptions = operands.slice(0, operands.includes("--") ? operands.indexOf("--") : operands.length);
  if (configKey === "git branch" && positional.length > 0 && !commandOptions.includes("--list")) return refusal("branch names require explicit --list; creating branches is forbidden");
  if (configKey === "git status" && positional.length > 0 && !operands.includes("--")) return refusal("status paths require --");
  if (command === "pwd" && positional.length > 0) return refusal("pwd accepts no path operands");
  const requestedCwd = toolName === "exec_command" ? record.workdir : record.cwd;
  if (requestedCwd !== undefined && typeof requestedCwd !== "string") return refusal("working directory must be a string");
  const workdir = resolve(cwd, requestedCwd as string | undefined ?? ".");
  if (options.enforceWorkspaceBoundary !== false && !inside(workdir, resolve(cwd))) return refusal("the working directory must remain inside the assigned project");
  let paths = positional;
  if (command === "git") {
    const separator = operands.indexOf("--");
    paths = separator >= 0 ? operands.slice(separator + 1) : configKey === "git ls-files" ? positional : [];
  } else if (command === "grep" || command === "rg") {
    const explicitPattern = operands.some((argument) => argument === "-e" || argument === "--regexp" || argument.startsWith("--regexp="));
    if (!explicitPattern && !operands.includes("--files")) paths = positional.slice(1);
  }
  const readPaths = [workdir, ...paths.filter((operand) => operand !== "-").map((operand) => resolve(workdir, operand))];
  if (options.enforceWorkspaceBoundary !== false && readPaths.some((target) => !inside(target, resolve(cwd)))) return refusal("path operands must remain inside the assigned project");
  return { allowed: true, invocation: Object.freeze({ command, args: Object.freeze(words), cwd: workdir, readPaths: Object.freeze(readPaths) }) };
}

function executableIdentity(program: string): string {
  const stat = statSync(program, { bigint: true });
  if (!stat.isFile()) throw new Error("Read-only inspection executable is not a regular file");
  if (process.platform !== "win32" && (stat.uid !== 0n || (stat.mode & 0o022n) !== 0n || (stat.mode & 0o111n) === 0n)) {
    throw new Error("Read-only inspection requires a system-owned executable that users cannot replace");
  }
  if (process.platform !== "win32") {
    let directory = dirname(program);
    for (;;) {
      const parentStat = statSync(directory, { bigint: true });
      if (parentStat.uid !== 0n || (parentStat.mode & 0o022n) !== 0n) throw new Error("Read-only inspection executable directory is writable by an untrusted user");
      if (dirname(directory) === directory) break;
      directory = dirname(directory);
    }
  }
  const descriptor = openSync(program, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4 || !["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(header.toString("hex")) && header.subarray(0, 2).toString() !== "MZ") {
      throw new Error("Read-only inspection requires a native executable, not a script shim");
    }
  } finally { closeSync(descriptor); }
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function trustedInspectionExecutable(command: string, cwd: string): string {
  if (process.platform === "win32") throw new Error("Read-only shell inspection requires verified executable ownership; use native read tools on Windows");
  const directories = ["/usr/bin", "/bin", "/usr/local/bin"];
  for (const directory of directories) {
    try {
      const program = realpathSync(resolve(directory, command));
      if (inside(program, realpathSync(cwd))) continue;
      executableIdentity(program);
      return program;
    } catch { continue; }
  }
  throw new Error(`Read-only inspection requires a trusted installed ${command} executable`);
}

export function prepareReadOnlyInspectionInvocation(
  inspection: ReadOnlyInspectionCommand,
  runtimeSandbox: UnifiedExecRuntimeSandbox,
): ReadOnlyInspectionInvocation {
  if (runtimeSandbox.preference !== "require" || runtimeSandbox.permissionProfile.fileSystem.kind !== "restricted" || runtimeSandbox.permissionProfile.fileSystem.entries.some((entry) => entry.access === "write") || networkPolicyEnabled(runtimeSandbox.permissionProfile.network)) {
    throw new Error("Read-only inspection requires mandatory no-write, no-network platform isolation");
  }
  const program = trustedInspectionExecutable(inspection.command, inspection.cwd);
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  if (process.platform === "win32" && process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  let args = [...inspection.args];
  if (inspection.command === "rg") args = ["--no-config", ...args];
  if (inspection.command === "git") {
    const subcommand = args.shift()!;
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "", GIT_ASKPASS: "", GIT_NO_LAZY_FETCH: "1" });
    args = ["--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "diff.external=", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "log.showSignature=false", "-c", "format.pretty=medium", "-c", "submodule.recurse=false", subcommand,
      ...(["diff", "log", "show"].includes(subcommand) ? ["--no-ext-diff", "--no-textconv"] : []), ...args];
  }
  const invocation = Object.freeze({ program, args: Object.freeze(args), cwd: inspection.cwd, env: Object.freeze(env), runtimeSandbox });
  identityByInvocation.set(invocation, executableIdentity(program));
  return invocation;
}

export function attachReadOnlyInspectionInvocation(args: object, invocation: ReadOnlyInspectionInvocation): void {
  invocationByArgs.set(args, invocation);
}

export function readReadOnlyInspectionInvocation(args: object): ReadOnlyInspectionInvocation | undefined {
  const invocation = invocationByArgs.get(args);
  if (invocation !== undefined) assertReadOnlyInspectionInvocation(invocation);
  return invocation;
}

export function assertReadOnlyInspectionInvocation(invocation: ReadOnlyInspectionInvocation): void {
  if (identityByInvocation.get(invocation) !== executableIdentity(invocation.program)) {
    throw new Error("Read-only inspection executable changed before launch or invocation authority is missing");
  }
}
