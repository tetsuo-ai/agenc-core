import { basename, relative, resolve as resolvePath, sep } from "node:path";

import {
  SHELL_COMMAND_SEPARATORS,
  tokenizeShellCommand,
} from "../tools/system/command-line.js";

const SHELL_WORKSPACE_WRITE_TOOL_NAMES = new Set([
  "system.bash",
  "desktop.bash",
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
  "<>",
  ">&",
  "<&",
  "&>",
  "&>>",
]);
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
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const DYNAMIC_SHELL_TARGET_RE = /(?:[$*?\[\]{}~]|`|\$\(|<\()/;

export interface ShellWorkspaceWritePolicyDecision {
  readonly blocked: boolean;
  readonly indeterminate: boolean;
  readonly observedTargets: readonly string[];
  readonly blockedTargets: readonly string[];
  readonly message?: string;
}

interface ShellWriteTargetCollection {
  targets: string[];
  indeterminate: boolean;
}

function isWritePolicyEnabled(turnClass: string | undefined): boolean {
  return turnClass === "workflow_implementation";
}

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

function normalizeConcreteTargetPath(
  rawPath: string,
  cwd: string,
): ShellWriteTargetCollection {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed === "-") {
    return { targets: [], indeterminate: false };
  }
  if (DYNAMIC_SHELL_TARGET_RE.test(trimmed)) {
    return { targets: [], indeterminate: true };
  }
  return {
    targets: [
      trimmed.startsWith("/")
        ? resolvePath(trimmed)
        : resolvePath(cwd, trimmed),
    ],
    indeterminate: false,
  };
}

function emptyTargetCollection(): ShellWriteTargetCollection {
  return { targets: [], indeterminate: false };
}

function collectOperandTargets(
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
  const collection: ShellWriteTargetCollection = {
    targets: [],
    indeterminate: false,
  };
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
    const normalized = normalizeConcreteTargetPath(token, cwd);
    collection.indeterminate ||= normalized.indeterminate;
    for (const target of normalized.targets) {
      if (!collection.targets.includes(target)) {
        collection.targets = [...collection.targets, target];
      }
    }
  }
  return collection;
}

function isWorkspaceGeneratedOutputPath(
  workspaceRoot: string,
  absolutePath: string,
): boolean {
  const rel = relative(workspaceRoot, absolutePath);
  if (
    rel.length === 0 ||
    rel === "." ||
    rel.startsWith("..") ||
    rel.startsWith(`..${sep}`)
  ) {
    return false;
  }
  const firstSegment = rel.split(/[\\/]/)[0] ?? "";
  return WORKSPACE_GENERATED_ROOTS.has(firstSegment);
}

function stripRedirections(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (ALL_REDIRECT_OPERATORS.has(token)) {
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

function collectDestinationTarget(
  command: string,
  args: readonly string[],
  cwd: string,
): ShellWriteTargetCollection {
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
  const explicitTarget = targetDirectory
    ? normalizeConcreteTargetPath(targetDirectory, cwd)
    : emptyTargetCollection();
  const collection = {
    targets: [...explicitTarget.targets],
    indeterminate: explicitTarget.indeterminate,
  };
  if (collection.targets.length > 0 || collection.indeterminate) {
    if (collection.targets.length > 0) {
      return collection;
    }
    return collection;
  }
  const destination = operands[operands.length - 1];
  if (!destination) {
    return collection;
  }
  const normalized = normalizeConcreteTargetPath(destination, cwd);
  collection.indeterminate ||= normalized.indeterminate;
  for (const target of normalized.targets) {
    if (!collection.targets.includes(target)) {
      collection.targets.push(target);
    }
  }
  if (command === "install" && operands.length <= 1 && !targetDirectory) {
    return emptyTargetCollection();
  }
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
      return { targets: [], indeterminate: true };
    }
    return emptyTargetCollection();
  }
  if (SHELL_WRAPPER_COMMANDS.has(command)) {
    const nestedCommand = extractWrappedShellCommand(params.args);
    return nestedCommand
      ? collectShellCommandWriteTargets(nestedCommand, params.cwd)
      : hasWrapperScriptOperand(params.args)
        ? emptyTargetCollection()
        : { targets: [], indeterminate: true };
  }
  if (command === "tee") {
    return collectTeeTargets(params.args, params.cwd);
  }
  if (command === "touch") {
    return collectTouchTargets(params.args, params.cwd);
  }
  if (command === "cp" || command === "mv" || command === "install" || command === "ln") {
    return collectDestinationTarget(command, params.args, params.cwd);
  }
  if (command === "mkdir") {
    return emptyTargetCollection();
  }
  if (command === "rm" || command === "rmdir" || command === "truncate") {
    return collectOperandTargets(params.args, params.cwd);
  }
  if (command === "dd") {
    const targets = new Set<string>();
    let indeterminate = false;
    for (const token of params.args) {
      if (!token) continue;
      if (token.startsWith("of=")) {
        const normalized = normalizeConcreteTargetPath(token.slice(3), params.cwd);
        indeterminate ||= normalized.indeterminate;
        for (const target of normalized.targets) {
          targets.add(target);
        }
      }
      if (token.startsWith("of=") && token.length === 3) {
        indeterminate = true;
      }
    }
    return { targets: [...targets], indeterminate };
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
  const targets = new Set<string>();
  let indeterminate = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || !WRITE_REDIRECT_OPERATORS.has(token)) {
      continue;
    }
    const next = tokens[i + 1];
    if (!next || SHELL_COMMAND_SEPARATORS.has(next) || ALL_REDIRECT_OPERATORS.has(next)) {
      indeterminate = true;
      continue;
    }
    if (
      token === ">&" &&
      (/^\d+$/.test(next) || /^&\d+$/.test(next))
    ) {
      continue;
    }
    const normalized = normalizeConcreteTargetPath(next, cwd);
    indeterminate ||= normalized.indeterminate;
    for (const target of normalized.targets) {
      targets.add(target);
    }
  }
  return { targets: [...targets], indeterminate };
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
  const redirections = collectRedirectionTargets(tokens, cwd);
  const targets = new Set<string>(redirections.targets);
  let indeterminate = redirections.indeterminate;
  let segment: string[] = [];
  const flushSegment = (): void => {
    const collection = collectSegmentCommandWriteTargets(segment, cwd);
    indeterminate ||= collection.indeterminate;
    for (const target of collection.targets) {
      targets.add(target);
    }
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
  return { targets: [...targets], indeterminate };
}

function buildPolicyMessage(blockedTargets: readonly string[]): string {
  return (
    "shell_workspace_file_write_disallowed: Workflow implementation turns " +
    "must use structured file tools for project file authoring. Use " +
    "`system.writeFile`, `system.editFile`, `system.appendFile`, " +
    "`desktop.text_editor`, `system.mkdir`, or `system.move` instead of " +
    "shell redirection, heredocs, `tee`, `cp`, `mv`, `ln`, `touch`, `install`, " +
    "`rm`, `rmdir`, `truncate`, `dd`, `sed -i`, or `perl -i` for workspace files. " +
    "Shell writes are only allowed under generated output roots (`build`, `dist`, " +
    "`logs`, `.cache`, `tmp`, `coverage`)." +
    (blockedTargets.length > 0
      ? ` Blocked target(s): ${blockedTargets.join(", ")}`
      : "")
  );
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

export function classifyShellWorkspaceWritePolicy(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot?: string;
}): ShellWorkspaceWritePolicyDecision {
  if (!SHELL_WORKSPACE_WRITE_TOOL_NAMES.has(params.toolName)) {
    return {
      blocked: false,
      indeterminate: false,
      observedTargets: [],
      blockedTargets: [],
    };
  }
  if (!params.workspaceRoot) {
    return {
      blocked: true,
      indeterminate: true,
      observedTargets: [],
      blockedTargets: [],
      message: buildIndeterminatePolicyMessage([]),
    };
  }

  const cwd = resolveWorkingDirectory(params.workspaceRoot, params.args.cwd);
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

  const blockedTargets = collected.targets.filter((target) => {
    const rel = relative(params.workspaceRoot!, target);
    if (
      rel.length === 0 ||
      rel === "." ||
      rel.startsWith("..") ||
      rel.startsWith(`..${sep}`)
    ) {
      return false;
    }
    return !isWorkspaceGeneratedOutputPath(params.workspaceRoot!, target);
  });

  if (collected.indeterminate) {
    return {
      blocked: true,
      indeterminate: true,
      observedTargets: collected.targets,
      blockedTargets,
      message:
        blockedTargets.length > 0
          ? `${buildPolicyMessage(blockedTargets)} ${buildIndeterminatePolicyMessage(collected.targets)}`
          : buildIndeterminatePolicyMessage(collected.targets),
    };
  }

  return {
    blocked: blockedTargets.length > 0,
    indeterminate: false,
    observedTargets: collected.targets,
    blockedTargets,
    ...(blockedTargets.length > 0
      ? { message: buildPolicyMessage(blockedTargets) }
      : {}),
  };
}

export function evaluateShellWorkspaceWritePolicy(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot?: string;
  readonly turnClass?: string;
}): ShellWorkspaceWritePolicyDecision {
  if (!isWritePolicyEnabled(params.turnClass)) {
    return {
      blocked: false,
      indeterminate: false,
      observedTargets: [],
      blockedTargets: [],
    };
  }
  return classifyShellWorkspaceWritePolicy(params);
}
