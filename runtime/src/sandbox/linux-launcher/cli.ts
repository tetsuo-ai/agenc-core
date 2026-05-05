import path from "node:path";

import {
  type PermissionProfile,
  permissionProfileToRuntimePermissions,
} from "../engine/index.js";

export class LinuxSandboxCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinuxSandboxCliError";
  }
}

export interface LinuxSandboxLauncherOptions {
  readonly sandboxPolicyCwd: string;
  readonly commandCwd: string;
  readonly permissionProfile: PermissionProfile;
  readonly useLegacyLandlock: boolean;
  readonly applySeccompThenExec: boolean;
  readonly allowNetworkForProxy: boolean;
  readonly proxyRouteSpec: string | null;
  readonly mountProc: boolean;
  readonly command: readonly string[];
}

export function parseLinuxSandboxLauncherArgs(
  argv: readonly string[],
): LinuxSandboxLauncherOptions {
  let sandboxPolicyCwd: string | null = null;
  let commandCwd: string | null = null;
  let permissionProfile: PermissionProfile | null = null;
  let useLegacyLandlock = false;
  let applySeccompThenExec = false;
  let allowNetworkForProxy = false;
  let proxyRouteSpec: string | null = null;
  let mountProc = true;
  const command: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      command.push(...argv.slice(index + 1));
      break;
    }
    switch (arg) {
      case "--sandbox-policy-cwd":
        sandboxPolicyCwd = normalizeCwd(readValue(argv, index, arg));
        index += 1;
        break;
      case "--command-cwd":
        commandCwd = normalizeCwd(readValue(argv, index, arg));
        index += 1;
        break;
      case "--permission-profile":
        permissionProfile = parsePermissionProfile(readValue(argv, index, arg));
        index += 1;
        break;
      case "--use-legacy-landlock":
        useLegacyLandlock = true;
        break;
      case "--apply-seccomp-then-exec":
        applySeccompThenExec = true;
        break;
      case "--allow-network-for-proxy":
        allowNetworkForProxy = true;
        break;
      case "--proxy-route-spec":
        proxyRouteSpec = readValue(argv, index, arg);
        index += 1;
        break;
      case "--no-proc":
        mountProc = false;
        break;
      default:
        throw new LinuxSandboxCliError(`unknown Linux sandbox argument: ${arg}`);
    }
  }

  if (command.length === 0) {
    throw new LinuxSandboxCliError("Linux sandbox command is missing");
  }
  if (permissionProfile === null) {
    throw new LinuxSandboxCliError("Linux sandbox permission profile is missing");
  }
  const resolvedSandboxCwd = sandboxPolicyCwd ?? process.cwd();
  const resolvedCommandCwd = commandCwd ?? resolvedSandboxCwd;
  if (applySeccompThenExec && useLegacyLandlock) {
    throw new LinuxSandboxCliError(
      "--apply-seccomp-then-exec cannot be combined with --use-legacy-landlock",
    );
  }

  return {
    sandboxPolicyCwd: resolvedSandboxCwd,
    commandCwd: resolvedCommandCwd,
    permissionProfile,
    useLegacyLandlock,
    applySeccompThenExec,
    allowNetworkForProxy,
    proxyRouteSpec,
    mountProc,
    command,
  };
}

export function parsePermissionProfile(value: string): PermissionProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new LinuxSandboxCliError(
      `invalid permission profile JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertPermissionProfile(parsed);
  return parsed;
}

function assertPermissionProfile(value: unknown): asserts value is PermissionProfile {
  if (typeof value !== "object" || value === null) {
    throw new LinuxSandboxCliError("permission profile must be an object");
  }
  const candidate = value as Partial<PermissionProfile>;
  try {
    permissionProfileToRuntimePermissions(candidate as PermissionProfile);
  } catch (error) {
    throw new LinuxSandboxCliError(
      `permission profile has an invalid shape: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    candidate.fileSystem === undefined ||
    typeof candidate.fileSystem !== "object" ||
    candidate.network === undefined
  ) {
    throw new LinuxSandboxCliError(
      "permission profile must include fileSystem and network permissions",
    );
  }
}

function normalizeCwd(value: string): string {
  if (value.length === 0) {
    throw new LinuxSandboxCliError("cwd argument cannot be empty");
  }
  return path.resolve(value);
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "--") {
    throw new LinuxSandboxCliError(`${flag} requires a value`);
  }
  return value;
}
