/**
 * Permission profile transforms for the sandbox engine.
 *
 * Merge, intersection, and effective-policy helpers. These helpers are
 * deliberately data-only so later launcher items can share the same policy
 * math.
 */

import path from "node:path";
import {
  canReadAccess,
  canWriteAccess,
  canonicalizePathForPolicy,
  getUnreadableGlobsWithCwd,
  getUnreadableRootsWithCwd,
  hasFullDiskWriteAccess,
  pathOverlaps,
  permissionProfileFromRuntimePermissions,
  resolveAccessWithCwd,
  resolvePathAgainstBase,
  resolvePermissionPath,
  restrictedFileSystemPolicy,
  type AdditionalPermissionProfile,
  type FileSystemAccessMode,
  type FileSystemPermissions,
  type FileSystemSandboxEntry,
  type FileSystemSandboxPolicy,
  type NetworkPermissions,
  type NetworkSandboxPolicy,
  type PermissionProfile,
} from "./index.js";

export function normalizeAdditionalPermissions(
  additionalPermissions: AdditionalPermissionProfile,
  cwd: string = process.cwd(),
): AdditionalPermissionProfile {
  const network =
    additionalPermissions.network &&
    Object.keys(additionalPermissions.network).length > 0
      ? additionalPermissions.network
      : undefined;
  const fileSystem = additionalPermissions.fileSystem
    ? normalizeFileSystemPermissions(additionalPermissions.fileSystem, cwd)
    : undefined;
  return {
    ...(network !== undefined ? { network } : {}),
    ...(fileSystem !== undefined && !fileSystemPermissionsEmpty(fileSystem)
      ? { fileSystem }
      : {}),
  };
}

export function mergePermissionProfiles(
  base?: AdditionalPermissionProfile,
  permissions?: AdditionalPermissionProfile,
): AdditionalPermissionProfile | undefined {
  if (!permissions) return cloneAdditionalPermissionProfile(base);
  if (!base) return cloneAdditionalPermissionProfile(permissions);
  const network = mergeNetworkPermissions(base.network, permissions.network);
  const fileSystem = mergeFileSystemPermissions(
    base.fileSystem,
    permissions.fileSystem,
  );
  const merged = {
    ...(network !== undefined ? { network } : {}),
    ...(fileSystem !== undefined ? { fileSystem } : {}),
  };
  return additionalPermissionProfileEmpty(merged) ? undefined : merged;
}

export function intersectPermissionProfiles(
  requested: AdditionalPermissionProfile,
  granted: AdditionalPermissionProfile,
  cwd: string,
): AdditionalPermissionProfile {
  const requestedFileSystem = requested.fileSystem;
  const grantedFileSystem = granted.fileSystem ?? { entries: [] };
  const fileSystem = requestedFileSystem
    ? intersectFileSystemPermissions(
        requestedFileSystem,
        grantedFileSystem,
        cwd,
      )
    : undefined;
  const network =
    requested.network?.enabled === true && granted.network?.enabled === true
      ? { enabled: true }
      : undefined;
  return {
    ...(network !== undefined ? { network } : {}),
    ...(fileSystem !== undefined && !fileSystemPermissionsEmpty(fileSystem)
      ? { fileSystem }
      : {}),
  };
}

export function effectiveFileSystemSandboxPolicy(
  fileSystemPolicy: FileSystemSandboxPolicy,
  additionalPermissions?: AdditionalPermissionProfile,
): FileSystemSandboxPolicy {
  const permissions = additionalPermissions?.fileSystem;
  if (!permissions || fileSystemPermissionsEmpty(permissions)) {
    return fileSystemPolicy;
  }
  if (fileSystemPolicy.kind !== "restricted") return fileSystemPolicy;
  return restrictedFileSystemPolicy(
    mergePermissionEntries(fileSystemPolicy.entries, permissions.entries),
    {
      globScanMaxDepth: mergeGlobScanMaxDepth(
        fileSystemPolicy.entries,
        fileSystemPolicy.globScanMaxDepth,
        permissions.entries,
        permissions.globScanMaxDepth,
      ),
      includePlatformDefaults: fileSystemPolicy.includePlatformDefaults,
    },
  );
}

export function effectiveNetworkSandboxPolicy(
  networkPolicy: NetworkSandboxPolicy,
  additionalPermissions?: AdditionalPermissionProfile,
): NetworkSandboxPolicy {
  if (!additionalPermissions) return networkPolicy;
  if (networkPolicy === "enabled" || additionalPermissions.network?.enabled === true) {
    return "enabled";
  }
  return "restricted";
}

export function effectivePermissionProfile(
  permissionProfile: PermissionProfile,
  additionalPermissions?: AdditionalPermissionProfile,
): PermissionProfile {
  const fileSystem = effectiveFileSystemSandboxPolicy(
    permissionProfile.fileSystem,
    additionalPermissions,
  );
  const network = effectiveNetworkSandboxPolicy(
    permissionProfile.network,
    additionalPermissions,
  );
  return permissionProfileFromRuntimePermissions(
    fileSystem,
    network,
    permissionProfile.enforcement,
  );
}

export function shouldRequirePlatformSandbox(
  fileSystemPolicy: FileSystemSandboxPolicy,
  networkPolicy: NetworkSandboxPolicy,
  hasManagedNetworkRequirements: boolean,
): boolean {
  if (hasManagedNetworkRequirements) return true;
  if (networkPolicy !== "enabled") {
    return fileSystemPolicy.kind !== "external_sandbox";
  }
  return fileSystemPolicy.kind === "restricted" &&
    !fileSystemPolicyHasFullDiskWriteAccess(fileSystemPolicy);
}

function normalizeFileSystemPermissions(
  permissions: FileSystemPermissions,
  cwd: string,
): FileSystemPermissions {
  const entries: FileSystemSandboxEntry[] = [];
  for (const entry of permissions.entries) {
    if (entry.path.kind === "glob" && entry.access !== "none") {
      throw new Error("glob file system permissions only support deny-read entries");
    }
    const normalized =
      entry.path.kind === "path"
        ? {
            ...entry,
          path: {
            kind: "path" as const,
            path: canonicalizePathForPolicy(
              resolvePathAgainstBase(entry.path.path, cwd),
            ),
          },
        }
        : entry;
    if (!entries.some((candidate) => entryEquals(candidate, normalized))) {
      entries.push(normalized);
    }
  }
  return {
    entries,
    ...(permissions.globScanMaxDepth !== undefined
      ? { globScanMaxDepth: permissions.globScanMaxDepth }
      : {}),
  };
}

function intersectFileSystemPermissions(
  requested: FileSystemPermissions,
  granted: FileSystemPermissions,
  cwd: string,
): FileSystemPermissions {
  const requestedPolicy = restrictedFileSystemPolicy(requested.entries);
  const acceptedEntries: FileSystemSandboxEntry[] = [];
  for (const grantedEntry of granted.entries) {
    if (!canReadAccess(grantedEntry.access)) continue;
    if (
      grantedFileSystemEntryWithinRequest(
        requested,
        requestedPolicy,
        grantedEntry,
        cwd,
      )
    ) {
      pushUnique(acceptedEntries, materializeCwdDependentEntry(grantedEntry, cwd));
    }
  }
  const entries = [...acceptedEntries];
  const requestedDenyEntries = retainConstrainingDenyEntries(
    requested.entries,
    acceptedEntries,
    cwd,
    entries,
  );
  const grantedDenyEntries = retainConstrainingDenyEntries(
    granted.entries,
    acceptedEntries,
    cwd,
    entries,
  );
  const globScanMaxDepth = mergeGlobScanMaxDepth(
    requestedDenyEntries,
    requested.globScanMaxDepth,
    grantedDenyEntries,
    granted.globScanMaxDepth,
  );
  return {
    entries,
    ...(globScanMaxDepth !== undefined
      ? {
          globScanMaxDepth,
        }
      : {}),
  };
}

function grantedFileSystemEntryWithinRequest(
  requested: FileSystemPermissions,
  requestedPolicy: FileSystemSandboxPolicy,
  grantedEntry: FileSystemSandboxEntry,
  cwd: string,
): boolean {
  if (!canReadAccess(grantedEntry.access)) return false;
  const grantedPath = resolvePermissionPath(grantedEntry.path, cwd);
  if (grantedPath !== null) {
    if (isReadDenied(requestedPolicy, grantedPath, cwd)) {
      return false;
    }
    return accessCovers(
      resolveAccessWithCwd(requestedPolicy, grantedPath, cwd),
      grantedEntry.access,
    );
  }
  return requested.entries.some(
    (requestedEntry) =>
      accessCovers(requestedEntry.access, grantedEntry.access) &&
      entryEquals(requestedEntry, grantedEntry),
  );
}

function retainConstrainingDenyEntries(
  sourceEntries: readonly FileSystemSandboxEntry[],
  acceptedEntries: readonly FileSystemSandboxEntry[],
  cwd: string,
  outputEntries: FileSystemSandboxEntry[],
): FileSystemSandboxEntry[] {
  const retained: FileSystemSandboxEntry[] = [];
  for (const entry of sourceEntries) {
    if (entry.access !== "none") continue;
    if (!denyEntryConstrainsAcceptedGrant(entry, acceptedEntries, cwd)) continue;
    const materialized = materializeCwdDependentEntry(entry, cwd);
    pushUnique(outputEntries, materialized);
    retained.push(materialized);
  }
  return retained;
}

function denyEntryConstrainsAcceptedGrant(
  denyEntry: FileSystemSandboxEntry,
  acceptedEntries: readonly FileSystemSandboxEntry[],
  cwd: string,
): boolean {
  return acceptedEntries.filter((entry) => canReadAccess(entry.access)).some((entry) => {
    const grantPath = resolvePermissionPath(entry.path, cwd);
    if (grantPath === null) return false;
    if (denyEntry.path.kind === "glob") {
      const prefix = globStaticPrefixPath(denyEntry.path.pattern, cwd);
      return prefix !== null && pathOverlaps(prefix, grantPath);
    }
    const denyPath = resolvePermissionPath(denyEntry.path, cwd);
    return denyPath !== null && pathOverlaps(denyPath, grantPath);
  });
}

function globStaticPrefixPath(pattern: string, cwd: string): string | null {
  const resolved = resolvePathAgainstBase(pattern, cwd);
  const index = resolved.search(/[*?[\]]/u);
  if (index === 0) return null;
  const prefix =
    index === -1
      ? resolved
      : /[/\\]$/u.test(resolved.slice(0, index))
        ? resolved.slice(0, index)
        : path.dirname(resolved.slice(0, index));
  return prefix.length > 0 ? prefix : null;
}

function materializeCwdDependentEntry(
  entry: FileSystemSandboxEntry,
  cwd: string,
): FileSystemSandboxEntry {
  if (entry.path.kind === "special" && entry.path.value.kind === "project_roots") {
    const resolved = resolvePermissionPath(entry.path, cwd);
    return resolved
      ? { path: { kind: "path", path: resolved }, access: entry.access }
      : entry;
  }
  if (entry.path.kind === "glob") {
    return {
      path: { kind: "glob", pattern: resolvePathAgainstBase(entry.path.pattern, cwd) },
      access: entry.access,
    };
  }
  return entry;
}

function mergeFileSystemPermissions(
  left?: FileSystemPermissions,
  right?: FileSystemPermissions,
): FileSystemPermissions | undefined {
  if (left && right) {
    return {
      entries: mergePermissionEntries(left.entries, right.entries),
      ...(mergeGlobScanMaxDepth(
        left.entries,
        left.globScanMaxDepth,
        right.entries,
        right.globScanMaxDepth,
      ) !== undefined
        ? {
            globScanMaxDepth: mergeGlobScanMaxDepth(
              left.entries,
              left.globScanMaxDepth,
              right.entries,
              right.globScanMaxDepth,
            ),
          }
        : {}),
    };
  }
  return left ? cloneFileSystemPermissions(left) : right ? cloneFileSystemPermissions(right) : undefined;
}

function mergeNetworkPermissions(
  left?: NetworkPermissions,
  right?: NetworkPermissions,
): NetworkPermissions | undefined {
  return left?.enabled === true || right?.enabled === true
    ? { enabled: true }
    : undefined;
}

function mergePermissionEntries(
  left: readonly FileSystemSandboxEntry[],
  right: readonly FileSystemSandboxEntry[],
): FileSystemSandboxEntry[] {
  const merged: FileSystemSandboxEntry[] = [];
  for (const entry of [...left, ...right]) pushUnique(merged, entry);
  return merged;
}

function mergeGlobScanMaxDepth(
  leftEntries: readonly FileSystemSandboxEntry[],
  leftDepth: number | undefined,
  rightEntries: readonly FileSystemSandboxEntry[],
  rightDepth: number | undefined,
): number | undefined {
  const left = effectiveGlobScanDepth(leftEntries, leftDepth);
  const right = effectiveGlobScanDepth(rightEntries, rightDepth);
  if (left === "unbounded" || right === "unbounded") return undefined;
  if (typeof left === "number" && typeof right === "number") {
    return Math.max(left, right);
  }
  return typeof left === "number" ? left : typeof right === "number" ? right : undefined;
}

function effectiveGlobScanDepth(
  entries: readonly FileSystemSandboxEntry[],
  depth: number | undefined,
): number | "unbounded" | undefined {
  const hasGlobDeny = entries.some(
    (entry) => entry.access === "none" && entry.path.kind === "glob",
  );
  if (!hasGlobDeny) return undefined;
  return depth ?? "unbounded";
}

function accessCovers(
  requested: FileSystemAccessMode,
  granted: FileSystemAccessMode,
): boolean {
  switch (granted) {
    case "read":
      return canReadAccess(requested);
    case "write":
      return canWriteAccess(requested);
    case "none":
      return false;
  }
}

function fileSystemPolicyHasFullDiskWriteAccess(
  policy: FileSystemSandboxPolicy,
): boolean {
  return hasFullDiskWriteAccess(policy);
}

function isReadDenied(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
): boolean {
  const deniedRoots = getUnreadableRootsWithCwd(policy, cwd);
  if (deniedRoots.some((root) => pathOverlaps(root, target) || targetStartsWith(target, root))) {
    return true;
  }
  return getUnreadableGlobsWithCwd(policy, cwd).some((pattern) =>
    globPatternMatches(pattern, target),
  );
}

function targetStartsWith(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function globPatternMatches(pattern: string, target: string): boolean {
  const regex = globPatternToRegex(pattern);
  return regex.test(target);
}

function globPatternToRegex(pattern: string): RegExp {
  let regex = "^";
  const chars = [...pattern];
  let index = 0;
  while (index < chars.length) {
    const ch = chars[index++] ?? "";
    switch (ch) {
      case "*":
        if (chars[index] === "*") {
          index += 1;
          if (chars[index] === "/") {
            index += 1;
            regex += "(.*/)?";
          } else {
            regex += ".*";
          }
        } else {
          regex += "[^/]*";
        }
        break;
      case "?":
        regex += "[^/]";
        break;
      case "[":
        regex += "\\[";
        break;
      case "]":
        regex += "\\]";
        break;
      default:
        regex += ch.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
        break;
    }
  }
  regex += "$";
  return new RegExp(regex, "u");
}

function fileSystemPermissionsEmpty(permissions: FileSystemPermissions): boolean {
  return permissions.entries.length === 0;
}

function additionalPermissionProfileEmpty(
  permissions: AdditionalPermissionProfile,
): boolean {
  return !permissions.network && !permissions.fileSystem;
}

function cloneAdditionalPermissionProfile(
  profile?: AdditionalPermissionProfile,
): AdditionalPermissionProfile | undefined {
  if (!profile) return undefined;
  return {
    ...(profile.network !== undefined ? { network: { ...profile.network } } : {}),
    ...(profile.fileSystem !== undefined
      ? { fileSystem: cloneFileSystemPermissions(profile.fileSystem) }
      : {}),
  };
}

function cloneFileSystemPermissions(
  permissions: FileSystemPermissions,
): FileSystemPermissions {
  return {
    entries: permissions.entries.map((entry) => ({ ...entry })),
    ...(permissions.globScanMaxDepth !== undefined
      ? { globScanMaxDepth: permissions.globScanMaxDepth }
      : {}),
  };
}

function pushUnique(
  entries: FileSystemSandboxEntry[],
  entry: FileSystemSandboxEntry,
): void {
  if (!entries.some((candidate) => entryEquals(candidate, entry))) {
    entries.push(entry);
  }
}

function entryEquals(
  left: FileSystemSandboxEntry,
  right: FileSystemSandboxEntry,
): boolean {
  return left.access === right.access &&
    JSON.stringify(left.path) === JSON.stringify(right.path);
}
