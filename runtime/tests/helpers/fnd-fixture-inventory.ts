import { type BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { FndFixtureManifest } from "./fnd-fixture-manifest.js";
import {
  FND_FIXTURE_EXPECTED_CONTROL_FILES,
  FND_FIXTURE_MANIFEST_FILE,
  MAX_FND_FIXTURE_BYTES,
  MAX_FND_FIXTURE_CONTROL_FILE_BYTES,
  MAX_FND_FIXTURE_INVENTORY_BYTES,
  MAX_FND_FIXTURE_INVENTORY_DIRECTORIES,
  MAX_FND_FIXTURE_INVENTORY_ENTRIES,
  MAX_FND_FIXTURE_MANIFEST_BYTES,
} from "./fnd-fixture-policy.js";
import {
  portablePathIdentity,
  validatePortableRepositoryPath,
} from "./portable-repository-path.js";

export interface FndFixtureRootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly ownerUser: bigint;
  readonly ownerGroup: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
  readonly realPath: string;
}

export interface FndFixtureInventoryEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modifiedNs: bigint;
  readonly changedNs: bigint;
}

export async function inspectFndFixtureRoot(
  root: string,
): Promise<FndFixtureRootIdentity> {
  const status = await lstat(root, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("FND fixture root is not a regular directory");
  }
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    mode: status.mode,
    ownerUser: status.uid,
    ownerGroup: status.gid,
    size: status.size,
    modifiedNs: status.mtimeNs,
    changedNs: status.ctimeNs,
    realPath: await realpath(root),
  });
}

export async function assertFndFixtureRootUnchanged(
  root: string,
  expected: FndFixtureRootIdentity,
): Promise<void> {
  const status = await lstat(root, { bigint: true });
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.dev !== expected.device ||
    status.ino !== expected.inode ||
    status.nlink !== expected.links ||
    status.mode !== expected.mode ||
    status.uid !== expected.ownerUser ||
    status.gid !== expected.ownerGroup ||
    status.size !== expected.size ||
    status.mtimeNs !== expected.modifiedNs ||
    status.ctimeNs !== expected.changedNs ||
    (await realpath(root)) !== expected.realPath
  ) {
    throw new Error("FND fixture root changed while it was opened");
  }
}

export async function inventoryFndFixtureRoot(
  root: string,
): Promise<ReadonlyMap<string, FndFixtureInventoryEntry>> {
  const inventory = new Map<string, FndFixtureInventoryEntry>();
  const identities = new Set<string>();
  const queue: Array<{
    readonly absolutePath: string;
    readonly relativePath: string;
  }> = [{ absolutePath: root, relativePath: "" }];
  let queueIndex = 0;
  let entryCount = 0;
  let totalBytes = 0;

  while (queueIndex < queue.length) {
    const item = queue[queueIndex++]!;
    const directory = await opendir(item.absolutePath);
    let childCount = 0;
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      for (;;) {
        const child = await directory.read();
        if (child === null) break;
        childCount += 1;
        entryCount += 1;
        if (entryCount > MAX_FND_FIXTURE_INVENTORY_ENTRIES) {
          throw new Error("FND fixture inventory exceeds its entry limit");
        }
        const relativePath =
          item.relativePath === ""
            ? child.name
            : `${item.relativePath}/${child.name}`;
        validatePortableRepositoryPath(relativePath);
        const identity = portablePathIdentity(relativePath);
        if (identities.has(identity)) {
          throw new Error(
            `FND fixture inventory has a portable collision: ${relativePath}`,
          );
        }
        identities.add(identity);
        const absolutePath = join(item.absolutePath, child.name);
        const status = await lstat(absolutePath, { bigint: true });
        if (status.isSymbolicLink()) {
          throw new Error(
            `FND fixture inventory contains a symlink: ${relativePath}`,
          );
        }
        if (status.isDirectory()) {
          if (queue.length >= MAX_FND_FIXTURE_INVENTORY_DIRECTORIES) {
            throw new Error(
              "FND fixture inventory exceeds its directory limit",
            );
          }
          inventory.set(
            relativePath,
            inventoryEntry(relativePath, "directory", status),
          );
          queue.push({ absolutePath, relativePath });
          continue;
        }
        if (!status.isFile()) {
          throw new Error(
            `FND fixture inventory contains a special file: ${relativePath}`,
          );
        }
        if (status.nlink !== 1n) {
          throw new Error(
            `FND fixture inventory file must be singly linked: ${relativePath}`,
          );
        }
        const maximum = inventoryFileLimit(relativePath);
        if (status.size < 0n || status.size > BigInt(maximum)) {
          throw new Error(
            `FND fixture inventory file exceeds its limit: ${relativePath}`,
          );
        }
        const size = Number(status.size);
        if (totalBytes > MAX_FND_FIXTURE_INVENTORY_BYTES - size) {
          throw new Error(
            "FND fixture inventory exceeds its aggregate byte limit",
          );
        }
        totalBytes += size;
        inventory.set(
          relativePath,
          inventoryEntry(relativePath, "file", status),
        );
      }
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }
    const closeResult = await closeDirectory(directory);
    if (primaryFailed && closeResult.failed) {
      throw new AggregateError(
        [primaryError, closeResult.error],
        "FND fixture directory read and close both failed",
      );
    }
    if (primaryFailed) throw primaryError;
    if (closeResult.failed) throw closeResult.error;
    if (item.relativePath !== "" && childCount === 0) {
      throw new Error(
        `FND fixture inventory contains an empty directory: ${item.relativePath}`,
      );
    }
  }
  return inventory;
}

export function assertFndInventoryMatchesManifest(
  inventory: ReadonlyMap<string, FndFixtureInventoryEntry>,
  manifest: FndFixtureManifest,
): void {
  for (const control of FND_FIXTURE_EXPECTED_CONTROL_FILES) {
    if (inventory.get(control)?.kind !== "file") {
      throw new Error(`FND fixture control file is missing: ${control}`);
    }
  }
  const actualPayloads = [...inventory.values()]
    .filter(
      (entry) =>
        entry.kind === "file" &&
        !FND_FIXTURE_EXPECTED_CONTROL_FILES.includes(entry.path),
    )
    .map((entry) => entry.path)
    .sort(compareCodePoints);
  const expectedPayloads = manifest.fixtures
    .map((entry) => entry.path)
    .slice()
    .sort(compareCodePoints);
  if (!equalStrings(actualPayloads, expectedPayloads)) {
    throw new Error("FND fixture payload set does not match its manifest");
  }
}

export function assertEqualFndFixtureInventories(
  before: ReadonlyMap<string, FndFixtureInventoryEntry>,
  after: ReadonlyMap<string, FndFixtureInventoryEntry>,
): void {
  if (before.size !== after.size) {
    throw new Error(
      "FND fixture inventory changed while the catalog was opened",
    );
  }
  for (const [path, expected] of before) {
    const actual = after.get(path);
    if (
      actual === undefined ||
      expected.kind !== actual.kind ||
      expected.device !== actual.device ||
      expected.inode !== actual.inode ||
      expected.links !== actual.links ||
      expected.mode !== actual.mode ||
      expected.size !== actual.size ||
      expected.modifiedNs !== actual.modifiedNs ||
      expected.changedNs !== actual.changedNs
    ) {
      throw new Error(`FND fixture inventory changed at ${path}`);
    }
  }
}

export async function resolveFndFixturePath(
  root: string,
  rootRealPath: string,
  manifestPath: string,
): Promise<string> {
  const segments = validatePortableRepositoryPath(manifestPath);
  const candidate = resolve(root, ...segments);
  assertContained(root, candidate, manifestPath);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const status = await lstat(current, { bigint: true });
    if (status.isSymbolicLink()) {
      throw new Error(`FND fixture path traverses a symlink: ${manifestPath}`);
    }
  }
  assertContained(rootRealPath, await realpath(candidate), manifestPath);
  return candidate;
}

function inventoryEntry(
  path: string,
  kind: FndFixtureInventoryEntry["kind"],
  status: BigIntStats,
): FndFixtureInventoryEntry {
  return Object.freeze({
    path,
    kind,
    device: status.dev,
    inode: status.ino,
    links: status.nlink,
    mode: status.mode,
    size: status.size,
    modifiedNs: status.mtimeNs,
    changedNs: status.ctimeNs,
  });
}

function inventoryFileLimit(relativePath: string): number {
  if (!FND_FIXTURE_EXPECTED_CONTROL_FILES.includes(relativePath)) {
    return MAX_FND_FIXTURE_BYTES;
  }
  return relativePath === FND_FIXTURE_MANIFEST_FILE
    ? MAX_FND_FIXTURE_MANIFEST_BYTES
    : MAX_FND_FIXTURE_CONTROL_FILE_BYTES;
}

async function closeDirectory(
  directory: Awaited<ReturnType<typeof opendir>>,
): Promise<
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown }
> {
  try {
    await directory.close();
    return { failed: false };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ERR_DIR_CLOSED"
      ? { failed: false }
      : { failed: true, error };
  }
}

function assertContained(base: string, candidate: string, label: string): void {
  const displacement = relative(base, candidate);
  if (
    displacement === ".." ||
    displacement.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(displacement)
  ) {
    throw new Error(`FND fixture path escapes its root: ${label}`);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
