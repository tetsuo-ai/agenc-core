/**
 * TOOL-03 / TOOL-04: apply the same platform sandbox transform used by
 * unified-exec `exec_command` to other shell spawns (system.bash direct
 * spawn, and callers that build command lines before exec).
 */

import { basename } from "node:path";
import {
  permissionProfileFromRuntimePermissions,
  restrictedFileSystemPolicy,
  type FileSystemSandboxEntry,
  type FileSystemSandboxPolicy,
  type PermissionProfile,
  type SandboxManager,
} from "../../sandbox/engine/index.js";
import { effectivePermissionProfile } from "../../sandbox/engine/policy-transforms.js";
import {
  readSandboxExecutionBroker,
  readSandboxExecutionSurface,
  transformSandboxedCommand,
  type SandboxPreparedSpawn,
  type SandboxExecutionSurface,
} from "../../sandbox/execution-broker.js";
import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
import { readToolRuntimeContext } from "../runtimes/context.js";
import { runtimeSandboxForExec } from "./exec-command.js";

export interface SandboxSpawnCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cwdBinding?: "inherited_readonly";
  readonly argv0?: string;
}

interface ApplyRuntimeSandboxToSpawnParams {
  readonly toolArgs: Record<string, unknown>;
  readonly fallbackCwd: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cwdBinding?: "inherited_readonly";
  readonly sandboxManager?: SandboxManager;
  readonly surface?: SandboxExecutionSurface;
}

/**
 * If the tool runtime context requires platform isolation, transform
 * program/args through SandboxManager (landlock/bwrap/etc.). When isolation
 * is required but unavailable, throw — fail closed (TOOL-03 honesty).
 */
export function applyRuntimeSandboxToSpawn(
  params: ApplyRuntimeSandboxToSpawnParams,
): SandboxSpawnCommand | SandboxPreparedSpawn {
  return applyRuntimeSandboxToSpawnWithCapabilities(params, "inherit");
}

/**
 * Apply the authenticated session boundary to a subprocess that is itself
 * strictly read-only. This is a narrowing transform: it never constructs a
 * runtime identity, never expands the session's read scope, and never carries
 * filesystem-write or network grants into the child.
 */
export function applyReadOnlyRuntimeSandboxToSpawn(
  params: ApplyRuntimeSandboxToSpawnParams,
): SandboxSpawnCommand | SandboxPreparedSpawn {
  return applyRuntimeSandboxToSpawnWithCapabilities(params, "read_only");
}

function applyRuntimeSandboxToSpawnWithCapabilities(
  params: ApplyRuntimeSandboxToSpawnParams,
  capabilities: "inherit" | "read_only",
): SandboxSpawnCommand | SandboxPreparedSpawn {
  const runtimeContext = readToolRuntimeContext(params.toolArgs);
  const surface = params.surface ??
    readSandboxExecutionSurface(params.toolArgs) ??
    "tool";
  const runtimeSandbox = runtimeSandboxForExec(
    params.toolArgs,
    params.fallbackCwd,
    surface,
  );
  const broker = readSandboxExecutionBroker(params.toolArgs);
  if (broker !== undefined) {
    return broker.prepareSpawn(surface, {
      program: params.program,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      argv0: basename(params.program),
      ...(params.cwdBinding !== undefined
        ? { cwdBinding: params.cwdBinding }
        : {}),
      ...(capabilities === "read_only" && runtimeSandbox !== undefined
        ? {
            permissionProfileOverride:
              narrowRuntimeSandboxToReadOnly(runtimeSandbox)
                .permissionProfile,
          }
        : {}),
    });
  }
  if (runtimeSandbox === undefined) {
    // A real runtime context is authoritative. `undefined` here means that
    // context explicitly selected danger-full-access/external sandbox, not
    // that the sandbox was missing (restricted-mode failures throw above).
    if (runtimeContext === undefined) {
      const broker = readSandboxExecutionBroker(params.toolArgs);
      if (broker !== undefined) {
        throw new Error("sandbox execution broker admission was lost");
      }
    }
    return {
      program: params.program,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      argv0: basename(params.program),
      ...(params.cwdBinding !== undefined
        ? { cwdBinding: params.cwdBinding }
        : {}),
    };
  }
  return transformWithRuntimeSandbox({
    program: params.program,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    ...(params.cwdBinding !== undefined
      ? { cwdBinding: params.cwdBinding }
      : {}),
    runtimeSandbox:
      capabilities === "read_only"
        ? narrowRuntimeSandboxToReadOnly(runtimeSandbox)
        : runtimeSandbox,
    ...(params.sandboxManager !== undefined
      ? { sandboxManager: params.sandboxManager }
      : {}),
  });
}

function narrowRuntimeSandboxToReadOnly(
  runtimeSandbox: UnifiedExecRuntimeSandbox,
): UnifiedExecRuntimeSandbox {
  const effectiveProfile = effectivePermissionProfile(
    runtimeSandbox.permissionProfile,
    runtimeSandbox.additionalPermissions,
  );
  // `external_sandbox` is already an out-of-process authority boundary. AgenC
  // cannot replace or narrow that host-owned policy without silently changing
  // who enforces it. Glob/Grep execute the pinned ripgrep binary with
  // data-only arguments, so preserve the external boundary exactly; the
  // managed profiles below are the ones whose write/network grants AgenC can
  // and must remove.
  if (effectiveProfile.fileSystem.kind === "external_sandbox") {
    return runtimeSandbox;
  }
  const permissionProfile = narrowPermissionProfileToReadOnly(effectiveProfile);
  const {
    additionalPermissions: _additionalPermissions,
    enforceManagedNetwork: _enforceManagedNetwork,
    network: _network,
    ...boundary
  } = runtimeSandbox;
  return {
    ...boundary,
    permissionProfile,
  };
}

function narrowPermissionProfileToReadOnly(
  profile: PermissionProfile,
): PermissionProfile {
  return permissionProfileFromRuntimePermissions(
    narrowFileSystemPolicyToReadOnly(profile.fileSystem),
    "disabled",
    profile.enforcement,
  );
}

function narrowFileSystemPolicyToReadOnly(
  policy: FileSystemSandboxPolicy,
): FileSystemSandboxPolicy {
  switch (policy.kind) {
    case "restricted":
      return restrictedFileSystemPolicy(
        policy.entries.map(readOnlyEntry),
        {
          ...(policy.globScanMaxDepth !== undefined
            ? { globScanMaxDepth: policy.globScanMaxDepth }
            : {}),
          ...(policy.includePlatformDefaults !== undefined
            ? { includePlatformDefaults: policy.includePlatformDefaults }
            : {}),
        },
      );
    case "unrestricted":
      return restrictedFileSystemPolicy(
        [
          {
            path: { kind: "special", value: { kind: "root" } },
            access: "read",
          },
        ],
        { includePlatformDefaults: true },
      );
    case "external_sandbox":
      // Handled before this transform so the external authority remains exact.
      return policy;
  }
}

function readOnlyEntry(entry: FileSystemSandboxEntry): FileSystemSandboxEntry {
  return entry.access === "write" ? { ...entry, access: "read" } : entry;
}

export function transformWithRuntimeSandbox(params: {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cwdBinding?: "inherited_readonly";
  readonly runtimeSandbox: UnifiedExecRuntimeSandbox;
  readonly sandboxManager?: SandboxManager;
}): SandboxSpawnCommand {
  return transformSandboxedCommand(params);
}
