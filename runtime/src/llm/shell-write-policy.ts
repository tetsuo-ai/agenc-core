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
  readonly observedTargets: readonly string[];
  readonly blockedTargets: readonly string[];
  readonly message?: string;
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
): string | undefined {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed === "-") {
    return undefined;
  }
  if (DYNAMIC_SHELL_TARGET_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed.startsWith("/")
    ? resolvePath(trimmed)
    : resolvePath(cwd, trimmed);
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

function collectTeeTargets(
  args: readonly string[],
  cwd: string,
): readonly string[] {
  const targets = new Set<string>();
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
    if (normalized) {
      targets.add(normalized);
    }
  }
  return [...targets];
}

function collectTouchTargets(
  args: readonly string[],
  cwd: string,
): readonly string[] {
  const targets = new Set<string>();
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
    if (normalized) {
      targets.add(normalized);
    }
  }
  return [...targets];
}

function collectDestinationTarget(
  command: string,
  args: readonly string[],
  cwd: string,
): readonly string[] {
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
    : undefined;
  if (explicitTarget) {
    return [explicitTarget];
  }
  const destination = operands[operands.length - 1];
  if (!destination) {
    return [];
  }
  const normalized = normalizeConcreteTargetPath(destination, cwd);
  if (!normalized) {
    return [];
  }
  if (command === "install" && operands.length <= 1 && !explicitTarget) {
    return [];
  }
  return [normalized];
}

function collectDirectCommandWriteTargets(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}): readonly string[] {
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
    }
    return [];
  }
  if (SHELL_WRAPPER_COMMANDS.has(command)) {
    const nestedCommand = extractWrappedShellCommand(params.args);
    return nestedCommand
      ? collectShellCommandWriteTargets(nestedCommand, params.cwd)
      : [];
  }
  if (command === "tee") {
    return collectTeeTargets(params.args, params.cwd);
  }
  if (command === "touch") {
    return collectTouchTargets(params.args, params.cwd);
  }
  if (command === "cp" || command === "mv" || command === "install") {
    return collectDestinationTarget(command, params.args, params.cwd);
  }
  return [];
}

function collectRedirectionTargets(
  tokens: readonly string[],
  cwd: string,
): readonly string[] {
  const targets = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || !WRITE_REDIRECT_OPERATORS.has(token)) {
      continue;
    }
    const next = tokens[i + 1];
    if (!next || SHELL_COMMAND_SEPARATORS.has(next) || ALL_REDIRECT_OPERATORS.has(next)) {
      continue;
    }
    if (
      token === ">&" &&
      (/^\d+$/.test(next) || /^&\d+$/.test(next))
    ) {
      continue;
    }
    const normalized = normalizeConcreteTargetPath(next, cwd);
    if (normalized) {
      targets.add(normalized);
    }
  }
  return [...targets];
}

function collectSegmentCommandWriteTargets(
  segment: readonly string[],
  cwd: string,
): readonly string[] {
  const stripped = stripRedirections(segment);
  if (stripped.length === 0) {
    return [];
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
    return [];
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
): readonly string[] {
  const tokens = tokenizeShellCommand(commandLine);
  const targets = new Set<string>(collectRedirectionTargets(tokens, cwd));
  let segment: string[] = [];
  const flushSegment = (): void => {
    for (const target of collectSegmentCommandWriteTargets(segment, cwd)) {
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
  return [...targets];
}

function buildPolicyMessage(blockedTargets: readonly string[]): string {
  return (
    "shell_workspace_file_write_disallowed: Workflow implementation turns " +
    "must use structured file tools for project file authoring. Use " +
    "`system.writeFile`, `system.editFile`, `system.appendFile`, " +
    "`desktop.text_editor`, `system.mkdir`, or `system.move` instead of " +
    "shell redirection, heredocs, `tee`, `cp`, `mv`, `touch`, or `install` " +
    "for workspace files. Shell writes are only allowed under generated " +
    "output roots (`build`, `dist`, `logs`, `.cache`, `tmp`, `coverage`)." +
    (blockedTargets.length > 0
      ? ` Blocked target(s): ${blockedTargets.join(", ")}`
      : "")
  );
}

export function evaluateShellWorkspaceWritePolicy(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly workspaceRoot?: string;
  readonly turnClass?: string;
}): ShellWorkspaceWritePolicyDecision {
  if (
    !isWritePolicyEnabled(params.turnClass) ||
    !params.workspaceRoot ||
    !SHELL_WORKSPACE_WRITE_TOOL_NAMES.has(params.toolName)
  ) {
    return {
      blocked: false,
      observedTargets: [],
      blockedTargets: [],
    };
  }

  const cwd = resolveWorkingDirectory(params.workspaceRoot, params.args.cwd);
  let observedTargets: readonly string[] = [];
  if (Array.isArray(params.args.args)) {
    observedTargets = collectDirectCommandWriteTargets({
      command:
        typeof params.args.command === "string" ? params.args.command : "",
      args: params.args.args.filter((value): value is string => typeof value === "string"),
      cwd,
    });
  } else if (typeof params.args.command === "string") {
    observedTargets = collectShellCommandWriteTargets(params.args.command, cwd);
  }

  const blockedTargets = observedTargets.filter((target) => {
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

  return {
    blocked: blockedTargets.length > 0,
    observedTargets,
    blockedTargets,
    ...(blockedTargets.length > 0
      ? { message: buildPolicyMessage(blockedTargets) }
      : {}),
  };
}
