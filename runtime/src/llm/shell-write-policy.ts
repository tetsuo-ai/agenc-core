import { homedir, tmpdir } from "node:os";
import { basename, relative, resolve as resolvePath, sep } from "node:path";

import {
  SHELL_COMMAND_SEPARATORS,
  tokenizeShellCommand,
} from "./_deps/command-line.js";

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
const ALL_REDIRECT_OPERATORS = new Set([
  ">",
  ">>",
  ">|",
  "<",
  "<<",
  "<<-",
  "<>",
  ">&",
  "<&",
  "&>",
  "&>>",
]);
// The tokenizer keeps a file-descriptor prefix glued to its operator
// (`2>`, `2>>`, `2>&`, `0<`). The prefix does not change what the
// redirection writes to, so classification looks at the bare operator.
const FD_PREFIXED_REDIRECT_RE = /^\d+(>>|>&|>\||<<-|<<|<&|<>|>|<)$/;

function redirectOperator(token: string): string | undefined {
  if (ALL_REDIRECT_OPERATORS.has(token)) return token;
  return FD_PREFIXED_REDIRECT_RE.exec(token)?.[1];
}
const WRITE_REDIRECT_OPERATORS = new Set([
  ">",
  ">>",
  ">|",
  ">&",
  "&>",
  "&>>",
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

export function isSafePseudoDevicePath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  return (
    SAFE_PSEUDO_DEVICE_TARGETS.has(trimmed) ||
    SAFE_PSEUDO_DEVICE_FD_RE.test(trimmed)
  );
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
}

interface ShellMove {
  readonly sources: readonly string[];
  readonly destination: string;
}

interface ShellWriteTargetCollection {
  targets: string[];
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
  return { targets: [], deletions: [], moves: [], indeterminate: false };
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
  for (const target of from.deletions) pushUnique(into.deletions, target);
  into.moves.push(...from.moves);
  into.indeterminate ||= from.indeterminate;
}

function normalizeConcreteTargetPath(
  rawPath: string,
  cwd: string,
): ShellWriteTargetCollection {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed === "-") {
    return emptyTargetCollection();
  }
  if (DYNAMIC_SHELL_TARGET_RE.test(trimmed)) {
    return indeterminateTargetCollection();
  }
  return {
    ...emptyTargetCollection(),
    targets: [
      trimmed.startsWith("/")
        ? resolvePath(trimmed)
        : resolvePath(cwd, trimmed),
    ],
  };
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

function stripRedirections(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (redirectOperator(token) !== undefined) {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
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

function collectDirectCommandWriteTargets(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}): ShellWriteTargetCollection {
  const command = basename(params.command);
  if (command === "env") {
    const shellIndex = params.args.findIndex((token) =>
      SHELL_WRAPPER_COMMANDS.has(basename(token)) ||
      token === "env"
    );
    if (shellIndex >= 0) {
      const nestedCommand = extractWrappedShellCommand(
        params.args.slice(shellIndex + 1),
      );
      if (nestedCommand) {
        return collectShellCommandWriteTargets(nestedCommand, params.cwd);
      }
      return indeterminateTargetCollection();
    }
    return emptyTargetCollection();
  }
  if (SHELL_WRAPPER_COMMANDS.has(command)) {
    const nestedCommand = extractWrappedShellCommand(params.args);
    return nestedCommand
      ? collectShellCommandWriteTargets(nestedCommand, params.cwd)
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
  if (command === "sed" || command === "perl") {
    const inPlace = params.args.some((token) => token === "-i" || token.startsWith("-i"));
    if (!inPlace) {
      return emptyTargetCollection();
    }
    return collectOperandTargets(params.args, params.cwd);
  }
  return emptyTargetCollection();
}

function collectRedirectionTargets(
  tokens: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const collection = emptyTargetCollection();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const operator = token === undefined ? undefined : redirectOperator(token);
    if (operator === undefined || !WRITE_REDIRECT_OPERATORS.has(operator)) {
      continue;
    }
    const next = tokens[i + 1];
    if (
      !next ||
      SHELL_COMMAND_SEPARATORS.has(next) ||
      redirectOperator(next) !== undefined
    ) {
      collection.indeterminate = true;
      continue;
    }
    if (
      operator === ">&" &&
      (/^\d+$/.test(next) || /^&\d+$/.test(next))
    ) {
      continue;
    }
    if (isSafePseudoDevicePath(next)) {
      continue;
    }
    mergeTargetCollections(collection, normalizeConcreteTargetPath(next, cwd));
  }
  return collection;
}

function collectSegmentCommandWriteTargets(
  segment: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const stripped = stripRedirections(segment);
  if (stripped.length === 0) {
    return emptyTargetCollection();
  }
  let commandIndex = 0;
  while (
    commandIndex < stripped.length &&
    ENV_ASSIGNMENT_RE.test(stripped[commandIndex] ?? "")
  ) {
    commandIndex += 1;
  }
  const command = stripped[commandIndex];
  if (!command) {
    return emptyTargetCollection();
  }
  return collectDirectCommandWriteTargets({
    command,
    args: stripped.slice(commandIndex + 1),
    cwd,
  });
}

function collectShellCommandWriteTargets(
  commandLine: string,
  cwd: string,
): ShellWriteTargetCollection {
  const tokens = tokenizeShellCommand(commandLine);
  const collection = collectRedirectionTargets(tokens, cwd);
  let segment: string[] = [];
  const flushSegment = (): void => {
    mergeTargetCollections(
      collection,
      collectSegmentCommandWriteTargets(segment, cwd),
    );
    segment = [];
  };
  for (const token of tokens) {
    if (SHELL_COMMAND_SEPARATORS.has(token)) {
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

function classifyDeletionTarget(
  absolutePath: string,
  workspaceRoot: string,
  protectedRoots: readonly string[],
  allowWorkspaceDeletions: boolean,
):
  | { readonly kind: "allowed"; readonly inWorkspace: boolean }
  | { readonly kind: "blocked"; readonly reason: DeletionBlockReason } {
  if (isProtectedDeletionPath(absolutePath, workspaceRoot, protectedRoots)) {
    return { kind: "blocked", reason: "protected" };
  }
  if (workspaceRelation(workspaceRoot, absolutePath) === "outside") {
    return isUnderTempRoot(absolutePath)
      ? { kind: "allowed", inWorkspace: false }
      : { kind: "blocked", reason: "outside" };
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
  let collected: ShellWriteTargetCollection = emptyTargetCollection();
  if (Array.isArray(params.args.args)) {
    collected = collectDirectCommandWriteTargets({
      command:
        typeof params.args.command === "string" ? params.args.command : "",
      args: params.args.args.filter((value): value is string => typeof value === "string"),
      cwd,
    });
  } else if (typeof params.args.command === "string") {
    collected = collectShellCommandWriteTargets(params.args.command, cwd);
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

  const blockedTargets = writes.filter(
    (target) =>
      workspaceRelation(workspaceRoot, target) === "inside" &&
      !isWorkspaceGeneratedOutputPath(workspaceRoot, target),
  );
  const deletionTargets: string[] = [];
  const blockedDeletions: string[] = [];
  const deletionReasons = new Set<DeletionBlockReason>();
  for (const target of removals) {
    const verdict = classifyDeletionTarget(
      target,
      workspaceRoot,
      params.protectedRoots ?? [],
      params.allowWorkspaceDeletions === true,
    );
    if (verdict.kind === "allowed") {
      if (verdict.inWorkspace) deletionTargets.push(target);
    } else {
      blockedDeletions.push(target);
      deletionReasons.add(verdict.reason);
    }
  }

  const observedTargets = [...writes];
  for (const target of removals) pushUnique(observedTargets, target);
  const messages: string[] = [];
  if (blockedTargets.length > 0) messages.push(buildPolicyMessage(blockedTargets));
  if (blockedDeletions.length > 0) {
    messages.push(buildDeletionPolicyMessage(deletionReasons, blockedDeletions));
  }
  if (collected.indeterminate) {
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
