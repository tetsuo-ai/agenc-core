import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

import {
  getShellRedirectOperator,
  isShellCommandSeparator,
  lexShellCommand,
  type ShellToken,
} from "../utils/shell/command-line.js";
import { analyzeSedWrites } from "../utils/shell/sed-writes.js";

const SHELL_WORKSPACE_WRITE_TOOL_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "system.bash",
]);
const SHELL_WRAPPER_COMMANDS = new Set([
  "bash",
  "dash",
  "ksh",
  "sh",
  "zsh",
]);
const WRITE_REDIRECT_OPERATORS = new Set([
  ">",
  ">>",
  ">|",
  ">&",
  "&>",
  "&>>",
  "<>",
]);
const WORKSPACE_GENERATED_ROOTS = new Set([
  "build",
  "coverage",
  "dist",
  "logs",
  ".cache",
  "tmp",
]);
/**
 * Commands whose operands are removed from the filesystem. A removal is a
 * file mutation the file tools cannot perform (Edit and Write cannot delete),
 * so the policy allows it inside the workspace when the session may edit
 * without prompting, instead of treating it as an untracked content write.
 */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink"]);
/** Path segments that mark a path as protected from shell removal. */
const PROTECTED_DELETION_SEGMENTS = new Set([".git", ".agenc", ".agents"]);
/** Shell and git configuration files a shell command may not remove. */
const PROTECTED_DELETION_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
]);
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]?$/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const DYNAMIC_SHELL_TARGET_RE = /(?:[$*?\[\]{}~]|`|\$\(|<\()/;

/**
 * Pseudo-device targets that are always safe to redirect into: they never
 * mutate the filesystem (`2>/dev/null`, `>/dev/stdout`, `>/dev/fd/1`, …).
 * Treating them as workspace-escaping write targets makes the sandbox deny
 * utterly routine commands (`2>/dev/null` under plan mode) — observed as a
 * session-poisoning SandboxDeniedError. `/dev/tty` is deliberately NOT
 * listed: writing to the user's terminal is an interactive side effect the
 * policy should still see.
 */
const SAFE_PSEUDO_DEVICE_TARGETS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);
const SAFE_PSEUDO_DEVICE_FD_RE = /^\/dev\/fd\/\d+$/;

/** Matches the name exactly: ` /dev/null` with a blank is a workspace path. */
export function isSafePseudoDevicePath(path: string): boolean {
  return SAFE_PSEUDO_DEVICE_TARGETS.has(path) || SAFE_PSEUDO_DEVICE_FD_RE.test(path);
}

export interface ShellWorkspaceWritePolicyDecision {
  readonly blocked: boolean;
  readonly indeterminate: boolean;
  /** Every path the command writes, removes, or moves onto. */
  readonly observedTargets: readonly string[];
  /** Content writes the policy refused (workspace files outside generated roots). */
  readonly blockedTargets: readonly string[];
  /**
   * Workspace paths the command removes or replaces by a move and that the
   * policy lets through. Callers use them to back the files up before the
   * command runs.
   */
  readonly deletionTargets: readonly string[];
  /** Removals and moves the policy refused. */
  readonly blockedDeletions: readonly string[];
  readonly message?: string;
}

export interface ShellWorkspaceWritePolicyInput {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot?: string;
  readonly validationPhase?: "preflight" | "execution";
  /**
   * Whether this call may remove or move files that already exist in the
   * workspace: true when the session's permission mode allows edits without
   * prompting or the call was approved by the session's approval resolver.
   * Absent or false, such removals are refused with a message that names the
   * approval path.
   */
  readonly allowWorkspaceDeletions?: boolean;
  /** Extra roots (the AgenC home) that a shell command may never remove. */
  readonly protectedRoots?: readonly string[];
  /**
   * Directories the user added with `--add-dir` or approved during the
   * session. A shell command may remove or move files under them the way it
   * may inside the workspace: without a prompt when `allowWorkspaceDeletions`
   * is set, otherwise after approval. Content writes there were never
   * refused, since they are outside the workspace.
   */
  readonly additionalRoots?: readonly string[];
  /**
   * The session bypasses approvals and runs without a sandbox
   * (`--dangerously-bypass-approvals-and-sandbox`, or bypassPermissions on a
   * host that cannot sandbox). Nothing but this policy would gate a shell
   * mutation, and the user chose that, so the guards that exist only to route
   * a mutation through a prompt or the sandbox are lifted: a command whose
   * write targets cannot be determined runs, and removals outside the
   * workspace are allowed. Workspace content writes still belong to Edit and
   * Write, and the protected roots (`/`, the home, `.git`, `.agenc`, the
   * AgenC home, shell and git config files) stay refused.
   */
  readonly bypassesApprovalsAndSandbox?: boolean;
  /**
   * The host the command runs on; `process.platform` when absent. On macOS
   * and the BSDs `sed` may be BSD sed, which reads `-i` differently.
   */
  readonly platform?: NodeJS.Platform;
}

interface ShellMove {
  readonly sources: readonly string[];
  readonly destination: string;
}

interface ShellWriteTargetCollection {
  targets: string[];
  /**
   * Targets whose protected-path check runs before the generated-root and
   * outside-workspace exemptions (sed's, which are resolved through symlinks).
   */
  protectedFirstTargets: string[];
  /**
   * sed targets whose destination could not be determined, such as a symlink
   * loop. They are refused in every mode, since they could reach a protected path.
   */
  unresolvedProtectedFirst: string[];
  deletions: string[];
  moves: ShellMove[];
  indeterminate: boolean;
}

type DeletionBlockReason = "needs_approval" | "outside" | "protected";

function resolveWorkingDirectory(
  workspaceRoot: string,
  rawCwd: unknown,
): string {
  if (typeof rawCwd !== "string" || rawCwd.trim().length === 0) {
    return workspaceRoot;
  }
  const trimmed = rawCwd.trim();
  return trimmed.startsWith("/")
    ? resolvePath(trimmed)
    : resolvePath(workspaceRoot, trimmed);
}

function emptyTargetCollection(): ShellWriteTargetCollection {
  return { targets: [], protectedFirstTargets: [], unresolvedProtectedFirst: [], deletions: [], moves: [], indeterminate: false };
}

function indeterminateTargetCollection(): ShellWriteTargetCollection {
  return { ...emptyTargetCollection(), indeterminate: true };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function mergeTargetCollections(
  into: ShellWriteTargetCollection,
  from: ShellWriteTargetCollection,
): void {
  for (const target of from.targets) pushUnique(into.targets, target);
  for (const target of from.protectedFirstTargets) pushUnique(into.protectedFirstTargets, target);
  for (const target of from.unresolvedProtectedFirst) pushUnique(into.unresolvedProtectedFirst, target);
  for (const target of from.deletions) pushUnique(into.deletions, target);
  into.moves.push(...from.moves);
  into.indeterminate ||= from.indeterminate;
}

/**
 * A target exactly as the command names it: a blank at either end is part
 * of the name, so ` tmp/x` is not under tmp.
 */
function normalizeConcreteTargetPath(
  rawPath: string,
  cwd: string,
): ShellWriteTargetCollection {
  if (rawPath.length === 0 || rawPath === "-") {
    return emptyTargetCollection();
  }
  if (DYNAMIC_SHELL_TARGET_RE.test(rawPath)) {
    return indeterminateTargetCollection();
  }
  return { ...emptyTargetCollection(), targets: [resolvePath(cwd, rawPath)] };
}

function collectOperandTargets(
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const collection = emptyTargetCollection();
  let treatRemainingAsOperands = false;
  for (const token of args) {
    if (!token) continue;
    if (!treatRemainingAsOperands && token === "--") {
      treatRemainingAsOperands = true;
      continue;
    }
    if (!treatRemainingAsOperands && token.startsWith("-")) {
      continue;
    }
    mergeTargetCollections(collection, normalizeConcreteTargetPath(token, cwd));
  }
  return collection;
}

function collectDeletionTargets(
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const operands = collectOperandTargets(args, cwd);
  return {
    ...emptyTargetCollection(),
    deletions: operands.targets,
    indeterminate: operands.indeterminate,
  };
}

function isWorkspaceGeneratedOutputPath(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  if (workspaceRelation(workspaceRoot, absolutePath) !== "inside") {
    return false;
  }
  const rel = relative(workspaceRoot, absolutePath);
  const firstSegment = rel.split(/[\\/]/)[0] ?? "";
  return WORKSPACE_GENERATED_ROOTS.has(firstSegment);
}

function workspaceRelation(
  workspaceRoot: string,
  absolutePath: string,
): "root" | "inside" | "outside" {
  const rel = relative(workspaceRoot, absolutePath);
  if (rel.length === 0 || rel === ".") return "root";
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) return "outside";
  return "inside";
}

function stripRedirections(tokens: readonly ShellToken[]): ShellToken[] {
  const output: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (getShellRedirectOperator(token) !== undefined) {
      index += 1;
      continue;
    }
    output.push(token);
  }
  return output;
}

function extractWrappedShellCommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-c" || token === "-lc" || token === "-ic" || token === "--command") {
      const command = args[i + 1];
      return typeof command === "string" && command.trim().length > 0
        ? command
        : undefined;
    }
  }
  return undefined;
}

function hasWrapperScriptOperand(args: readonly string[]): boolean {
  let treatRemainingAsOperands = false;
  for (const token of args) {
    if (!token) continue;
    if (!treatRemainingAsOperands && token === "--") {
      treatRemainingAsOperands = true;
      continue;
    }
    if (!treatRemainingAsOperands && token.startsWith("-")) {
      continue;
    }
    return true;
  }
  return false;
}

function collectTeeTargets(
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  return collectOperandTargets(args, cwd);
}

function collectTouchTargets(
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  return collectOperandTargets(args, cwd);
}

interface DestinationOperands {
  readonly operands: readonly string[];
  readonly targetDirectory?: string;
}

function parseDestinationOperands(args: readonly string[]): DestinationOperands {
  const operands: string[] = [];
  let targetDirectory: string | undefined;
  let treatRemainingAsOperands = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) continue;
    if (!treatRemainingAsOperands && token === "--") {
      treatRemainingAsOperands = true;
      continue;
    }
    if (!treatRemainingAsOperands) {
      if (token === "-t" || token === "--target-directory") {
        const value = args[i + 1];
        if (typeof value === "string") {
          targetDirectory = value;
          i += 1;
        }
        continue;
      }
      if (token.startsWith("--target-directory=")) {
        targetDirectory = token.slice("--target-directory=".length);
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
    }
    operands.push(token);
  }
  return targetDirectory === undefined
    ? { operands }
    : { operands, targetDirectory };
}

function collectDestinationTarget(
  command: string,
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const { operands, targetDirectory } = parseDestinationOperands(args);
  const collection = emptyTargetCollection();
  if (targetDirectory !== undefined) {
    mergeTargetCollections(
      collection,
      normalizeConcreteTargetPath(targetDirectory, cwd),
    );
    if (collection.targets.length > 0 || collection.indeterminate) {
      return collection;
    }
  }
  const destination = operands[operands.length - 1];
  if (!destination) {
    return collection;
  }
  mergeTargetCollections(collection, normalizeConcreteTargetPath(destination, cwd));
  if (command === "install" && operands.length <= 1 && targetDirectory === undefined) {
    return emptyTargetCollection();
  }
  return collection;
}

/**
 * `mv` removes its sources and puts their content at the destination. The
 * sources are removals; the destination is decided by the classifier, which
 * knows the workspace root: a move within the workspace is a rename (the same
 * mutation class as a removal), a move from elsewhere into the workspace is a
 * content write.
 */
function collectMoveTargets(
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const { operands, targetDirectory } = parseDestinationOperands(args);
  const collection = emptyTargetCollection();
  let destinationRaw: string | undefined;
  let sourceRaws: readonly string[];
  if (targetDirectory !== undefined) {
    destinationRaw = targetDirectory;
    sourceRaws = operands;
  } else if (operands.length >= 2) {
    destinationRaw = operands[operands.length - 1];
    sourceRaws = operands.slice(0, -1);
  } else {
    destinationRaw = operands[0];
    sourceRaws = [];
  }
  if (destinationRaw === undefined) return collection;
  const destination = normalizeConcreteTargetPath(destinationRaw, cwd);
  collection.indeterminate ||= destination.indeterminate;
  const sources: string[] = [];
  for (const raw of sourceRaws) {
    const normalized = normalizeConcreteTargetPath(raw, cwd);
    collection.indeterminate ||= normalized.indeterminate;
    for (const target of normalized.targets) pushUnique(sources, target);
  }
  const destinationPath = destination.targets[0];
  if (destinationPath === undefined) {
    for (const source of sources) pushUnique(collection.deletions, source);
    return collection;
  }
  collection.moves.push({ sources, destination: destinationPath });
  return collection;
}

/** Where the command runs, as far as the targets depend on it. */
interface ShellWriteEnvironment {
  /** `sed` may be BSD sed on this host (macOS and the BSDs). */
  readonly bsdSed: boolean;
  readonly workspaceRoot: string;
}

/** Hosts whose `sed` is BSD sed unless GNU sed comes first on the PATH. */
const BSD_SED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "darwin",
  "freebsd",
  "netbsd",
  "openbsd",
]);

/** The path the kernel opens: a `..` after a symlink is not collapsed first. */
function kernelPath(cwd: string, name: string): string {
  return isAbsolute(name) ? name : `${cwd}${sep}${name}`;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The file a write to `path` reaches once the filesystem follows the
 * symlinks in it, named under the workspace root when it lands inside.
 * A symlink to something that does not exist yet is followed to the file
 * the write would create. Undefined when that cannot be read, as with a
 * symlink loop.
 */
function resolveWriteThroughSymlinks(path: string, workspaceRoot: string, depth = 0): string | undefined {
  // The kernel gives up after about 40 links; so does this.
  if (depth > 40) return undefined;
  let existing = path;
  const missing: string[] = [];
  while (!pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  let reached: string;
  try {
    reached = join(realpathSync.native(existing), ...missing);
  } catch {
    // A symlink whose destination does not exist yet: writing through it
    // creates that destination, so judge the destination. A relative link is
    // read from the link's own directory as the filesystem reaches it.
    let destination: string;
    try {
      if (!lstatSync(existing).isSymbolicLink()) return undefined;
      destination = resolvePath(realpathSync.native(dirname(existing)), readlinkSync(existing));
    } catch {
      return undefined;
    }
    return resolveWriteThroughSymlinks(join(destination, ...missing), workspaceRoot, depth + 1);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync.native(workspaceRoot);
  } catch {
    return reached;
  }
  const rel = relative(realRoot, reached);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return reached;
  return resolvePath(workspaceRoot, rel);
}

/**
 * The file `sed -i` replaces: its directory as the filesystem reaches it,
 * its name as written, since sed replaces a symlink there rather than the
 * file it points to. Undefined when the directory cannot be resolved.
 */
function resolveInPlaceTarget(path: string, workspaceRoot: string): string | undefined {
  const directory = resolveWriteThroughSymlinks(dirname(path), workspaceRoot);
  return directory === undefined ? undefined : join(directory, basename(path));
}

/**
 * `sed` writes its in-place files, their backups, and the files its script
 * names in `w` commands. The script itself is not a path. Names are taken
 * exactly as sed opens them, blanks included. An in-place edit replaces the
 * named file; a `w` file is opened through any symlink in its path, so it is
 * judged by the file it reaches.
 */
function collectSedWriteTargets(params: {
  readonly args: readonly string[];
  readonly argsRequiringExpansion?: readonly boolean[];
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
  /** Whether BSD sed may run it, or only shows which words are disputed. */
  readonly bsd: "runs" | "disputes" | "absent";
}): ShellWriteTargetCollection {
  const { cwd, environment } = params;
  const writes = analyzeSedWrites(params.args, params.argsRequiringExpansion, { bsd: params.bsd });
  const collection = emptyTargetCollection();
  collection.indeterminate = writes.indeterminate;
  const addTarget = (name: string, reached: string | undefined): void => {
    if (reached === undefined) {
      collection.indeterminate = true;
      pushUnique(collection.unresolvedProtectedFirst, resolvePath(cwd, name));
    }
    const target = reached ?? resolvePath(cwd, name);
    pushUnique(collection.targets, target);
    pushUnique(collection.protectedFirstTargets, target);
  };
  // sed opens the `w` files while it compiles, before it edits anything.
  for (const name of writes.scriptWrites) {
    if (isSafePseudoDevicePath(name)) continue;
    addTarget(name, resolveWriteThroughSymlinks(kernelPath(cwd, name), environment.workspaceRoot));
  }
  for (const edit of writes.edits) {
    // sed -i never creates a file.
    if (edit.onlyIfExists && !pathExists(kernelPath(cwd, edit.file))) continue;
    for (const name of edit.backup === undefined ? [edit.file] : [edit.file, edit.backup]) {
      addTarget(name, resolveInPlaceTarget(kernelPath(cwd, name), environment.workspaceRoot));
    }
  }
  // The commands an `e` runs already make the result indeterminate; their
  // known targets are still checked.
  for (const command of writes.commands) {
    mergeTargetCollections(collection, collectShellCommandWriteTargets(command, cwd, environment));
  }
  return collection;
}

/** env's long options that take no argument, or only an attached one. */
const ENV_LONG_FLAGS = new Set([
  "block-signal",
  "debug",
  "default-signal",
  "ignore-environment",
  "ignore-signal",
  "list-signal-handling",
  "null",
]);

/**
 * `env [option]... [NAME=VALUE]... [command [argument]...]` runs the command
 * with a changed environment, so it writes what the command writes. An
 * option that moves or rebuilds the command (`-C`, `-S`), an option env does
 * not document, and a command or option the shell still expands leave the
 * command unknown.
 */
function collectEnvCommandWriteTargets(params: {
  readonly args: readonly string[];
  readonly argsRequiringExpansion?: readonly boolean[];
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
}): ShellWriteTargetCollection {
  const { args } = params;
  const expands = (index: number): boolean => params.argsRequiringExpansion?.[index] === true;
  let index = 0;
  let assigning = false;
  words: for (; index < args.length; index += 1) {
    const token = args[index]!;
    if (ENV_ASSIGNMENT_RE.test(token)) {
      assigning = true;
      continue;
    }
    // Options come before the assignments; `-` is `-i`.
    if (assigning || !token.startsWith("-")) break;
    if (expands(index)) return indeterminateTargetCollection();
    if (token === "-") continue;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = token.slice(2, equals < 0 ? undefined : equals);
      if (ENV_LONG_FLAGS.has(name)) continue;
      if (name === "unset" || name === "argv0") {
        if (equals < 0) index += 1;
        continue;
      }
      if (name === "help" || name === "version") return emptyTargetCollection();
      return indeterminateTargetCollection();
    }
    for (let at = 1; at < token.length; at += 1) {
      const option = token[at]!;
      if (option === "i" || option === "0" || option === "v") continue;
      if (option === "u" || option === "P" || option === "a") {
        if (at + 1 === token.length) index += 1;
        continue words;
      }
      return indeterminateTargetCollection();
    }
  }
  // Without a command, env only prints the environment.
  if (index >= args.length) return emptyTargetCollection();
  if (expands(index)) return indeterminateTargetCollection();
  return collectDirectCommandWriteTargets({
    command: args[index]!,
    args: args.slice(index + 1),
    ...(params.argsRequiringExpansion === undefined
      ? {}
      : { argsRequiringExpansion: params.argsRequiringExpansion.slice(index + 1) }),
    cwd: params.cwd,
    environment: params.environment,
  });
}

function collectDirectCommandWriteTargets(params: {
  readonly command: string;
  readonly args: readonly string[];
  /** Which of `args` the shell still expands; absent for an argument vector. */
  readonly argsRequiringExpansion?: readonly boolean[];
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
}): ShellWriteTargetCollection {
  const command = basename(params.command);
  if (command === "env") {
    return collectEnvCommandWriteTargets(params);
  }
  if (SHELL_WRAPPER_COMMANDS.has(command)) {
    const nestedCommand = extractWrappedShellCommand(params.args);
    return nestedCommand
      ? collectShellCommandWriteTargets(nestedCommand, params.cwd, params.environment)
      : hasWrapperScriptOperand(params.args)
        ? emptyTargetCollection()
        : indeterminateTargetCollection();
  }
  if (command === "tee") {
    return collectTeeTargets(params.args, params.cwd);
  }
  if (command === "touch") {
    return collectTouchTargets(params.args, params.cwd);
  }
  if (command === "mv") {
    return collectMoveTargets(params.args, params.cwd);
  }
  if (command === "cp" || command === "install" || command === "ln") {
    return collectDestinationTarget(command, params.args, params.cwd);
  }
  if (command === "mkdir") {
    return emptyTargetCollection();
  }
  if (DELETE_COMMANDS.has(command)) {
    return collectDeletionTargets(params.args, params.cwd);
  }
  if (command === "truncate") {
    return collectOperandTargets(params.args, params.cwd);
  }
  if (command === "dd") {
    const collection = emptyTargetCollection();
    for (const token of params.args) {
      if (!token) continue;
      if (token.startsWith("of=")) {
        mergeTargetCollections(
          collection,
          normalizeConcreteTargetPath(token.slice(3), params.cwd),
        );
      }
      if (token.startsWith("of=") && token.length === 3) {
        collection.indeterminate = true;
      }
    }
    return collection;
  }
  if (command === "sed" || command === "gsed") {
    // `gsed` is GNU sed installed next to a BSD `sed`.
    const bsd = command === "gsed" ? "absent" : params.environment.bsdSed ? "runs" : "disputes";
    return collectSedWriteTargets({ ...params, bsd });
  }
  if (command === "perl") {
    const inPlace = params.args.some((token) => token === "-i" || token.startsWith("-i"));
    if (!inPlace) {
      return emptyTargetCollection();
    }
    return collectOperandTargets(params.args, params.cwd);
  }
  return emptyTargetCollection();
}

function collectRedirectionTargets(
  tokens: readonly ShellToken[],
  cwd: string,
): ShellWriteTargetCollection {
  const collection = emptyTargetCollection();
  for (let index = 0; index < tokens.length; index += 1) {
    const operator = getShellRedirectOperator(tokens[index]!);
    if (operator === undefined || !WRITE_REDIRECT_OPERATORS.has(operator)) {
      continue;
    }
    const next = tokens[index + 1];
    if (
      next?.kind !== "word" ||
      next.value.length === 0
    ) {
      collection.indeterminate = true;
      continue;
    }
    if (
      operator === ">&" &&
      (/^\d+-?$/.test(next.value) || next.value === "-")
    ) {
      continue;
    }
    if (isSafePseudoDevicePath(next.value)) {
      continue;
    }
    mergeTargetCollections(collection, normalizeConcreteTargetPath(next.value, cwd));
  }
  return collection;
}

function collectSegmentCommandWriteTargets(
  segment: readonly ShellToken[],
  cwd: string,
  environment: ShellWriteEnvironment,
): ShellWriteTargetCollection {
  const stripped = stripRedirections(segment);
  if (stripped.length === 0) {
    return emptyTargetCollection();
  }
  let commandIndex = 0;
  while (
    commandIndex < stripped.length &&
    ENV_ASSIGNMENT_RE.test(stripped[commandIndex]?.value ?? "")
  ) {
    commandIndex += 1;
  }
  const command = stripped[commandIndex];
  if (command === undefined || command.value.length === 0) {
    return emptyTargetCollection();
  }
  if (command.requiresExpansion) return indeterminateTargetCollection();
  const args = stripped.slice(commandIndex + 1);
  return collectDirectCommandWriteTargets({
    command: command.value,
    args: args.map((token) => token.value),
    argsRequiringExpansion: args.map((token) => token.requiresExpansion),
    cwd,
    environment,
  });
}

function collectShellCommandWriteTargets(
  commandLine: string,
  cwd: string,
  environment: ShellWriteEnvironment,
): ShellWriteTargetCollection {
  const parsed = lexShellCommand(commandLine);
  const collection = collectRedirectionTargets(parsed.tokens, cwd);
  collection.indeterminate ||= parsed.malformed || parsed.hasCommandSubstitution;
  let segment: ShellToken[] = [];
  const flushSegment = (): void => {
    mergeTargetCollections(
      collection,
      collectSegmentCommandWriteTargets(segment, cwd, environment),
    );
    segment = [];
  };
  for (const token of parsed.tokens) {
    if (isShellCommandSeparator(token)) {
      flushSegment();
      continue;
    }
    segment.push(token);
  }
  flushSegment();
  return collection;
}

/**
 * The system temp directory (`os.tmpdir()` honours TMPDIR) plus `/tmp` and
 * its macOS target, where shell scratch files live (`cat > /tmp/x.js`).
 */
function shellTempRoots(): readonly string[] {
  const roots = new Set<string>();
  for (const candidate of [tmpdir(), "/tmp", "/private/tmp"]) {
    if (candidate.trim().length > 0) {
      roots.add(resolvePath(candidate.trim()));
    }
  }
  return [...roots];
}

function isStrictlyUnder(root: string, absolutePath: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return absolutePath.startsWith(prefix);
}

/** Paths under the system temp directory (never the directory itself). */
function isUnderTempRoot(absolutePath: string): boolean {
  return shellTempRoots().some((root) => isStrictlyUnder(root, absolutePath));
}

/** `/`, a Windows drive root, or the home directory itself. */
function isDangerousRemovalRoot(absolutePath: string): boolean {
  const normalized = absolutePath.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (normalized === "/" || WINDOWS_DRIVE_ROOT_RE.test(absolutePath)) return true;
  return normalized === homedir().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * A path no shell command may write: a .git, .agenc or .agents directory, a
 * shell or git config file, or the AgenC home. Inside the workspace only the
 * part below its root counts, so a worktree placed under .agenc is not
 * protected as a whole.
 */
function isProtectedWriteTarget(
  absolutePath: string,
  workspaceRoot: string,
  protectedRoots: readonly string[],
): boolean {
  const relation = workspaceRelation(workspaceRoot, absolutePath);
  const named = relation === "outside" ? absolutePath : relative(workspaceRoot, absolutePath);
  if (named.split(/[\\/]/).some((segment) => PROTECTED_DELETION_SEGMENTS.has(segment))) {
    return true;
  }
  if (PROTECTED_DELETION_FILES.has(basename(absolutePath))) return true;
  return protectedRoots.some(
    (root) =>
      (absolutePath === root || isStrictlyUnder(root, absolutePath)) &&
      (relation === "outside" || workspaceRelation(root, workspaceRoot) === "outside"),
  );
}

function isProtectedDeletionPath(
  absolutePath: string,
  workspaceRoot: string,
  protectedRoots: readonly string[],
): boolean {
  if (workspaceRelation(workspaceRoot, absolutePath) === "root") return true;
  if (isDangerousRemovalRoot(absolutePath)) return true;
  // A protected root that contains the workspace (a home that hosts the
  // project) protects nothing inside the workspace; its own files are
  // outside the workspace and refused on that ground.
  if (
    protectedRoots.some(
      (root) =>
        workspaceRelation(root, workspaceRoot) === "outside" &&
        (absolutePath === root || isStrictlyUnder(root, absolutePath)),
    )
  ) {
    return true;
  }
  if (absolutePath.split(/[\\/]/).some((segment) => PROTECTED_DELETION_SEGMENTS.has(segment))) {
    return true;
  }
  return PROTECTED_DELETION_FILES.has(basename(absolutePath));
}

interface DeletionPolicyScope {
  readonly workspaceRoot: string;
  readonly protectedRoots: readonly string[];
  readonly additionalRoots: readonly string[];
  readonly allowWorkspaceDeletions: boolean;
  readonly bypassesApprovalsAndSandbox: boolean;
}

function classifyDeletionTarget(
  absolutePath: string,
  scope: DeletionPolicyScope,
):
  | { readonly kind: "allowed"; readonly inWorkspace: boolean }
  | { readonly kind: "blocked"; readonly reason: DeletionBlockReason } {
  const { workspaceRoot, protectedRoots, allowWorkspaceDeletions } = scope;
  if (isProtectedDeletionPath(absolutePath, workspaceRoot, protectedRoots)) {
    return { kind: "blocked", reason: "protected" };
  }
  if (workspaceRelation(workspaceRoot, absolutePath) === "outside") {
    if (isUnderTempRoot(absolutePath) || scope.bypassesApprovalsAndSandbox) {
      return { kind: "allowed", inWorkspace: false };
    }
    // An added directory is a root the user granted, so a removal there is
    // the workspace class of mutation (prompt-free or approved), never the
    // "ask the user to remove it themselves" refusal. It is still not a
    // workspace path: the file-history sidecar does not back it up.
    if (
      scope.additionalRoots.some(
        (root) => workspaceRelation(root, absolutePath) === "inside",
      )
    ) {
      return allowWorkspaceDeletions
        ? { kind: "allowed", inWorkspace: false }
        : { kind: "blocked", reason: "needs_approval" };
    }
    return { kind: "blocked", reason: "outside" };
  }
  if (isWorkspaceGeneratedOutputPath(workspaceRoot, absolutePath)) {
    return { kind: "allowed", inWorkspace: true };
  }
  return allowWorkspaceDeletions
    ? { kind: "allowed", inWorkspace: true }
    : { kind: "blocked", reason: "needs_approval" };
}

function buildPolicyMessage(blockedTargets: readonly string[]): string {
  return (
    "shell_workspace_file_write_disallowed: shell commands may not write " +
    "workspace files except under build, dist, logs, .cache, tmp, or coverage; " +
    "use Edit or Write instead." +
    (blockedTargets.length > 0
      ? ` Blocked target(s): ${blockedTargets.join(", ")}`
      : "")
  );
}

function buildProtectedWritePolicyMessage(blockedTargets: readonly string[]): string {
  return (
    "shell_workspace_file_write_disallowed: shell commands may not write protected " +
    "paths (.git, .agenc, .agents, the AgenC home, shell and git config files), " +
    "including through a symlink or under tmp and the other generated directories; " +
    "ask the user to change them themselves. Blocked target(s): " +
    blockedTargets.join(", ")
  );
}

function buildDeletionPolicyMessage(
  reasons: ReadonlySet<DeletionBlockReason>,
  blockedDeletions: readonly string[],
): string {
  const parts: string[] = [];
  if (reasons.has("needs_approval")) {
    parts.push(
      "shell_workspace_file_delete_requires_approval: deleting or moving " +
        "workspace files with a shell command needs the user's approval in this " +
        "permission mode; ask the user to approve this exact command, or to " +
        "switch to acceptEdits or bypassPermissions, then run it again. Edit and " +
        "Write cannot delete files.",
    );
  }
  if (reasons.has("outside")) {
    parts.push(
      "shell_workspace_file_delete_disallowed: shell commands may delete or " +
        "move files only inside the workspace or the system temp directory; ask " +
        "the user to remove anything else themselves.",
    );
  }
  if (reasons.has("protected")) {
    parts.push(
      "shell_workspace_file_delete_disallowed: shell commands may not delete or " +
        "move protected paths (the workspace root, .git, .agenc, .agents, the " +
        "AgenC home, shell and git config files); ask the user to remove them " +
        "themselves.",
    );
  }
  return `${parts.join(" ")} Blocked target(s): ${blockedDeletions.join(", ")}`;
}

function buildIndeterminatePolicyMessage(
  observedTargets: readonly string[],
): string {
  return (
    "shell_workspace_file_write_disallowed: Unable to confirm workspace write targets " +
    "for this shell command. Use structured file tools instead of shell writes, " +
    "and avoid dynamic shell indirection for file mutations." +
    (observedTargets.length > 0
      ? ` Observed target(s): ${observedTargets.join(", ")}`
      : "")
  );
}

export function classifyShellWorkspaceWritePolicy(
  params: ShellWorkspaceWritePolicyInput,
): ShellWorkspaceWritePolicyDecision {
  if (!SHELL_WORKSPACE_WRITE_TOOL_NAMES.has(params.toolName)) {
    return {
      blocked: false,
      indeterminate: false,
      observedTargets: [],
      blockedTargets: [],
      deletionTargets: [],
      blockedDeletions: [],
    };
  }
  if (!params.workspaceRoot) {
    return {
      blocked: true,
      indeterminate: true,
      observedTargets: [],
      blockedTargets: [],
      deletionTargets: [],
      blockedDeletions: [],
      message: buildIndeterminatePolicyMessage([]),
    };
  }

  const workspaceRoot = params.workspaceRoot;
  const cwd = resolveWorkingDirectory(workspaceRoot, params.args.cwd);
  const environment: ShellWriteEnvironment = {
    bsdSed: BSD_SED_PLATFORMS.has(params.platform ?? process.platform),
    workspaceRoot,
  };
  let collected: ShellWriteTargetCollection = emptyTargetCollection();
  if (Array.isArray(params.args.args)) {
    collected = collectDirectCommandWriteTargets({
      command:
        typeof params.args.command === "string" ? params.args.command : "",
      args: params.args.args.filter((value): value is string => typeof value === "string"),
      cwd,
      environment,
    });
  } else if (typeof params.args.command === "string") {
    collected = collectShellCommandWriteTargets(params.args.command, cwd, environment);
  }

  // A move keeps workspace content in the workspace when every source is a
  // workspace path; then its destination is a rename, not a content write.
  const writes = [...collected.targets];
  const removals = [...collected.deletions];
  for (const move of collected.moves) {
    const sourcesInWorkspace =
      move.sources.length > 0 &&
      move.sources.every(
        (source) => workspaceRelation(workspaceRoot, source) === "inside",
      );
    for (const source of move.sources) pushUnique(removals, source);
    if (
      sourcesInWorkspace &&
      workspaceRelation(workspaceRoot, move.destination) === "inside"
    ) {
      pushUnique(removals, move.destination);
    } else {
      pushUnique(writes, move.destination);
    }
  }

  const protectedRoots = params.protectedRoots ?? [];
  // A protected path stays refused under a generated root and outside the
  // workspace. For now only sed's targets are checked this way.
  const protectedTargets = writes.filter(
    (target) =>
      collected.protectedFirstTargets.includes(target) &&
      isProtectedWriteTarget(target, workspaceRoot, protectedRoots),
  );
  const routedTargets = writes.filter(
    (target) =>
      !protectedTargets.includes(target) &&
      workspaceRelation(workspaceRoot, target) === "inside" &&
      !isWorkspaceGeneratedOutputPath(workspaceRoot, target),
  );
  const unresolvedTargets = writes.filter((target) => collected.unresolvedProtectedFirst.includes(target));
  const blockedTargets = [...protectedTargets, ...routedTargets];
  for (const target of unresolvedTargets) pushUnique(blockedTargets, target);
  const deletionTargets: string[] = [];
  const blockedDeletions: string[] = [];
  const deletionReasons = new Set<DeletionBlockReason>();
  const bypassesApprovalsAndSandbox = params.bypassesApprovalsAndSandbox === true;
  const deletionScope: DeletionPolicyScope = {
    workspaceRoot,
    protectedRoots,
    additionalRoots: (params.additionalRoots ?? []).map((root) => resolvePath(root)),
    allowWorkspaceDeletions: params.allowWorkspaceDeletions === true,
    bypassesApprovalsAndSandbox,
  };
  for (const target of removals) {
    const verdict = classifyDeletionTarget(target, deletionScope);
    if (verdict.kind === "allowed") {
      if (verdict.inWorkspace) deletionTargets.push(target);
    } else {
      if (params.validationPhase === "preflight" && verdict.reason === "needs_approval") {
        continue;
      }
      blockedDeletions.push(target);
      deletionReasons.add(verdict.reason);
    }
  }

  const observedTargets = [...writes];
  for (const target of removals) pushUnique(observedTargets, target);
  const messages: string[] = [];
  if (protectedTargets.length > 0) {
    messages.push(buildProtectedWritePolicyMessage(protectedTargets));
  }
  if (routedTargets.length > 0) messages.push(buildPolicyMessage(routedTargets));
  // Refused even with approvals bypassed: where these land is unknown, so they
  // could reach a protected path.
  if (unresolvedTargets.length > 0) {
    messages.push(
      `sed would write through a path whose destination cannot be determined (${unresolvedTargets.join(", ")}); the command was not run. Write to a path without a symlink loop.`,
    );
  }
  if (blockedDeletions.length > 0) {
    messages.push(buildDeletionPolicyMessage(deletionReasons, blockedDeletions));
  }
  // With approvals bypassed and no sandbox, an unresolvable target no longer
  // has a prompt or a kernel boundary to be routed to; refusing it only made
  // the model rewrite `echo "$(id)"` and `for f in *; do ... done` until they
  // parsed. The decision still reports `indeterminate` for callers.
  if (collected.indeterminate && !bypassesApprovalsAndSandbox) {
    messages.push(buildIndeterminatePolicyMessage(observedTargets));
  }

  return {
    blocked: messages.length > 0,
    indeterminate: collected.indeterminate,
    observedTargets,
    blockedTargets,
    deletionTargets,
    blockedDeletions,
    ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
  };
}

/**
 * Absolute workspace paths a shell command would remove or replace by a move
 * if it ran. The file-history sidecar backs these files up before the command
 * runs, the way it does for Edit and Write. A command the policy would refuse
 * for any other reason (a content write, a protected or outside path, an
 * indeterminate target) contributes nothing because it will not run.
 */
export function collectShellWorkspaceDeletionTargets(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot: string;
}): readonly string[] {
  const decision = classifyShellWorkspaceWritePolicy({
    ...params,
    allowWorkspaceDeletions: true,
  });
  return decision.blocked ? [] : decision.deletionTargets;
}
