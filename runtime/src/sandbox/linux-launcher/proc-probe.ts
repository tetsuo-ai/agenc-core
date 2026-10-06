import { spawnSync } from "node:child_process";
import type { BoundReadOnlyCwdIdentity } from "../bound-readonly-cwd.js";
import type { FileSystemSandboxPolicy } from "../engine/policy.js";
import { createBwrapCommandArgs, type BwrapNetworkMode } from "./bwrap.js";
import type { BubblewrapLauncher } from "./launcher.js";
import { sanitizeSandboxLauncherEnvironment } from "../launcher-environment.js";

export interface ProcMountProbeOptions {
  readonly launcher: BubblewrapLauncher;
  readonly fileSystem: FileSystemSandboxPolicy;
  readonly sandboxPolicyCwd: string;
  readonly commandCwd: string;
  readonly inheritedCwdFd?: number;
  readonly boundReadOnlyCwd?: BoundReadOnlyCwdIdentity;
  readonly networkMode: BwrapNetworkMode;
  readonly sessionTempRoot: string;
}

export function createProcMountProbeArgs(options: Omit<ProcMountProbeOptions, "launcher">) {
  return createBwrapCommandArgs(["/bin/true"], options.fileSystem,
    options.sandboxPolicyCwd, options.commandCwd, {
      mountProc: true, networkMode: options.networkMode,
      sessionTempRoot: options.sessionTempRoot,
      inheritedReadOnlyCwd: options.inheritedCwdFd !== undefined,
      ...(options.boundReadOnlyCwd === undefined ? {} : { boundReadOnlyCwd: options.boundReadOnlyCwd }),
    });
}

export function runProcMountProbe(
  options: ProcMountProbeOptions,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(options.launcher.program, args, {
    cwd: options.inheritedCwdFd === undefined ? options.commandCwd : ".",
    env: sanitizeSandboxLauncherEnvironment(env),
    encoding: "utf8",
    timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    stdio: options.inheritedCwdFd === undefined
      ? ["ignore", "ignore", "pipe"]
      : ["ignore", "ignore", "pipe", "ignore", options.inheritedCwdFd],
  });
}
