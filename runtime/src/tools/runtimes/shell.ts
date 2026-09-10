import { inspectReadOnlyCommand } from "../../permissions/readonly-inspection.js";
import {
  isShellCommandSeparator,
  lexShellCommand,
} from "../../utils/shell/command-line.js";
import {
  classifyShellWorkspaceWritePolicy,
  isSafePseudoDevicePath,
} from "../../llm/shell-write-policy.js";
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

  const inspection = inspectReadOnlyCommand(tool.name, { ...args, ...(tool.name === "exec_command" ? { cmd: command } : { command }) }, cwd, { enforceWorkspaceBoundary: false, allowWorktreeGitInspection: true });
  const literalStdin = isLiteralCatHereDocument(command);
  const knownReadOnly = inspection.allowed || literalStdin;
  const reads = inspection.allowed
    ? { targets: inspection.invocation.readPaths, indeterminate: false }
    : literalStdin ? { targets: [], indeterminate: false }
    : shellCommandReadTargets(command, runtimeCommand.cwd);
  for (const target of reads.targets) {
    if (!isSafePseudoDevicePath(target)) readTargets.add(target);
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

function isLiteralCatHereDocument(command: string): boolean {
  const parsed = lexShellCommand(command);
  const [program, redirect, delimiter, ...tail] = parsed.tokens;
  return !parsed.malformed && !parsed.hasCommandSubstitution && !parsed.hasComment &&
    program?.kind === "word" && program.value === "cat" && !program.requiresExpansion &&
    redirect?.kind === "operator" && ["<<", "<<-"].includes(redirect.value) &&
    delimiter?.kind === "word" && !delimiter.requiresExpansion &&
    tail.every((token) => token.kind === "operator" && token.value === ";");
}

function shellCommandReadTargets(
  command: string,
  cwd: string,
): { readonly targets: readonly string[]; readonly indeterminate: boolean } {
  const targets = new Set<string>();
  const parsed = lexShellCommand(command);
  let indeterminate = parsed.malformed || parsed.hasCommandSubstitution;
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
      if (isSafePseudoDevicePath(token)) continue;
      targets.add(resolveRuntimePathTarget(token, cwd));
    }
  }
  return { indeterminate };
}

function tokenizeShellLike(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of lexShellCommand(command).tokens) {
    if (isShellCommandSeparator(token)) {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(token.value);
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

function isShellPathOperand(token: string): boolean {
  if (token.startsWith("-")) return false;
  return (
    token.startsWith("/") ||
    token.startsWith(".") ||
    token.includes("/") ||
    token.includes("\\")
  );
}
