import path from "node:path";
import {
  SHELL_COMMAND_SEPARATORS,
  tokenizeShellCommand,
} from "../../llm/_deps/command-line.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import type { Tool } from "../types.js";
import {
  isUnifiedExecRuntimeTool,
  unifiedExecRuntimeCommand,
} from "./unified-exec.js";
import { resolveRuntimePathTarget } from "./paths.js";

export interface ShellRuntimeAccessAnalysis {
  readonly writeTargets: readonly string[];
  readonly readTargets: readonly string[];
  readonly indeterminateRead: boolean;
  readonly indeterminateWrite: boolean;
  readonly knownSafeWhenTargetless: boolean;
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  "basename",
  "cat",
  "cut",
  "dirname",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
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
const DYNAMIC_SHELL_READ_TARGET_RE = /(?:[$*?\[\]{}~]|`|\$\(|<\()/u;

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
      indeterminateRead: false,
      indeterminateWrite: false,
      knownSafeWhenTargetless: true,
    };
  }

  const knownReadOnly = isShellCommandKnownReadOnly(command);
  const reads = shellCommandReadTargets(command, runtimeCommand.cwd);
  for (const target of reads.targets) {
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
  return {
    writeTargets: decision.observedTargets,
    readTargets: [...readTargets],
    indeterminateRead: reads.indeterminate || !knownReadOnly,
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
): { readonly targets: readonly string[]; readonly indeterminate: boolean } {
  const targets = new Set<string>();
  let indeterminate = false;
  for (const segment of tokenizeShellLike(command)) {
    const result = collectShellSegmentReadTargets(segment, cwd, targets);
    indeterminate ||= result.indeterminate;
  }
  return { targets: [...targets], indeterminate };
}

function collectShellSegmentReadTargets(
  segment: readonly string[],
  cwd: string,
  targets: Set<string>,
): { readonly indeterminate: boolean } {
  const command = shellSegmentCommand(segment);
  if (command === undefined) return { indeterminate: false };
  const commandIndex = segment.indexOf(command);
  const pathOptionValueIndexes = new Set<number>();
  let indeterminate = DYNAMIC_SHELL_READ_TARGET_RE.test(command);
  for (let i = commandIndex + 1; i < segment.length; i += 1) {
    const token = segment[i];
    if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
      pathOptionValueIndexes.add(i + 1);
    }
  }
  for (let i = commandIndex + 1; i < segment.length; i += 1) {
    const token = segment[i];
    if (!token || token === "--") continue;
    if (token.startsWith("-") && !pathOptionValueIndexes.has(i)) continue;
    if (DYNAMIC_SHELL_READ_TARGET_RE.test(token)) {
      indeterminate = true;
      continue;
    }
    if (pathOptionValueIndexes.has(i) || isShellPathOperand(token)) {
      targets.add(resolveRuntimePathTarget(token, cwd));
    }
  }
  return { indeterminate };
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
  for (const token of tokenizeShellCommand(command)) {
    if (SHELL_COMMAND_SEPARATORS.has(token)) {
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

function isShellPathOperand(token: string): boolean {
  if (token.startsWith("-")) return false;
  return (
    token.startsWith("/") ||
    token.startsWith(".") ||
    token.includes("/") ||
    token.includes("\\")
  );
}
