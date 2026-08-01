import { type BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { readBoundedRegularFile } from "./bounded-file-io.js";
import {
  assertContainedPath,
  assertDirectory,
  assertSameIdentity,
  createOwnedEntry,
  errnoCode,
  isPathOrDescendant,
  lstatOrNull,
  type OwnedRepositoryEntry,
  type OwnedRepositoryEntryKind,
  readBoundedDirectoryNames,
  replacePathPrefix,
} from "./bounded-repository-filesystem.js";
import { digestBytes, type MutableUsage } from "./bounded-repository-policy.js";
import type {
  CommittedRepositoryLedger,
  PortableSiblingExpectation,
  PortableSiblingSnapshot,
  TransactionTransientDirectory,
} from "./bounded-repository-transaction.js";
import {
  BoundedRepositoryError,
  type BoundedRepositoryLimits,
  type BoundedRepositoryUsage,
  repositoryExternalChange,
  repositoryQuotaError,
} from "./bounded-repository-types.js";
import {
  portablePathIdentity,
  type PortableRepositoryPathLimits,
} from "./portable-repository-path.js";

const GIT_DIRECTORY = ".git";
const PINNED_ROOT_METADATA_ENTRY_COUNT = 1;

export class BoundedRepositoryOwnership {
  readonly #root: string;
  readonly #limits: BoundedRepositoryLimits;
  readonly #pathLimits: PortableRepositoryPathLimits;
  readonly #isGitInitialized: () => boolean;
  readonly #assertRootIdentity: () => Promise<void>;
  readonly #poison: () => void;
  readonly #entries = new Map<string, OwnedRepositoryEntry>();
  readonly #usage: MutableUsage = {
    entries: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    totalBytes: 0,
  };

  constructor(options: {
    readonly root: string;
    readonly limits: BoundedRepositoryLimits;
    readonly pathLimits: PortableRepositoryPathLimits;
    readonly isGitInitialized: () => boolean;
    readonly assertRootIdentity: () => Promise<void>;
    readonly poison: () => void;
  }) {
    this.#root = options.root;
    this.#limits = options.limits;
    this.#pathLimits = options.pathLimits;
    this.#isGitInitialized = options.isGitInitialized;
    this.#assertRootIdentity = options.assertRootIdentity;
    this.#poison = options.poison;
  }

  usage(): BoundedRepositoryUsage {
    this.assertCounterInvariant();
    return Object.freeze({ ...this.#usage });
  }

  ownedEntryByIdentity(identity: string): OwnedRepositoryEntry | undefined {
    return this.#entries.get(identity);
  }

  ownedEntry(relativePath: string): OwnedRepositoryEntry | undefined {
    return this.#entries.get(
      portablePathIdentity(relativePath, this.#pathLimits),
    );
  }

  assertOwnedStatus(
    status: BigIntStats,
    relativePath: string,
    kind: OwnedRepositoryEntryKind,
  ): OwnedRepositoryEntry {
    const entry = this.ownedEntry(relativePath);
    if (
      entry === undefined ||
      entry.relativePath !== relativePath ||
      entry.kind !== kind ||
      (kind === "file" &&
        (entry.bytes !== Number(status.size) || entry.digest === null)) ||
      (kind !== "file" && entry.digest !== null)
    ) {
      throw repositoryExternalChange(relativePath);
    }
    assertSameIdentity(status, entry, relativePath);
    return entry;
  }

  async assertOwnedFileContent(
    absolutePath: string,
    entry: OwnedRepositoryEntry,
    label: string,
  ): Promise<void> {
    if (entry.kind !== "file" || entry.digest === null) {
      throw repositoryExternalChange(`${label} content identity`);
    }
    const bytes = await readBoundedRegularFile(absolutePath, {
      byteLimit: this.#limits.maxFileBytes,
      label: `owned repository file ${label}`,
    });
    this.assertOwnedStatus(
      await lstat(absolutePath, { bigint: true }),
      label,
      "file",
    );
    if (digestBytes(bytes) !== entry.digest) {
      throw repositoryExternalChange(`${label} content`);
    }
  }

  async assertOwnedDirectoryTree(
    relativeRoot: string,
    absoluteRoot: string,
  ): Promise<void> {
    const expected = new Map(
      [...this.#entries.entries()].filter(
        ([, entry]) =>
          entry.relativePath !== relativeRoot &&
          isPathOrDescendant(entry.relativePath, relativeRoot),
      ),
    );
    const queue = [{ relativePath: relativeRoot, absolutePath: absoluteRoot }];
    let index = 0;
    let entries = 0;
    while (index < queue.length) {
      const item = queue[index++]!;
      const directory = await opendir(item.absolutePath);
      let auditFailed = false;
      let auditError: unknown;
      try {
        for (;;) {
          const child = await directory.read();
          if (child === null) break;
          entries += 1;
          if (entries > this.#limits.maxEntries) {
            throw repositoryQuotaError(
              "repository directory audit exceeds maxEntries",
            );
          }
          const relativePath = `${item.relativePath}/${child.name}`;
          const absolutePath = join(item.absolutePath, child.name);
          const status = await lstat(absolutePath, { bigint: true });
          const kind = repositoryKind(status, relativePath);
          const owned = this.assertOwnedStatus(status, relativePath, kind);
          expected.delete(portablePathIdentity(relativePath, this.#pathLimits));
          if (kind === "file") {
            await this.assertOwnedFileContent(
              absolutePath,
              owned,
              relativePath,
            );
          }
          if (kind === "directory") queue.push({ relativePath, absolutePath });
        }
      } catch (error) {
        auditFailed = true;
        auditError = error;
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
      if (auditFailed && closeFailed) {
        throw new AggregateError(
          [auditError, closeError],
          `repository directory audit and close both failed for ${item.relativePath}`,
        );
      }
      if (auditFailed) throw auditError;
      if (closeFailed) throw closeError;
    }
    const missing = expected.values().next().value;
    if (missing !== undefined) {
      throw repositoryExternalChange(
        `${relativeRoot} is missing owned descendant ${missing.relativePath}`,
      );
    }
  }

  async assertSafeParents(path: string, requireOwned: boolean): Promise<void> {
    const parentRelative = relative(this.#root, dirname(path));
    if (parentRelative === "") return;
    let current = this.#root;
    const relativeSegments: string[] = [];
    for (const segment of parentRelative.split(/[\\/]+/u)) {
      current = join(current, segment);
      relativeSegments.push(segment);
      const relativePath = relativeSegments.join("/");
      const status = await lstat(current, { bigint: true });
      assertDirectory(status, relativePath);
      await this.assertPortableSiblingState(current, relativePath, "owned");
      if (requireOwned) {
        this.assertOwnedStatus(status, relativePath, "directory");
      }
    }
    assertContainedPath(
      await realpath(this.#root),
      await realpath(dirname(path)),
      "repository parent",
    );
  }

  async assertNoPortableSiblingCollision(
    absolutePath: string,
    relativePath: string,
  ): Promise<void> {
    const parent = dirname(absolutePath);
    const parentStatus = await lstatOrNull(parent);
    if (parentStatus === null) return;
    assertDirectory(parentStatus, `parent of ${relativePath}`);
    const candidateName = basename(absolutePath);
    const candidateIdentity = portablePathIdentity(
      relativePath,
      this.#pathLimits,
    );
    const parentRelative = portableRelativePath(this.#root, parent);
    const siblingNames = await this.#readUserSiblingNames(
      parent,
      `parent of ${relativePath}`,
      this.#limits.maxEntries,
    );
    for (const siblingName of siblingNames) {
      if (siblingName === candidateName) continue;
      const siblingPath = joinPortable(parentRelative, siblingName);
      const siblingIdentity = this.#portableSiblingIdentity(
        siblingPath,
        siblingName,
      );
      if (siblingIdentity === candidateIdentity) {
        throw repositoryExternalChange(
          `${relativePath} collides with existing sibling ${siblingName}`,
        );
      }
    }
  }

  async scanPortableSiblings(
    parentAbsolutePath: string,
    parentRelativePath: string,
    maximumEntries: number,
  ): Promise<PortableSiblingSnapshot> {
    const status = await lstatOrNull(parentAbsolutePath);
    if (status === null) {
      return Object.freeze({ entries: 0, identities: new Map() });
    }
    assertDirectory(status, `repository parent ${parentRelativePath}`);
    const names = await this.#readUserSiblingNames(
      parentAbsolutePath,
      `repository parent ${parentRelativePath}`,
      maximumEntries,
    );
    const identities = new Map<string, string>();
    for (const name of names) {
      const siblingPath = joinPortable(parentRelativePath, name);
      const identity = this.#portableSiblingIdentity(siblingPath, name);
      const existing = identities.get(identity);
      if (existing !== undefined) {
        throw repositoryExternalChange(
          `${siblingPath} duplicates portable sibling ${existing}`,
        );
      }
      identities.set(identity, name);
    }
    return Object.freeze({ entries: names.length, identities });
  }

  async assertRepositoryMutationParents(
    absolutePath: string,
    transientDirectories: readonly TransactionTransientDirectory[],
  ): Promise<void> {
    assertContainedPath(this.#root, absolutePath, "repository mutation path");
    await this.#assertRootIdentity();
    const parent = dirname(absolutePath);
    const parentRelative = portableRelativePath(this.#root, parent);
    if (parentRelative.length === 0) return;
    const transientByPath = new Map(
      transientDirectories.map((directory) => [
        directory.relativePath,
        directory,
      ]),
    );
    let current = this.#root;
    const segments: string[] = [];
    for (const segment of parentRelative.split("/")) {
      current = join(current, segment);
      segments.push(segment);
      const relativePath = segments.join("/");
      const status = await lstat(current, { bigint: true });
      assertDirectory(status, relativePath);
      await this.assertPortableSiblingState(current, relativePath, "owned");
      const transient = transientByPath.get(relativePath);
      if (transient === undefined) {
        this.assertOwnedStatus(status, relativePath, "directory");
      } else {
        if (transient.absolutePath !== current) {
          throw repositoryExternalChange(
            `${relativePath} transient parent path`,
          );
        }
        assertSameIdentity(status, transient, relativePath);
      }
    }
    assertContainedPath(
      await realpath(this.#root),
      await realpath(parent),
      "repository mutation parent",
    );
  }

  async assertPortableSiblingState(
    absolutePath: string,
    relativePath: string,
    expectation: PortableSiblingExpectation,
  ): Promise<void> {
    const parent = dirname(absolutePath);
    const snapshot = await this.scanPortableSiblings(
      parent,
      portableRelativePath(this.#root, parent),
      this.#limits.maxEntries,
    );
    const identity = portablePathIdentity(relativePath, this.#pathLimits);
    const sibling = snapshot.identities.get(identity);
    const candidate = basename(absolutePath);
    if (
      (expectation === "absent" && sibling !== undefined) ||
      (expectation === "owned" && sibling !== candidate)
    ) {
      throw repositoryExternalChange(
        `${relativePath} portable sibling state changed before mutation`,
      );
    }
  }

  applyCommittedTransaction(ledger: CommittedRepositoryLedger): void {
    for (const directory of ledger.directories) {
      this.#entries.set(
        portablePathIdentity(directory.relativePath, this.#pathLimits),
        createOwnedEntry(
          directory.relativePath,
          "directory",
          directory,
          0,
          null,
        ),
      );
    }
    for (const file of ledger.files) {
      this.#entries.set(
        file.write.identity,
        createOwnedEntry(
          file.write.relativePath,
          "file",
          file,
          file.write.bytes.byteLength,
          file.write.digest,
        ),
      );
    }
    Object.assign(this.#usage, ledger.usage);
    this.assertCounterInvariant();
  }

  recordSymlink(relativePath: string, status: BigIntStats): void {
    this.#entries.set(
      portablePathIdentity(relativePath, this.#pathLimits),
      createOwnedEntry(relativePath, "symlink", identity(status), 0, null),
    );
    this.#usage.entries += 1;
    this.#usage.symlinks += 1;
    this.assertCounterInvariant();
  }

  removeEntry(
    relativePath: string,
    kind: OwnedRepositoryEntryKind,
    entry: OwnedRepositoryEntry,
  ): void {
    this.#entries.delete(portablePathIdentity(relativePath, this.#pathLimits));
    this.#usage.entries -= 1;
    if (kind === "directory") this.#usage.directories -= 1;
    else if (kind === "symlink") this.#usage.symlinks -= 1;
    else {
      this.#usage.files -= 1;
      this.#usage.totalBytes -= entry.bytes;
    }
    this.assertCounterInvariant();
  }

  assertRenameCollisions(from: string, to: string): void {
    const moving = [...this.#entries.entries()].filter(([, entry]) =>
      isPathOrDescendant(entry.relativePath, from),
    );
    const movingKeys = new Set(moving.map(([key]) => key));
    for (const [, entry] of moving) {
      const destination = replacePathPrefix(entry.relativePath, from, to);
      const destinationKey = portablePathIdentity(
        destination,
        this.#pathLimits,
      );
      if (
        this.#entries.has(destinationKey) &&
        !movingKeys.has(destinationKey)
      ) {
        throw new BoundedRepositoryError(
          "invalid_input",
          `repository rename collides at ${destination}`,
        );
      }
    }
  }

  moveEntries(from: string, to: string): void {
    const moving = [...this.#entries.entries()].filter(([, entry]) =>
      isPathOrDescendant(entry.relativePath, from),
    );
    for (const [key] of moving) this.#entries.delete(key);
    for (const [, entry] of moving) {
      const relativePath = replacePathPrefix(entry.relativePath, from, to);
      this.#entries.set(
        portablePathIdentity(relativePath, this.#pathLimits),
        Object.freeze({ ...entry, relativePath }),
      );
    }
  }

  assertCounterInvariant(): void {
    if (
      this.#usage.entries !==
        this.#usage.files + this.#usage.directories + this.#usage.symlinks ||
      this.#entries.size !== this.#usage.entries ||
      this.#usage.entries < 0 ||
      this.#usage.totalBytes < 0 ||
      this.#usage.entries > this.#limits.maxEntries ||
      this.#usage.totalBytes > this.#limits.maxTotalBytes
    ) {
      this.#poison();
      throw new BoundedRepositoryError(
        "poisoned",
        "bounded repository accounting invariant failed",
      );
    }
  }

  #isIgnoredGitSibling(parent: string, name: string): boolean {
    return (
      parent === this.#root &&
      this.#isGitInitialized() &&
      name === GIT_DIRECTORY
    );
  }

  async #readUserSiblingNames(
    parent: string,
    label: string,
    maximumUserEntries: number,
  ): Promise<readonly string[]> {
    const internalAllowance =
      parent === this.#root && this.#isGitInitialized()
        ? PINNED_ROOT_METADATA_ENTRY_COUNT
        : 0;
    const names = await readBoundedDirectoryNames(
      parent,
      maximumUserEntries + internalAllowance,
      label,
    );
    const userNames = names.filter(
      (name) => !this.#isIgnoredGitSibling(parent, name),
    );
    if (userNames.length > maximumUserEntries) {
      throw repositoryExternalChange(`${label} contains too many user entries`);
    }
    return Object.freeze(userNames);
  }

  #portableSiblingIdentity(siblingPath: string, name: string): string {
    try {
      return portablePathIdentity(siblingPath, this.#pathLimits);
    } catch (error) {
      throw new BoundedRepositoryError(
        "external_change",
        `bounded repository parent contains non-portable entry ${JSON.stringify(name)}`,
        { cause: error },
      );
    }
  }
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0)
    .join("/");
}

function joinPortable(parent: string, child: string): string {
  return parent.length === 0 ? child : `${parent}/${child}`;
}

function repositoryKind(
  status: BigIntStats,
  label: string,
): OwnedRepositoryEntryKind {
  if (status.isSymbolicLink()) return "symlink";
  if (status.isDirectory()) return "directory";
  if (status.isFile() && status.nlink === 1n) return "file";
  throw repositoryExternalChange(`${label} has an unsupported type`);
}

function identity(status: BigIntStats): {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly ownerUser: bigint;
  readonly ownerGroup: bigint;
} {
  return Object.freeze({
    device: status.dev,
    inode: status.ino,
    mode: status.mode,
    ownerUser: status.uid,
    ownerGroup: status.gid,
  });
}
