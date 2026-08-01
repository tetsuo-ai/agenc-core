import { type BigIntStats } from "node:fs";
import { lstat, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { readBoundedRegularFile } from "./bounded-file-io.js";
import {
  assertContainedPath,
  isPathOrDescendant,
  isUnsupportedSymlinkError,
  lstatOrNull,
  repositoryEntryKind,
} from "./bounded-repository-filesystem.js";
import {
  type BoundedRepositoryAllocation,
  BoundedRepositoryLifecycle,
  createBoundedRepositoryAllocation,
} from "./bounded-repository-lifecycle.js";
import {
  BoundedRepositoryGitMetadata,
  BoundedRepositoryMetadata,
  type PreparedOwnedGitPath,
} from "./bounded-repository-metadata.js";
import { BoundedRepositoryOwnership } from "./bounded-repository-ownership.js";
import {
  digestBytes,
  MAX_GIT_MESSAGE_BYTES,
  type PreparedPath,
  projectPathLimits,
  snapshotBoundedString,
  snapshotGitPaths,
  snapshotLimits,
  snapshotPath,
  snapshotRepositoryTestHooks,
  snapshotWrites,
} from "./bounded-repository-policy.js";
import { BoundedRepositoryTransaction } from "./bounded-repository-transaction.js";
import {
  BoundedRepositoryError,
  type BoundedRepositoryByteWrite,
  type BoundedRepositoryLimits,
  type BoundedRepositoryTestHooks,
  type BoundedRepositoryUsage,
  type BoundedTempRepository,
  invalidRepositoryInput,
  repositoryExternalChange,
  repositoryQuotaError,
} from "./bounded-repository-types.js";
import {
  isWellFormedUnicode,
  type PortableRepositoryPathLimits,
  validatePortableRepositoryPath,
} from "./portable-repository-path.js";

export {
  BoundedRepositoryError,
  type BoundedRepositoryByteWrite,
  type BoundedRepositoryLimits,
  type BoundedRepositoryTestHooks,
  type BoundedRepositoryUsage,
  type BoundedTempRepository,
} from "./bounded-repository-types.js";

export { isWellFormedUnicode, validatePortableRepositoryPath };

type RepositoryState = "active" | "cleaned" | "poisoned" | "quarantined";

class BoundedTempRepositoryImplementation implements BoundedTempRepository {
  readonly root: string;
  readonly limits: BoundedRepositoryLimits;

  readonly #lifecycle: BoundedRepositoryLifecycle;
  readonly #gitMetadata: BoundedRepositoryGitMetadata;
  readonly #ownership: BoundedRepositoryOwnership;
  readonly #pathLimits: PortableRepositoryPathLimits;
  readonly #hooks: BoundedRepositoryTestHooks | undefined;
  readonly #transaction: BoundedRepositoryTransaction;

  #state: RepositoryState = "active";
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly allocation: BoundedRepositoryAllocation;
    readonly limits: BoundedRepositoryLimits;
    readonly hooks?: BoundedRepositoryTestHooks;
  }) {
    this.#lifecycle = new BoundedRepositoryLifecycle(options.allocation);
    this.root = this.#lifecycle.root;
    this.limits = options.limits;
    this.#hooks = options.hooks;
    this.#pathLimits = projectPathLimits(this.limits);
    const metadata = new BoundedRepositoryMetadata(this.root);
    this.#ownership = new BoundedRepositoryOwnership({
      root: this.root,
      limits: this.limits,
      pathLimits: this.#pathLimits,
      isGitInitialized: () => metadata.initialized,
      assertRootIdentity: () => this.#lifecycle.assertRootIdentity(),
      poison: () => {
        this.#state = "poisoned";
      },
    });
    this.#gitMetadata = new BoundedRepositoryGitMetadata({
      allocationRoot: this.#lifecycle.allocation,
      repositoryRoot: this.root,
      controlRoot: this.#lifecycle.controlRoot,
      maxOutputBytes: this.limits.maxGitOutputBytes,
      maxWallMs: this.limits.maxGitWallMs,
      pathLimits: this.#pathLimits,
      metadata,
      assertMutableRoot: () => this.#assertMutableRoot(),
      assertReadableRoot: () => this.#assertReadableRoot(),
      assertControlIdentity: () => this.#lifecycle.assertControlIdentity(),
      prepareOwnedPath: (relativePath) =>
        this.#prepareOwnedGitPath(relativePath),
      poison: () => {
        this.#state = "poisoned";
      },
      hit: (checkpoint) => this.#hit(checkpoint),
    });
    this.#transaction = new BoundedRepositoryTransaction({
      root: this.root,
      controlRoot: this.#lifecycle.controlRoot,
      limits: this.limits,
      pathLimits: this.#pathLimits,
      assertMutableRoot: () => this.#assertMutableRoot(),
      assertControlIdentity: () => this.#lifecycle.assertControlIdentity(),
      assertControlRootIdentity: () =>
        this.#lifecycle.assertControlRootIdentity(),
      currentUsage: () => this.#ownership.usage(),
      ownedEntry: (identity) => this.#ownership.ownedEntryByIdentity(identity),
      assertOwnedStatus: (status, relativePath, kind) =>
        this.#ownership.assertOwnedStatus(status, relativePath, kind),
      assertOwnedFileContent: (absolutePath, entry, label) =>
        this.#ownership.assertOwnedFileContent(absolutePath, entry, label),
      scanPortableSiblings: (
        parentAbsolutePath,
        parentRelativePath,
        maximumEntries,
      ) =>
        this.#ownership.scanPortableSiblings(
          parentAbsolutePath,
          parentRelativePath,
          maximumEntries,
        ),
      assertRepositoryMutationParents: (absolutePath, transientDirectories) =>
        this.#ownership.assertRepositoryMutationParents(
          absolutePath,
          transientDirectories,
        ),
      assertPortableSiblingState: (absolutePath, relativePath, expectation) =>
        this.#ownership.assertPortableSiblingState(
          absolutePath,
          relativePath,
          expectation,
        ),
      hit: (checkpoint) => this.#hit(checkpoint),
      poison: () => {
        this.#state = "poisoned";
      },
      applyCommittedLedger: (ledger) => {
        this.#ownership.applyCommittedTransaction(ledger);
        return undefined;
      },
    });
  }

  usage(): BoundedRepositoryUsage {
    this.#assertReadable();
    return this.#ownership.usage();
  }

  resolve(relativePath: string): string {
    this.#assertReadable();
    const segments = validatePortableRepositoryPath(
      relativePath,
      this.#pathLimits,
    );
    const candidate = resolve(this.root, ...segments);
    assertContainedPath(this.root, candidate, "repository path");
    return candidate;
  }

  makeDirectory(relativePath: string): Promise<void> {
    const path = snapshotPath(relativePath, this.#pathLimits);
    return this.#runExclusive(() => this.#transaction.makeDirectories(path));
  }

  writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    return this.writeBytesBatch([{ relativePath, bytes }]);
  }

  writeBytesBatch(
    writes: readonly BoundedRepositoryByteWrite[],
  ): Promise<void> {
    const prepared = snapshotWrites(writes, this.limits, this.#pathLimits);
    return this.#runExclusive(() => this.#transaction.writeBatch(prepared));
  }

  readBytes(relativePath: string): Promise<Buffer> {
    const path = snapshotPath(relativePath, this.#pathLimits);
    return this.#runExclusive(() => this.#readBytesUnlocked(path));
  }

  rename(from: string, to: string): Promise<void> {
    const source = snapshotPath(from, this.#pathLimits);
    const destination = snapshotPath(to, this.#pathLimits);
    return this.#runExclusive(() =>
      this.#renameUnlocked(source.relativePath, destination.relativePath),
    );
  }

  remove(relativePath: string): Promise<void> {
    const path = snapshotPath(relativePath, this.#pathLimits);
    return this.#runExclusive(() => this.#removeUnlocked(path.relativePath));
  }

  createSymlink(
    linkPath: string,
    target: string,
    kind: "file" | "directory",
  ): Promise<"created" | "unsupported"> {
    const path = snapshotPath(linkPath, this.#pathLimits);
    const safeTarget = snapshotBoundedString(
      target,
      this.limits.maxPathUtf8Bytes,
      "symlink target",
    );
    if (kind !== "file" && kind !== "directory") {
      throw invalidInput("symlink kind must be file or directory");
    }
    return this.#runExclusive(() =>
      this.#createSymlinkUnlocked(path.relativePath, safeTarget, kind),
    );
  }

  initGit(): Promise<void> {
    return this.#runExclusive(() => this.#gitMetadata.initialize());
  }

  gitAdd(paths: readonly string[]): Promise<void> {
    const copied = snapshotGitPaths(paths, this.#pathLimits);
    return this.#runExclusive(() => this.#gitMetadata.add(copied));
  }

  gitCommit(message: string): Promise<string> {
    const copied = snapshotBoundedString(
      message,
      MAX_GIT_MESSAGE_BYTES,
      "Git commit message",
    );
    if (copied.length === 0) throw invalidInput("Git commit message is empty");
    return this.#runExclusive(() => this.#gitMetadata.commit(copied));
  }

  gitHead(): Promise<string> {
    return this.#runExclusive(() => this.#gitMetadata.head());
  }

  gitStatus(): Promise<string> {
    return this.#runExclusive(() => this.#gitMetadata.status());
  }

  cleanup(): Promise<void> {
    return this.#runExclusive(() => this.#cleanupUnlocked(), true);
  }

  async #readBytesUnlocked(path: PreparedPath): Promise<Buffer> {
    await this.#assertReadableRoot();
    const absolutePath = resolve(this.root, ...path.segments);
    await this.#ownership.assertSafeParents(absolutePath, false);
    const status = await lstat(absolutePath, { bigint: true });
    const owned = this.#ownership.ownedEntryByIdentity(path.identity);
    if (owned !== undefined) {
      this.#ownership.assertOwnedStatus(status, path.relativePath, "file");
    }
    const bytes = await readBoundedRegularFile(absolutePath, {
      byteLimit: this.limits.maxFileBytes,
      label: `repository file ${path.relativePath}`,
    });
    if (owned !== undefined) {
      this.#ownership.assertOwnedStatus(
        await lstat(absolutePath, { bigint: true }),
        path.relativePath,
        "file",
      );
      if (owned.digest === null || digestBytes(bytes) !== owned.digest) {
        throw externalChange(`${path.relativePath} content`);
      }
    }
    return bytes;
  }

  async #renameUnlocked(from: string, to: string): Promise<void> {
    await this.#assertMutableRoot();
    if (isPathOrDescendant(to, from)) {
      throw invalidInput("repository cannot rename a path into itself");
    }
    const source = this.resolve(from);
    const destination = this.resolve(to);
    await this.#ownership.assertSafeParents(source, true);
    await this.#ownership.assertSafeParents(destination, true);
    const status = await lstat(source, { bigint: true });
    const kind = repositoryEntryKind(status, from);
    const owned = this.#ownership.assertOwnedStatus(status, from, kind);
    await this.#ownership.assertNoPortableSiblingCollision(destination, to);
    if (
      (await lstatOrNull(destination)) !== null ||
      this.#ownership.ownedEntry(to) !== undefined
    ) {
      throw invalidInput("repository rename destination already exists");
    }
    await this.#auditOwnedSource(from, source, kind, owned);
    this.#ownership.assertRenameCollisions(from, to);

    this.#hit("rename:before-commit");
    await this.#ownership.assertSafeParents(source, true);
    await this.#ownership.assertSafeParents(destination, true);
    this.#ownership.assertOwnedStatus(
      await lstat(source, { bigint: true }),
      from,
      kind,
    );
    await this.#auditOwnedSource(from, source, kind, owned);
    await this.#ownership.assertNoPortableSiblingCollision(destination, to);
    if (
      (await lstatOrNull(destination)) !== null ||
      this.#ownership.ownedEntry(to) !== undefined
    ) {
      throw externalChange(
        "repository rename destination changed before commit",
      );
    }

    await rename(source, destination);
    this.#ownership.moveEntries(from, to);
    try {
      this.#hit("rename:after-commit-before-verify");
      const moved = await lstat(destination, { bigint: true });
      const movedEntry = this.#ownership.assertOwnedStatus(moved, to, kind);
      await this.#auditOwnedSource(to, destination, kind, movedEntry);
    } catch (error) {
      this.#state = "poisoned";
      throw new BoundedRepositoryError(
        "committed_cleanup",
        "repository rename committed but post-rename verification failed",
        { cause: error, committed: true },
      );
    }
  }

  async #removeUnlocked(relativePath: string): Promise<void> {
    await this.#assertMutableRoot();
    const absolutePath = this.resolve(relativePath);
    await this.#ownership.assertSafeParents(absolutePath, true);
    const status = await lstat(absolutePath, { bigint: true });
    const kind = repositoryEntryKind(status, relativePath);
    const owned = this.#ownership.assertOwnedStatus(status, relativePath, kind);
    await this.#auditOwnedSource(relativePath, absolutePath, kind, owned);

    this.#hit("remove:before-commit");
    await this.#ownership.assertSafeParents(absolutePath, true);
    this.#ownership.assertOwnedStatus(
      await lstat(absolutePath, { bigint: true }),
      relativePath,
      kind,
    );
    await this.#auditOwnedSource(relativePath, absolutePath, kind, owned);
    if (kind === "directory") await rmdir(absolutePath);
    else await unlink(absolutePath);
    try {
      this.#hit("remove:after-commit-before-verify");
      if ((await lstatOrNull(absolutePath)) !== null) {
        throw externalChange(`${relativePath} was recreated after removal`);
      }
    } catch (error) {
      this.#state = "poisoned";
      throw new BoundedRepositoryError(
        "committed_cleanup",
        "repository removal committed but post-remove verification failed",
        { cause: error, committed: true },
      );
    }
    this.#ownership.removeEntry(relativePath, kind, owned);
  }

  async #auditOwnedSource(
    relativePath: string,
    absolutePath: string,
    kind: "directory" | "file" | "symlink",
    owned: ReturnType<BoundedRepositoryOwnership["assertOwnedStatus"]>,
  ): Promise<void> {
    if (kind === "directory") {
      await this.#ownership.assertOwnedDirectoryTree(
        relativePath,
        absolutePath,
      );
    } else if (kind === "file") {
      await this.#ownership.assertOwnedFileContent(
        absolutePath,
        owned,
        relativePath,
      );
    }
  }

  async #createSymlinkUnlocked(
    linkPath: string,
    target: string,
    kind: "file" | "directory",
  ): Promise<"created" | "unsupported"> {
    await this.#assertMutableRoot();
    const absolutePath = this.resolve(linkPath);
    await this.#ownership.assertSafeParents(absolutePath, true);
    await this.#ownership.assertNoPortableSiblingCollision(
      absolutePath,
      linkPath,
    );
    if (
      (await lstatOrNull(absolutePath)) !== null ||
      this.#ownership.ownedEntry(linkPath) !== undefined
    ) {
      throw invalidInput("repository symlink destination already exists");
    }
    if (this.#ownership.usage().entries >= this.limits.maxEntries) {
      throw quotaError("repository symlink exceeds maxEntries");
    }
    try {
      await symlink(
        target,
        absolutePath,
        kind === "directory" ? "dir" : "file",
      );
    } catch (error) {
      if (isUnsupportedSymlinkError(error)) return "unsupported";
      throw error;
    }
    let status: BigIntStats;
    try {
      status = await lstat(absolutePath, { bigint: true });
      if (!status.isSymbolicLink()) throw externalChange(linkPath);
    } catch (error) {
      this.#state = "poisoned";
      throw new BoundedRepositoryError(
        "committed_cleanup",
        "repository symlink was created but post-create verification failed",
        { cause: error, committed: true },
      );
    }
    this.#ownership.recordSymlink(linkPath, status);
    return "created";
  }

  async #prepareOwnedGitPath(
    relativePath: string,
  ): Promise<PreparedOwnedGitPath> {
    const absolutePath = this.resolve(relativePath);
    await this.#ownership.assertSafeParents(absolutePath, true);
    const status = await lstat(absolutePath, { bigint: true });
    const kind = repositoryEntryKind(status, relativePath);
    this.#ownership.assertOwnedStatus(status, relativePath, kind);
    return Object.freeze({
      relativePath,
      portableIdentity: snapshotPath(relativePath, this.#pathLimits).identity,
      kind,
      audit: async () => {
        await this.#ownership.assertSafeParents(absolutePath, true);
        const current = await lstat(absolutePath, { bigint: true });
        const currentKind = repositoryEntryKind(current, relativePath);
        const currentOwned = this.#ownership.assertOwnedStatus(
          current,
          relativePath,
          currentKind,
        );
        await this.#auditOwnedSource(
          relativePath,
          absolutePath,
          currentKind,
          currentOwned,
        );
      },
    });
  }

  async #cleanupUnlocked(): Promise<void> {
    if (this.#state === "cleaned") return;
    await this.#lifecycle.cleanup({
      unprovenGitSurvivor: this.#gitMetadata.unprovenGitSurvivor,
      hit: (checkpoint) => this.#hit(checkpoint),
      onRootQuarantined: () => {
        this.#state = "quarantined";
      },
    });
    this.#state = "cleaned";
  }

  async #assertMutableRoot(): Promise<void> {
    if (this.#state === "poisoned") {
      throw new BoundedRepositoryError(
        "poisoned",
        "bounded repository is poisoned; only reads and cleanup remain available",
      );
    }
    if (this.#state !== "active") this.#assertReadable();
    await this.#lifecycle.assertRootIdentity();
  }

  async #assertReadableRoot(): Promise<void> {
    this.#assertReadable();
    await this.#lifecycle.assertRootIdentity();
  }

  #assertReadable(): void {
    if (this.#state === "cleaned") {
      throw new BoundedRepositoryError(
        "cleaned",
        "bounded repository is cleaned",
      );
    }
    if (this.#state === "quarantined") {
      throw new BoundedRepositoryError(
        "cleaned",
        "bounded repository is quarantined for cleanup",
      );
    }
  }

  #hit(checkpoint: string): void {
    this.#hooks?.hit(checkpoint);
  }

  #runExclusive<T>(
    operation: () => Promise<T>,
    allowCleanup = false,
  ): Promise<T> {
    if (!allowCleanup && this.#state === "cleaned") {
      return Promise.reject(
        new BoundedRepositoryError("cleaned", "bounded repository is cleaned"),
      );
    }
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export async function createBoundedTempRepository(
  options: Partial<BoundedRepositoryLimits> = {},
): Promise<BoundedTempRepository> {
  return createRepository(options, undefined);
}

/** Test-only deterministic failure seam; production-style callers use the function above. */
export async function createBoundedTempRepositoryForTest(
  options: Partial<BoundedRepositoryLimits>,
  hooks: BoundedRepositoryTestHooks,
): Promise<BoundedTempRepository> {
  return createRepository(options, snapshotRepositoryTestHooks(hooks));
}

async function createRepository(
  options: Partial<BoundedRepositoryLimits>,
  hooks: BoundedRepositoryTestHooks | undefined,
): Promise<BoundedTempRepository> {
  const limits = snapshotLimits(options);
  const allocation = await createBoundedRepositoryAllocation();
  try {
    return new BoundedTempRepositoryImplementation({
      allocation,
      limits,
      ...(hooks === undefined ? {} : { hooks }),
    });
  } catch (error) {
    const lifecycle = new BoundedRepositoryLifecycle(allocation);
    try {
      await lifecycle.cleanup({
        unprovenGitSurvivor: false,
        hit: () => {},
        onRootQuarantined: () => {},
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "bounded repository creation failed and cleanup was incomplete",
      );
    }
    throw error;
  }
}

const invalidInput = invalidRepositoryInput;
const quotaError = repositoryQuotaError;
const externalChange = repositoryExternalChange;
