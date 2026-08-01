import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

import {
  MAX_CONFIGURED_GIT_WALL_MS,
  snapshotPlainDataRecord,
} from "./bounded-repository-policy.js";
import { isWellFormedUnicode } from "./portable-repository-path.js";

const DEFAULT_WINDOWS_PATHEXT = ".EXE;.COM";
const GIT_EXECUTABLE_BASENAME = "git";
const MINIMUM_POSITIVE_LIMIT = 1;
const MINIMUM_REMAINING_WALL_MS = 1;
export const MAX_GIT_PATH_BYTES = 1_048_576;
const MAX_GIT_PATH_ENTRIES = 4_096;
const MAX_GIT_PATH_ENTRY_BYTES = 32_768;
const MAX_GIT_PATHEXT_BYTES = 1_024;
const MAX_GIT_PATHEXT_ENTRIES = 32;
const MAX_GIT_PATHEXT_EXTENSION_BYTES = 16;
const MAX_GIT_DISCOVERY_CANDIDATES = 4_096;
export const MAX_GIT_CANDIDATE_PATH_BYTES = 32_768;
const MAX_GIT_EXECUTABLE_BYTES = 134_217_728;
const PATHEXT_EXTENSION = /^\.[A-Za-z0-9]+$/u;
const stringToLowerCase = String.prototype.toLowerCase;
const RESOLVE_GIT_OPTION_KEYS = Object.freeze([
  "pathValue",
  "pathExtValue",
  "wallMs",
] as const);

export type BoundedGitDiscoveryFailureKind = "deadline" | "discovery";

export interface ResolveGitExecutableOptions {
  readonly pathValue?: string;
  readonly pathExtValue?: string;
  readonly wallMs: number;
}

interface FrozenResolveGitExecutableOptions {
  readonly pathValue: string | undefined;
  readonly pathExtValue: string | undefined;
  readonly wallMs: number;
}

export interface GitWallDeadline {
  readonly expiresAt: number;
}

export interface ResolvedGitExecutable {
  readonly program: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
  readonly ownerUser: bigint;
  readonly ownerGroup: bigint;
}

export class BoundedGitDiscoveryError extends Error {
  readonly kind: BoundedGitDiscoveryFailureKind;

  constructor(
    kind: BoundedGitDiscoveryFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoundedGitDiscoveryError";
    this.kind = kind;
  }
}

class GitDeadlineExceeded extends Error {
  constructor() {
    super("bounded Git wall deadline expired");
    this.name = "GitDeadlineExceeded";
  }
}

/** Resolve Git within a standalone bounded discovery wall budget. */
export async function resolveBoundedGitExecutable(
  options: ResolveGitExecutableOptions,
): Promise<string> {
  const copiedOptions = snapshotResolveGitExecutableOptions(options);
  validatePositiveLimit(
    copiedOptions.wallMs,
    MAX_CONFIGURED_GIT_WALL_MS,
    "Git discovery wall limit",
  );
  const executable = await resolveGitExecutableBeforeDeadline(
    copiedOptions.pathValue,
    copiedOptions.pathExtValue,
    createGitWallDeadline(copiedOptions.wallMs),
  );
  return executable.program;
}

/** Resolve and identity-pin Git without starting a second wall budget. */
export async function resolveGitExecutableBeforeDeadline(
  pathValue: string | undefined,
  pathExtValue: string | undefined,
  deadline: GitWallDeadline,
): Promise<ResolvedGitExecutable> {
  remainingGitWallMs(deadline);
  const directories = snapshotPathDirectories(pathValue);
  const extensions =
    process.platform === "win32"
      ? validateGitPathExtensions(pathExtValue ?? DEFAULT_WINDOWS_PATHEXT)
      : Object.freeze([""]);
  if (
    directories.length >
    Math.floor(MAX_GIT_DISCOVERY_CANDIDATES / extensions.length)
  ) {
    throw discoveryFailure(
      "Git executable discovery has too many total candidates",
    );
  }
  // Charge synchronous PATH/PATHEXT parsing to the command deadline before
  // beginning the first filesystem probe.
  remainingGitWallMs(deadline);

  let candidates = 0;
  for (const directory of directories) {
    const canonicalDirectory = await canonicalExecutableDirectory(
      directory,
      deadline,
    );
    if (canonicalDirectory === null) continue;
    for (const extension of extensions) {
      candidates += 1;
      if (candidates > MAX_GIT_DISCOVERY_CANDIDATES) {
        throw discoveryFailure(
          "Git executable discovery exceeded its candidate limit",
        );
      }
      const executable = await probeExecutableCandidate(
        canonicalDirectory,
        extension,
        deadline,
      );
      if (executable !== null) return executable;
    }
  }
  throw discoveryFailure("Git executable was not found on PATH");
}

/** Revalidate the exact cached executable before another spawn. */
export async function assertGitExecutableIdentity(
  executable: ResolvedGitExecutable,
  deadline: GitWallDeadline,
): Promise<void> {
  try {
    const status = await beforeDeadline(deadline, () =>
      lstat(executable.program, { bigint: true }),
    );
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.dev !== executable.device ||
      status.ino !== executable.inode ||
      status.nlink !== executable.links ||
      status.mode !== executable.mode ||
      status.size !== executable.size ||
      status.mtimeNs !== executable.modifiedNs ||
      status.ctimeNs !== executable.changedNs ||
      status.uid !== executable.ownerUser ||
      status.gid !== executable.ownerGroup
    ) {
      throw discoveryFailure("cached Git executable identity changed");
    }
    await beforeDeadline(deadline, () =>
      access(executable.program, fsConstants.X_OK),
    );
  } catch (error) {
    if (error instanceof GitDeadlineExceeded) throw deadlineFailure();
    if (error instanceof BoundedGitDiscoveryError) throw error;
    throw new BoundedGitDiscoveryError(
      "discovery",
      "cached Git executable is no longer available",
      { cause: error },
    );
  }
}

/** Validate and normalize Windows PATHEXT without filesystem access. */
export function validateGitPathExtensions(value: string): readonly string[] {
  if (
    typeof value !== "string" ||
    value.length > MAX_GIT_PATHEXT_BYTES ||
    !isWellFormedUnicode(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_PATHEXT_BYTES
  ) {
    throw discoveryFailure("PATHEXT is malformed or exceeds its byte limit");
  }
  const rawExtensions = value.split(";");
  if (
    rawExtensions.length === 0 ||
    rawExtensions.length > MAX_GIT_PATHEXT_ENTRIES
  ) {
    throw discoveryFailure("PATHEXT has too many entries");
  }

  const extensions: string[] = [];
  const seen = new Set<string>();
  for (const extension of rawExtensions) {
    if (
      extension.length === 0 ||
      extension.length > MAX_GIT_PATHEXT_EXTENSION_BYTES ||
      Buffer.byteLength(extension, "utf8") > MAX_GIT_PATHEXT_EXTENSION_BYTES ||
      !PATHEXT_EXTENSION.test(extension)
    ) {
      throw discoveryFailure(
        "PATHEXT entries must be a dot followed by bounded ASCII letters or digits",
      );
    }
    const normalized = Reflect.apply(
      stringToLowerCase,
      extension,
      [],
    ) as string;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      extensions.push(normalized);
    }
  }
  return Object.freeze(extensions);
}

export function createGitWallDeadline(maxWallMs: number): GitWallDeadline {
  return Object.freeze({ expiresAt: performance.now() + maxWallMs });
}

export function remainingGitWallMs(deadline: GitWallDeadline): number {
  const remaining = Math.floor(deadline.expiresAt - performance.now());
  if (remaining < MINIMUM_REMAINING_WALL_MS) throw deadlineFailure();
  return remaining;
}

export function validateBoundedAbsoluteGitPath(
  value: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_GIT_CANDIDATE_PATH_BYTES ||
    !isWellFormedUnicode(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_CANDIDATE_PATH_BYTES ||
    !isAbsolute(value)
  ) {
    throw discoveryFailure(`${label} is not a bounded absolute path`);
  }
  return value;
}

export function isContainedGitPath(root: string, candidate: string): boolean {
  const displacement = relative(root, candidate);
  return (
    displacement.length > 0 &&
    displacement !== ".." &&
    !displacement.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
    !isAbsolute(displacement)
  );
}

function snapshotPathDirectories(
  pathValue: string | undefined,
): readonly string[] {
  if (
    pathValue === undefined ||
    typeof pathValue !== "string" ||
    pathValue.length === 0 ||
    pathValue.length > MAX_GIT_PATH_BYTES ||
    !isWellFormedUnicode(pathValue) ||
    pathValue.includes("\0") ||
    Buffer.byteLength(pathValue, "utf8") > MAX_GIT_PATH_BYTES
  ) {
    throw discoveryFailure("Git PATH is missing, malformed, or unbounded");
  }
  const rawDirectories = pathValue.split(delimiter);
  if (rawDirectories.length > MAX_GIT_PATH_ENTRIES) {
    throw discoveryFailure("Git PATH has too many entries");
  }

  const directories: string[] = [];
  const seen = new Set<string>();
  for (const directory of rawDirectories) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    if (
      directory.length > MAX_GIT_PATH_ENTRY_BYTES ||
      Buffer.byteLength(directory, "utf8") > MAX_GIT_PATH_ENTRY_BYTES
    ) {
      throw discoveryFailure("Git PATH entry exceeds its byte limit");
    }
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }
  return Object.freeze(directories);
}

function snapshotResolveGitExecutableOptions(
  input: ResolveGitExecutableOptions,
): FrozenResolveGitExecutableOptions {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = snapshotPlainDataRecord(
      input,
      "Git discovery options",
      RESOLVE_GIT_OPTION_KEYS.length,
    );
  } catch (error) {
    throw new BoundedGitDiscoveryError(
      "discovery",
      "Git discovery options must be a plain own-data-property record",
      { cause: error },
    );
  }
  const keys = Object.keys(record);
  if (
    !Object.hasOwn(record, "wallMs") ||
    keys.some(
      (key) => !(RESOLVE_GIT_OPTION_KEYS as readonly string[]).includes(key),
    ) ||
    (record.pathValue !== undefined && typeof record.pathValue !== "string") ||
    (record.pathExtValue !== undefined &&
      typeof record.pathExtValue !== "string")
  ) {
    throw discoveryFailure(
      "Git discovery options contain missing, unknown, or invalid properties",
    );
  }
  return Object.freeze({
    pathValue: record.pathValue as string | undefined,
    pathExtValue: record.pathExtValue as string | undefined,
    wallMs: record.wallMs as number,
  });
}

async function canonicalExecutableDirectory(
  directory: string,
  deadline: GitWallDeadline,
): Promise<string | null> {
  try {
    const canonical = await beforeDeadline(deadline, () => realpath(directory));
    const status = await beforeDeadline(deadline, () =>
      lstat(canonical, { bigint: true }),
    );
    if (
      !isAbsolute(canonical) ||
      canonical.length > MAX_GIT_CANDIDATE_PATH_BYTES ||
      Buffer.byteLength(canonical, "utf8") > MAX_GIT_CANDIDATE_PATH_BYTES ||
      status.isSymbolicLink() ||
      !status.isDirectory()
    ) {
      return null;
    }
    return canonical;
  } catch (error) {
    if (error instanceof GitDeadlineExceeded) throw deadlineFailure();
    if (error instanceof BoundedGitDiscoveryError) throw error;
    return null;
  }
}

async function probeExecutableCandidate(
  canonicalDirectory: string,
  extension: string,
  deadline: GitWallDeadline,
): Promise<ResolvedGitExecutable | null> {
  const candidate = join(
    canonicalDirectory,
    `${GIT_EXECUTABLE_BASENAME}${extension}`,
  );
  if (
    !isContainedGitPath(canonicalDirectory, candidate) ||
    candidate.length > MAX_GIT_CANDIDATE_PATH_BYTES ||
    Buffer.byteLength(candidate, "utf8") > MAX_GIT_CANDIDATE_PATH_BYTES
  ) {
    return null;
  }
  try {
    const canonicalCandidate = await beforeDeadline(deadline, () =>
      realpath(candidate),
    );
    if (!isContainedGitPath(canonicalDirectory, canonicalCandidate))
      return null;
    const status = await beforeDeadline(deadline, () =>
      lstat(canonicalCandidate, { bigint: true }),
    );
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      status.size < 1n ||
      status.size > BigInt(MAX_GIT_EXECUTABLE_BYTES)
    ) {
      return null;
    }
    await beforeDeadline(deadline, () =>
      access(canonicalCandidate, fsConstants.X_OK),
    );
    return Object.freeze({
      program: canonicalCandidate,
      ...identityFromStatus(status),
    });
  } catch (error) {
    if (error instanceof GitDeadlineExceeded) throw deadlineFailure();
    if (error instanceof BoundedGitDiscoveryError) throw error;
    return null;
  }
}

async function beforeDeadline<T>(
  deadline: GitWallDeadline,
  operation: () => Promise<T>,
): Promise<T> {
  const remaining = remainingGitWallMs(deadline);
  const pending = operation();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GitDeadlineExceeded()), remaining);
    timer.unref();
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validatePositiveLimit(
  value: number,
  maximum: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_POSITIVE_LIMIT ||
    value > maximum
  ) {
    throw discoveryFailure(`${label} is invalid`);
  }
}

function identityFromStatus(status: BigIntStats): Readonly<{
  device: bigint;
  inode: bigint;
  links: bigint;
  mode: bigint;
  size: bigint;
  modifiedNs: bigint;
  changedNs: bigint;
  ownerUser: bigint;
  ownerGroup: bigint;
}> {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    mode: status.mode,
    size: status.size,
    modifiedNs: status.mtimeNs,
    changedNs: status.ctimeNs,
    ownerUser: status.uid,
    ownerGroup: status.gid,
  });
}

function deadlineFailure(): BoundedGitDiscoveryError {
  return new BoundedGitDiscoveryError(
    "deadline",
    "Git executable discovery exceeded the command wall deadline",
  );
}

function discoveryFailure(message: string): BoundedGitDiscoveryError {
  return new BoundedGitDiscoveryError("discovery", message);
}
