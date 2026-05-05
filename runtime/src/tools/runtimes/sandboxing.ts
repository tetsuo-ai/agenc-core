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
import type { SandboxMode } from "../orchestrator.js";
import type { Tool } from "../types.js";
import type { ToolRuntimeAttemptContext } from "./context.js";
import { analyzeApplyPatchRuntimeWrites } from "./apply-patch.js";
import { analyzeShellRuntimeAccess } from "./shell.js";

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
  enforceRuntimeReadSandboxAttempt(input, policy, cwd);
  if (input.tool.name === "write_stdin" && policy.kind === "read_only") {
    throw new SandboxDeniedError(
      "sandbox read_only blocked write_stdin without process sandbox context",
      {
        denial: "filesystem",
        target: input.tool.name,
        policy,
      },
    );
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

function enforceRuntimeReadSandboxAttempt(
  input: RuntimeSandboxEnforcementInput,
  policy: SandboxPolicy,
  cwd: string,
): void {
  if (policy.kind !== "read_only") return;
  const shell = analyzeShellRuntimeAccess(input.tool, input.args, cwd);
  if (shell === null) return;
  if (shell.indeterminateRead) {
    throw new SandboxDeniedError(
      `sandbox read_only could not verify read targets for ${input.tool.name}`,
      {
        denial: "filesystem",
        target: input.tool.name,
        policy,
      },
    );
  }
  for (const target of shell.readTargets) {
    if (isPathUnder(target, cwd)) continue;
    throw new SandboxDeniedError(
      `sandbox read_only blocked read outside workspace: ${target}`,
      {
        denial: "filesystem",
        target,
        policy,
      },
    );
  }
}

function analyzeWrites(
  tool: Tool,
  args: Record<string, unknown>,
  cwd: string,
): WriteAnalysis {
  const shell = analyzeShellRuntimeAccess(tool, args, cwd);
  if (shell !== null) {
    return {
      targets: shell.writeTargets,
      indeterminate: shell.indeterminateWrite,
      knownSafeWhenTargetless: shell.knownSafeWhenTargetless,
    };
  }
  const patch = analyzeApplyPatchRuntimeWrites(tool, args, cwd);
  if (patch !== null) {
    return {
      targets: patch.targets,
      indeterminate: patch.indeterminate,
      knownSafeWhenTargetless: false,
    };
  }
  if (tool.name === "write_stdin") {
    return {
      targets: [],
      indeterminate: false,
      knownSafeWhenTargetless: true,
    };
  }
  const targets = writeTargets(args, cwd);
  return {
    targets,
    indeterminate: targets.length === 0,
    knownSafeWhenTargetless: false,
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

function resolveTarget(value: string, cwd: string): string {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(cwd, value);
}

function isPathUnder(candidateRaw: string, rootRaw: string): boolean {
  const candidate = path.normalize(candidateRaw);
  const root = path.normalize(rootRaw);
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}
