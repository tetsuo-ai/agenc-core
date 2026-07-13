/**
 * TOOL-03 / TOOL-04: apply the same platform sandbox transform used by
 * unified-exec `exec_command` to other shell spawns (system.bash direct
 * spawn, and callers that build command lines before exec).
 */

import { basename } from "node:path";
import {
  SandboxManager,
  type SandboxType,
} from "../../sandbox/engine/index.js";
import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
import { UnifiedExecError } from "../../unified-exec/types.js";
import { runtimeSandboxForExec } from "./exec-command.js";

export interface SandboxSpawnCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly argv0?: string;
}

const defaultSandboxManager = new SandboxManager();

/**
 * If the tool runtime context requires platform isolation, transform
 * program/args through SandboxManager (landlock/bwrap/etc.). When isolation
 * is required but unavailable, throw — fail closed (TOOL-03 honesty).
 */
export function applyRuntimeSandboxToSpawn(params: {
  readonly toolArgs: Record<string, unknown>;
  readonly fallbackCwd: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly sandboxManager?: SandboxManager;
}): SandboxSpawnCommand {
  const runtimeSandbox = runtimeSandboxForExec(
    params.toolArgs,
    params.fallbackCwd,
  );
  if (runtimeSandbox === undefined) {
    return {
      program: params.program,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      argv0: basename(params.program),
    };
  }
  return transformWithRuntimeSandbox({
    program: params.program,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    runtimeSandbox,
    sandboxManager: params.sandboxManager ?? defaultSandboxManager,
  });
}

export function transformWithRuntimeSandbox(params: {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly runtimeSandbox: UnifiedExecRuntimeSandbox;
  readonly sandboxManager?: SandboxManager;
}): SandboxSpawnCommand {
  const sandboxManager = params.sandboxManager ?? defaultSandboxManager;
  const permissions = params.runtimeSandbox.permissionProfile;
  const windowsSandboxLevel =
    params.runtimeSandbox.windowsSandboxLevel ?? "disabled";
  let sandbox: SandboxType = "none";
  try {
    sandbox = sandboxManager.selectInitial({
      fileSystemPolicy: permissions.fileSystem,
      networkPolicy: permissions.network,
      preference: params.runtimeSandbox.preference ?? "require",
      windowsSandboxLevel,
      hasManagedNetworkRequirements:
        params.runtimeSandbox.enforceManagedNetwork === true ||
        params.runtimeSandbox.network !== undefined,
    });
    if (
      sandbox === "none" &&
      (params.runtimeSandbox.preference ?? "require") === "require"
    ) {
      throw new UnifiedExecError(
        "create_process",
        "sandbox isolation was required but no platform sandbox is available",
      );
    }
    const transformed = sandboxManager.transform({
      command: {
        program: params.program,
        args: params.args,
        cwd: params.cwd,
        env: params.env,
        ...(params.runtimeSandbox.additionalPermissions !== undefined
          ? {
              additionalPermissions:
                params.runtimeSandbox.additionalPermissions,
            }
          : {}),
      },
      permissions,
      sandbox,
      enforceManagedNetwork:
        params.runtimeSandbox.enforceManagedNetwork ?? false,
      ...(params.runtimeSandbox.network !== undefined
        ? { network: params.runtimeSandbox.network }
        : {}),
      ...(params.runtimeSandbox.networkPolicyDecider !== undefined
        ? {
            networkPolicyDecider: params.runtimeSandbox.networkPolicyDecider,
          }
        : {}),
      ...(params.runtimeSandbox.blockedRequestObserver !== undefined
        ? {
            blockedRequestObserver:
              params.runtimeSandbox.blockedRequestObserver,
          }
        : {}),
      sandboxPolicyCwd: params.runtimeSandbox.sandboxPolicyCwd,
      ...(params.runtimeSandbox.agencLinuxSandboxExe !== undefined
        ? {
            agencLinuxSandboxExe: params.runtimeSandbox.agencLinuxSandboxExe,
          }
        : {}),
      useLegacyLandlock: params.runtimeSandbox.useLegacyLandlock ?? false,
      windowsSandboxLevel,
      windowsSandboxPrivateDesktop:
        params.runtimeSandbox.windowsSandboxPrivateDesktop ?? false,
      ...(params.runtimeSandbox.allowGpu === true ? { allowGpu: true } : {}),
    });
    const [program, ...args] = transformed.command;
    if (program === undefined) {
      throw new UnifiedExecError(
        "create_process",
        "sandbox transform returned an empty command",
      );
    }
    return {
      program,
      args,
      cwd: transformed.cwd,
      env: { ...transformed.env },
      argv0: transformed.arg0 ?? basename(program),
    };
  } catch (error) {
    if (error instanceof UnifiedExecError) throw error;
    throw new UnifiedExecError(
      "create_process",
      error instanceof Error ? error.message : String(error),
    );
  }
}
