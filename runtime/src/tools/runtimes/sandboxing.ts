import path from "node:path";
import {
  externalFileSystemPolicy,
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type FileSystemSandboxEntry,
  type NetworkSandboxPolicy,
  type PermissionProfile,
} from "../../sandbox/engine/index.js";
import {
  compatibilitySandboxPolicyForPermissionProfile,
} from "../../sandbox/engine/manager.js";
import {
  SandboxDeniedError,
  isPathWritable,
  type SandboxPolicy,
} from "../../permissions/sandbox.js";
import { classifyShellWorkspaceWritePolicy } from "../../llm/shell-write-policy.js";
import type { SandboxMode } from "../orchestrator.js";
import type { Tool } from "../types.js";
import type { ToolRuntimeAttemptContext } from "./context.js";

export interface RuntimeSandboxProfileOptions {
  readonly cwd: string;
  readonly network?: NetworkSandboxPolicy;
}

export interface RuntimeSandboxEnforcementInput {
  readonly context: ToolRuntimeAttemptContext;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
}

interface WriteAnalysis {
  readonly targets: readonly string[];
  readonly indeterminate: boolean;
  readonly knownSafeWhenTargetless: boolean;
}

function projectRootEntry(
  access: FileSystemSandboxEntry["access"],
): FileSystemSandboxEntry {
  return {
    path: { kind: "special", value: { kind: "project_roots" } },
    access,
  };
}

function tmpdirEntry(): FileSystemSandboxEntry {
  return {
    path: { kind: "special", value: { kind: "tmpdir" } },
    access: "write",
  };
}

export function permissionProfileForSandboxMode(
  mode: SandboxMode,
  options: RuntimeSandboxProfileOptions,
): PermissionProfile {
  const network = options.network ?? "enabled";
  switch (mode) {
    case "danger_full_access":
      return permissionProfileFromRuntimePermissions(
        unrestrictedFileSystemPolicy(),
        network,
      );
    case "external_sandbox":
      return permissionProfileFromRuntimePermissions(
        externalFileSystemPolicy(),
        network,
      );
    case "read_only":
      return permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy([projectRootEntry("read")], {
          includePlatformDefaults: true,
        }),
        network,
      );
    case "workspace_write":
      return permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy(
          [projectRootEntry("write"), tmpdirEntry()],
          { includePlatformDefaults: true },
        ),
        network,
      );
  }
  void options.cwd;
}

export function sandboxModeRequiresPlatformIsolation(mode: SandboxMode): boolean {
  return mode === "read_only" || mode === "workspace_write";
}

export function compatibilityPolicyForSandboxMode(
  mode: SandboxMode,
  options: RuntimeSandboxProfileOptions,
): SandboxPolicy {
  const profile = permissionProfileForSandboxMode(mode, options);
  return compatibilitySandboxPolicyForPermissionProfile(
    profile,
    profile.fileSystem,
    profile.network,
    options.cwd,
  );
}

export function enforceRuntimeSandboxAttempt(
  input: RuntimeSandboxEnforcementInput,
): void {
  const cwd = runtimeCwd(input.context);
  const policy = compatibilityPolicyForSandboxMode(input.context.sandboxMode, {
    cwd,
  });
  if (policy.kind === "danger_full_access" || policy.kind === "external_sandbox") {
    return;
  }
  if (!toolMayMutate(input.tool)) return;
  const writes = analyzeWrites(input.tool, input.args, cwd);
  if (writes.indeterminate) {
    throw new SandboxDeniedError(
      `sandbox ${policy.kind} could not verify write targets for ${input.tool.name}`,
      {
        denial: "filesystem",
        target: writes.targets[0] ?? input.tool.name,
        policy,
      },
    );
  }
  if (policy.kind === "read_only") {
    if (writes.targets.length === 0 && writes.knownSafeWhenTargetless) return;
    throw new SandboxDeniedError(
      `sandbox read_only blocked write-capable operation ${input.tool.name}`,
      {
        denial: "filesystem",
        target: writes.targets[0] ?? input.tool.name,
        policy,
      },
    );
  }

  for (const target of writes.targets) {
    if (!isPathWritable(policy, target, cwd)) {
      throw new SandboxDeniedError(
        `sandbox workspace_write blocked write outside workspace: ${target}`,
        {
          denial: "filesystem",
          target,
          policy,
        },
      );
    }
  }
}

function analyzeWrites(
  tool: Tool,
  args: Record<string, unknown>,
  cwd: string,
): WriteAnalysis {
  const shell = shellWriteAnalysis(tool, args, cwd);
  if (shell !== null) return shell;
  const targets = writeTargets(args, cwd);
  return {
    targets,
    indeterminate: targets.length === 0,
    knownSafeWhenTargetless: false,
  };
}

function shellWriteAnalysis(
  tool: Tool,
  args: Record<string, unknown>,
  cwd: string,
): WriteAnalysis | null {
  if (!SHELL_TOOL_NAMES.has(tool.name)) return null;
  const command =
    typeof args["cmd"] === "string"
      ? args["cmd"]
      : typeof args["command"] === "string"
        ? args["command"]
        : typeof args["chars"] === "string"
          ? args["chars"]
          : undefined;
  if (command === undefined || command.trim().length === 0) {
    return {
      targets: [],
      indeterminate: false,
      knownSafeWhenTargetless: true,
    };
  }
  const cwdArg =
    typeof args["workdir"] === "string"
      ? args["workdir"]
      : typeof args["cwd"] === "string"
        ? args["cwd"]
        : cwd;
  const decision = classifyShellWorkspaceWritePolicy({
    toolName: "exec_command",
    args: {
      command,
      cwd: cwdArg,
    },
    workspaceRoot: cwd,
  });
  const knownReadOnly = isShellCommandKnownReadOnly(command);
  return {
    targets: decision.observedTargets,
    indeterminate:
      decision.indeterminate ||
      (decision.observedTargets.length === 0 && !knownReadOnly),
    knownSafeWhenTargetless: knownReadOnly,
  };
}

function runtimeCwd(context: ToolRuntimeAttemptContext): string {
  const cwd = (context.invocation.turn as { readonly cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function toolMayMutate(tool: Tool): boolean {
  if (tool.isReadOnly === true) return false;
  if (tool.metadata?.mutating === true) return true;
  if (
    tool.recoveryCategory === "side-effecting" ||
    tool.recoveryCategory === "interactive"
  ) {
    return true;
  }
  return MUTATING_TOOL_NAMES.has(tool.name);
}

const MUTATING_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "apply_patch",
  "exec_command",
  "system.bash",
  "system.delete",
  "system.mkdir",
  "system.move",
  "write_stdin",
]);

const SHELL_TOOL_NAMES = new Set([
  "exec_command",
  "system.bash",
  "write_stdin",
]);

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

const WRITE_PATH_ARG_KEYS = new Set([
  "dest",
  "destination",
  "dir",
  "directory",
  "file_path",
  "filepath",
  "filename",
  "file_name",
  "path",
  "target",
  "target_path",
  "targetpath",
  "new_path",
  "newpath",
  "old_path",
  "oldpath",
  "output",
  "output_path",
  "outputpath",
]);

function writeTargets(
  args: Record<string, unknown>,
  cwd: string,
): readonly string[] {
  const targets = new Set<string>();
  const baseCwd = argWorkingDirectory(args, cwd);
  collectWriteTargets(args, baseCwd, undefined, targets);
  return [...targets];
}

function collectWriteTargets(
  value: unknown,
  cwd: string,
  key: string | undefined,
  targets: Set<string>,
): void {
  if (typeof value === "string") {
    if (key !== undefined && isWritePathArgKey(key)) {
      targets.add(resolveTarget(value, cwd));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectWriteTargets(entry, cwd, key, targets);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectWriteTargets(childValue, cwd, childKey, targets);
  }
}

function argWorkingDirectory(
  args: Record<string, unknown>,
  cwd: string,
): string {
  const value = typeof args["workdir"] === "string"
    ? args["workdir"]
    : typeof args["cwd"] === "string"
      ? args["cwd"]
      : undefined;
  return value === undefined ? cwd : resolveTarget(value, cwd);
}

function isWritePathArgKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return WRITE_PATH_ARG_KEYS.has(normalized) || normalized.endsWith("path");
}

function isShellCommandKnownReadOnly(command: string): boolean {
  const segments = tokenizeShellLike(command);
  return segments.length > 0 && segments.every(isShellSegmentKnownReadOnly);
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
