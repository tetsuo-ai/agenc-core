import path from "node:path";

import {
  type FileSystemAccessMode,
  type FileSystemPath,
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

function parsePermissionProfile(value: string): PermissionProfile {
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
  assertNetwork(candidate.network);
  assertFileSystem(candidate.fileSystem);
  try {
    permissionProfileToRuntimePermissions(candidate as PermissionProfile);
  } catch (error) {
    throw new LinuxSandboxCliError(
      `permission profile has an invalid shape: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (candidate.fileSystem === undefined || candidate.network === undefined) {
    throw new LinuxSandboxCliError(
      "permission profile must include fileSystem and network permissions",
    );
  }
}

function assertNetwork(value: unknown): void {
  if (value !== "enabled" && value !== "disabled" && value !== "restricted") {
    throw new LinuxSandboxCliError("permission profile network must be enabled, disabled, or restricted");
  }
}

function assertFileSystem(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new LinuxSandboxCliError("permission profile fileSystem must be an object");
  }
  const candidate = value as {
    kind?: unknown;
    entries?: unknown;
    globScanMaxDepth?: unknown;
    includePlatformDefaults?: unknown;
  };
  if (
    candidate.kind !== "restricted" &&
    candidate.kind !== "unrestricted" &&
    candidate.kind !== "external_sandbox"
  ) {
    throw new LinuxSandboxCliError("permission profile fileSystem kind is invalid");
  }
  if (!Array.isArray(candidate.entries)) {
    throw new LinuxSandboxCliError("permission profile fileSystem entries must be an array");
  }
  const globScanMaxDepth = candidate.globScanMaxDepth;
  if (
    globScanMaxDepth !== undefined &&
    (typeof globScanMaxDepth !== "number" ||
      !Number.isInteger(globScanMaxDepth) ||
      globScanMaxDepth < 0)
  ) {
    throw new LinuxSandboxCliError("permission profile globScanMaxDepth must be a non-negative integer");
  }
  if (
    candidate.includePlatformDefaults !== undefined &&
    typeof candidate.includePlatformDefaults !== "boolean"
  ) {
    throw new LinuxSandboxCliError("permission profile includePlatformDefaults must be a boolean");
  }
  for (const entry of candidate.entries) {
    assertFileSystemEntry(entry);
  }
}

function assertFileSystemEntry(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new LinuxSandboxCliError("permission profile fileSystem entry must be an object");
  }
  const entry = value as { access?: unknown; path?: unknown };
  assertAccess(entry.access);
  assertFileSystemPath(entry.path);
}

function assertAccess(value: unknown): asserts value is FileSystemAccessMode {
  if (value !== "none" && value !== "read" && value !== "write") {
    throw new LinuxSandboxCliError("permission profile fileSystem entry access is invalid");
  }
}

function assertFileSystemPath(value: unknown): asserts value is FileSystemPath {
  if (typeof value !== "object" || value === null) {
    throw new LinuxSandboxCliError("permission profile fileSystem entry path must be an object");
  }
  const pathSpec = value as { kind?: unknown; path?: unknown; pattern?: unknown; value?: unknown };
  if (pathSpec.kind === "path") {
    if (typeof pathSpec.path !== "string" || pathSpec.path.length === 0) {
      throw new LinuxSandboxCliError("permission profile path entry must include a non-empty path");
    }
    return;
  }
  if (pathSpec.kind === "glob") {
    if (typeof pathSpec.pattern !== "string" || pathSpec.pattern.length === 0) {
      throw new LinuxSandboxCliError("permission profile glob entry must include a non-empty pattern");
    }
    return;
  }
  if (pathSpec.kind === "special") {
    assertSpecialPath(pathSpec.value);
    return;
  }
  throw new LinuxSandboxCliError("permission profile fileSystem entry path kind is invalid");
}

function assertSpecialPath(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throw new LinuxSandboxCliError("permission profile special path must be an object");
  }
  const special = value as { kind?: unknown; path?: unknown; subpath?: unknown };
  switch (special.kind) {
    case "root":
    case "project_roots":
    case "tmpdir":
    case "slash_tmp":
    case "minimal":
      break;
    case "unknown":
      if (typeof special.path !== "string" || special.path.length === 0) {
        throw new LinuxSandboxCliError("permission profile unknown special path must include a path");
      }
      break;
    default:
      throw new LinuxSandboxCliError("permission profile special path kind is invalid");
  }
  if (special.subpath !== undefined && typeof special.subpath !== "string") {
    throw new LinuxSandboxCliError("permission profile special path subpath must be a string");
  }
  if (special.kind === "project_roots" && typeof special.subpath === "string") {
    assertProjectRootSubpath(special.subpath);
  }
}

function assertProjectRootSubpath(value: string): void {
  if (path.isAbsolute(value)) {
    throw new LinuxSandboxCliError(
      "permission profile project root subpath must be relative",
    );
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new LinuxSandboxCliError(
      "permission profile project root subpath must stay within the project root",
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
