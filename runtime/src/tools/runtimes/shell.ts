import path from "node:path";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import type { Tool } from "../types.js";
import {
  isUnifiedExecRuntimeTool,
  unifiedExecRuntimeCommand,
} from "./unified-exec.js";

export interface ShellRuntimeAccessAnalysis {
  readonly writeTargets: readonly string[];
  readonly readTargets: readonly string[];
  readonly indeterminateWrite: boolean;
  readonly knownSafeWhenTargetless: boolean;
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  "awk",
  "basename",
  "cat",
  "cut",
  "dirname",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "test",
  "true",
  "uniq",
  "wc",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "merge-base",
  "rev-parse",
  "show",
  "status",
]);

export function analyzeShellRuntimeAccess(
  tool: Tool,
  args: Record<string, unknown>,
  cwd: string,
): ShellRuntimeAccessAnalysis | null {
  if (!isUnifiedExecRuntimeTool(tool)) return null;
  const runtimeCommand = unifiedExecRuntimeCommand(args, cwd);
  const readTargets = new Set<string>([runtimeCommand.cwd]);
  const command = runtimeCommand.command;
  if (command === undefined || command.trim().length === 0) {
    return {
      writeTargets: [],
      readTargets: [...readTargets],
      indeterminateWrite: false,
      knownSafeWhenTargetless: true,
    };
  }

  for (const target of shellCommandReadTargets(command, runtimeCommand.cwd)) {
    readTargets.add(target);
  }
  const decision = classifyShellWorkspaceWritePolicy({
    toolName: "exec_command",
    args: {
      command,
      cwd: runtimeCommand.cwd,
    },
    workspaceRoot: cwd,
  });
  const knownReadOnly = isShellCommandKnownReadOnly(command);
  return {
    writeTargets: decision.observedTargets,
    readTargets: [...readTargets],
    indeterminateWrite:
      decision.indeterminate ||
      (decision.observedTargets.length === 0 && !knownReadOnly),
    knownSafeWhenTargetless: knownReadOnly,
  };
}

function isShellCommandKnownReadOnly(command: string): boolean {
  const segments = tokenizeShellLike(command);
  return segments.length > 0 && segments.every(isShellSegmentKnownReadOnly);
}

function shellCommandReadTargets(
  command: string,
  cwd: string,
): readonly string[] {
  const targets = new Set<string>();
  for (const segment of tokenizeShellLike(command)) {
    collectShellSegmentReadTargets(segment, cwd, targets);
  }
  return [...targets];
}

function collectShellSegmentReadTargets(
  segment: readonly string[],
  cwd: string,
  targets: Set<string>,
): void {
  const command = shellSegmentCommand(segment);
  if (command === undefined) return;
  const commandIndex = segment.indexOf(command);
  const pathOptionValueIndexes = new Set<number>();
  for (let i = commandIndex + 1; i < segment.length; i += 1) {
    const token = segment[i];
    if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
      pathOptionValueIndexes.add(i + 1);
    }
  }
  for (let i = commandIndex + 1; i < segment.length; i += 1) {
    const token = segment[i];
    if (!token || token === "--") continue;
    if (pathOptionValueIndexes.has(i) || isShellPathOperand(token)) {
      targets.add(resolveTarget(token, cwd));
    }
  }
}

function isShellSegmentKnownReadOnly(segment: readonly string[]): boolean {
  const command = shellSegmentCommand(segment);
  if (command === undefined) return true;
  const basename = path.basename(command);
  if (basename === "git") {
    const subcommand = gitSubcommand(segment);
    return subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  return READ_ONLY_SHELL_COMMANDS.has(basename);
}

function tokenizeShellLike(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of command.split(/\s+/).filter(Boolean)) {
    if (token === "&&" || token === "||" || token === ";" || token === "|") {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  segments.push(current);
  return segments.filter((segment) => segment.length > 0);
}

function shellSegmentCommand(segment: readonly string[]): string | undefined {
  let index = 0;
  while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] ?? "")) {
    index += 1;
  }
  if (segment[index] === "env") {
    index += 1;
    while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] ?? "")) {
      index += 1;
    }
  }
  if (segment[index] === "command" || segment[index] === "builtin") {
    index += 1;
  }
  return segment[index];
}

function gitSubcommand(segment: readonly string[]): string | undefined {
  const gitIndex = segment.findIndex((token) => path.basename(token) === "git");
  if (gitIndex < 0) return undefined;
  for (const token of segment.slice(gitIndex + 1)) {
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function resolveTarget(value: string, cwd: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(cwd, value);
}

function isShellPathOperand(token: string): boolean {
  if (token.startsWith("-")) return false;
  return (
    token.startsWith("/") ||
    token.startsWith(".") ||
    token.includes("/") ||
    token.includes("\\")
  );
}
