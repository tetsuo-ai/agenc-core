/**
 * Linux sandbox launcher argument generation.
 *
 * C-01b supplies the launcher entrypoint that consumes these arguments and
 * applies Linux isolation. This file serializes the requested policy and owns
 * the child-process handoff to that launcher.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  type PermissionProfile,
} from "./index.js";

export interface SpawnLinuxSandboxCommandParams {
  readonly executablePath: string;
  readonly command: readonly string[];
  readonly commandCwd: string;
  readonly permissionProfile: PermissionProfile;
  readonly sandboxPolicyCwd: string;
  readonly useLegacyLandlock: boolean;
  readonly allowNetworkForProxy: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly arg0?: string;
}

export function allowNetworkForProxy(enforceManagedNetwork: boolean): boolean {
  return enforceManagedNetwork;
}

export function createLinuxSandboxCommandArgsForPermissionProfile(
  command: readonly string[],
  commandCwd: string,
  permissionProfile: PermissionProfile,
  sandboxPolicyCwd: string,
  useLegacyLandlock: boolean,
  allowNetworkForProxyValue: boolean,
): string[] {
  const args = [
    "--sandbox-policy-cwd",
    sandboxPolicyCwd,
    "--command-cwd",
    commandCwd,
    "--permission-profile",
    JSON.stringify(permissionProfile),
  ];
  if (useLegacyLandlock) args.push("--use-legacy-landlock");
  if (allowNetworkForProxyValue) args.push("--allow-network-for-proxy");
  args.push("--", ...command);
  return args;
}

export function spawnLinuxSandboxCommand(
  params: SpawnLinuxSandboxCommandParams,
  options: SpawnOptions = {},
): ChildProcess {
  const args = createLinuxSandboxCommandArgsForPermissionProfile(
    params.command,
    params.commandCwd,
    params.permissionProfile,
    params.sandboxPolicyCwd,
    params.useLegacyLandlock,
    params.allowNetworkForProxy,
  );
  return spawn(params.executablePath, args, {
    ...options,
    cwd: options.cwd ?? params.commandCwd,
    env: options.env ?? params.env,
    argv0: options.argv0 ?? params.arg0,
  });
}
