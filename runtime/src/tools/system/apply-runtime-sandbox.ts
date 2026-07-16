/**
 * TOOL-03 / TOOL-04: apply the same platform sandbox transform used by
 * unified-exec `exec_command` to other shell spawns (system.bash direct
 * spawn, and callers that build command lines before exec).
 */

import { basename } from "node:path";
import type { SandboxManager } from "../../sandbox/engine/index.js";
import {
  readSandboxExecutionBroker,
  readSandboxExecutionSurface,
  transformSandboxedCommand,
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
  readonly argv0?: string;
}

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
  readonly surface?: SandboxExecutionSurface;
}): SandboxSpawnCommand {
  const runtimeContext = readToolRuntimeContext(params.toolArgs);
  const surface = params.surface ??
    readSandboxExecutionSurface(params.toolArgs) ??
    "tool";
  const runtimeSandbox = runtimeSandboxForExec(
    params.toolArgs,
    params.fallbackCwd,
    surface,
  );
  if (runtimeSandbox === undefined) {
    // A real runtime context is authoritative. `undefined` here means that
    // context explicitly selected danger-full-access/external sandbox, not
    // that the sandbox was missing (restricted-mode failures throw above).
    if (runtimeContext === undefined) {
      const broker = readSandboxExecutionBroker(params.toolArgs);
      if (broker !== undefined) {
        return broker.prepareSpawn(surface, {
          program: params.program,
          args: params.args,
          cwd: params.cwd,
          env: params.env,
          argv0: basename(params.program),
        });
      }
    }
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
    ...(params.sandboxManager !== undefined
      ? { sandboxManager: params.sandboxManager }
      : {}),
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
  return transformSandboxedCommand(params);
}
