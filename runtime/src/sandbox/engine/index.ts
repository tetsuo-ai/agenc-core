/**
 * Cross-platform sandbox engine primitives.
 *
 * Shared policy/profile data model used by the platform backends and the
 * manager. Platform-specific files build command lines and policy payloads
 * and expose the spawn surfaces used by launcher integration.
 *
 * Cross-cuts deliberately not carried:
 *   - The Linux launcher binary is C-01b.
 *   - Approval-driven sandbox escalation is C-01e.
 */

import fs from "node:fs";
import path from "node:path";

export const AGENC_LINUX_SANDBOX_ARG0 = "agenc-linux-sandbox";
export const PROTECTED_METADATA_PATH_NAMES = [".git", ".agenc", ".agents"] as const;

export type SandboxType =
  | "none"
  | "macos_seatbelt"
  | "linux_seccomp"
  | "windows_restricted_token";

export type SandboxablePreference = "auto" | "require" | "forbid";

export type NetworkSandboxPolicy = "enabled" | "disabled" | "restricted";

export type FileSystemAccessMode = "none" | "read" | "write";
export type FileSystemSandboxKind =
  | "restricted"
  | "unrestricted"
  | "external_sandbox";

export type FileSystemSpecialPath =
  | { readonly kind: "root" }
  | { readonly kind: "project_roots"; readonly subpath?: string }
  | { readonly kind: "tmpdir" }
  | { readonly kind: "slash_tmp" }
  | { readonly kind: "minimal" }
  | { readonly kind: "unknown"; readonly path: string; readonly subpath?: string };

import type {
  BlockedRequestObserver,
  NetworkPolicyDecider,
} from "../network-policy.js";

export type FileSystemPath =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "glob"; readonly pattern: string }
  | { readonly kind: "special"; readonly value: FileSystemSpecialPath };

export interface FileSystemSandboxEntry {
  readonly path: FileSystemPath;
  readonly access: FileSystemAccessMode;
}

export interface FileSystemSandboxPolicy {
  readonly kind: FileSystemSandboxKind;
  readonly entries: readonly FileSystemSandboxEntry[];
  readonly globScanMaxDepth?: number;
  readonly includePlatformDefaults?: boolean;
}

export interface NetworkPermissions {
  readonly enabled?: boolean;
}

export interface FileSystemPermissions {
  readonly entries: readonly FileSystemSandboxEntry[];
  readonly globScanMaxDepth?: number;
}

export interface AdditionalPermissionProfile {
  readonly network?: NetworkPermissions;
  readonly fileSystem?: FileSystemPermissions;
}

export type PermissionEnforcement = "default" | "untrusted" | "managed";

export interface PermissionProfile {
  readonly fileSystem: FileSystemSandboxPolicy;
  readonly network: NetworkSandboxPolicy;
  readonly enforcement?: PermissionEnforcement;
}

export interface WritableRoot {
  readonly root: string;
  readonly readOnlySubpaths: readonly string[];
  readonly protectedMetadataNames?: readonly string[];
}

export interface SandboxCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly additionalPermissions?: AdditionalPermissionProfile;
}

export interface SandboxExecRequest {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly network?: NetworkProxyConfig;
  readonly sandbox: SandboxType;
  readonly windowsSandboxLevel: WindowsSandboxLevel;
  readonly windowsSandboxPrivateDesktop: boolean;
  readonly permissionProfile: PermissionProfile;
  readonly fileSystemSandboxPolicy: FileSystemSandboxPolicy;
  readonly networkSandboxPolicy: NetworkSandboxPolicy;
  readonly arg0?: string;
}

export interface SandboxTransformRequest {
  readonly command: SandboxCommand;
  readonly permissions: PermissionProfile;
  readonly sandbox: SandboxType;
  readonly enforceManagedNetwork: boolean;
  readonly network?: NetworkProxyConfig;
  readonly networkPolicyDecider?: NetworkPolicyDecider;
  readonly blockedRequestObserver?: BlockedRequestObserver;
  readonly sandboxPolicyCwd: string;
  readonly agencLinuxSandboxExe?: string;
  readonly useLegacyLandlock: boolean;
  readonly windowsSandboxLevel: WindowsSandboxLevel;
  readonly windowsSandboxPrivateDesktop: boolean;
  readonly platform?: NodeJS.Platform;
  readonly isWsl1?: boolean;
  /** Opt-in GPU compute inside the sandbox (macOS seatbelt only for now). */
  readonly allowGpu?: boolean;
}

export type WindowsSandboxLevel = "disabled" | "low" | "medium" | "high";

export interface NetworkProxyConfig {
  readonly env?: Readonly<Record<string, string>>;
  readonly allowLocalBinding?: boolean;
  readonly allowUnixSockets?: readonly string[];
  readonly allowAllUnixSockets?: boolean;
}

export class SandboxTransformError extends Error {
  constructor(
    readonly code:
      | "missing_linux_sandbox_executable"
      | "writable_linux_sandbox_launcher"
      | "writable_linux_sandbox_helper"
      | "wsl1_unsupported_for_bubblewrap"
      | "windows_restricted_token_unimplemented"
      | "seatbelt_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SandboxTransformError";
  }
}

export function getPlatformSandbox(options: {
  readonly platform?: NodeJS.Platform;
  readonly windowsSandboxEnabled?: boolean;
} = {}): SandboxType | null {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return "macos_seatbelt";
  if (platform === "linux") return "linux_seccomp";
  if (platform === "win32" && options.windowsSandboxEnabled === true) {
    return "windows_restricted_token";
  }
  return null;
}

export function restrictedFileSystemPolicy(
  entries: readonly FileSystemSandboxEntry[] = [],
  options: {
    readonly globScanMaxDepth?: number;
    readonly includePlatformDefaults?: boolean;
  } = {},
): FileSystemSandboxPolicy {
  return {
    kind: "restricted",
    entries: [...entries],
    ...(options.globScanMaxDepth !== undefined
      ? { globScanMaxDepth: options.globScanMaxDepth }
      : {}),
    ...(options.includePlatformDefaults !== undefined
      ? { includePlatformDefaults: options.includePlatformDefaults }
      : {}),
  };
}

export function unrestrictedFileSystemPolicy(): FileSystemSandboxPolicy {
  return { kind: "unrestricted", entries: [] };
}

export function externalFileSystemPolicy(): FileSystemSandboxPolicy {
  return { kind: "external_sandbox", entries: [] };
}

export function permissionProfileFromRuntimePermissions(
  fileSystem: FileSystemSandboxPolicy,
  network: NetworkSandboxPolicy,
  enforcement?: PermissionEnforcement,
): PermissionProfile {
  return {
    fileSystem,
    network,
    ...(enforcement !== undefined ? { enforcement } : {}),
  };
}

export function permissionProfileToRuntimePermissions(
  profile: PermissionProfile,
): {
  readonly fileSystem: FileSystemSandboxPolicy;
  readonly network: NetworkSandboxPolicy;
} {
  return { fileSystem: profile.fileSystem, network: profile.network };
}

export function canReadAccess(access: FileSystemAccessMode): boolean {
  return access === "read" || access === "write";
}

export function canWriteAccess(access: FileSystemAccessMode): boolean {
  return access === "write";
}

export function networkPolicyEnabled(policy: NetworkSandboxPolicy): boolean {
  return policy === "enabled";
}

export function normalizePathForPolicy(value: string): string {
  const normalized = path.resolve(value);
  if (normalized.length > 1 && normalized.endsWith(path.sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export function canonicalizePathForPolicy(value: string): string {
  return normalizePathForPolicy(canonicalizePreservingSymlinks(value));
}

export function resolvePathAgainstBase(value: string, base: string): string {
  return path.isAbsolute(value)
    ? normalizePathForPolicy(value)
    : normalizePathForPolicy(path.resolve(base, value));
}

function resolveProjectRootSubpath(subpath: string, cwd: string): string | null {
  if (path.isAbsolute(subpath)) return null;
  const normalizedCwd = normalizePathForPolicy(cwd);
  const resolved = normalizePathForPolicy(path.resolve(normalizedCwd, subpath));
  return pathStartsWith(resolved, normalizedCwd) ? resolved : null;
}

export function pathOverlaps(left: string, right: string): boolean {
  const a = normalizePathForPolicy(left);
  const b = normalizePathForPolicy(right);
  return pathStartsWith(a, b) || pathStartsWith(b, a);
}

export function pathStartsWith(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForPolicy(candidate);
  const normalizedRoot = normalizePathForPolicy(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolvePermissionPath(
  target: FileSystemPath,
  cwd: string,
): string | null {
  switch (target.kind) {
    case "path":
      return resolvePathAgainstBase(target.path, cwd);
    case "glob":
      return null;
    case "special":
      return resolveSpecialPath(target.value, cwd);
  }
}

export function resolveSpecialPath(
  target: FileSystemSpecialPath,
  cwd: string,
): string | null {
  switch (target.kind) {
    case "root":
      return path.parse(normalizePathForPolicy(cwd)).root;
    case "project_roots":
      return target.subpath
        ? resolveProjectRootSubpath(target.subpath, cwd)
        : normalizePathForPolicy(cwd);
    case "tmpdir": {
      const tmpdir = process.env["TMPDIR"];
      return typeof tmpdir === "string" &&
        tmpdir.length > 0 &&
        path.isAbsolute(tmpdir)
        ? normalizePathForPolicy(tmpdir)
        : null;
    }
    case "slash_tmp": {
      try {
        return path.sep === "/" && fs.statSync("/tmp").isDirectory()
          ? "/tmp"
          : null;
      } catch {
        return null;
      }
    }
    case "minimal":
    case "unknown":
      return null;
  }
}

export function getWritableRootsWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
): WritableRoot[] {
  if (policy.kind !== "restricted") return [];
  if (hasFullDiskWriteAccess(policy)) return [];
  const resolvedEntries = resolvedEntriesWithCwd(policy, cwd);
  const writableEntries = resolvedEntries
    .filter((entry) => canWriteAccess(entry.access))
    .filter((entry) => canWritePathWithCwd(policy, entry.path, cwd))
    .map((entry) => entry.path);
  const writableRoots = dedupPaths(writableEntries, true);

  return writableRoots.map((root) => {
    const preserveRawCarveoutPaths = !isFilesystemRoot(root);
    const rawWritableRoots = writableEntries.filter(
      (entry) => normalizeEffectivePath(entry) === root,
    );
    const explicitCarveouts = resolvedEntries
      .filter((entry) => !canWriteAccess(entry.access))
      .filter((entry) => !canWritePathWithCwd(policy, entry.path, cwd))
      .map((entry) =>
        readOnlyCarveoutForWritableRoot(
          entry.path,
          root,
          rawWritableRoots,
          preserveRawCarveoutPaths,
        ),
      )
      .filter((candidate): candidate is string => candidate !== null);
    const defaultCarveouts = defaultReadOnlySubpathsForWritableRoot(root)
      .filter((candidate) =>
        !resolvedEntries.some((entry) => entry.path === candidate),
      );
    const readOnlySubpaths = dedupPaths([
      ...defaultCarveouts,
      ...explicitCarveouts,
    ]);
    return {
      root,
      readOnlySubpaths,
      protectedMetadataNames: protectedMetadataNamesForWritableRoot(
        policy,
        root,
        cwd,
        rawWritableRoots,
      ),
    };
  });
}

export function getReadableRootsWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
): string[] {
  if (hasFullDiskReadAccess(policy)) return [];
  if (policy.kind === "external_sandbox") return [];
  return dedupPaths(
    resolvedEntriesWithCwd(policy, cwd)
      .filter((entry) => canReadAccess(entry.access))
      .filter((entry) => canReadPathWithCwd(policy, entry.path, cwd))
      .map((entry) => entry.path),
    true,
  );
}

export function getUnreadableRootsWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
): string[] {
  if (policy.kind !== "restricted") return [];
  const filesystemRoot = path.parse(normalizePathForPolicy(cwd)).root;
  return dedupPaths(
    resolvedEntriesWithCwd(policy, cwd)
      .filter((entry) => entry.access === "none")
      .filter((entry) => !canReadPathWithCwd(policy, entry.path, cwd))
      .filter((entry) => entry.path !== filesystemRoot)
      .map((entry) => entry.path),
    true,
  );
}

export function getUnreadableGlobsWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
): string[] {
  if (policy.kind !== "restricted") return [];
  return policy.entries
    .filter((entry) => entry.access === "none" && entry.path.kind === "glob")
    .map((entry) =>
      entry.path.kind === "glob"
        ? resolvePathAgainstBase(entry.path.pattern, cwd)
        : "",
    )
    .filter(Boolean);
}

export function resolveAccessWithCwd(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
): FileSystemAccessMode {
  if (policy.kind === "unrestricted") return "write";
  if (policy.kind === "external_sandbox") return "write";
  const normalized = resolvePathAgainstBase(target, cwd);
  return resolvedEntriesWithCwd(policy, cwd)
    .filter((entry) => pathStartsWith(normalized, entry.path))
    .sort((left, right) => resolvedEntryPrecedence(right) - resolvedEntryPrecedence(left))[0]
    ?.access ?? "none";
}

export function canReadPathWithCwd(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
): boolean {
  return canReadAccess(resolveAccessWithCwd(policy, target, cwd));
}

export function canWritePathWithCwd(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
): boolean {
  if (!canWriteAccess(resolveAccessWithCwd(policy, target, cwd))) return false;
  if (hasFullDiskWriteAccess(policy)) return true;
  return !isMetadataWriteDenied(policy, target, cwd);
}

export function hasFullDiskWriteAccess(policy: FileSystemSandboxPolicy): boolean {
  switch (policy.kind) {
    case "unrestricted":
    case "external_sandbox":
      return true;
    case "restricted":
      return hasRootAccess(policy, canWriteAccess) &&
        !hasWriteNarrowingEntries(policy);
  }
}

export function hasFullDiskReadAccess(policy: FileSystemSandboxPolicy): boolean {
  switch (policy.kind) {
    case "unrestricted":
    case "external_sandbox":
      return true;
    case "restricted":
      return hasRootAccess(policy, canReadAccess) &&
        !hasDeniedReadRestrictions(policy);
  }
}

export function includePlatformDefaults(policy: FileSystemSandboxPolicy): boolean {
  return !hasFullDiskReadAccess(policy) &&
    policy.kind === "restricted" &&
    policy.entries.some(
      (entry) =>
        entry.path.kind === "special" &&
        entry.path.value.kind === "minimal" &&
        canReadAccess(entry.access),
    );
}

function defaultReadOnlySubpathsForWritableRoot(root: string): string[] {
  const normalized = normalizePathForPolicy(root);
  return PROTECTED_METADATA_PATH_NAMES.map((name) => path.join(normalized, name));
}

interface ResolvedFileSystemEntry {
  readonly path: string;
  readonly access: FileSystemAccessMode;
}

function resolvedEntriesWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
): ResolvedFileSystemEntry[] {
  if (policy.kind !== "restricted") return [];
  return policy.entries
    .filter((entry) => entry.path.kind !== "glob")
    .map((entry) => ({
      path: resolvePermissionPath(entry.path, cwd),
      access: entry.access,
    }))
    .filter(
      (entry): entry is ResolvedFileSystemEntry => entry.path !== null,
    );
}

function resolvedEntryPrecedence(entry: ResolvedFileSystemEntry): number {
  return pathSpecificity(entry.path) * 10 + accessPrecedence(entry.access);
}

function pathSpecificity(target: string): number {
  const normalized = normalizePathForPolicy(target);
  if (normalized === path.parse(normalized).root) return 0;
  return normalized.split(path.sep).filter(Boolean).length;
}

function accessPrecedence(access: FileSystemAccessMode): number {
  switch (access) {
    case "read":
      return 0;
    case "write":
      return 1;
    case "none":
      return 2;
  }
}

function hasRootAccess(
  policy: FileSystemSandboxPolicy,
  predicate: (access: FileSystemAccessMode) => boolean,
): boolean {
  return policy.kind === "restricted" &&
    policy.entries.some((entry) => {
      if (!predicate(entry.access)) return false;
      if (entry.path.kind === "special" && entry.path.value.kind === "root") {
        return true;
      }
      if (entry.path.kind === "path") {
        const normalized = normalizePathForPolicy(entry.path.path);
        return normalized === path.parse(normalized).root;
      }
      return false;
    });
}

function hasDeniedReadRestrictions(policy: FileSystemSandboxPolicy): boolean {
  return policy.kind === "restricted" &&
    policy.entries.some((entry) => entry.access === "none");
}

function hasWriteNarrowingEntries(policy: FileSystemSandboxPolicy): boolean {
  return policy.kind === "restricted" &&
    policy.entries.some((entry) => {
      if (canWriteAccess(entry.access)) return false;
      switch (entry.path.kind) {
        case "glob":
          return true;
        case "path":
          return !hasSameTargetWriteOverride(policy, entry);
        case "special":
          switch (entry.path.value.kind) {
            case "root":
              return entry.access === "none";
            case "minimal":
            case "unknown":
              return false;
            case "project_roots":
            case "tmpdir":
            case "slash_tmp":
              return !hasSameTargetWriteOverride(policy, entry);
          }
      }
    });
}

function hasSameTargetWriteOverride(
  policy: FileSystemSandboxPolicy,
  entry: FileSystemSandboxEntry,
): boolean {
  return policy.entries.some(
    (candidate) =>
      canWriteAccess(candidate.access) &&
      accessPrecedence(candidate.access) > accessPrecedence(entry.access) &&
      fileSystemPathsShareTarget(candidate.path, entry.path),
  );
}

function fileSystemPathsShareTarget(
  left: FileSystemPath,
  right: FileSystemPath,
): boolean {
  if (left.kind === "glob" || right.kind === "glob") {
    return left.kind === "glob" && right.kind === "glob" &&
      left.pattern === right.pattern;
  }
  if (left.kind === "path" && right.kind === "path") {
    return left.path === right.path;
  }
  if (left.kind === "special" && right.kind === "special") {
    return JSON.stringify(left.value) === JSON.stringify(right.value);
  }
  const pathTarget = left.kind === "path" ? left : right.kind === "path" ? right : null;
  const specialTarget = left.kind === "special" ? left : right.kind === "special" ? right : null;
  if (!pathTarget || !specialTarget) return false;
  if (specialTarget.value.kind === "root") {
    const normalized = normalizePathForPolicy(pathTarget.path);
    return normalized === path.parse(normalized).root;
  }
  if (specialTarget.value.kind === "slash_tmp") {
    return normalizePathForPolicy(pathTarget.path) === "/tmp";
  }
  return false;
}

function isMetadataWriteDenied(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
): boolean {
  if (policy.kind !== "restricted") return false;
  const normalizedTarget = resolvePathAgainstBase(target, cwd);
  const protectedPath = metadataChildOfWritableRoot(policy, normalizedTarget, cwd);
  if (protectedPath === null) return false;
  return !hasExplicitWriteEntryForMetadataPath(
    policy,
    protectedPath,
    normalizedTarget,
    cwd,
  );
}

function metadataChildOfWritableRoot(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
): string | null {
  for (const entry of resolvedEntriesWithCwd(policy, cwd)) {
    if (!canWriteAccess(entry.access)) continue;
    const relative = path.relative(entry.path, target);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const [firstComponent] = relative.split(path.sep);
    if (
      firstComponent &&
      PROTECTED_METADATA_PATH_NAMES.includes(
        firstComponent as (typeof PROTECTED_METADATA_PATH_NAMES)[number],
      )
    ) {
      return path.join(entry.path, firstComponent);
    }
  }
  return null;
}

function hasExplicitWriteEntryForMetadataPath(
  policy: FileSystemSandboxPolicy,
  protectedMetadataPath: string,
  target: string,
  cwd: string,
): boolean {
  return resolvedEntriesWithCwd(policy, cwd).some(
    (entry) =>
      canWriteAccess(entry.access) &&
      pathStartsWith(target, entry.path) &&
      pathStartsWith(entry.path, protectedMetadataPath),
  );
}

function protectedMetadataNamesForWritableRoot(
  policy: FileSystemSandboxPolicy,
  root: string,
  cwd: string,
  rawWritableRoots: readonly string[] = [],
): string[] {
  return PROTECTED_METADATA_PATH_NAMES.filter(
    (name) => {
      const metadataPaths = [
        path.join(root, name),
        ...rawWritableRoots.map((rawRoot) => path.join(rawRoot, name)),
      ];
      return metadataPaths.every(
        (metadataPath) => !canWritePathWithCwd(policy, metadataPath, cwd),
      );
    },
  );
}

function dedupPaths(
  paths: readonly string[],
  normalizeEffectivePaths = false,
): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of paths) {
    const normalized = normalizeEffectivePaths
      ? normalizeEffectivePath(item)
      : normalizePathForPolicy(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function readOnlyCarveoutForWritableRoot(
  entryPath: string,
  root: string,
  rawWritableRoots: readonly string[],
  preserveRawCarveoutPaths: boolean,
): string | null {
  const effectivePath = normalizeEffectivePath(entryPath);
  if (preserveRawCarveoutPaths) {
    if (entryPath !== root && pathStartsWith(entryPath, root)) {
      return entryPath;
    }
    for (const rawRoot of rawWritableRoots) {
      const relative = path.relative(rawRoot, entryPath);
      if (
        relative.length > 0 &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return path.join(root, relative);
      }
    }
  }
  if (effectivePath === root || !pathStartsWith(effectivePath, root)) {
    return null;
  }
  return effectivePath;
}

function normalizeEffectivePath(value: string): string {
  const rawPath = normalizePathForPolicy(value);
  for (const ancestor of pathAncestors(rawPath)) {
    if (!pathExistsForSymlinkMetadata(ancestor)) continue;
    const normalizedAncestor = canonicalizePreservingSymlinks(ancestor);
    const suffix = path.relative(ancestor, rawPath);
    return normalizePathForPolicy(
      suffix.length === 0
        ? normalizedAncestor
        : path.join(normalizedAncestor, suffix),
    );
  }
  return rawPath;
}

function canonicalizePreservingSymlinks(value: string): string {
  const logical = normalizePathForPolicy(value);
  const preserveLogicalPath = shouldPreserveLogicalPath(logical);
  try {
    const canonical = normalizePathForPolicy(fs.realpathSync.native(logical));
    return preserveLogicalPath && canonical !== logical ? logical : canonical;
  } catch {
    return logical;
  }
}

function shouldPreserveLogicalPath(logical: string): boolean {
  return pathAncestors(logical).some((ancestor) => {
    if (isFilesystemRoot(ancestor)) return false;
    const parent = path.dirname(ancestor);
    if (isFilesystemRoot(parent)) return false;
    try {
      return fs.lstatSync(ancestor).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function pathAncestors(value: string): string[] {
  const ancestors: string[] = [];
  let current = normalizePathForPolicy(value);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function pathExistsForSymlinkMetadata(value: string): boolean {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function isFilesystemRoot(value: string): boolean {
  const normalized = normalizePathForPolicy(value);
  return path.dirname(normalized) === normalized;
}

export { SandboxManager, compatibilitySandboxPolicyForPermissionProfile } from "./manager.js";
export { createLinuxSandboxCommandArgsForPermissionProfile } from "./landlock.js";
export { createSeatbeltCommandArgs } from "./seatbelt.js";
export { findSystemBwrapInPath, systemBwrapWarning } from "./bwrap.js";
