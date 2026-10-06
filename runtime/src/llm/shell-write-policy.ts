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
/**
 * The file tools a refused shell write is pointed at, in the order a refusal
 * names them. Edit and Write come first; MultiEdit and apply_patch are named
 * only in a session that has neither of those.
 */
const PRIMARY_FILE_WRITE_TOOL_NAMES = ["Edit", "Write"] as const;
const FALLBACK_FILE_WRITE_TOOL_NAMES = ["MultiEdit", "apply_patch"] as const;
export const SHELL_FILE_WRITE_TOOL_NAMES: readonly string[] = [
  ...PRIMARY_FILE_WRITE_TOOL_NAMES,
  ...FALLBACK_FILE_WRITE_TOOL_NAMES,
];
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

/** The editing tools of SHELL_FILE_WRITE_TOOL_NAMES a session has. */
export interface ShellFileWriteTools {
  /** In the model's tool list. */
  readonly listed: readonly string[];
  /** In the session but not in the list yet: their schemas are not loaded. */
  readonly unlisted: readonly string[];
  /** The listed tool that loads an unlisted one (system.searchTools), if any. */
  readonly loadWith?: string;
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
   * The editing tools the session has. A refusal names only these as the way
   * to change a workspace file, preferring the ones in the model's tool list;
   * with none (a read-only subagent) it says the session cannot change those
   * files and points at the generated directories. Absent, or answering
   * undefined, when there is no session to ask, and then the refusal names
   * Edit and Write. Called only while a refusal message is written, at most
   * once per classification: listing a session's tools costs time that an
   * allowed command must not pay.
   */
  readonly fileWriteTools?: () => ShellFileWriteTools | undefined;
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

/**
 * Option letters that bash, dash, zsh and ksh93 each read as a flag taking no
 * argument, or refuse and exit without running anything. Left out: `b` (zsh
 * ends its options after it), `s` (the code comes from stdin), and `R` and
 * `T` (ksh93 takes the next word after them).
 */
const SHELL_WRAPPER_FLAG_LETTERS = new Set("aefhiklmnprtuvxBCEHP");
/** bash's long options that take no argument. zsh and ksh93 read the ones they know the same way. */
const BASH_LONG_FLAGS = new Set([
  "debugger",
  "dump-po-strings",
  "dump-strings",
  "help",
  "login",
  "noediting",
  "noprofile",
  "norc",
  "posix",
  "restricted",
  "verbose",
  "version",
]);
/** bash's long options that take the next word. The other shells refuse them and run nothing. */
const BASH_LONG_OPTIONS_WITH_ARGUMENT = new Set(["init-file", "rcfile"]);

/**
 * Where a shell wrapper takes the code it runs: the word it runs as code
 * (`-c`), the word naming the script it runs, or, when the command line does
 * not show that, the first word that could be the code. With no such word
 * (`bash`, `bash -i`), the code comes from stdin.
 */
type ShellWrapperOperand =
  | { readonly kind: "code" | "script"; readonly index: number }
  | { readonly kind: "unknown"; readonly from: number };

/**
 * Reads a wrapper's options the way bash, dash, zsh and ksh do: `c` anywhere
 * in a short option cluster (`-ec`, `+c`) asks for code; `o`, and for bash
 * `O`, at the end of a cluster takes the next word (`-eo pipefail`); bash's
 * `--rcfile` and `--init-file` take the next word; `--` or `-` ends the
 * options. The first word after the options is the code when `c` was given,
 * else the script, so `bash -c -e CODE` runs CODE. Anything the shells read
 * differently or this reader does not know leaves the code unknown from that
 * word on: an `o` inside a cluster (`-opipefail` is one option to zsh and
 * ksh93, two to bash), `-O` outside bash (a flag to zsh), a lone `+`, or
 * bash's single-dash spelling of a long option (`-rcfile FILE` before the
 * short options, letters to the other shells).
 */
function parseShellWrapperOptions(
  shell: string,
  args: readonly string[],
): ShellWrapperOperand {
  let runsCode = false;
  let index = 0;
  while (index < args.length) {
    const word = args[index]!;
    if (word === "--" || word === "-") {
      index += 1;
      break;
    }
    if (!word.startsWith("-") && !word.startsWith("+")) break;
    let next = index + 1;
    if (word.startsWith("--")) {
      const name = word.slice(2);
      if (BASH_LONG_OPTIONS_WITH_ARGUMENT.has(name)) next += 1;
      else if (!BASH_LONG_FLAGS.has(name)) return { kind: "unknown", from: index };
    } else {
      const name = word.slice(1);
      if (name.length === 0 || BASH_LONG_FLAGS.has(name) || BASH_LONG_OPTIONS_WITH_ARGUMENT.has(name)) {
        return { kind: "unknown", from: index };
      }
      for (let at = 1; at < word.length; at += 1) {
        const letter = word[at]!;
        if (letter === "c") {
          runsCode = true;
        } else if (
          (letter === "o" || (letter === "O" && shell === "bash")) &&
          at === word.length - 1
        ) {
          next += 1;
        } else if (!SHELL_WRAPPER_FLAG_LETTERS.has(letter)) {
          return { kind: "unknown", from: index };
        }
      }
    }
    if (next > args.length) return { kind: "unknown", from: index };
    index = next;
  }
  if (index >= args.length) return { kind: "unknown", from: args.length };
  return { kind: runsCode ? "code" : "script", index };
}

/**
 * The wrapper's operand, with the words the outer shell still expands taken
 * into account. Such a word up to the operand could expand into options or
 * into nothing, which moves the code onto any later word (`bash $F CODE`
 * with `F=-c`, `bash -c "$C" CODE` with `C=-e`), so when a word follows it,
 * the code is unknown from it on. As the last word it moves nothing, so
 * `bash "$SCRIPT"` still runs a script.
 */
function readShellWrapperOperand(
  shell: string,
  args: readonly string[],
  argsRequiringExpansion: readonly boolean[] | undefined,
): ShellWrapperOperand {
  const operand = parseShellWrapperOptions(shell, args);
  const last = operand.kind === "unknown" ? operand.from - 1 : operand.index;
  for (let index = 0; index <= last && index < args.length - 1; index += 1) {
    if (argsRequiringExpansion?.[index] === true) return { kind: "unknown", from: index };
  }
  return operand;
}

/**
 * `sh -c CODE [name [arg]...]` runs CODE, so it writes what CODE writes. The
 * outer shell expands CODE before sh reads it, so the quotes CODE shows are
 * not the ones sh sees (`sh -c "echo '$X'"`): a code word the shell still
 * expands leaves the code unknown, and the targets its literal text names are
 * still judged. When the options do not show which word is the code, every
 * word that could be is judged that way, so a protected path one of them
 * names stays refused.
 *
 * `sh FILE [arg]...` runs FILE, which the command line does not show. ksh93
 * runs a FILE it cannot find as the code `FILE "$@"` instead, so for ksh a
 * literal FILE is judged as that code too (`ksh 'rm -rf .git'` removes .git).
 */
function collectWrappedShellWriteTargets(params: {
  readonly shell: string;
  readonly args: readonly string[];
  readonly argsRequiringExpansion?: readonly boolean[];
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
}): ShellWriteTargetCollection {
  const { args, cwd, environment } = params;
  const operand = readShellWrapperOperand(params.shell, args, params.argsRequiringExpansion);
  if (operand.kind === "unknown") {
    const collection = indeterminateTargetCollection();
    for (const word of args.slice(operand.from)) {
      mergeTargetCollections(collection, collectShellCommandWriteTargets(word, cwd, environment));
    }
    return collection;
  }
  const word = args[operand.index]!;
  const expands = params.argsRequiringExpansion?.[operand.index] === true;
  if (operand.kind === "code") {
    const collection = collectShellCommandWriteTargets(word, cwd, environment);
    collection.indeterminate ||= expands;
    return collection;
  }
  if (params.shell !== "ksh" || expands) return emptyTargetCollection();
  const code = operand.index + 1 < args.length ? `${word} "$@"` : word;
  return collectShellCommandWriteTargets(code, cwd, environment);
}

/**
 * `eval [arg]...` joins its words with blanks and runs the result as shell
 * code in this shell, so it writes what that code writes, read like
 * `sh -c`. bash, zsh and ksh skip a leading `--`. A word the shell still
 * expands (`eval "$CMD"`, `eval $(ssh-agent)`) leaves the code unknown;
 * the targets its literal words name are still judged.
 */
function collectEvalWriteTargets(params: {
  readonly args: readonly string[];
  readonly argsRequiringExpansion?: readonly boolean[];
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
}): ShellWriteTargetCollection {
  const words = params.args[0] === "--" ? params.args.slice(1) : params.args;
  const collection = collectShellCommandWriteTargets(
    words.join(" "),
    params.cwd,
    params.environment,
  );
  collection.indeterminate ||= params.argsRequiringExpansion?.includes(true) === true;
  return collection;
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
  /**
   * The command runs where a change the line does not spell out may have
   * moved the shell, so whether a file exists there is not known.
   */
  readonly directoryUnknown?: boolean;
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
    // Where the directory is not known, neither is whether the file exists.
    if (
      edit.onlyIfExists &&
      !environment.directoryUnknown &&
      !pathExists(kernelPath(cwd, edit.file))
    ) {
      continue;
    }
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

/** A command's words after its name, and where it runs. */
interface CommandArguments {
  readonly args: readonly string[];
  /** Which of `args` the shell still expands; absent for an argument vector. */
  readonly argsRequiringExpansion?: readonly boolean[];
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
}

/** What the command named by word `index` of a wrapper's words writes; nothing without one. */
function collectCommandWordWriteTargets(
  params: CommandArguments,
  index: number,
): ShellWriteTargetCollection {
  if (index >= params.args.length) return emptyTargetCollection();
  if (params.argsRequiringExpansion?.[index] === true) return indeterminateTargetCollection();
  return collectDirectCommandWriteTargets({
    command: params.args[index]!,
    args: params.args.slice(index + 1),
    ...(params.argsRequiringExpansion === undefined
      ? {}
      : { argsRequiringExpansion: params.argsRequiringExpansion.slice(index + 1) }),
    cwd: params.cwd,
    environment: params.environment,
  });
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
function collectEnvCommandWriteTargets(params: CommandArguments): ShellWriteTargetCollection {
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
  return collectCommandWordWriteTargets(params, index);
}

/** One option a wrapper's words set. */
interface WrapperOption {
  /** Its letter, or its long name when it has none. */
  readonly name: string;
  readonly value?: string;
}

/** A wrapper's options, and the index of the first word after them. */
interface WrapperOptions {
  readonly options: readonly WrapperOption[];
  readonly end: number;
}

/**
 * The options of a program or builtin that runs the command written after
 * them, read the way getopt reads them. Each letter of `short` is an option:
 * one followed by `:` takes an argument, attached or in the next word, and
 * one followed by `::` an optional argument that only comes attached. Each
 * long option gives, the same way, the letter it stands for (if any) and its
 * arity: `"kill-after": "k:"`, `help: ""`. A long option may be shortened to
 * any prefix that names only it.
 */
interface CommandWrapper {
  readonly short: string;
  readonly long?: Readonly<Record<string, string>>;
  /** Letters of options after which the wrapper prints and runs nothing (`command -v`). */
  readonly inspects?: string;
  /** nice's `-N`, `--N` and `-+N`: an adjustment written as an option. */
  readonly numericAdjustment?: boolean;
  /** sudo's `NAME=value` words, which may come among the options. */
  readonly assignments?: boolean;
  /** What runs after the options; the next word as a command when absent. */
  readonly collect?: (params: CommandArguments, read: WrapperOptions) => ShellWriteTargetCollection;
}

/** GNU's `--help` and `--version`, which print and run nothing. */
const GNU_STANDARD_OPTIONS: Readonly<Record<string, string>> = { help: "", version: "" };

/** The arity a short option letter has in a getopt string; undefined when it is not an option. */
function shortOptionArity(short: string, letter: string): string | undefined {
  const at = short.indexOf(letter);
  if (letter === ":" || at < 0) return undefined;
  if (short.startsWith("::", at + 1)) return "::";
  return short[at + 1] === ":" ? ":" : "";
}

/**
 * The long option a `--name` word names, exactly or by a prefix only it
 * has: the letter it stands for, or its own name, and its arity.
 */
function longOption(
  long: Readonly<Record<string, string>>,
  written: string,
): { readonly name: string; readonly arity: string } | undefined {
  const candidates = Object.hasOwn(long, written)
    ? [written]
    : Object.keys(long).filter((option) => option.startsWith(written));
  if (written.length === 0 || candidates.length !== 1) return undefined;
  const name = candidates[0]!;
  const spec = long[name]!;
  return /^[^:]/u.test(spec)
    ? { name: spec[0]!, arity: spec.slice(1) }
    : { name, arity: spec };
}

function wrapperOption(name: string, value?: string): WrapperOption {
  return value === undefined ? { name } : { name, value };
}

/**
 * The options one word sets (`-vk5`, `--signal=KILL`) and how many words
 * they take: two when the last one's argument is the next word. Undefined
 * when the word is an option the wrapper does not take, which includes one
 * the shell still expands (`-$FLAGS`).
 */
function readOptionWord(
  wrapper: CommandWrapper,
  word: string,
  next: string | undefined,
): { readonly options: readonly WrapperOption[]; readonly words: number } | undefined {
  if (wrapper.numericAdjustment === true && /^-[-+]?\d/u.test(word)) {
    return { options: [wrapperOption("n", word.slice(1))], words: 1 };
  }
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    const named = longOption(wrapper.long ?? {}, word.slice(2, equals < 0 ? undefined : equals));
    if (named === undefined) return undefined;
    if (equals >= 0) {
      return named.arity === ""
        ? undefined
        : { options: [wrapperOption(named.name, word.slice(equals + 1))], words: 1 };
    }
    return named.arity === ":"
      ? { options: [wrapperOption(named.name, next)], words: 2 }
      : { options: [wrapperOption(named.name)], words: 1 };
  }
  const options: WrapperOption[] = [];
  for (let at = 1; at < word.length; at += 1) {
    const letter = word[at]!;
    const arity = shortOptionArity(wrapper.short, letter);
    if (arity === undefined) return undefined;
    if (arity === "") {
      options.push(wrapperOption(letter));
      continue;
    }
    const attached = word.slice(at + 1);
    if (attached.length > 0 || arity === "::") {
      options.push(wrapperOption(letter, attached.length > 0 ? attached : undefined));
      return { options, words: 1 };
    }
    options.push(wrapperOption(letter, next));
    return { options, words: 2 };
  }
  return { options, words: 1 };
}

/**
 * The options at the start of a wrapper's words, up to `--` or the first
 * word that is not an option: the command, or an operand before it.
 * Undefined when one is an option the wrapper does not take. A missing
 * argument makes the wrapper fail before it runs anything, which reads as
 * no command.
 */
function readWrapperOptions(
  wrapper: CommandWrapper,
  args: readonly string[],
): WrapperOptions | undefined {
  const options: WrapperOption[] = [];
  let index = 0;
  while (index < args.length) {
    const word = args[index]!;
    if (word === "--") return { options, end: index + 1 };
    if (word.length > 1 && word.startsWith("-")) {
      const read = readOptionWord(wrapper, word, args[index + 1]);
      if (read === undefined) return undefined;
      options.push(...read.options);
      index += read.words;
    } else if (wrapper.assignments === true && isSudoAssignment(word)) {
      index += 1;
    } else {
      break;
    }
  }
  return { options, end: Math.min(index, args.length) };
}

/** A word sudo reads as `NAME=value`: one with `=` that starts with neither `/` nor `=`. */
function isSudoAssignment(word: string): boolean {
  return word.includes("=") && !word.startsWith("/") && !word.startsWith("=");
}

/** timeout's duration comes before its command. */
function collectTimeoutWriteTargets(
  params: CommandArguments,
  read: WrapperOptions,
): ShellWriteTargetCollection {
  return collectCommandWordWriteTargets(params, read.end + 1);
}

/** The time program writes its report to the file `-o` names, then runs the command. */
function collectTimeWriteTargets(
  params: CommandArguments,
  read: WrapperOptions,
): ShellWriteTargetCollection {
  const collection = emptyTargetCollection();
  for (const option of read.options) {
    if (option.name !== "o" || option.value === undefined) continue;
    if (isSafePseudoDevicePath(option.value)) continue;
    mergeTargetCollections(collection, normalizeConcreteTargetPath(option.value, params.cwd));
  }
  mergeTargetCollections(collection, collectCommandWordWriteTargets(params, read.end));
  return collection;
}

/**
 * The words xargs adds to its command from its input. The line does not
 * show them, so they read as a word the shell still expands, the way
 * `rm "$@"` is read.
 */
const XARGS_INPUT = "$@";

/**
 * xargs runs its command with words from its input after the command's
 * own words, or, with `-I`, `-i` or `-J`, in place of the replace string in
 * them. Without a command it runs echo.
 */
function collectXargsWriteTargets(
  params: CommandArguments,
  read: WrapperOptions,
): ShellWriteTargetCollection {
  if (read.end >= params.args.length) return emptyTargetCollection();
  let replace: string | undefined;
  for (const option of read.options) {
    if (option.name === "I" || option.name === "i") replace = option.value ?? "{}";
    else if (option.name === "J" && option.value !== undefined) replace = option.value;
  }
  const words = params.args.slice(read.end);
  const expands = words.map((_, at) => params.argsRequiringExpansion?.[read.end + at] === true);
  // The lexer marks `{}` for brace expansion, but the shell leaves it as written.
  const replaceUnknown = replace !== undefined && replace !== "{}" && DYNAMIC_SHELL_TARGET_RE.test(replace);
  if (replace === undefined) {
    words.push(XARGS_INPUT);
    expands.push(true);
  } else if (!replaceUnknown && replace.length > 0) {
    for (let at = 0; at < words.length; at += 1) {
      if (!words[at]!.includes(replace)) continue;
      words[at] = words[at]!.split(replace).join(XARGS_INPUT);
      expands[at] = true;
    }
  }
  const collection = collectCommandWordWriteTargets(
    { ...params, args: words, argsRequiringExpansion: expands },
    0,
  );
  // Where the input goes is not known; what the words name is still judged.
  collection.indeterminate ||= replaceUnknown;
  return collection;
}

/**
 * sudo runs its command after its options and `NAME=value` words. With
 * `-e` it edits the files named instead. `-D` and `-R` move the command to
 * another directory or root and `-i` to the target user's home, so where
 * its targets land is not read; `-s` without a command starts a shell that
 * reads its commands from its input.
 */
function collectSudoWriteTargets(
  params: CommandArguments,
  read: WrapperOptions,
): ShellWriteTargetCollection {
  const names = new Set(read.options.map((option) => option.name));
  if (names.has("D") || names.has("R") || names.has("i")) return indeterminateTargetCollection();
  const rest = params.args.slice(read.end);
  if (names.has("e")) return collectOperandTargets(rest, params.cwd);
  if (rest.length === 0 && names.has("s")) return indeterminateTargetCollection();
  return collectCommandWordWriteTargets(params, read.end);
}

/**
 * Programs that run the command written after their own options, with the
 * GNU and the BSD options of each together.
 */
const WRAPPER_PROGRAMS: readonly (readonly [string, CommandWrapper])[] = [
  ["nice", {
    short: "n:",
    long: { adjustment: "n:", ...GNU_STANDARD_OPTIONS },
    numericAdjustment: true,
  }],
  ["nohup", { short: "", long: GNU_STANDARD_OPTIONS }],
  ["stdbuf", {
    short: "e:i:o:",
    long: { error: "e:", input: "i:", output: "o:", ...GNU_STANDARD_OPTIONS },
  }],
  ["time", {
    short: "af:hlo:pqvV",
    long: {
      append: "a", format: "f:", help: "", "output-file": "o:",
      portability: "p", quiet: "q", verbose: "v", version: "V",
    },
    inspects: "V",
    collect: collectTimeWriteTargets,
  }],
  ["timeout", {
    short: "fk:ps:v",
    long: {
      foreground: "f", "kill-after": "k:", "preserve-status": "p",
      signal: "s:", verbose: "v", ...GNU_STANDARD_OPTIONS,
    },
    collect: collectTimeoutWriteTargets,
  }],
  ["xargs", {
    short: "0a:d:E:e::I:i::J:L:l::n:oP:pR:rS:s:tx",
    long: {
      "arg-file": "a:", delimiter: "d:", eof: "e::", exit: "x",
      interactive: "p", "max-args": "n:", "max-chars": "s:",
      "max-lines": "l::", "max-procs": "P:", "no-run-if-empty": "r",
      null: "0", "open-tty": "o", "process-slot-var": ":", replace: "I::",
      "show-limits": "", verbose: "t", ...GNU_STANDARD_OPTIONS,
    },
    collect: collectXargsWriteTargets,
  }],
];

/**
 * Builtins and programs that run the command written after their own
 * options, so they write what it writes. A `g`-prefixed program is GNU's,
 * installed next to a BSD one.
 */
const COMMAND_WRAPPERS: ReadonlyMap<string, CommandWrapper> = new Map([
  // Shell builtins and zsh's precommand modifiers.
  ["-", { short: "" }],
  ["builtin", { short: "" }],
  ["command", { short: "pvV", inspects: "vV" }],
  ["exec", { short: "a:cl" }],
  ["nocorrect", { short: "" }],
  ["noglob", { short: "" }],
  ...WRAPPER_PROGRAMS,
  ...WRAPPER_PROGRAMS.map(([name, wrapper]) => [`g${name}`, wrapper] as const),
  // sudo's `-h` is a host or, alone, help; reading it as a host never misses a command.
  ["sudo", {
    short: "Aa:BbC:c:D:Eeg:Hh:iKklNnPp:R:r:SsT:t:U:u:Vv",
    long: {
      askpass: "A", "auth-type": "a:", background: "b", bell: "B",
      chdir: "D:", chroot: "R:", "close-from": "C:", "command-timeout": "T:",
      edit: "e", group: "g:", help: "", host: ":", list: "l", login: "i",
      "login-class": "c:", "no-update": "N", "non-interactive": "n",
      "other-user": "U:", "preserve-env": "::", "preserve-groups": "P",
      prompt: "p:", "remove-timestamp": "K", "reset-timestamp": "k",
      role: "r:", "set-home": "H", shell: "s", stdin: "S", type: "t:",
      user: "u:", validate: "v", version: "V",
    },
    inspects: "KlVv",
    assignments: true,
    collect: collectSudoWriteTargets,
  }],
]);

/**
 * What a wrapper's command writes: `nohup rm x`, `sudo -u root rm x`,
 * `command rm x`. An option the wrapper does not take leaves the command
 * unknown rather than guessed.
 */
function collectWrappedCommandWriteTargets(
  wrapper: CommandWrapper,
  params: CommandArguments,
): ShellWriteTargetCollection {
  const read = readWrapperOptions(wrapper, params.args);
  if (read === undefined) return indeterminateTargetCollection();
  const prints = read.options.some(
    (option) =>
      option.name === "help" ||
      option.name === "version" ||
      (option.name.length === 1 && (wrapper.inspects ?? "").includes(option.name)),
  );
  if (prints) return emptyTargetCollection();
  return wrapper.collect?.(params, read) ?? collectCommandWordWriteTargets(params, read.end);
}

function collectDirectCommandWriteTargets(
  params: CommandArguments & { readonly command: string },
): ShellWriteTargetCollection {
  const command = basename(params.command);
  if (command === "env") {
    return collectEnvCommandWriteTargets(params);
  }
  const wrapper = COMMAND_WRAPPERS.get(command);
  if (wrapper !== undefined) {
    return collectWrappedCommandWriteTargets(wrapper, params);
  }
  if (SHELL_WRAPPER_COMMANDS.has(command)) {
    return collectWrappedShellWriteTargets({ ...params, shell: command });
  }
  if (command === "eval") {
    return collectEvalWriteTargets(params);
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

/**
 * Reserved words a simple command can follow in its segment: `then rm`,
 * `! touch`, `do echo`, `coproc rm`, `{ rm`. The command is the next word.
 */
const COMMAND_PREFIX_RESERVED_WORDS = new Set([
  "!", "{", "coproc", "do", "elif", "else", "if", "then", "time", "until", "while",
]);
/** What `time` reads before its pipeline. */
const TIME_OPTIONS = new Set(["-p", "--"]);
/** The test commands. The lexer marks them as globs, but without a closing `]` they do not expand. */
const TEST_COMMAND_WORDS = new Set(["[", "[["]);

/**
 * Index of a simple command's command word: after assignments, `time` and
 * the options it reads before its pipeline, and the words in `reserved`.
 * Both the write reading and the directory walk find the command here.
 * After an assignment `time` is the program, not the reserved word; with
 * `assignedTimeIsCommand` it is then the command word.
 */
function commandWordIndexAfter(
  words: readonly ShellToken[],
  reserved: ReadonlySet<string>,
  assignedTimeIsCommand = false,
): number {
  let index = 0;
  let timed = false;
  let assigned = false;
  for (; index < words.length; index += 1) {
    const value = words[index]!.value;
    if (timed && TIME_OPTIONS.has(value)) continue;
    timed = value === "time" && !(assignedTimeIsCommand && assigned);
    if (!timed && !ENV_ASSIGNMENT_RE.test(value) && !reserved.has(value)) break;
    assigned ||= ENV_ASSIGNMENT_RE.test(value);
  }
  return index;
}

/** Index of the command word whose writes a segment makes. */
function writeCommandWordIndex(words: readonly ShellToken[]): number {
  return commandWordIndexAfter(words, COMMAND_PREFIX_RESERVED_WORDS);
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
  // `function f { rm x; }`: the body is the brace group that starts at the
  // `{` in this segment, read as any brace group is.
  const body = stripped[0]!.value === "function" && !stripped[0]!.requiresExpansion
    ? stripped.findIndex((word) => word.value === "{")
    : -1;
  if (body > 0) return collectSegmentCommandWriteTargets(stripped.slice(body), cwd, environment);
  const commandIndex = writeCommandWordIndex(stripped);
  const prefix = stripped.slice(0, commandIndex);
  // The lexer reads a lone `{` as a brace expansion, so a brace group stays
  // indeterminate; the command inside it is read as well.
  const opensBraceGroup = prefix.some((word) => word.value === "{");
  const command = stripped[commandIndex];
  if (command === undefined || command.value.length === 0) {
    return opensBraceGroup ? indeterminateTargetCollection() : emptyTargetCollection();
  }
  // After a reserved word, `[` and `[[` are read as the test commands they
  // are (`if [ -d build ]`); a segment that starts with one stays indeterminate.
  const testCommand =
    TEST_COMMAND_WORDS.has(command.value) &&
    prefix.some((word) => COMMAND_PREFIX_RESERVED_WORDS.has(word.value));
  if (command.requiresExpansion && !testCommand) return indeterminateTargetCollection();
  const args = stripped.slice(commandIndex + 1);
  const collection = collectDirectCommandWriteTargets({
    command: command.value,
    args: args.map((token) => token.value),
    argsRequiringExpansion: args.map((token) => token.requiresExpansion),
    cwd,
    environment,
  });
  collection.indeterminate ||= opensBraceGroup;
  return collection;
}

/** The shell builtins that change the directory the rest of a line runs in. */
const DIRECTORY_CHANGE_COMMANDS = new Set(["cd", "pushd", "popd"]);
/** Builtins that run, in this shell, shell code the line does not show. */
const SHELL_CODE_COMMANDS = new Set([".", "eval", "source"]);
/** Prefixes that run the builtin named after them. */
const BUILTIN_PREFIX_COMMANDS = new Set(["-", "builtin", "command", "exec", "nocorrect", "noglob"]);
/**
 * Reserved words of compound commands. In a loop a command can run after a
 * `cd` written later in the line; under `if`, `!` or `case` a command runs
 * on a status this module does not follow.
 */
const COMPOUND_RESERVED_WORDS = new Set([
  "!", "{", "}", "case", "coproc", "do", "done", "elif", "else", "esac",
  "fi", "for", "function", "if", "select", "then", "until", "while",
]);
/**
 * Builtins that change how later commands, or `cd` itself, behave: a trap
 * or an alias runs code the line does not show, `enable -n cd` turns `cd`
 * into a program, and shell options can make `cd` read a name as a variable.
 */
const SHELL_BEHAVIOR_COMMANDS = new Set([
  "alias", "emulate", "enable", "setopt", "shopt", "trap", "unsetopt",
]);
const LIST_SEPARATORS = new Set([";", ";;", ";&", ";;&", "&"]);
const PIPE_SEPARATORS = new Set(["|", "|&"]);

/** Where a directory change leaves the shell when it succeeds. */
type DirectoryChange =
  | { readonly kind: "to"; readonly path: string }
  /** A place the line does not spell out: `cd "$DIR"`, `cd -`, `popd`. */
  | { readonly kind: "unknown" }
  /** `source`, `.` or `eval`: shell code the line does not show may change it. */
  | { readonly kind: "shell-code" };

const UNKNOWN_DIRECTORY: DirectoryChange = { kind: "unknown" };

/** What the whole line says about the variables `cd` reads. */
interface DirectoryChangeContext {
  /** The line names HOME, which a bare `cd` goes to. */
  readonly homeMayChange: boolean;
  /** CDPATH is set, or the line names it: `cd name` may go elsewhere. */
  readonly cdpathMayBeSet: boolean;
}

function directoryChangeContext(tokens: readonly ShellToken[]): DirectoryChangeContext {
  return {
    homeMayChange: tokens.some((token) => token.value.includes("HOME")),
    cdpathMayBeSet:
      (process.env.CDPATH ?? "").length > 0 ||
      tokens.some((token) => /cdpath/iu.test(token.value)),
  };
}

/**
 * Index of the command word the directory walk reads. `X=1 time cd /` runs
 * the time program, whose `cd` does not move this shell.
 */
function commandWordIndex(words: readonly ShellToken[]): number {
  return commandWordIndexAfter(words, COMPOUND_RESERVED_WORDS, true);
}

/**
 * A word that runs the builtin named after it, the time program, or an
 * option word where a command belongs (`time -x cd`): what the command
 * after it does to this shell's directory differs between shells.
 */
function isBuiltinPrefix(command: string): boolean {
  return BUILTIN_PREFIX_COMMANDS.has(command) || command === "time" || command.startsWith("-");
}

/** Whether these words run `cd`, `pushd` or `popd` in this shell. */
function namesDirectoryChange(words: readonly ShellToken[]): boolean {
  const stripped = stripRedirections(words);
  const index = commandWordIndex(stripped);
  const command = stripped[index]?.value;
  if (command === undefined) return false;
  if (DIRECTORY_CHANGE_COMMANDS.has(command)) return true;
  return isBuiltinPrefix(command) &&
    stripped.slice(index + 1).some((word) => DIRECTORY_CHANGE_COMMANDS.has(word.value));
}

function lineChangesDirectory(tokens: readonly ShellToken[]): boolean {
  let segment: ShellToken[] = [];
  for (const token of tokens) {
    if (!isShellCommandSeparator(token)) {
      segment.push(token);
      continue;
    }
    if (namesDirectoryChange(segment)) return true;
    segment = [];
  }
  return namesDirectoryChange(segment);
}

/** Whether the walk reads this command as written: not compound, not a shell behavior change. */
function segmentIsFollowed(segment: readonly ShellToken[]): boolean {
  const first = segment.find((token) => !ENV_ASSIGNMENT_RE.test(token.value));
  if (first?.kind === "word" && COMPOUND_RESERVED_WORDS.has(first.value)) return false;
  const words = stripRedirections(segment);
  return !SHELL_BEHAVIOR_COMMANDS.has(words[commandWordIndex(words)]?.value ?? "");
}

/** `$(`, `<(`, `>(` and `name=(`: a `(` that does not define a function. */
function opensSubstitution(previous: ShellToken): boolean {
  if (previous.kind === "operator") return getShellRedirectOperator(previous) !== undefined;
  return (
    (previous.requiresExpansion && previous.value.endsWith("$")) ||
    previous.value.endsWith("=")
  );
}

/**
 * Whether the line is simple commands joined by `&&`, `||`, `;`, `&` and
 * pipes, with subshells and substitutions that open and close in order,
 * and nothing that changes how the shell behaves: the line the directory
 * walk reads exactly.
 */
function lineStructureIsFollowed(tokens: readonly ShellToken[]): boolean {
  const scopes: string[] = [];
  let segment: ShellToken[] = [];
  for (const token of tokens) {
    if (!isShellCommandSeparator(token)) {
      segment.push(token);
      continue;
    }
    if (!segmentIsFollowed(segment)) return false;
    const previous = segment[segment.length - 1];
    if (token.value === "(") {
      if (previous !== undefined && !opensSubstitution(previous)) return false;
      scopes.push("(");
    } else if (token.value === ")") {
      if (scopes.pop() !== "(") return false;
    } else if (token.value === "`") {
      if (scopes[scopes.length - 1] === "`") scopes.pop();
      else scopes.push("`");
    }
    segment = [];
  }
  return segmentIsFollowed(segment) && scopes.length === 0;
}

function directoryOperandChange(
  command: string,
  words: readonly ShellToken[],
  context: DirectoryChangeContext,
): DirectoryChange {
  if (command === "popd" || words.some((word) => word.requiresExpansion)) {
    return UNKNOWN_DIRECTORY;
  }
  let operands = words.map((word) => word.value);
  while (operands.length > 0 && /^-[LPe@]+$/u.test(operands[0]!)) {
    operands = operands.slice(1);
  }
  if (operands[0] === "--") operands = operands.slice(1);
  if (operands.length === 0) {
    // `cd` alone goes to $HOME; `pushd` alone swaps the top two directories.
    return command === "cd" && !context.homeMayChange
      ? { kind: "to", path: homedir() }
      : UNKNOWN_DIRECTORY;
  }
  const operand = operands[0]!;
  // `-`, `-N` and `+N` name the directory stack, any other `-x` is an
  // option, and zsh reads `cd old new` as a substitution in $PWD.
  if (operands.length > 1 || operand.length === 0 || /^[-+]/u.test(operand)) {
    return UNKNOWN_DIRECTORY;
  }
  // CDPATH is not searched for a name that starts with `/`, `.` or `..`.
  if (context.cdpathMayBeSet && !isAbsolute(operand) && !/^\.\.?(?:\/|$)/u.test(operand)) {
    return UNKNOWN_DIRECTORY;
  }
  return { kind: "to", path: operand };
}

/**
 * Where a simple command's words move the shell: undefined for a command
 * that does not change the directory.
 */
function directoryChangeOf(
  words: readonly ShellToken[],
  context: DirectoryChangeContext,
): DirectoryChange | undefined {
  const stripped = stripRedirections(words);
  const index = commandWordIndex(stripped);
  const command = stripped[index];
  if (command === undefined) return undefined;
  // `$CMD` may be `cd`.
  if (command.requiresExpansion) return UNKNOWN_DIRECTORY;
  if (SHELL_CODE_COMMANDS.has(command.value)) return { kind: "shell-code" };
  const rest = stripped.slice(index + 1);
  if (isBuiltinPrefix(command.value)) {
    const runsChange = rest.some(
      (word) => DIRECTORY_CHANGE_COMMANDS.has(word.value) || SHELL_CODE_COMMANDS.has(word.value),
    );
    return runsChange ? UNKNOWN_DIRECTORY : undefined;
  }
  return DIRECTORY_CHANGE_COMMANDS.has(command.value)
    ? directoryOperandChange(command.value, rest, context)
    : undefined;
}

/** The directories a command may run in, as far as the line shows them. */
interface DirectoryState {
  readonly known: ReadonlySet<string>;
  /** A change the line does not spell out may have moved the shell. */
  readonly unknown: boolean;
}

/** Where the shell is after a command, by its exit status. */
interface DirectoryOutcome {
  readonly succeeded: DirectoryState;
  readonly failed: DirectoryState;
}

function unionDirectoryStates(left: DirectoryState, right: DirectoryState): DirectoryState {
  if (left === right) return left;
  return {
    known: new Set([...left.known, ...right.known]),
    unknown: left.unknown || right.unknown,
  };
}

function sameOutcome(state: DirectoryState): DirectoryOutcome {
  return { succeeded: state, failed: state };
}

interface DirectoryWalk {
  readonly tokens: readonly ShellToken[];
  index: number;
  /** The tool call's directory, where the line was read before it followed `cd`. */
  readonly cwd: string;
  readonly environment: ShellWriteEnvironment;
  readonly context: DirectoryChangeContext;
  /** The line has a compound command or a function, which the walk does not follow. */
  readonly unfollowed: boolean;
  readonly collection: ShellWriteTargetCollection;
}

function separatorAt(walk: DirectoryWalk): string | undefined {
  const token = walk.tokens[walk.index];
  return token !== undefined && isShellCommandSeparator(token) ? token.value : undefined;
}

function writesAnything(collection: ShellWriteTargetCollection): boolean {
  return (
    collection.targets.length > 0 ||
    collection.deletions.length > 0 ||
    collection.moves.length > 0
  );
}

/**
 * Collects the targets of part of a command in every directory it may run
 * in. Where the directory is not known, the part is also read in the tool
 * call's directory, as the line was read before it followed `cd`, and a
 * write there makes the result indeterminate.
 */
function collectPartTargets(
  walk: DirectoryWalk,
  part: readonly ShellToken[],
  state: DirectoryState,
): void {
  if (part.length === 0) return;
  const directoryUnknown = state.unknown || walk.unfollowed;
  const directories = new Set(state.known);
  if (directoryUnknown) directories.add(walk.cwd);
  const environment = { ...walk.environment, directoryUnknown };
  const collected = emptyTargetCollection();
  for (const directory of directories) {
    mergeTargetCollections(collected, collectRedirectionTargets(part, directory));
    mergeTargetCollections(
      collected,
      collectSegmentCommandWriteTargets(part, directory, environment),
    );
  }
  if (directoryUnknown && writesAnything(collected)) collected.indeterminate = true;
  mergeTargetCollections(walk.collection, collected);
}

/** A `cd` may fail; then the shell stays where it was. */
function applyDirectoryChange(
  walk: DirectoryWalk,
  state: DirectoryState,
  change: DirectoryChange | undefined,
): DirectoryOutcome {
  if (change === undefined) return sameOutcome(state);
  if (change.kind === "shell-code") {
    return sameOutcome({ known: new Set([...state.known, walk.cwd]), unknown: state.unknown });
  }
  if (change.kind === "unknown") {
    return { succeeded: { known: state.known, unknown: true }, failed: state };
  }
  const known = new Set(
    [...state.known].map((directory) => resolvePath(directory, change.path)),
  );
  return {
    succeeded: { known, unknown: state.unknown && !isAbsolute(change.path) },
    failed: state,
  };
}

/**
 * One command: its words, and the subshells and substitutions inside it,
 * which run in a subshell whose `cd` ends with it.
 */
function walkCommand(
  walk: DirectoryWalk,
  state: DirectoryState,
  closer?: string,
): DirectoryOutcome {
  const words: ShellToken[] = [];
  let part: ShellToken[] = [];
  let subshell = false;
  let substitution = false;
  let substitutedCommand = false;
  while (walk.index < walk.tokens.length) {
    const separator = separatorAt(walk);
    const opensBacktick = separator === "`" && closer !== "`";
    const opener = separator === "(" ? ")" : opensBacktick ? "`" : undefined;
    if (separator !== undefined && opener === undefined) break;
    const token = walk.tokens[walk.index]!;
    walk.index += 1;
    if (opener === undefined) {
      words.push(token);
      part.push(token);
      continue;
    }
    // The part before the scope is read on its own, as the line reader always split it.
    collectPartTargets(walk, part, state);
    part = [];
    if (opener === ")" && words.length === 0) subshell = true;
    else substitution = true;
    // `` `echo cd` .. ``: the substitution's output is the command.
    const stripped = stripRedirections(words);
    if (opener === "`" && commandWordIndex(stripped) >= stripped.length) {
      substitutedCommand = true;
    }
    walkList(walk, state, opener);
    if (separatorAt(walk) === opener) walk.index += 1;
  }
  collectPartTargets(walk, part, state);
  if (subshell) return sameOutcome(state);
  const change = substitutedCommand ? UNKNOWN_DIRECTORY : directoryChangeOf(words, walk.context);
  // `cd "$(pwd)/x"`: where a substitution leads is not on the line.
  const substituted = substitution && change?.kind === "to";
  return applyDirectoryChange(walk, state, substituted ? UNKNOWN_DIRECTORY : change);
}

/**
 * Every command of a pipeline but the last runs in a subshell; the last
 * runs in this shell under zsh (and bash's lastpipe), so its `cd` may or
 * may not last.
 */
function walkPipeline(
  walk: DirectoryWalk,
  state: DirectoryState,
  closer?: string,
): DirectoryOutcome {
  const first = walkCommand(walk, state, closer);
  if (!PIPE_SEPARATORS.has(separatorAt(walk) ?? "")) return first;
  let last = first;
  while (PIPE_SEPARATORS.has(separatorAt(walk) ?? "")) {
    walk.index += 1;
    last = walkCommand(walk, state, closer);
  }
  const lastRan = unionDirectoryStates(last.succeeded, last.failed);
  return sameOutcome(unionDirectoryStates(state, lastRan));
}

/** `a && b` runs b where a succeeded; `a || b` runs b where a failed. */
function walkAndOr(
  walk: DirectoryWalk,
  state: DirectoryState,
  closer?: string,
): DirectoryOutcome {
  let outcome = walkPipeline(walk, state, closer);
  for (;;) {
    const operator = separatorAt(walk);
    if (operator !== "&&" && operator !== "||") return outcome;
    walk.index += 1;
    if (operator === "&&") {
      const next = walkPipeline(walk, outcome.succeeded, closer);
      outcome = {
        succeeded: next.succeeded,
        failed: unionDirectoryStates(outcome.failed, next.failed),
      };
    } else {
      const next = walkPipeline(walk, outcome.failed, closer);
      outcome = {
        succeeded: unionDirectoryStates(outcome.succeeded, next.succeeded),
        failed: next.failed,
      };
    }
  }
}

/**
 * Commands up to `closer` (the end of a subshell or substitution) or the
 * end of the line. After `;` the next command runs whatever the last one
 * returned; a list sent to the background with `&` runs in a subshell.
 */
function walkList(
  walk: DirectoryWalk,
  state: DirectoryState,
  closer?: string,
): DirectoryState {
  let current = state;
  while (walk.index < walk.tokens.length) {
    const listStart = current;
    const outcome = walkAndOr(walk, current, closer);
    current = unionDirectoryStates(outcome.succeeded, outcome.failed);
    const separator = separatorAt(walk);
    if (separator === undefined || separator === closer) break;
    // A `;`, a `&`, or a `)` that closes nothing (a `case` pattern, in a
    // line the walk does not follow).
    walk.index += 1;
    if (separator === "&") current = listStart;
    else if (!LIST_SEPARATORS.has(separator)) current = unionDirectoryStates(current, listStart);
  }
  return current;
}

/**
 * The targets of a command line that changes directory, each command read
 * in every directory it may run in: `cd x && cmd` runs cmd in x, `cd x; cmd`
 * in x or, when the cd fails, where the line started, and a subshell's or a
 * background list's change ends with it. Where a change the line does not
 * spell out (`cd "$DIR"`, `cd -`, `popd`) may have moved the shell, a later
 * write is indeterminate; so is any write in a line with a compound command
 * or a function, which the walk does not follow. Those commands are also
 * read in the tool call's directory, so a target the line reader saw before
 * it followed `cd` is still judged.
 */
function collectTargetsFollowingDirectoryChanges(
  parsed: ReturnType<typeof lexShellCommand>,
  cwd: string,
  environment: ShellWriteEnvironment,
): ShellWriteTargetCollection {
  const collection = emptyTargetCollection();
  collection.indeterminate ||= parsed.malformed || parsed.hasCommandSubstitution;
  const walk: DirectoryWalk = {
    tokens: parsed.tokens,
    index: 0,
    cwd,
    environment,
    context: directoryChangeContext(parsed.tokens),
    unfollowed: !lineStructureIsFollowed(parsed.tokens),
    collection,
  };
  walkList(walk, { known: new Set([cwd]), unknown: environment.directoryUnknown === true });
  return collection;
}

function collectShellCommandWriteTargets(
  commandLine: string,
  cwd: string,
  environment: ShellWriteEnvironment,
): ShellWriteTargetCollection {
  const parsed = lexShellCommand(commandLine);
  if (lineChangesDirectory(parsed.tokens)) {
    return collectTargetsFollowingDirectoryChanges(parsed, cwd, environment);
  }
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
export function shellTempRoots(): readonly string[] {
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

/** The editing tools a refusal names, and the tool that loads them if they are not listed. */
interface NamedFileWriteTools {
  readonly names: readonly string[];
  readonly loadWith?: string;
}

/** Whichever of Edit and Write are available, else MultiEdit or apply_patch. */
function preferredFileWriteTools(available: readonly string[]): readonly string[] {
  const primary = PRIMARY_FILE_WRITE_TOOL_NAMES.filter((name) => available.includes(name));
  if (primary.length > 0) return primary;
  return FALLBACK_FILE_WRITE_TOOL_NAMES.filter((name) => available.includes(name));
}

/**
 * The editing tools a refusal names: Edit and Write when there is no session
 * to ask; otherwise the listed ones (an OpenAI Light session lists
 * apply_patch, not Edit and Write); else the unlisted ones, with the tool that
 * loads them; else none.
 */
function fileWriteToolsToName(tools: ShellFileWriteTools | undefined): NamedFileWriteTools {
  if (tools === undefined) return { names: PRIMARY_FILE_WRITE_TOOL_NAMES };
  const listed = preferredFileWriteTools(tools.listed);
  if (listed.length > 0) return { names: listed };
  const unlisted = preferredFileWriteTools(tools.unlisted);
  return unlisted.length > 0 && tools.loadWith !== undefined
    ? { names: unlisted, loadWith: tools.loadWith }
    : { names: unlisted };
}

/** `Write`, `Edit or Write`, `MultiEdit and apply_patch`. */
function joinToolNames(names: readonly string[], conjunction: "and" | "or"): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

/** Use the named editing tools, and how to load them when they are not listed. */
function useFileWriteTools(tools: NamedFileWriteTools, purpose: string): string {
  const use = `; use ${joinToolNames(tools.names, "or")} ${purpose}.`;
  if (tools.loadWith === undefined) return use;
  const one = tools.names.length === 1;
  return `${use} ${one ? "Its schema is" : "Their schemas are"} not loaded yet; ` +
    `${tools.loadWith} with select:${tools.names.join(",")} loads ${one ? "it" : "them"}.`;
}

function buildPolicyMessage(
  blockedTargets: readonly string[],
  fileWriteTools: NamedFileWriteTools,
): string {
  const instead = fileWriteTools.names.length > 0
    ? useFileWriteTools(fileWriteTools, "instead")
    : ". This session has no file editing tool, so it cannot change these " +
      "files: put scratch files under one of those directories (tmp/, for " +
      "example) and describe any other change in your reply instead of making it.";
  return (
    "shell_workspace_file_write_disallowed: shell commands may not write " +
    "workspace files except under build, dist, logs, .cache, tmp, or coverage" +
    instead +
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
  fileWriteTools: () => NamedFileWriteTools,
): string {
  const parts: string[] = [];
  if (reasons.has("needs_approval")) {
    // apply_patch can remove a file; the others cannot.
    const cannotDelete = fileWriteTools().names.filter((name) => name !== "apply_patch");
    parts.push(
      "shell_workspace_file_delete_requires_approval: deleting or moving " +
        "workspace files with a shell command needs the user's approval in this " +
        "permission mode; ask the user to approve this exact command, or to " +
        "switch to acceptEdits or bypassPermissions, then run it again." +
        (cannotDelete.length > 0
          ? ` ${joinToolNames(cannotDelete, "and")} cannot delete files.`
          : ""),
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
  fileWriteTools: NamedFileWriteTools,
): string {
  const instead = fileWriteTools.names.length > 0
    ? useFileWriteTools(fileWriteTools, "for workspace files")
    : ". This session has no file editing tool, so keep scratch files under " +
      "the workspace's build, dist, logs, .cache, tmp, or coverage directory.";
  return (
    "shell_workspace_file_write_disallowed: Unable to confirm workspace write targets " +
    "for this shell command. Name each file it writes with a literal path, " +
    "without variables or globs, and leave out command substitution" +
    instead +
    (observedTargets.length > 0
      ? ` Observed target(s): ${observedTargets.join(", ")}`
      : "")
  );
}

/** The targets of a shell tool call: a command line, or a program and its argument vector. */
function collectToolCallWriteTargets(
  args: Record<string, unknown>,
  environment: ShellWriteEnvironment,
): ShellWriteTargetCollection {
  const cwd = resolveWorkingDirectory(environment.workspaceRoot, args.cwd);
  if (Array.isArray(args.args)) {
    return collectDirectCommandWriteTargets({
      command: typeof args.command === "string" ? args.command : "",
      args: args.args.filter((value): value is string => typeof value === "string"),
      cwd,
      environment,
    });
  }
  if (typeof args.command === "string") {
    return collectShellCommandWriteTargets(args.command, cwd, environment);
  }
  return emptyTargetCollection();
}

export interface ShellMutationTargets {
  /** Every path the command writes, removes, or moves a file from or onto. */
  readonly targets: readonly string[];
  /** Some target could not be read from the command (`> "$OUT"`, a write after `cd "$DIR"`). */
  readonly indeterminate: boolean;
}

/**
 * Every path a shell tool call changes, as far as the command line shows it,
 * with each command resolved in the directories it may run in: `args.cwd`
 * (relative to `workspaceRoot`) and any `cd` earlier in the line, read as
 * the workspace write policy reads it. What a program does on its own
 * (`node -e`, `git -C`) is not visible here.
 */
export function collectShellMutationTargets(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot: string;
  readonly platform?: NodeJS.Platform;
}): ShellMutationTargets {
  if (!SHELL_WORKSPACE_WRITE_TOOL_NAMES.has(params.toolName)) {
    return { targets: [], indeterminate: false };
  }
  const collected = collectToolCallWriteTargets(params.args, {
    bsdSed: BSD_SED_PLATFORMS.has(params.platform ?? process.platform),
    workspaceRoot: params.workspaceRoot,
  });
  const targets = [...collected.targets];
  for (const target of collected.deletions) pushUnique(targets, target);
  for (const move of collected.moves) {
    for (const source of move.sources) pushUnique(targets, source);
    pushUnique(targets, move.destination);
  }
  return { targets, indeterminate: collected.indeterminate };
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
      message: buildIndeterminatePolicyMessage(
        [],
        fileWriteToolsToName(params.fileWriteTools?.()),
      ),
    };
  }

  const workspaceRoot = params.workspaceRoot;
  const collected = collectToolCallWriteTargets(params.args, {
    bsdSed: BSD_SED_PLATFORMS.has(params.platform ?? process.platform),
    workspaceRoot,
  });

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
  // Resolved on the first message that names a tool, never for an allowed command.
  let namedFileWriteTools: NamedFileWriteTools | undefined;
  const fileWriteTools = (): NamedFileWriteTools =>
    (namedFileWriteTools ??= fileWriteToolsToName(params.fileWriteTools?.()));
  if (routedTargets.length > 0) {
    messages.push(buildPolicyMessage(routedTargets, fileWriteTools()));
  }
  // Refused even with approvals bypassed: where these land is unknown, so they
  // could reach a protected path.
  if (unresolvedTargets.length > 0) {
    messages.push(
      `sed would write through a path whose destination cannot be determined (${unresolvedTargets.join(", ")}); the command was not run. Write to a path without a symlink loop.`,
    );
  }
  if (blockedDeletions.length > 0) {
    messages.push(
      buildDeletionPolicyMessage(deletionReasons, blockedDeletions, fileWriteTools),
    );
  }
  // With approvals bypassed and no sandbox, an unresolvable target no longer
  // has a prompt or a kernel boundary to be routed to; refusing it only made
  // the model rewrite `echo "$(id)"` and `for f in *; do ... done` until they
  // parsed. The decision still reports `indeterminate` for callers.
  if (collected.indeterminate && !bypassesApprovalsAndSandbox) {
    messages.push(buildIndeterminatePolicyMessage(observedTargets, fileWriteTools()));
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
