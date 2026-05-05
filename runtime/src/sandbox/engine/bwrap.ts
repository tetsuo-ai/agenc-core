/**
 * Linux bubblewrap diagnostics.
 *
 * Warning checks used before selecting the Linux sandbox helper. The command
 * probe is best-effort and never mutates state.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  permissionProfileToRuntimePermissions,
  type PermissionProfile,
} from "./index.js";
import { shouldRequirePlatformSandbox } from "./policy-transforms.js";

const SYSTEM_BWRAP_PROGRAM = "bwrap";
const USER_NAMESPACE_FAILURES = [
  "loopback: Failed RTM_NEWADDR",
  "loopback: Failed RTM_NEWLINK",
  "setting up uid map: Permission denied",
  "No permissions to create a new namespace",
] as const;

export const MISSING_BWRAP_WARNING =
  "AgenC could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. AgenC will use the bundled Linux sandbox helper in the meantime.";
export const USER_NAMESPACE_WARNING =
  "AgenC's Linux sandbox uses bubblewrap and needs access to create user namespaces.";
export const WSL1_BWRAP_WARNING =
  "AgenC's Linux sandbox uses bubblewrap, which is not supported on WSL1 because WSL1 cannot create the required user namespaces. Use WSL2 for sandboxed shell commands.";

export function systemBwrapWarning(
  permissionProfile: PermissionProfile,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "linux") return null;
  if (!shouldWarnAboutSystemBwrap(permissionProfile)) return null;
  return systemBwrapWarningForPath(findSystemBwrapInPath(), platform);
}

function shouldWarnAboutSystemBwrap(permissionProfile: PermissionProfile): boolean {
  const { fileSystem, network } =
    permissionProfileToRuntimePermissions(permissionProfile);
  return shouldRequirePlatformSandbox(fileSystem, network, false);
}

export function systemBwrapWarningForPath(
  systemBwrapPath: string | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "linux") return null;
  if (isWsl1()) return WSL1_BWRAP_WARNING;
  if (systemBwrapPath === null) return MISSING_BWRAP_WARNING;
  if (!systemBwrapHasUserNamespaceAccess(systemBwrapPath)) {
    return USER_NAMESPACE_WARNING;
  }
  return null;
}

export function systemBwrapHasUserNamespaceAccess(
  systemBwrapPath: string,
): boolean {
  const output = spawnSync(systemBwrapPath, [
    "--unshare-user",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "/bin/true",
  ]);
  return output.error !== undefined ||
    output.status === 0 ||
    !isUserNamespaceFailure(output);
}

export function isWsl1(procVersion?: string): boolean {
  if (procVersion !== undefined) return procVersionIndicatesWsl1(procVersion);
  try {
    return procVersionIndicatesWsl1(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function procVersionIndicatesWsl1(procVersion: string): boolean {
  const lower = procVersion.toLowerCase();
  let remaining = lower;
  while (true) {
    const marker = remaining.indexOf("wsl");
    if (marker === -1) break;
    const rest = remaining.slice(marker + "wsl".length);
    const digits = rest.match(/^\d+/u)?.[0];
    if (digits !== undefined) return Number.parseInt(digits, 10) === 1;
    remaining = rest;
  }
  return lower.includes("microsoft") && !lower.includes("microsoft-standard");
}

export function isUserNamespaceFailure(
  output: Pick<SpawnSyncReturns<Buffer>, "stderr">,
): boolean {
  const stderr = Buffer.isBuffer(output.stderr)
    ? output.stderr.toString("utf8")
    : String(output.stderr ?? "");
  return USER_NAMESPACE_FAILURES.some((failure) => stderr.includes(failure));
}

export function findSystemBwrapInPath(
  searchPath: string | undefined = process.env["PATH"],
  cwd: string = process.cwd(),
): string | null {
  if (!searchPath) return null;
  const cwdReal = realpathOrSelf(cwd);
  for (const segment of searchPath.split(path.delimiter)) {
    if (!segment) continue;
    const candidate = path.join(segment, SYSTEM_BWRAP_PROGRAM);
    if (!isExecutableFile(candidate)) continue;
    const real = realpathOrSelf(candidate);
    if (real.startsWith(cwdReal + path.sep) || real === cwdReal) continue;
    return real;
  }
  return null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function realpathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
