import { type BigIntStats } from "node:fs";
import { lstat, opendir, rm } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { repositoryExternalChange } from "./bounded-repository-types.js";

export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly ownerUser: bigint;
  readonly ownerGroup: bigint;
}

export type OwnedRepositoryEntryKind = "directory" | "file" | "symlink";

export interface OwnedRepositoryEntry extends FileIdentity {
  readonly relativePath: string;
  readonly kind: OwnedRepositoryEntryKind;
  readonly bytes: number;
  readonly digest: string | null;
}

export type RemovalResult =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown };

export function identityFromStatus(status: BigIntStats): FileIdentity {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
    ownerUser: status.uid,
    ownerGroup: status.gid,
  });
}

export function createOwnedEntry(
  relativePath: string,
  kind: OwnedRepositoryEntryKind,
  identity: FileIdentity,
  bytes: number,
  digest: string | null,
): OwnedRepositoryEntry {
  return Object.freeze({ relativePath, kind, ...identity, bytes, digest });
}

export function assertSameIdentity(
  status: BigIntStats,
  expected: FileIdentity,
  label: string,
): void {
  if (
    status.dev !== expected.device ||
    status.ino !== expected.inode ||
    status.mode !== expected.mode ||
    status.uid !== expected.ownerUser ||
    status.gid !== expected.ownerGroup
  ) {
    throw repositoryExternalChange(label);
  }
}

export function assertDirectory(status: BigIntStats, label: string): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw repositoryExternalChange(`${label} is not a directory`);
  }
}

export function assertSinglyLinkedRegularFile(
  status: BigIntStats,
  label: string,
): void {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1n) {
    throw repositoryExternalChange(
      `${label} is not a singly linked regular file`,
    );
  }
}

export function assertStagedRegularFileLink(
  status: BigIntStats,
  label: string,
): void {
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 2n) {
    throw repositoryExternalChange(
      `${label} was not installed from one staged link`,
    );
  }
}

export function repositoryEntryKind(
  status: BigIntStats,
  label: string,
): OwnedRepositoryEntryKind {
  if (status.isSymbolicLink()) return "symlink";
  if (status.isDirectory()) return "directory";
  if (status.isFile() && status.nlink === 1n) return "file";
  throw repositoryExternalChange(`${label} has an unsupported type`);
}

export async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function removePath(path: string): Promise<RemovalResult> {
  try {
    await rm(path, { recursive: true, force: false });
    return Object.freeze({ failed: false });
  } catch (error) {
    return Object.freeze({ failed: true, error });
  }
}

export async function readBoundedDirectoryNames(
  path: string,
  maximumEntries: number,
  label: string,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    throw new TypeError(
      "bounded directory entry limit must be a non-negative safe integer",
    );
  }
  const directory = await opendir(path);
  const names: string[] = [];
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) break;
      if (names.length >= maximumEntries) {
        throw repositoryExternalChange(`${label} contains too many entries`);
      }
      names.push(entry.name);
    }
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let closeFailed = false;
  let closeError: unknown;
  try {
    await directory.close();
  } catch (error) {
    if (errnoCode(error) !== "ERR_DIR_CLOSED") {
      closeFailed = true;
      closeError = error;
    }
  }
  if (primaryFailed && closeFailed) {
    throw new AggregateError(
      [primaryError, closeError],
      `${label} audit and directory close both failed`,
    );
  }
  if (primaryFailed) throw primaryError;
  if (closeFailed) throw closeError;
  return Object.freeze(names);
}

export function isUnsupportedSymlinkError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

export function errnoCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

export function isPathOrDescendant(
  candidate: string,
  ancestor: string,
): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export function replacePathPrefix(
  candidate: string,
  from: string,
  to: string,
): string {
  return candidate === from ? to : `${to}${candidate.slice(from.length)}`;
}

export function assertContainedPath(
  root: string,
  candidate: string,
  label: string,
): void {
  const displacement = relative(root, candidate);
  if (
    displacement === ".." ||
    displacement.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(displacement)
  ) {
    throw repositoryExternalChange(`${label} escapes the bounded repository`);
  }
}
