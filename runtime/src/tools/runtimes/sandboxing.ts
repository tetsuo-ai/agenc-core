import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  externalFileSystemPolicy,
  canReadPathWithCwd,
  canWritePathWithCwd,
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type FileSystemSandboxEntry,
  type FileSystemSandboxPolicy as EngineFileSystemSandboxPolicy,
  type FileSystemPath,
  type NetworkSandboxPolicy,
  type PermissionProfile,
} from "../../sandbox/engine/index.js";
import {
  compatibilitySandboxPolicyForPermissionProfile,
} from "../../sandbox/engine/manager.js";
import {
  effectivePermissionProfile,
  normalizeAdditionalPermissions,
} from "../../sandbox/engine/policy-transforms.js";
import {
  SandboxDeniedError,
  type SandboxPolicy,
} from "../../permissions/sandbox.js";
import type { SandboxMode } from "../orchestrator.js";
import type { Tool } from "../types.js";
import type { ToolRuntimeAttemptContext } from "./context.js";
import { analyzeApplyPatchRuntimeWrites } from "./apply-patch.js";
import { resolveRuntimePathTarget } from "./paths.js";
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

export interface RuntimePlatformSandboxStatus {
  readonly available: boolean;
  readonly agencLinuxSandboxExe?: string;
  readonly reason?: string;
}

function projectRootEntry(
  access: FileSystemSandboxEntry["access"],
): FileSystemSandboxEntry {
  return {
    path: { kind: "special", value: { kind: "project_roots" } },
    access,
  };
}

function rootEntry(
  access: FileSystemSandboxEntry["access"],
): FileSystemSandboxEntry {
  return {
    path: { kind: "special", value: { kind: "root" } },
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
  const network = options.network ?? defaultNetworkForSandboxMode(mode);
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
        restrictedFileSystemPolicy([rootEntry("read")], {
          includePlatformDefaults: true,
        }),
        network,
      );
    case "workspace_write":
      return permissionProfileFromRuntimePermissions(
        restrictedFileSystemPolicy(
          [rootEntry("read"), projectRootEntry("write"), tmpdirEntry()],
          { includePlatformDefaults: true },
        ),
        network,
      );
  }
  void options.cwd;
}

function defaultNetworkForSandboxMode(mode: SandboxMode): NetworkSandboxPolicy {
  switch (mode) {
    case "danger_full_access":
      return "enabled";
    case "external_sandbox":
      return "restricted";
    case "read_only":
    case "workspace_write":
      return "disabled";
  }
}

export function sandboxModeRequiresPlatformIsolation(mode: SandboxMode): boolean {
  return mode === "read_only" || mode === "workspace_write";
}

function runtimePlatformSandboxAvailable(
  context: ToolRuntimeAttemptContext,
): boolean {
  return runtimePlatformSandboxStatus(context).available;
}

export function runtimePlatformSandboxStatus(
  context: ToolRuntimeAttemptContext,
): RuntimePlatformSandboxStatus {
  const turn = context.invocation.turn as {
    readonly agencLinuxSandboxExe?: unknown;
    readonly config?: { readonly agencLinuxSandboxExe?: unknown };
    readonly sandboxUnavailableReason?: unknown;
    readonly windowsSandboxLevel?: unknown;
  };
  switch (process.platform) {
    case "linux":
      return linuxSandboxStatus(context, turn);
    case "darwin":
      return { available: true };
    case "win32":
      if (isWindowsSandboxRequested(turn.windowsSandboxLevel)) {
        return {
          available: false,
          reason: "windows restricted token sandbox is not implemented",
        };
      }
      return { available: false, reason: "windows sandbox is disabled" };
    default:
      return { available: false, reason: `platform ${process.platform} has no sandbox` };
  }
}

function isWindowsSandboxRequested(value: unknown): boolean {
  return value === "permissive" ||
    value === "strict" ||
    value === "low" ||
    value === "medium" ||
    value === "high";
}

function linuxSandboxStatus(
  context: ToolRuntimeAttemptContext,
  turn: {
    readonly agencLinuxSandboxExe?: unknown;
    readonly config?: { readonly agencLinuxSandboxExe?: unknown };
    readonly sandboxUnavailableReason?: unknown;
  },
): RuntimePlatformSandboxStatus {
  const candidate = stringValue(turn.agencLinuxSandboxExe) ??
    stringValue(turn.config?.agencLinuxSandboxExe);
  if (candidate === undefined) {
    return {
      available: false,
      reason: stringValue(turn.sandboxUnavailableReason) ??
        "agencLinuxSandboxExe is not configured",
    };
  }
  const workspaceRoot = runtimeCwd(context);
  const resolved = path.resolve(workspaceRoot, candidate);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    return {
      available: false,
      reason: `linux sandbox helper does not exist: ${resolved}`,
    };
  }
  if (!stat.isFile()) {
    return {
      available: false,
      reason: `linux sandbox helper is not a file: ${resolved}`,
    };
  }
  if ((stat.mode & 0o111) === 0) {
    return {
      available: false,
      reason: `linux sandbox helper is not executable: ${resolved}`,
    };
  }
  const workspaceResolved = path.resolve(workspaceRoot);
  const workspaceReal = safeRealpath(workspaceRoot);
  const helperReal = safeRealpath(resolved);
  if (
    isPathUnder(resolved, workspaceResolved) ||
    isPathUnder(resolved, workspaceReal) ||
    isPathUnder(helperReal, workspaceReal)
  ) {
    return {
      available: false,
      reason: "linux sandbox helper must be outside the workspace",
    };
  }
  return { available: true, agencLinuxSandboxExe: helperReal };
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function permissionProfileForRuntimeContext(
  context: ToolRuntimeAttemptContext,
  options: RuntimeSandboxProfileOptions,
): PermissionProfile {
  if (!sandboxModeRequiresPlatformIsolation(context.sandboxMode)) {
    return applyRuntimeAdditionalPermissions(
      permissionProfileForSandboxMode(context.sandboxMode, options),
      context,
      options.cwd,
    );
  }
  const fileSystem = fileSystemPolicyFromContext(context, options.cwd);
  const network = networkPolicyFromContext(context) ??
    options.network ??
    defaultNetworkForSandboxMode(context.sandboxMode);
  const profile = fileSystem === undefined
    ? permissionProfileForSandboxMode(context.sandboxMode, {
        cwd: options.cwd,
        network,
      })
    : permissionProfileFromRuntimePermissions(fileSystem, network);
  return applyRuntimeAdditionalPermissions(profile, context, options.cwd);
}

function applyRuntimeAdditionalPermissions(
  profile: PermissionProfile,
  context: ToolRuntimeAttemptContext,
  cwd: string,
): PermissionProfile {
  if (context.additionalPermissions === undefined) return profile;
  const normalized = normalizeAdditionalPermissions(
    context.additionalPermissions,
    cwd,
  );
  return effectivePermissionProfile(profile, normalized);
}

export function enforceRuntimeSandboxAttempt(
  input: RuntimeSandboxEnforcementInput,
): void {
  const cwd = runtimeCwd(input.context);
  const profile = permissionProfileForRuntimeContext(input.context, { cwd });
  const policy = compatibilitySandboxPolicyForPermissionProfile(
    profile,
    profile.fileSystem,
    profile.network,
    cwd,
  );
  if (policy.kind === "danger_full_access" || policy.kind === "external_sandbox") {
    return;
  }
  const shellAccess = analyzeShellRuntimeAccess(input.tool, input.args, cwd);
  const platformSandbox = runtimePlatformSandboxStatus(input.context);
  if (
    shellAccess !== null &&
    sandboxModeRequiresPlatformIsolation(input.context.sandboxMode) &&
    !platformSandbox.available
  ) {
    throw new SandboxDeniedError(
      `sandbox ${policy.kind} blocked ${input.tool.name} without platform sandbox context${platformSandbox.reason ? `: ${platformSandbox.reason}` : ""}`,
      {
        denial: "filesystem",
        target: input.tool.name,
        policy,
      },
    );
  }
  if (
    shellEnvelopeRequiresPlatformSandbox(input.tool, input.args) &&
    !platformSandbox.available
  ) {
    throw new SandboxDeniedError(
      `sandbox ${policy.kind} could not verify shell execution envelope for ${input.tool.name}`,
      {
        denial: "filesystem",
        target: input.tool.name,
        policy,
      },
    );
  }
  enforceRuntimeReadSandboxAttempt(input, policy, cwd, profile.fileSystem);
  if (input.tool.name === "write_stdin") {
    if (!platformSandbox.available) {
      throw new SandboxDeniedError(
        `sandbox ${policy.kind} blocked write_stdin without platform sandbox context${platformSandbox.reason ? `: ${platformSandbox.reason}` : ""}`,
        {
          denial: "filesystem",
          target: input.tool.name,
          policy,
        },
      );
    }
    return;
  }
  if (!toolMayMutate(input.tool)) return;
  const writes = analyzeWrites(input.tool, input.args, cwd);
  if (writes.indeterminate) {
    if (
      policy.kind === "workspace_write" &&
      canDeferIndeterminateWritesToPlatformSandbox(input, cwd)
    ) {
      return;
    }
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
    if (!canWritePathWithCwd(profile.fileSystem, target, cwd)) {
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

function canDeferIndeterminateWritesToPlatformSandbox(
  input: RuntimeSandboxEnforcementInput,
  cwd: string,
): boolean {
  if (!runtimePlatformSandboxAvailable(input.context)) return false;
  return analyzeShellRuntimeAccess(input.tool, input.args, cwd) !== null;
}

function shellEnvelopeRequiresPlatformSandbox(
  tool: Tool,
  args: Record<string, unknown>,
): boolean {
  if (analyzeShellRuntimeAccess(tool, args, process.cwd()) === null) return false;
  const shell = typeof args["shell"] === "string" ? args["shell"].trim() : "";
  return shell.length > 0 || args["login"] === true || args["tty"] === true;
}

function enforceRuntimeReadSandboxAttempt(
  input: RuntimeSandboxEnforcementInput,
  policy: SandboxPolicy,
  cwd: string,
  fileSystemPolicy: EngineFileSystemSandboxPolicy,
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
    if (isPathUnder(target, cwd) && canReadPathWithCwd(fileSystemPolicy, target, cwd)) {
      continue;
    }
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
      indeterminate: true,
      knownSafeWhenTargetless: false,
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

function fileSystemPolicyFromContext(
  context: ToolRuntimeAttemptContext,
  cwd: string,
): EngineFileSystemSandboxPolicy | undefined {
  const value = (context.invocation.turn as {
    readonly fileSystemSandboxPolicy?: unknown;
  }).fileSystemSandboxPolicy;
  if (isEngineFileSystemSandboxPolicy(value)) return value;
  if (isLiveFileSystemSandboxPolicy(value)) {
    return adaptLiveFileSystemPolicy(value, context.sandboxMode, cwd);
  }
  return undefined;
}

function networkPolicyFromContext(
  context: ToolRuntimeAttemptContext,
): NetworkSandboxPolicy | undefined {
  const value = (context.invocation.turn as {
    readonly networkSandboxPolicy?: unknown;
  }).networkSandboxPolicy;
  return isNetworkSandboxPolicy(value)
    ? value
    : liveNetworkPolicyToEngine(value);
}

function isEngineFileSystemSandboxPolicy(
  value: unknown,
): value is EngineFileSystemSandboxPolicy {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly entries?: unknown;
  };
  return (
    (candidate.kind === "restricted" ||
      candidate.kind === "unrestricted" ||
      candidate.kind === "external_sandbox") &&
    Array.isArray(candidate.entries)
  );
}

function isNetworkSandboxPolicy(value: unknown): value is NetworkSandboxPolicy {
  return value === "enabled" || value === "disabled" || value === "restricted";
}

interface LiveFileSystemSandboxPolicy {
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
  readonly allowRead: readonly string[];
  readonly denyRead: readonly string[];
}

interface LiveNetworkSandboxPolicy {
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  readonly allowManagedDomainsOnly: boolean;
  readonly enabled?: boolean;
}

function isLiveFileSystemSandboxPolicy(
  value: unknown,
): value is LiveFileSystemSandboxPolicy {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LiveFileSystemSandboxPolicy>;
  return Array.isArray(candidate.allowWrite) &&
    Array.isArray(candidate.denyWrite) &&
    Array.isArray(candidate.allowRead) &&
    Array.isArray(candidate.denyRead);
}

function adaptLiveFileSystemPolicy(
  policy: LiveFileSystemSandboxPolicy,
  mode: SandboxMode,
  cwd: string,
): EngineFileSystemSandboxPolicy {
  const denyWrite = new Set(policy.denyWrite.map((value) => path.resolve(cwd, value)));
  const denyRead = new Set(policy.denyRead.map((value) => path.resolve(cwd, value)));
  const entries: FileSystemSandboxEntry[] = [];

  if (policy.allowRead.length === 0) {
    entries.push(rootEntry("read"));
  }

  if (mode === "read_only") {
    entries.push(projectRootEntry("read"));
  } else if (mode === "workspace_write") {
    entries.push(projectRootEntry("write"), tmpdirEntry());
  }

  for (const target of policy.allowRead) {
    entries.push({ path: pathPolicyEntry(target), access: "read" });
  }
  for (const target of policy.allowWrite) {
    const resolved = path.resolve(cwd, target);
    if (denyWrite.has(resolved) || denyRead.has(resolved)) continue;
    entries.push({ path: pathPolicyEntry(target), access: "write" });
  }
  for (const target of policy.denyWrite) {
    if (denyRead.has(path.resolve(cwd, target))) continue;
    entries.push({ path: pathPolicyEntry(target), access: "read" });
  }
  for (const target of policy.denyRead) {
    entries.push({ path: pathPolicyEntry(target), access: "none" });
  }

  return restrictedFileSystemPolicy(entries, {
    includePlatformDefaults: true,
  });
}

function pathPolicyEntry(target: string): FileSystemPath {
  return { kind: "path", path: target };
}

function liveNetworkPolicyToEngine(
  value: unknown,
): NetworkSandboxPolicy | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<LiveNetworkSandboxPolicy>;
  if (!Array.isArray(candidate.allowlist) || !Array.isArray(candidate.denylist)) {
    return undefined;
  }
  if (candidate.enabled === false) return "disabled";
  if (
    candidate.allowManagedDomainsOnly === true ||
    candidate.allowlist.length > 0 ||
    candidate.denylist.length > 0
  ) {
    return "restricted";
  }
  return candidate.enabled === true ? "enabled" : undefined;
}

function toolMayMutate(tool: Tool): boolean {
  if (tool.isReadOnly === true) return false;
  // virtualNoFsWrites bypasses the indeterminate-target AND resolved-target
  // write checks below. Safe ONLY because each opted-in tool is hand-audited to
  // perform no arg-directed FS write — note writeTargets() treats any `*path`
  // arg as a write target, so a future flag on a tool that honors such an arg
  // would be a sandbox escape. Never flag a shell/code-executing or
  // model-path-steerable tool. See ToolMetadata.virtualNoFsWrites.
  if (tool.metadata?.virtualNoFsWrites === true) return false;
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
      targets.add(resolveRuntimePathTarget(value, cwd));
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
  return value === undefined ? cwd : resolveRuntimePathTarget(value, cwd);
}

function isWritePathArgKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return WRITE_PATH_ARG_KEYS.has(normalized) || normalized.endsWith("path");
}

function isPathUnder(candidateRaw: string, rootRaw: string): boolean {
  const candidate = path.normalize(candidateRaw);
  const root = path.normalize(rootRaw);
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}
