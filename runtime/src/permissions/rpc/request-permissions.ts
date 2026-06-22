/**
 * Ports the donor runtime request-permissions RPC shapes onto AgenC's
 * permission subsystem.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC already has tool-approval prompts and string permission events.
 *     This module adds the structured request-permissions substrate without
 *     wiring a second public approval path into the daemon protocol.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Full sandbox policy transforms. Response normalization only preserves
 *     grants that are exact or narrower than the requested concrete paths or
 *     cwd-bound project-root entries.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { asRecord } from "../../utils/record.js";

export type PermissionGrantScope = "turn" | "session";

export interface NetworkPermissions {
  readonly enabled?: boolean;
}

export type FileSystemAccessMode = "read" | "write" | "none";

export type FileSystemSpecialPath =
  | { readonly kind: "root" }
  | { readonly kind: "minimal" }
  | { readonly kind: "project_roots"; readonly subpath?: string | null }
  | { readonly kind: "tmpdir" }
  | { readonly kind: "slash_tmp" }
  | {
      readonly kind: "unknown";
      readonly path: string;
      readonly subpath?: string | null;
    };

export type FileSystemPath =
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "glob_pattern"; readonly pattern: string }
  | { readonly type: "special"; readonly value: FileSystemSpecialPath };

export interface FileSystemSandboxEntry {
  readonly path: FileSystemPath;
  readonly access: FileSystemAccessMode;
}

export interface FileSystemPermissions {
  readonly entries: readonly FileSystemSandboxEntry[];
  readonly globScanMaxDepth?: number;
}

export interface RequestPermissionProfile {
  readonly network?: NetworkPermissions;
  readonly fileSystem?: FileSystemPermissions;
}

export interface RequestPermissionsArgs {
  readonly reason?: string;
  readonly permissions: RequestPermissionProfile;
}

export interface RequestPermissionsResponse {
  readonly permissions: RequestPermissionProfile;
  readonly scope: PermissionGrantScope;
  readonly strictAutoReview: boolean;
}

export interface RequestPermissionsEvent {
  readonly callId: string;
  readonly turnId: string;
  readonly reason?: string;
  readonly permissions: RequestPermissionProfile;
  readonly cwd?: string;
}

export interface RequestPermissionsNormalizeOptions {
  readonly cwd?: string;
}

interface NormalizeProfileOptions extends RequestPermissionsNormalizeOptions {
  readonly strictTopLevel: boolean;
  readonly rejectGlobGrants: boolean;
}

export const EMPTY_REQUEST_PERMISSION_PROFILE: RequestPermissionProfile =
  Object.freeze({});

function readAliasedField(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  const hasCamel = Object.hasOwn(record, camel);
  const hasSnake = Object.hasOwn(record, snake);
  if (hasCamel && hasSnake) {
    throw new Error(`request_permissions cannot specify both ${camel} and ${snake}`);
  }
  return hasCamel ? record[camel] : record[snake];
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringField(value, field);
}

function projectRootSubpath(value: unknown, field: string): string | null {
  if (value === null) return null;
  const raw = stringField(value, field);
  if (path.isAbsolute(raw)) {
    throw new Error(`${field} must be relative`);
  }
  const normalized = path.normalize(raw);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${field} must stay within the project root`);
  }
  return raw;
}

function normalizeAbsolutePath(
  value: unknown,
  field: string,
  cwd: string | undefined,
): string {
  const raw = stringField(value, field);
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (cwd !== undefined) return path.resolve(cwd, raw);
  throw new Error(`${field} must be absolute when cwd is not provided`);
}

function normalizeNetworkPermissions(
  value: unknown,
): NetworkPermissions | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (record === null) {
    throw new Error("request_permissions network permissions must be an object");
  }
  const enabled = record.enabled;
  if (enabled === undefined || enabled === null) return undefined;
  if (typeof enabled !== "boolean") {
    throw new Error("request_permissions network.enabled must be a boolean");
  }
  return { enabled };
}

function normalizeGlobScanDepth(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("request_permissions fileSystem.globScanMaxDepth must be a positive integer");
  }
  return value;
}

function normalizeSpecialPath(value: unknown): FileSystemSpecialPath {
  const record = asRecord(value);
  if (record === null) {
    throw new Error("request_permissions fileSystem entry special path must be an object");
  }
  const kind = record.kind === "current_working_directory"
    ? "project_roots"
    : record.kind;
  switch (kind) {
    case "root":
      return { kind: "root" };
    case "minimal":
      return { kind: "minimal" };
    case "project_roots":
      return {
        kind: "project_roots",
        ...(record.subpath !== undefined
          ? {
              subpath: projectRootSubpath(
                record.subpath,
                "fileSystem entry special subpath",
              ),
            }
          : {}),
      };
    case "tmpdir":
      return { kind: "tmpdir" };
    case "slash_tmp":
      return { kind: "slash_tmp" };
    case "unknown":
      return {
        kind: "unknown",
        path: stringField(record.path, "fileSystem entry special unknown path"),
        ...(record.subpath !== undefined
          ? { subpath: optionalString(record.subpath, "fileSystem entry special subpath") ?? null }
          : {}),
      };
    default:
      throw new Error("request_permissions fileSystem entry special path has unknown kind");
  }
}

function normalizeFileSystemPath(
  value: unknown,
  field: string,
  options: NormalizeProfileOptions,
): FileSystemPath {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(`${field} must be an object`);
  }
  switch (record.type) {
    case "path":
      return {
        type: "path",
        path: normalizeAbsolutePath(record.path, `${field}.path`, options.cwd),
      };
    case "glob_pattern":
      return {
        type: "glob_pattern",
        pattern: stringField(record.pattern, `${field}.pattern`),
      };
    case "special":
      return {
        type: "special",
        value: normalizeSpecialPath(record.value),
      };
    default:
      throw new Error(`${field}.type must be path, glob_pattern, or special`);
  }
}

function normalizeAccessMode(value: unknown, field: string): FileSystemAccessMode {
  if (value === "read" || value === "write" || value === "none") return value;
  throw new Error(`${field} must be read, write, or none`);
}

function normalizeFileSystemEntry(
  value: unknown,
  index: number,
  options: NormalizeProfileOptions,
): FileSystemSandboxEntry {
  const record = asRecord(value);
  if (record === null) {
    throw new Error(`request_permissions fileSystem.entries[${index}] must be an object`);
  }
  const access = normalizeAccessMode(
    record.access,
    `request_permissions fileSystem.entries[${index}].access`,
  );
  const normalized = {
    path: normalizeFileSystemPath(
      record.path,
      `request_permissions fileSystem.entries[${index}].path`,
      options,
    ),
    access,
  } satisfies FileSystemSandboxEntry;
  if (
    options.rejectGlobGrants &&
    normalized.path.type === "glob_pattern" &&
    normalized.access !== "none"
  ) {
    throw new Error("glob file system permissions only support deny-read entries");
  }
  return normalized;
}

function normalizeLegacyPathEntries(
  value: unknown,
  field: string,
  access: FileSystemAccessMode,
  options: NormalizeProfileOptions,
): FileSystemSandboxEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`request_permissions fileSystem.${field} must be an array`);
  }
  return value.map((item) => ({
    path: {
      type: "path",
      path: normalizeAbsolutePath(
        item,
        `request_permissions fileSystem.${field}`,
        options.cwd,
      ),
    },
    access,
  }));
}

function entryKey(entry: FileSystemSandboxEntry): string {
  return JSON.stringify(entry);
}

function dedupeEntries(
  entries: readonly FileSystemSandboxEntry[],
): FileSystemSandboxEntry[] {
  const seen = new Set<string>();
  const out: FileSystemSandboxEntry[] = [];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function normalizeFileSystemPermissions(
  value: unknown,
  options: NormalizeProfileOptions,
): FileSystemPermissions | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (record === null) {
    throw new Error("request_permissions fileSystem permissions must be an object");
  }
  const depth = normalizeGlobScanDepth(
    readAliasedField(record, "globScanMaxDepth", "glob_scan_max_depth"),
  );
  const rawEntries = record.entries;
  const entries = rawEntries !== undefined && rawEntries !== null
    ? (() => {
        if (!Array.isArray(rawEntries)) {
          throw new Error("request_permissions fileSystem.entries must be an array");
        }
        return rawEntries.map((entry, index) =>
          normalizeFileSystemEntry(entry, index, options),
        );
      })()
    : [
        ...normalizeLegacyPathEntries(record.read, "read", "read", options),
        ...normalizeLegacyPathEntries(record.write, "write", "write", options),
      ];
  const deduped = dedupeEntries(entries);
  if (deduped.length === 0) return undefined;
  return {
    entries: deduped,
    ...(depth !== undefined ? { globScanMaxDepth: depth } : {}),
  };
}

export function requestPermissionProfileIsEmpty(
  profile: RequestPermissionProfile,
): boolean {
  return profile.network === undefined && profile.fileSystem === undefined;
}

function normalizeRequestPermissionProfile(
  value: unknown,
  options: RequestPermissionsNormalizeOptions = {},
): RequestPermissionProfile {
  return normalizePermissionProfile(value, {
    ...options,
    strictTopLevel: true,
    rejectGlobGrants: true,
  });
}

function normalizeGrantedPermissionProfile(
  value: unknown,
  options: RequestPermissionsNormalizeOptions = {},
): RequestPermissionProfile {
  return normalizePermissionProfile(value, {
    ...options,
    strictTopLevel: false,
    rejectGlobGrants: false,
  });
}

function normalizePermissionProfile(
  value: unknown,
  options: NormalizeProfileOptions,
): RequestPermissionProfile {
  if (value === undefined || value === null) return EMPTY_REQUEST_PERMISSION_PROFILE;
  const record = asRecord(value);
  if (record === null) {
    throw new Error("request_permissions permissions must be an object");
  }
  if (options.strictTopLevel) {
    for (const key of Object.keys(record)) {
      if (key !== "network" && key !== "fileSystem" && key !== "file_system") {
        throw new Error(`request_permissions permissions has unknown field: ${key}`);
      }
    }
  }
  const fileSystemValue = readAliasedField(record, "fileSystem", "file_system");
  const network = normalizeNetworkPermissions(record.network);
  const fileSystem = normalizeFileSystemPermissions(fileSystemValue, options);
  const profile: RequestPermissionProfile = {
    ...(network !== undefined ? { network } : {}),
    ...(fileSystem !== undefined ? { fileSystem } : {}),
  };
  return requestPermissionProfileIsEmpty(profile)
    ? EMPTY_REQUEST_PERMISSION_PROFILE
    : profile;
}

export function normalizeRequestPermissionsArgs(
  value: unknown,
  options: RequestPermissionsNormalizeOptions = {},
): RequestPermissionsArgs {
  const record = asRecord(value);
  if (record === null) {
    throw new Error("request_permissions requires an object argument");
  }
  const reason = optionalString(record.reason, "request_permissions.reason");
  const permissions = normalizeRequestPermissionProfile(
    record.permissions,
    options,
  );
  if (requestPermissionProfileIsEmpty(permissions)) {
    throw new Error("request_permissions requires at least one permission");
  }
  return {
    ...(reason !== undefined ? { reason } : {}),
    permissions,
  };
}

function normalizeGrantScope(value: unknown): PermissionGrantScope {
  if (value === undefined || value === null) return "turn";
  if (value === "turn" || value === "session") return value;
  throw new Error("request_permissions response.scope must be turn or session");
}

function normalizeStrictAutoReview(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  throw new Error("request_permissions response.strictAutoReview must be a boolean");
}

function emptyResponse(
  scope: PermissionGrantScope = "turn",
  strictAutoReview = false,
): RequestPermissionsResponse {
  return {
    permissions: EMPTY_REQUEST_PERMISSION_PROFILE,
    scope,
    strictAutoReview,
  };
}

export function normalizeRequestPermissionsResponse(
  requested: RequestPermissionProfile,
  value: unknown,
  options: RequestPermissionsNormalizeOptions = {},
): RequestPermissionsResponse {
  const record = asRecord(value);
  if (record === null) return emptyResponse();
  try {
    const scope = normalizeGrantScope(record.scope);
    const strictAutoReview = normalizeStrictAutoReview(
      readAliasedField(record, "strictAutoReview", "strict_auto_review"),
    );
    if (strictAutoReview && scope === "session") {
      return emptyResponse();
    }
    const granted = normalizeGrantedPermissionProfile(
      record.permissions ?? EMPTY_REQUEST_PERMISSION_PROFILE,
      options,
    );
    if (requestPermissionProfileIsEmpty(granted)) {
      return emptyResponse(scope, strictAutoReview);
    }
    return {
      permissions: intersectRequestPermissionProfiles(
        requested,
        granted,
        options.cwd,
      ),
      scope,
      strictAutoReview,
    };
  } catch {
    return emptyResponse();
  }
}

export function requestPermissionsEventPermissionLabels(
  profile: RequestPermissionProfile,
): readonly string[] {
  const labels: string[] = [];
  if (profile.network !== undefined) labels.push("network");
  if (profile.fileSystem !== undefined) labels.push("file_system");
  return labels;
}

export function intersectRequestPermissionProfiles(
  requested: RequestPermissionProfile,
  granted: RequestPermissionProfile,
  cwd?: string,
): RequestPermissionProfile {
  const network =
    requested.network?.enabled === true && granted.network?.enabled === true
      ? { enabled: true }
      : undefined;
  const fileSystem = intersectFileSystemPermissions(
    requested.fileSystem,
    granted.fileSystem,
    cwd,
  );
  const profile: RequestPermissionProfile = {
    ...(network !== undefined ? { network } : {}),
    ...(fileSystem !== undefined ? { fileSystem } : {}),
  };
  return requestPermissionProfileIsEmpty(profile)
    ? EMPTY_REQUEST_PERMISSION_PROFILE
    : profile;
}

function accessCanRead(access: FileSystemAccessMode): boolean {
  return access !== "none";
}

function accessCanWrite(access: FileSystemAccessMode): boolean {
  return access === "write";
}

function accessCovers(
  requested: FileSystemAccessMode,
  granted: FileSystemAccessMode,
): boolean {
  if (granted === "read") return accessCanRead(requested);
  if (granted === "write") return accessCanWrite(requested);
  return false;
}

function resolvePermissionPath(
  permissionPath: FileSystemPath,
  cwd: string | undefined,
): string | null {
  if (permissionPath.type === "path") {
    if (path.isAbsolute(permissionPath.path)) {
      return path.normalize(permissionPath.path);
    }
    return cwd === undefined ? null : path.resolve(cwd, permissionPath.path);
  }
  if (
    permissionPath.type === "special" &&
    cwd !== undefined
  ) {
    switch (permissionPath.value.kind) {
      case "root":
        return path.parse(path.resolve(cwd)).root;
      case "project_roots": {
        const subpath = permissionPath.value.subpath;
        return subpath === undefined || subpath === null
          ? path.normalize(cwd)
          : path.resolve(cwd, subpath);
      }
      case "tmpdir": {
        const tmpdir = process.env["TMPDIR"];
        if (!tmpdir) return null;
        return path.isAbsolute(tmpdir) ? path.normalize(tmpdir) : null;
      }
      case "slash_tmp": {
        if (process.platform === "win32" || !existsSync("/tmp")) return null;
        try {
          return statSync("/tmp").isDirectory() ? "/tmp" : null;
        } catch {
          return null;
        }
      }
      case "minimal":
      case "unknown":
        return null;
      default: {
        const _exhaustive: never = permissionPath.value;
        void _exhaustive;
        return null;
      }
    }
  }
  return null;
}

function pathIsSameOrDescendant(candidate: string, parent: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  if (normalizedCandidate === normalizedParent) return true;
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathIsSameOrDescendant(left, right) ||
    pathIsSameOrDescendant(right, left);
}

function requestedEntryCoversGrant(
  requested: FileSystemSandboxEntry,
  granted: FileSystemSandboxEntry,
  cwd: string | undefined,
): boolean {
  if (!accessCovers(requested.access, granted.access)) return false;
  const requestedPath = resolvePermissionPath(requested.path, cwd);
  const grantedPath = resolvePermissionPath(granted.path, cwd);
  if (requestedPath === null && grantedPath === null) {
    return JSON.stringify(requested.path) === JSON.stringify(granted.path);
  }
  if (requestedPath === null || grantedPath === null) return false;
  return pathIsSameOrDescendant(grantedPath, requestedPath);
}

function normalizeForGlob(value: string): string {
  return path.normalize(value).replaceAll(path.sep, "/");
}

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|{}]/.test(char) ? `\\${char}` : char;
}

function globPatternToRegex(pattern: string): RegExp {
  const normalized = normalizeForGlob(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = normalized.indexOf("]", index + 1);
      if (end > index + 1) {
        source += normalized.slice(index, end + 1);
        index = end;
        continue;
      }
    }
    source += escapeRegexChar(char);
  }
  source += "$";
  return new RegExp(source);
}

function denyGlobMatchesPath(
  pattern: string,
  targetPath: string,
  cwd: string | undefined,
): boolean {
  const resolvedPattern = path.isAbsolute(pattern)
    ? path.normalize(pattern)
    : cwd === undefined
      ? null
      : path.resolve(cwd, pattern);
  if (resolvedPattern === null) return false;
  try {
    return globPatternToRegex(resolvedPattern).test(normalizeForGlob(targetPath));
  } catch {
    const prefix = resolveGlobStaticPrefix(pattern, cwd);
    return prefix === null || pathIsSameOrDescendant(targetPath, prefix);
  }
}

function denyGlobIsMalformed(
  pattern: string,
  cwd: string | undefined,
): boolean {
  const resolvedPattern = path.isAbsolute(pattern)
    ? path.normalize(pattern)
    : cwd === undefined
      ? pattern
      : path.resolve(cwd, pattern);
  try {
    globPatternToRegex(resolvedPattern);
    return false;
  } catch {
    return true;
  }
}

function denyEntryBlocksPath(
  denyEntry: FileSystemSandboxEntry,
  targetPath: string,
  cwd: string | undefined,
): boolean {
  if (denyEntry.access !== "none") return false;
  if (denyEntry.path.type === "glob_pattern") {
    return denyGlobMatchesPath(denyEntry.path.pattern, targetPath, cwd);
  }
  const denyPath = resolvePermissionPath(denyEntry.path, cwd);
  return denyPath !== null && pathIsSameOrDescendant(targetPath, denyPath);
}

function requestedDenyEntriesBlockGrant(
  requestedEntries: readonly FileSystemSandboxEntry[],
  grant: FileSystemSandboxEntry,
  cwd: string | undefined,
): boolean {
  const grantPath = resolvePermissionPath(grant.path, cwd);
  if (grantPath === null) return false;
  if (
    requestedEntries.some((entry) =>
      entry.access === "none" &&
      entry.path.type === "glob_pattern" &&
      denyGlobIsMalformed(entry.path.pattern, cwd),
    )
  ) {
    return true;
  }
  return requestedEntries.some((entry) =>
    denyEntryBlocksPath(entry, grantPath, cwd),
  );
}

function resolveGlobStaticPrefix(
  pattern: string,
  cwd: string | undefined,
): string | null {
  const resolvedPattern = path.isAbsolute(pattern)
    ? path.normalize(pattern)
    : cwd === undefined
      ? null
      : path.resolve(cwd, pattern);
  if (resolvedPattern === null) return null;
  const match = /[*?[\]]/.exec(resolvedPattern);
  if (match === null) return resolvedPattern;
  if (match.index === 0) return null;
  const prefix = resolvedPattern.slice(0, match.index);
  return prefix.endsWith(path.sep) ||
    prefix.endsWith("/") ||
    prefix.endsWith("\\")
    ? path.normalize(prefix)
    : path.dirname(prefix);
}

function denyEntryConstrainsAcceptedGrant(
  denyEntry: FileSystemSandboxEntry,
  acceptedEntries: readonly FileSystemSandboxEntry[],
  cwd: string | undefined,
): boolean {
  return acceptedEntries
    .filter((entry) => accessCanRead(entry.access))
    .some((entry) => {
      const grantPath = resolvePermissionPath(entry.path, cwd);
      if (grantPath === null) return false;
      if (denyEntry.path.type === "glob_pattern") {
        const prefix = resolveGlobStaticPrefix(denyEntry.path.pattern, cwd);
        return prefix !== null && pathsOverlap(prefix, grantPath);
      }
      const denyPath = resolvePermissionPath(denyEntry.path, cwd);
      return denyPath !== null && pathsOverlap(denyPath, grantPath);
    });
}

function materializeCwdEntry(
  entry: FileSystemSandboxEntry,
  cwd: string | undefined,
): FileSystemSandboxEntry {
  const resolved = resolvePermissionPath(entry.path, cwd);
  if (
    resolved !== null &&
    entry.path.type === "special" &&
    entry.path.value.kind === "project_roots"
  ) {
    return {
      path: { type: "path", path: resolved },
      access: entry.access,
    };
  }
  if (entry.path.type === "glob_pattern") {
    const resolved = resolveGlobStaticPrefix(entry.path.pattern, cwd);
    if (resolved !== null && path.isAbsolute(resolved)) {
      const pattern = path.isAbsolute(entry.path.pattern)
        ? entry.path.pattern
        : path.resolve(cwd ?? "", entry.path.pattern);
      return {
        path: { type: "glob_pattern", pattern },
        access: entry.access,
      };
    }
  }
  return entry;
}

function retainConstrainingDenyEntries(
  sourceEntries: readonly FileSystemSandboxEntry[],
  acceptedEntries: readonly FileSystemSandboxEntry[],
  cwd: string | undefined,
  outputEntries: FileSystemSandboxEntry[],
): FileSystemSandboxEntry[] {
  const retained: FileSystemSandboxEntry[] = [];
  for (const entry of sourceEntries) {
    if (entry.access !== "none") continue;
    if (!denyEntryConstrainsAcceptedGrant(entry, acceptedEntries, cwd)) continue;
    const materialized = materializeCwdEntry(entry, cwd);
    if (!outputEntries.some((existing) => entryKey(existing) === entryKey(materialized))) {
      outputEntries.push(materialized);
    }
    retained.push(materialized);
  }
  return retained;
}

type GlobDepth =
  | { readonly kind: "bounded"; readonly depth: number }
  | { readonly kind: "unbounded" };

function effectiveGlobScanDepth(
  entries: readonly FileSystemSandboxEntry[],
  depth: number | undefined,
): GlobDepth | null {
  const hasDenyGlob = entries.some((entry) =>
    entry.access === "none" && entry.path.type === "glob_pattern",
  );
  if (!hasDenyGlob) return null;
  return depth === undefined
    ? { kind: "unbounded" }
    : { kind: "bounded", depth };
}

function mergeGlobScanMaxDepth(
  leftEntries: readonly FileSystemSandboxEntry[],
  leftDepth: number | undefined,
  rightEntries: readonly FileSystemSandboxEntry[],
  rightDepth: number | undefined,
): number | undefined {
  const left = effectiveGlobScanDepth(leftEntries, leftDepth);
  const right = effectiveGlobScanDepth(rightEntries, rightDepth);
  if (left?.kind === "unbounded" || right?.kind === "unbounded") {
    return undefined;
  }
  if (left?.kind === "bounded" && right?.kind === "bounded") {
    return Math.max(left.depth, right.depth);
  }
  if (left?.kind === "bounded") return left.depth;
  if (right?.kind === "bounded") return right.depth;
  return undefined;
}

function intersectFileSystemPermissions(
  requested: FileSystemPermissions | undefined,
  granted: FileSystemPermissions | undefined,
  cwd: string | undefined,
): FileSystemPermissions | undefined {
  if (requested === undefined || granted === undefined) return undefined;
  const accepted: FileSystemSandboxEntry[] = [];
  for (const grant of granted.entries) {
    if (!accessCanRead(grant.access)) continue;
    if (requestedDenyEntriesBlockGrant(requested.entries, grant, cwd)) continue;
    const covered = requested.entries.some((request) =>
      requestedEntryCoversGrant(request, grant, cwd),
    );
    if (covered) accepted.push(materializeCwdEntry(grant, cwd));
  }
  const entries = dedupeEntries(accepted);
  const requestedRetainedDenyEntries = retainConstrainingDenyEntries(
    requested.entries,
    entries,
    cwd,
    entries,
  );
  const grantedRetainedDenyEntries = retainConstrainingDenyEntries(
    granted.entries,
    entries,
    cwd,
    entries,
  );
  if (entries.length === 0) return undefined;
  const globScanMaxDepth = mergeGlobScanMaxDepth(
    requestedRetainedDenyEntries,
    requested.globScanMaxDepth,
    grantedRetainedDenyEntries,
    granted.globScanMaxDepth,
  );
  return {
    entries,
    ...(globScanMaxDepth !== undefined ? { globScanMaxDepth } : {}),
  };
}

export interface RequestPermissionsRpcRequest {
  readonly callId: string;
  readonly turnId?: string;
  readonly args: unknown;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface PendingRequestPermissionsRpc {
  readonly event: RequestPermissionsEvent;
  readonly response: Promise<RequestPermissionsResponse | null>;
}

interface PendingRequest {
  readonly requested: RequestPermissionProfile;
  readonly cwd?: string;
  readonly resolve: (response: RequestPermissionsResponse | null) => void;
  cleanup(): void;
}

export class RequestPermissionsRpc {
  readonly #pending = new Map<string, PendingRequest>();

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(opts: RequestPermissionsRpcRequest): PendingRequestPermissionsRpc {
    if (opts.callId.trim().length === 0) {
      throw new Error("request_permissions RPC requires callId");
    }
    const args = normalizeRequestPermissionsArgs(opts.args, { cwd: opts.cwd });
    const event: RequestPermissionsEvent = {
      callId: opts.callId,
      turnId: opts.turnId ?? "",
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      permissions: args.permissions,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    this.cancel(opts.callId);
    if (opts.signal?.aborted === true) {
      return { event, response: Promise.resolve(null) };
    }
    let resolveResponse: (response: RequestPermissionsResponse | null) => void =
      () => {};
    const response = new Promise<RequestPermissionsResponse | null>((resolve) => {
      resolveResponse = resolve;
    });
    const abort = (): void => {
      this.cancel(opts.callId);
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    const pending: PendingRequest = {
      requested: args.permissions,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      resolve: resolveResponse,
      cleanup: () => {
        opts.signal?.removeEventListener("abort", abort);
      },
    };
    this.#pending.set(opts.callId, pending);
    return { event, response };
  }

  respond(callId: string, rawResponse: unknown): boolean {
    const pending = this.#pending.get(callId);
    if (pending === undefined) return false;
    this.#pending.delete(callId);
    pending.cleanup();
    pending.resolve(
      normalizeRequestPermissionsResponse(
        pending.requested,
        rawResponse,
        { ...(pending.cwd !== undefined ? { cwd: pending.cwd } : {}) },
      ),
    );
    return true;
  }

  cancel(callId: string): boolean {
    const pending = this.#pending.get(callId);
    if (pending === undefined) return false;
    this.#pending.delete(callId);
    pending.cleanup();
    pending.resolve(null);
    return true;
  }

  abortAll(): number {
    const callIds = [...this.#pending.keys()];
    for (const callId of callIds) {
      this.cancel(callId);
    }
    return callIds.length;
  }
}
