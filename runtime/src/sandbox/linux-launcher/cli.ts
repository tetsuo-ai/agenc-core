import path from "node:path";

import {
  type FileSystemAccessMode,
  type FileSystemPath,
  type PermissionEnforcement,
  type PermissionProfile,
  permissionProfileToRuntimePermissions,
} from "../engine/index.js";
import { INHERITED_CWD_SANDBOX_PATH } from "./config.js";

export class LinuxSandboxCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinuxSandboxCliError";
  }
}

export interface LinuxSandboxLauncherOptions {
  readonly sandboxPolicyCwd: string;
  readonly commandCwd: string;
  readonly inheritedCwd: boolean;
  readonly permissionProfile: PermissionProfile;
  readonly sessionTempRoot: string;
  readonly applySeccompThenExec: boolean;
  readonly allowNetworkForProxy: boolean;
  readonly proxyRouteSpec: string | null;
  readonly mountProc: boolean;
  readonly command: readonly string[];
}

/**
 * Upper bound for a policy's glob scan depth. The bubblewrap glob expander
 * walks directories up to this depth for every glob entry, so the launcher
 * refuses a depth that could turn one policy into an unbounded filesystem
 * walk. An unbounded scan is expressed by omitting the field.
 */
export const MAX_GLOB_SCAN_DEPTH = 128;

const NUL_BYTE = String.fromCharCode(0);

const PROFILE_KEYS: ReadonlySet<string> = new Set(["fileSystem", "network", "enforcement"]);
const FILE_SYSTEM_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "entries",
  "globScanMaxDepth",
  "includePlatformDefaults",
]);
const ENTRY_KEYS: ReadonlySet<string> = new Set(["path", "access"]);
const PATH_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  path: new Set(["kind", "path"]),
  glob: new Set(["kind", "pattern"]),
  special: new Set(["kind", "value"]),
};
const SPECIAL_PATH_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  root: new Set(["kind"]),
  project_roots: new Set(["kind", "subpath"]),
  tmpdir: new Set(["kind"]),
  slash_tmp: new Set(["kind"]),
  minimal: new Set(["kind"]),
  unknown: new Set(["kind", "path", "subpath"]),
};
const ENFORCEMENT_VALUES: ReadonlySet<string> = new Set(["default", "untrusted", "managed"]);

export function parseLinuxSandboxLauncherArgs(
  argv: readonly string[],
): LinuxSandboxLauncherOptions {
  let sandboxPolicyCwd: string | null = null;
  let commandCwd: string | null = null;
  let inheritedCwd = false;
  let permissionProfile: PermissionProfile | null = null;
  let sessionTempRoot: string | null = null;
  let applySeccompThenExec = false;
  let allowNetworkForProxy = false;
  let proxyRouteSpec: string | null = null;
  let mountProc = true;
  const command: string[] = [];
  const seenValueFlags = new Set<string>();

  // Every flag that carries a value is accepted once. A repeated flag would
  // otherwise silently replace the earlier value, hiding a caller bug in the
  // exact arguments that decide what the sandbox may touch.
  const takeValue = (flag: string, index: number): string => {
    if (seenValueFlags.has(flag)) {
      throw new LinuxSandboxCliError(`${flag} may only be given once`);
    }
    seenValueFlags.add(flag);
    return readValue(argv, index, flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      command.push(...argv.slice(index + 1));
      break;
    }
    switch (arg) {
      case "--sandbox-policy-cwd":
        sandboxPolicyCwd = normalizeCwd(takeValue(arg, index), arg);
        index += 1;
        break;
      case "--command-cwd":
        commandCwd = normalizeCwd(takeValue(arg, index), arg);
        index += 1;
        break;
      case "--inherited-readonly-command-cwd":
        inheritedCwd = true;
        break;
      case "--permission-profile":
        permissionProfile = parsePermissionProfile(takeValue(arg, index));
        index += 1;
        break;
      case "--session-temp-root":
        sessionTempRoot = normalizeSessionTempRoot(takeValue(arg, index));
        index += 1;
        break;
      case "--apply-seccomp-then-exec":
        applySeccompThenExec = true;
        break;
      case "--allow-network-for-proxy":
        allowNetworkForProxy = true;
        break;
      case "--proxy-route-spec":
        proxyRouteSpec = normalizeProxyRouteSpec(takeValue(arg, index));
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
  assertCommand(command);
  if (permissionProfile === null) {
    throw new LinuxSandboxCliError("Linux sandbox permission profile is missing");
  }
  if (sessionTempRoot === null) {
    throw new LinuxSandboxCliError("Linux sandbox session temp root is missing");
  }
  if (inheritedCwd && (sandboxPolicyCwd !== null || commandCwd !== null)) {
    throw new LinuxSandboxCliError(
      "--inherited-readonly-command-cwd cannot be combined with explicit cwd arguments",
    );
  }
  if (inheritedCwd && applySeccompThenExec) {
    throw new LinuxSandboxCliError(
      "--inherited-readonly-command-cwd is only valid for the outer launcher stage",
    );
  }
  if (proxyRouteSpec !== null && !allowNetworkForProxy) {
    throw new LinuxSandboxCliError(
      "--proxy-route-spec requires --allow-network-for-proxy",
    );
  }
  // The policy cwd anchors every project-root grant, so it is never
  // inferred from the launcher's own working directory: a missing flag fails
  // closed instead of widening write access to wherever the launcher started.
  const resolvedSandboxCwd = inheritedCwd
    ? INHERITED_CWD_SANDBOX_PATH
    : requireProvided(sandboxPolicyCwd, "Linux sandbox policy cwd is missing");
  const resolvedCommandCwd = inheritedCwd
    ? INHERITED_CWD_SANDBOX_PATH
    : commandCwd ?? resolvedSandboxCwd;
  return {
    sandboxPolicyCwd: resolvedSandboxCwd,
    commandCwd: resolvedCommandCwd,
    inheritedCwd,
    permissionProfile,
    sessionTempRoot,
    applySeccompThenExec,
    allowNetworkForProxy,
    proxyRouteSpec,
    mountProc,
    command,
  };
}

function requireProvided(value: string | null, message: string): string {
  if (value === null) {
    throw new LinuxSandboxCliError(message);
  }
  return value;
}

function assertCommand(command: readonly string[]): void {
  if (command[0] === undefined || command[0].length === 0) {
    throw new LinuxSandboxCliError("Linux sandbox command program cannot be empty");
  }
  for (const argument of command) {
    assertNoNulByte(argument, "Linux sandbox command argument");
  }
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
  const candidate = assertPlainObject(value, "permission profile", PROFILE_KEYS) as Partial<PermissionProfile>;
  assertNetwork(candidate.network);
  assertFileSystem(candidate.fileSystem);
  assertEnforcement(candidate.enforcement);
  try {
    permissionProfileToRuntimePermissions(candidate as PermissionProfile);
  } catch (error) {
    throw new LinuxSandboxCliError(
      `permission profile has an invalid shape: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Accept only a plain JSON object whose every field is expected. Unknown
 * fields are rejected rather than carried through to the sandbox engine, so a
 * policy can never smuggle a setting the launcher did not validate.
 */
function assertPlainObject(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinuxSandboxCliError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new LinuxSandboxCliError(`${label} has an unsupported field: ${key}`);
    }
  }
  return value as Record<string, unknown>;
}

function assertNetwork(value: unknown): void {
  if (value !== "enabled" && value !== "disabled" && value !== "restricted") {
    throw new LinuxSandboxCliError("permission profile network must be enabled, disabled, or restricted");
  }
}

function assertEnforcement(value: unknown): asserts value is PermissionEnforcement | undefined {
  if (value !== undefined && (typeof value !== "string" || !ENFORCEMENT_VALUES.has(value))) {
    throw new LinuxSandboxCliError(
      "permission profile enforcement must be default, untrusted, or managed",
    );
  }
}

function assertFileSystem(value: unknown): void {
  const candidate = assertPlainObject(value, "permission profile fileSystem", FILE_SYSTEM_KEYS);
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
      globScanMaxDepth < 0 ||
      globScanMaxDepth > MAX_GLOB_SCAN_DEPTH)
  ) {
    throw new LinuxSandboxCliError(
      `permission profile globScanMaxDepth must be an integer between 0 and ${MAX_GLOB_SCAN_DEPTH}`,
    );
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
  const entry = assertPlainObject(value, "permission profile fileSystem entry", ENTRY_KEYS);
  assertAccess(entry.access);
  assertFileSystemPath(entry.path);
}

function assertAccess(value: unknown): asserts value is FileSystemAccessMode {
  if (value !== "none" && value !== "read" && value !== "write") {
    throw new LinuxSandboxCliError("permission profile fileSystem entry access is invalid");
  }
}

function assertFileSystemPath(value: unknown): asserts value is FileSystemPath {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinuxSandboxCliError("permission profile fileSystem entry path must be an object");
  }
  const kind = (value as { kind?: unknown }).kind;
  // Own-property lookup only: a kind such as "constructor" must not resolve
  // to an Object.prototype member.
  const allowedKeys =
    typeof kind === "string" && Object.hasOwn(PATH_KEYS, kind) ? PATH_KEYS[kind] : undefined;
  if (allowedKeys === undefined) {
    throw new LinuxSandboxCliError("permission profile fileSystem entry path kind is invalid");
  }
  const pathSpec = assertPlainObject(value, "permission profile fileSystem entry path", allowedKeys);
  if (kind === "path") {
    assertNonEmptyString(pathSpec.path, "permission profile path entry path");
    return;
  }
  if (kind === "glob") {
    assertNonEmptyString(pathSpec.pattern, "permission profile glob entry pattern");
    return;
  }
  assertSpecialPath(pathSpec.value);
}

function assertSpecialPath(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinuxSandboxCliError("permission profile special path must be an object");
  }
  const kind = (value as { kind?: unknown }).kind;
  const allowedKeys =
    typeof kind === "string" && Object.hasOwn(SPECIAL_PATH_KEYS, kind)
      ? SPECIAL_PATH_KEYS[kind]
      : undefined;
  if (allowedKeys === undefined) {
    throw new LinuxSandboxCliError("permission profile special path kind is invalid");
  }
  const special = assertPlainObject(value, "permission profile special path", allowedKeys);
  if (kind === "unknown") {
    assertNonEmptyString(special.path, "permission profile unknown special path path");
  }
  if (special.subpath !== undefined) {
    if (typeof special.subpath !== "string") {
      throw new LinuxSandboxCliError("permission profile special path subpath must be a string");
    }
    assertNoNulByte(special.subpath, "permission profile special path subpath");
  }
  if (kind === "project_roots" && typeof special.subpath === "string") {
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

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LinuxSandboxCliError(`${label} must be a non-empty string`);
  }
  assertNoNulByte(value, label);
}

/**
 * A NUL byte cannot cross an exec or C-string boundary intact, so a path or
 * argument carrying one would either fail deep inside the launcher or be
 * silently truncated. Reject it at the edge with a clear message instead.
 */
function assertNoNulByte(value: string, label: string): void {
  if (value.includes(NUL_BYTE)) {
    throw new LinuxSandboxCliError(`${label} must not contain a NUL byte`);
  }
}

function normalizeCwd(value: string, flag: string): string {
  if (value.length === 0) {
    throw new LinuxSandboxCliError(`${flag} cannot be empty`);
  }
  assertNoNulByte(value, `${flag} value`);
  // A relative cwd would be anchored to the launcher's own working
  // directory, the exact inference the required policy cwd exists to avoid.
  if (!path.isAbsolute(value)) {
    throw new LinuxSandboxCliError(`${flag} must be an absolute path`);
  }
  return path.resolve(value);
}

function normalizeSessionTempRoot(value: string): string {
  assertNoNulByte(value, "--session-temp-root value");
  if (value.length === 0 || !path.isAbsolute(value)) {
    throw new LinuxSandboxCliError(
      "Linux sandbox session temp root must be an absolute path",
    );
  }
  return path.normalize(value);
}

function normalizeProxyRouteSpec(value: string): string {
  assertNoNulByte(value, "--proxy-route-spec value");
  if (value.trim().length === 0) {
    throw new LinuxSandboxCliError("--proxy-route-spec cannot be empty");
  }
  return value;
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  // A value that spells another flag is a missing value, not a path: the
  // caller forgot the argument and the next flag must not be swallowed.
  if (value === undefined || value.startsWith("--")) {
    throw new LinuxSandboxCliError(`${flag} requires a value`);
  }
  return value;
}
