import type { BoundReadOnlyCwdCapability } from "../bound-readonly-cwd.js";
/**
 * Cross-platform sandbox engine primitives.
 *
 * Shared policy/profile data model used by the platform backends and the
 * manager. It imports no backend, so the Linux launcher process loads only
 * this model; `index.ts` adds the manager and the platform backends.
 *
 * Cross-cuts deliberately not carried:
 *   - The Linux launcher binary is C-01b.
 *   - Approval-driven sandbox escalation is C-01e.
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalAuthorityPath, isWithinAuthorityPath } from "../desktop-authority-protection.js";

import { PROTECTED_METADATA_PATH_NAMES } from "./constants.js";
export {
  AGENC_INHERITED_CWD_SANDBOX_PATH,
  AGENC_LINUX_SANDBOX_ARG0,
  PROTECTED_METADATA_PATH_NAMES,
} from "./constants.js";

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
  /** Native runtime reservations, never overrideable by additional/model grants. */
  readonly reservedReadOnlyPaths?: readonly string[];
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
  readonly reservedReadOnlyPaths?: readonly string[];
}

export interface SandboxCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwdBinding?: "inherited_readonly";
  readonly cwdCapability?: BoundReadOnlyCwdCapability;
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
  readonly sessionTempRoot: string;
  readonly agencLinuxSandboxExe?: string;
  readonly windowsSandboxLevel: WindowsSandboxLevel;
  readonly windowsSandboxPrivateDesktop: boolean;
  readonly platform?: NodeJS.Platform;
  readonly isWsl1?: boolean;
  /** Opt-in GPU compute inside the sandbox (macOS seatbelt only for now). */
  readonly allowGpu?: boolean;
  /**
   * The command launches Chromium for the Browser tool. Under macOS seatbelt
   * the profile adds the rules Chromium needs to start.
   */
  readonly chromiumBrowser?: boolean;
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
      | "invalid_inherited_cwd"
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
    readonly reservedReadOnlyPaths?: readonly string[];
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
    ...(options.reservedReadOnlyPaths !== undefined
      ? { reservedReadOnlyPaths: [...options.reservedReadOnlyPaths] }
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
  sessionTempRoot: string,
): string | null {
  switch (target.kind) {
    case "path":
      return resolvePathAgainstBase(target.path, cwd);
    case "glob":
      return null;
    case "special":
      return resolveSpecialPath(target.value, cwd, sessionTempRoot);
  }
}

export function resolveSpecialPath(
  target: FileSystemSpecialPath,
  cwd: string,
  sessionTempRoot: string,
): string | null {
  switch (target.kind) {
    case "root":
      return path.parse(normalizePathForPolicy(cwd)).root;
    case "project_roots":
      return target.subpath
        ? resolveProjectRootSubpath(target.subpath, cwd)
        : normalizePathForPolicy(cwd);
    case "tmpdir": {
      return normalizePathForPolicy(sessionTempRoot);
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
  sessionTempRoot: string,
): WritableRoot[] {
  if (policy.kind !== "restricted") return [];
  if (hasFullDiskWriteAccess(policy)) return [];
  const resolvedEntries = resolvedEntriesWithCwd(policy, cwd, sessionTempRoot);
  const writableEntries = resolvedEntries
    .filter((entry) => canWriteAccess(entry.access))
    .filter((entry) =>
      canWritePathWithCwd(policy, entry.path, cwd, sessionTempRoot)
    )
    .map((entry) => entry.path);
  const writableRoots = dedupPaths(writableEntries, true);

  return writableRoots.map((root) => {
    const reservedReadOnlyPaths = (policy.reservedReadOnlyPaths ?? []).filter(
      (reserved) => isWithinAuthorityPath(reserved, canonicalAuthorityPath(root)),
    );
    const preserveRawCarveoutPaths = !isFilesystemRoot(root);
    const rawWritableRoots = writableEntries.filter(
      (entry) => normalizeEffectivePath(entry) === root,
    );
    const explicitCarveouts = resolvedEntries
      .filter((entry) => !canWriteAccess(entry.access))
      .filter((entry) =>
        !canWritePathWithCwd(policy, entry.path, cwd, sessionTempRoot)
      )
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
      )
      // Narrow a real, not-explicitly-granted `.git` from a whole-directory
      // carve-out to only its execution/redirection paths, so ordinary branch,
      // add, commit, tag and stash writes (refs, objects, index, HEAD, logs,
      // the pseudo-refs and message files) succeed in the default sandbox while
      // hooks/config/info/objects-info/modules/worktrees/commondir stay
      // read-only. A `.git` gitfile pointer, a `.git` symlink, or an absent
      // `.git` is never narrowed; `.agenc`/`.agents` pass through unchanged.
      .flatMap((candidate) =>
        path.basename(candidate) === GIT_METADATA_DIR_NAME &&
        isExistingDirectory(candidate)
          ? gitNarrowedReadOnlyCarveouts(candidate)
          : [candidate],
      );
    const readOnlySubpaths = dedupPaths([
      ...defaultCarveouts,
      ...explicitCarveouts,
      ...reservedReadOnlyPaths,
    ]);
    return {
      root,
      readOnlySubpaths,
      ...(reservedReadOnlyPaths.length > 0 ? { reservedReadOnlyPaths } : {}),
      protectedMetadataNames: protectedMetadataNamesForWritableRoot(
        policy,
        root,
        cwd,
        sessionTempRoot,
        rawWritableRoots,
      ),
    };
  });
}

export function getReadableRootsWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
  sessionTempRoot: string,
): string[] {
  if (hasFullDiskReadAccess(policy)) return [];
  if (policy.kind === "external_sandbox") return [];
  return dedupPaths(
    resolvedEntriesWithCwd(policy, cwd, sessionTempRoot)
      .filter((entry) => canReadAccess(entry.access))
      .filter((entry) =>
        canReadPathWithCwd(policy, entry.path, cwd, sessionTempRoot)
      )
      .map((entry) => entry.path),
    true,
  );
}

export function getUnreadableRootsWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
  sessionTempRoot: string,
): string[] {
  if (policy.kind !== "restricted") return [];
  const filesystemRoot = path.parse(normalizePathForPolicy(cwd)).root;
  return dedupPaths(
    resolvedEntriesWithCwd(policy, cwd, sessionTempRoot)
      .filter((entry) => entry.access === "none")
      .filter((entry) =>
        !canReadPathWithCwd(policy, entry.path, cwd, sessionTempRoot)
      )
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
  sessionTempRoot: string,
): FileSystemAccessMode {
  if (policy.kind === "unrestricted") return "write";
  if (policy.kind === "external_sandbox") return "write";
  const normalized = resolvePathAgainstBase(target, cwd);
  return resolvedEntriesWithCwd(policy, cwd, sessionTempRoot)
    .filter((entry) => pathStartsWith(normalized, entry.path))
    .sort((left, right) => resolvedEntryPrecedence(right) - resolvedEntryPrecedence(left))[0]
    ?.access ?? "none";
}

export function canReadPathWithCwd(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
  sessionTempRoot: string,
): boolean {
  return canReadAccess(
    resolveAccessWithCwd(policy, target, cwd, sessionTempRoot),
  );
}

export function canWritePathWithCwd(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
  sessionTempRoot: string,
): boolean {
  if (!writableRootsAllow(policy, target, cwd, sessionTempRoot)) return false;
  if (hasFullDiskWriteAccess(policy)) return true;
  return !isMetadataWriteDenied(policy, target, cwd, sessionTempRoot);
}

/**
 * Write check for a location the runtime itself chose and declared through
 * `ToolMetadata.fixedWriteTargets`. The model cannot steer such a path, so
 * the protected-metadata rule (which keeps model-directed writes out of
 * `.git`, `.agenc` and `.agents`) does not apply to it; containment in the
 * writable roots and the reserved read-only paths still do.
 */
export function canWriteRuntimeOwnedPathWithCwd(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
  sessionTempRoot: string,
): boolean {
  return writableRootsAllow(policy, target, cwd, sessionTempRoot);
}

/** Containment in the writable roots, minus reserved read-only paths. */
function writableRootsAllow(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
  sessionTempRoot: string,
): boolean {
  const reserved = policy.reservedReadOnlyPaths ?? [];
  if (reserved.length > 0) {
    // One fresh physical target for this decision, checked against every
    // reservation. Never retain this observation across permission checks.
    const physicalTarget = canonicalAuthorityPath(path.resolve(cwd, target));
    if (reserved.some((root) => isWithinAuthorityPath(physicalTarget, root))) return false;
  }
  return canWriteAccess(
    resolveAccessWithCwd(policy, target, cwd, sessionTempRoot),
  );
}

export function hasFullDiskWriteAccess(policy: FileSystemSandboxPolicy): boolean {
  if ((policy.reservedReadOnlyPaths?.length ?? 0) > 0) return false;
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
  if (hasFullDiskReadAccess(policy) || policy.kind !== "restricted") {
    return false;
  }
  // The serialized field MUST be honored here, not just the `minimal`
  // special-path entry: adaptLiveFileSystemPolicy sets the field (via
  // restrictedFileSystemPolicy's option) and the daemon ships the policy
  // JSON to the linux launcher, where entries are all that survives — if
  // only the entry were checked, platform defaults (/bin /usr /lib…) would
  // never mount and every dynamically-linked payload would die with
  // execve ENOENT inside the namespace (observed: Glob via bundled rg).
  if (policy.includePlatformDefaults === true) {
    return true;
  }
  return policy.entries.some(
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

/**
 * The repository metadata directory whose inert data areas ordinary branch,
 * add, commit, tag and stash must write. The directory as a whole is kept
 * protected against the writes that run code or redirect git (below); only
 * those paths stay read-only, so `refs`, `objects`, the `index`, `HEAD`, the
 * reflogs, the pseudo-refs and the message files are writable in the default
 * sandbox without an escalation. `.agenc` and `.agents` are never narrowed.
 * Threat analysis and git-documentation sources: round4/jobs/gt/REPORT.md.
 */
const GIT_METADATA_DIR_NAME = ".git";

/**
 * Top-level entries inside a `.git` directory that execute code or redirect
 * git to attacker-controlled code, objects, refs or repositories. A write to
 * any of these, directly or through a symlink that resolves into them, stays
 * refused. Everything else inside `.git` is inert data git reads back.
 *   hooks            githooks(5): executables git runs during ordinary ops
 *   config           git-config(5): hooksPath/fsmonitor/sshCommand/filter/alias/...
 *   config.worktree  per-worktree config
 *   info             gitattributes(5): info/attributes activates filter/diff drivers
 *   modules          submodule gitdirs carry their own config and hooks
 *   worktrees        linked-worktree admin dirs: config.worktree, gitdir/commondir
 *   commondir        redirects the common git directory
 *   remotes          legacy remote definitions (gitrepository-layout(5)): fetch URLs
 *   branches         legacy remote shorthands (gitrepository-layout(5)): fetch URLs
 */
const GIT_PROTECTED_TOP_LEVEL_ENTRIES: ReadonlySet<string> = new Set([
  "hooks",
  "config",
  "config.worktree",
  "info",
  "modules",
  "worktrees",
  "commondir",
  "remotes",
  "branches",
]);

/**
 * Nested entries inside otherwise-writable `.git` data areas that stay
 * read-only. `objects/info` holds `alternates` and `http-alternates`, which
 * redirect object lookups to an arbitrary local store or dumb-HTTP URL; loose
 * objects and packs elsewhere in `objects/` are inert and writable.
 */
const GIT_PROTECTED_NESTED_ENTRIES: readonly string[] = ["objects/info"];

function isExistingDirectory(target: string): boolean {
  try {
    // lstat, not stat: a `.git` symlink is a pointer, the same class as a
    // gitfile. Following it would narrow the link name and admit writes into
    // whatever directory it names, including one outside the workspace.
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The protected (read-only) carve-outs inside a narrowed `.git` directory.
 * Every one that exists is mounted read-only; every one that is missing is
 * watched by the launcher's created-path monitor (detect, remove, fail the
 * command), never placeholdered - a placeholder at a missing path inside the
 * host-bind-mounted `.git` would make bubblewrap create that entry on the real
 * host `.git`. `commondir` is included so an unparseable write that creates it
 * (e.g. python, a compiled helper) is caught and removed, matching base.
 */
function gitNarrowedReadOnlyCarveouts(gitMetadataPath: string): string[] {
  const normalized = normalizePathForPolicy(gitMetadataPath);
  return [...GIT_PROTECTED_TOP_LEVEL_ENTRIES, ...GIT_PROTECTED_NESTED_ENTRIES].map(
    (entry) => path.join(normalized, ...entry.split("/")),
  );
}


/**
 * Whether a `.git`-relative path names the protected execution/redirection
 * surface. The `.git` directory entry itself (`rel === ""`) is writable; a
 * path that escapes `.git` fails closed as protected.
 */
function relIsWithinGitProtectedSurface(rel: string): boolean {
  if (rel === "") return false;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return true;
  }
  const [first] = rel.split(path.sep);
  if (first !== undefined && GIT_PROTECTED_TOP_LEVEL_ENTRIES.has(first)) return true;
  return GIT_PROTECTED_NESTED_ENTRIES.some(
    (nested) => rel === nested || rel.startsWith(`${nested}${path.sep}`),
  );
}

/**
 * Whether a write to `target` is to inert, writable data inside the `.git`
 * metadata directory `gitMetadataPath` (and so may be allowed even though the
 * directory is a protected-metadata name). Only applies when `.git` is a real
 * directory, never a `.git` gitfile pointer or a `.git` symlink. Fails closed
 * against symlink and alternate-path tricks: both the lexical target and its
 * physical, symlink-resolved spelling must stay inside this `.git` and off
 * the protected surface.
 */
function gitMetadataDirWriteAllowed(
  gitMetadataPath: string,
  target: string,
): boolean {
  if (path.basename(gitMetadataPath) !== GIT_METADATA_DIR_NAME) return false;
  if (!isExistingDirectory(gitMetadataPath)) return false;
  const lexicalRoot = normalizePathForPolicy(gitMetadataPath);
  const lexicalTarget = normalizePathForPolicy(target);
  const physicalRoot = canonicalAuthorityPath(gitMetadataPath);
  const physicalTarget = canonicalAuthorityPath(target);
  for (const [root, resolved] of [
    [lexicalRoot, lexicalTarget],
    [physicalRoot, physicalTarget],
  ] as const) {
    if (!isWithinAuthorityPath(resolved, root)) return false;
    if (relIsWithinGitProtectedSurface(path.relative(root, resolved))) return false;
  }
  return true;
}

interface ResolvedFileSystemEntry {
  readonly path: string;
  readonly access: FileSystemAccessMode;
}

function resolvedEntriesWithCwd(
  policy: FileSystemSandboxPolicy,
  cwd: string,
  sessionTempRoot: string,
): ResolvedFileSystemEntry[] {
  if (policy.kind !== "restricted") return [];
  return policy.entries
    .filter((entry) => entry.path.kind !== "glob")
    .map((entry) => ({
      path: resolvePermissionPath(entry.path, cwd, sessionTempRoot),
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
  sessionTempRoot: string,
): boolean {
  if (policy.kind !== "restricted") return false;
  const normalizedTarget = resolvePathAgainstBase(target, cwd);
  const protectedPath = metadataChildOfWritableRoot(
    policy,
    normalizedTarget,
    cwd,
    sessionTempRoot,
  );
  if (protectedPath === null) return false;
  if (
    hasExplicitWriteEntryForMetadataPath(
      policy,
      protectedPath,
      normalizedTarget,
      cwd,
      sessionTempRoot,
    )
  ) {
    return false;
  }
  // A real `.git` directory is narrowed: inert data is writable, only the
  // execution/redirection surface stays protected. `.agenc`/`.agents`, a
  // `.git` gitfile pointer and a `.git` symlink are never narrowed
  // (gitMetadataDirWriteAllowed returns false), so they stay fully denied.
  if (gitMetadataDirWriteAllowed(protectedPath, normalizedTarget)) return false;
  return true;
}

function metadataChildOfWritableRoot(
  policy: FileSystemSandboxPolicy,
  target: string,
  cwd: string,
  sessionTempRoot: string,
): string | null {
  for (const entry of resolvedEntriesWithCwd(policy, cwd, sessionTempRoot)) {
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
  sessionTempRoot: string,
): boolean {
  return resolvedEntriesWithCwd(policy, cwd, sessionTempRoot).some(
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
  sessionTempRoot: string,
  rawWritableRoots: readonly string[] = [],
): string[] {
  return PROTECTED_METADATA_PATH_NAMES.filter(
    (name) => {
      const metadataPaths = [
        path.join(root, name),
        ...rawWritableRoots.map((rawRoot) => path.join(rawRoot, name)),
      ];
      return metadataPaths.every(
        (metadataPath) =>
          !canWritePathWithCwd(
            policy,
            metadataPath,
            cwd,
            sessionTempRoot,
          ),
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
