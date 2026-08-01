import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { readBoundedRegularFile } from "./bounded-file-io.js";
import {
  assertDirectory,
  assertSameIdentity,
  assertSinglyLinkedRegularFile,
  type FileIdentity,
  identityFromStatus,
  readBoundedDirectoryNames,
  type RemovalResult,
} from "./bounded-repository-filesystem.js";
import {
  digestBytes,
  type PreparedWrite,
} from "./bounded-repository-policy.js";
import {
  BoundedRepositoryError,
  repositoryExternalChange,
} from "./bounded-repository-types.js";
import { type BoundedRepositoryTransactionContext } from "./bounded-repository-transaction-contract.js";

const TRANSACTION_PREFIX = "transaction-";
const TRANSACTION_STAGE_DIRECTORY = "stage";
const TRANSACTION_BACKUP_DIRECTORY = "backup";
const QUARANTINE_PREFIX = "quarantine-";
const PRIVATE_DIRECTORY_MODE = 0o700;
const TRANSACTION_ROOT_ENTRY_COUNT = 2;
const TRANSACTION_FILE_NAME = /^(?:0|[1-9]\d*)$/u;

export type TransactionScaffoldChild = "stage" | "backup";

export type TransactionScaffoldFile = FileIdentity &
  Readonly<{
    child: TransactionScaffoldChild;
    name: string;
  }>;

interface TransactionScaffoldDirectory extends FileIdentity {
  readonly child: TransactionScaffoldChild;
  readonly name: string;
}

export type TransactionScaffold = FileIdentity &
  Readonly<{
    root: string;
    stageRoot: string;
    stageIdentity: FileIdentity;
    backupRoot: string;
    backupIdentity: FileIdentity;
  }>;

export class BoundedRepositoryTransactionFilesystem {
  readonly #context: Readonly<BoundedRepositoryTransactionContext>;

  constructor(context: Readonly<BoundedRepositoryTransactionContext>) {
    this.#context = context;
  }

  async createScaffold(): Promise<TransactionScaffold> {
    await this.#context.assertControlIdentity();
    const root = join(
      this.#context.controlRoot,
      `${TRANSACTION_PREFIX}${randomUUID()}`,
    );
    const rootIdentity = await this.createVerifiedDirectory(
      root,
      "repository transaction root",
      undefined,
      () => this.#context.assertControlRootIdentity(),
    );
    const stageRoot = join(root, TRANSACTION_STAGE_DIRECTORY);
    const backupRoot = join(root, TRANSACTION_BACKUP_DIRECTORY);
    let stageIdentity: FileIdentity | undefined;
    let backupIdentity: FileIdentity | undefined;
    try {
      await this.#assertTransactionRoot(root, rootIdentity);
      stageIdentity = await this.createVerifiedDirectory(
        stageRoot,
        "repository transaction stage directory",
        undefined,
        () => this.#assertTransactionRoot(root, rootIdentity),
      );
      await this.#assertTransactionRoot(root, rootIdentity);
      backupIdentity = await this.createVerifiedDirectory(
        backupRoot,
        "repository transaction backup directory",
        undefined,
        () => this.#assertTransactionRoot(root, rootIdentity),
      );
      return Object.freeze({
        root,
        ...rootIdentity,
        stageRoot,
        stageIdentity,
        backupRoot,
        backupIdentity,
      });
    } catch (error) {
      const directories: TransactionScaffoldDirectory[] = [];
      if (stageIdentity !== undefined) {
        directories.push({
          child: "stage",
          name: TRANSACTION_STAGE_DIRECTORY,
          ...stageIdentity,
        });
      }
      if (backupIdentity !== undefined) {
        directories.push({
          child: "backup",
          name: TRANSACTION_BACKUP_DIRECTORY,
          ...backupIdentity,
        });
      }
      const cleanup = await this.#removeIdentityBoundScaffold(
        root,
        rootIdentity,
        directories,
        [],
      );
      if (cleanup.failed) {
        this.#context.poison();
        throw new AggregateError(
          [error, cleanup.error],
          "repository transaction creation failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async createVerifiedDirectory(
    path: string,
    label: string,
    verificationCheckpoint?: string,
    assertRemovalParent?: () => Promise<void>,
  ): Promise<FileIdentity> {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    let identity: FileIdentity;
    try {
      const status = await lstat(path, { bigint: true });
      assertDirectory(status, label);
      identity = identityFromStatus(status);
    } catch (error) {
      return this.#failCreatedDirectory(
        path,
        label,
        error,
        null,
        assertRemovalParent,
      );
    }
    if (verificationCheckpoint !== undefined) {
      try {
        this.#context.hit(verificationCheckpoint);
        const status = await lstat(path, { bigint: true });
        assertDirectory(status, label);
        assertSameIdentity(status, identity, label);
      } catch (error) {
        return this.#failCreatedDirectory(
          path,
          label,
          error,
          identity,
          assertRemovalParent,
        );
      }
    }
    return identity;
  }

  async assertScaffoldChild(
    transaction: TransactionScaffold,
    child: "stage" | "backup",
  ): Promise<void> {
    await this.#assertTransactionRoot(transaction.root, transaction);
    const path =
      child === "stage" ? transaction.stageRoot : transaction.backupRoot;
    const identity =
      child === "stage"
        ? transaction.stageIdentity
        : transaction.backupIdentity;
    const label = `repository transaction ${child} directory`;
    const status = await lstat(path, { bigint: true });
    assertDirectory(status, label);
    assertSameIdentity(status, identity, label);
  }

  async assertPreparedContent(
    path: string,
    identity: FileIdentity,
    write: PreparedWrite,
    label: string,
  ): Promise<void> {
    const bytes = await readBoundedRegularFile(path, {
      byteLimit: this.#context.limits.maxFileBytes,
      label,
    });
    const status = await lstat(path, { bigint: true });
    assertSinglyLinkedRegularFile(status, label);
    assertSameIdentity(status, identity, label);
    if (
      bytes.byteLength !== write.bytes.byteLength ||
      digestBytes(bytes) !== write.digest
    ) {
      throw repositoryExternalChange(`${label} content`);
    }
  }

  async removeTransaction(
    transaction: TransactionScaffold,
    expectedFiles: readonly TransactionScaffoldFile[],
  ): Promise<RemovalResult> {
    return this.#removeIdentityBoundScaffold(
      transaction.root,
      transaction,
      [
        {
          child: "stage",
          name: TRANSACTION_STAGE_DIRECTORY,
          ...transaction.stageIdentity,
        },
        {
          child: "backup",
          name: TRANSACTION_BACKUP_DIRECTORY,
          ...transaction.backupIdentity,
        },
      ],
      expectedFiles,
    );
  }

  async #failCreatedDirectory(
    path: string,
    label: string,
    primaryError: unknown,
    identity: FileIdentity | null,
    assertRemovalParent?: () => Promise<void>,
  ): Promise<never> {
    this.#context.poison();
    if (identity === null) {
      throw new BoundedRepositoryError(
        "poisoned",
        `${label} was created but could not be identity-bound`,
        { cause: primaryError },
      );
    }
    try {
      await assertRemovalParent?.();
      const status = await lstat(path, { bigint: true });
      assertDirectory(status, label);
      assertSameIdentity(status, identity, label);
      await rmdir(path);
    } catch (error) {
      throw new AggregateError(
        [primaryError, error],
        `${label} could not be verified or safely removed`,
      );
    }
    throw new BoundedRepositoryError(
      "poisoned",
      `${label} could not be identity-bound after creation`,
      { cause: primaryError },
    );
  }

  async #assertTransactionRoot(
    root: string,
    identity: FileIdentity,
  ): Promise<void> {
    await this.#context.assertControlRootIdentity();
    const status = await lstat(root, { bigint: true });
    assertDirectory(status, "repository transaction root");
    assertSameIdentity(status, identity, "repository transaction root");
  }

  async #removeIdentityBoundScaffold(
    source: string,
    identity: FileIdentity,
    directories: readonly TransactionScaffoldDirectory[],
    expectedFiles: readonly TransactionScaffoldFile[],
  ): Promise<RemovalResult> {
    try {
      const filesByChild = this.#validateExpectedFiles(
        directories,
        expectedFiles,
      );
      await this.#context.assertControlRootIdentity();
      const status = await lstat(source, { bigint: true });
      assertDirectory(status, "repository transaction root");
      assertSameIdentity(status, identity, "repository transaction root");
      const quarantine = join(
        this.#context.controlRoot,
        `${QUARANTINE_PREFIX}${randomUUID()}`,
      );
      await rename(source, quarantine);
      const moved = await lstat(quarantine, { bigint: true });
      assertDirectory(moved, "quarantined repository transaction root");
      assertSameIdentity(
        moved,
        identity,
        "quarantined repository transaction root",
      );
      await this.#auditScaffold(
        quarantine,
        identity,
        directories,
        filesByChild,
      );
      await this.#removeScaffoldEntries(
        quarantine,
        identity,
        directories,
        filesByChild,
      );
      return Object.freeze({ failed: false });
    } catch (error) {
      return Object.freeze({ failed: true, error });
    }
  }

  #validateExpectedFiles(
    directories: readonly TransactionScaffoldDirectory[],
    expectedFiles: readonly TransactionScaffoldFile[],
  ): ReadonlyMap<TransactionScaffoldChild, readonly TransactionScaffoldFile[]> {
    const directoryChildren = new Set(
      directories.map((directory) => directory.child),
    );
    if (
      directories.length > TRANSACTION_ROOT_ENTRY_COUNT ||
      directoryChildren.size !== directories.length
    ) {
      throw repositoryExternalChange(
        "repository transaction directory inventory is invalid",
      );
    }
    if (expectedFiles.length > this.#context.limits.maxEntries) {
      throw repositoryExternalChange(
        "repository transaction file inventory exceeds maxEntries",
      );
    }
    const mutable = new Map<
      TransactionScaffoldChild,
      TransactionScaffoldFile[]
    >([
      ["stage", []],
      ["backup", []],
    ]);
    const keys = new Set<string>();
    for (const file of expectedFiles) {
      if (
        !directoryChildren.has(file.child) ||
        !TRANSACTION_FILE_NAME.test(file.name)
      ) {
        throw repositoryExternalChange(
          "repository transaction file inventory is invalid",
        );
      }
      const key = `${file.child}/${file.name}`;
      if (keys.has(key)) {
        throw repositoryExternalChange(
          "repository transaction file inventory contains duplicates",
        );
      }
      keys.add(key);
      mutable.get(file.child)!.push(file);
    }
    return new Map(
      [...mutable].map(([child, files]) => [child, Object.freeze(files)]),
    );
  }

  async #auditScaffold(
    root: string,
    rootIdentity: FileIdentity,
    directories: readonly TransactionScaffoldDirectory[],
    filesByChild: ReadonlyMap<
      TransactionScaffoldChild,
      readonly TransactionScaffoldFile[]
    >,
  ): Promise<void> {
    await this.#assertQuarantinedRoot(root, rootIdentity);
    const rootNames = await readBoundedDirectoryNames(
      root,
      directories.length,
      "repository transaction root",
    );
    assertExactNames(
      rootNames,
      directories.map((directory) => directory.name),
      "repository transaction root",
    );
    for (const directory of directories) {
      await this.#assertQuarantinedRoot(root, rootIdentity);
      const directoryPath = join(root, directory.name);
      await this.#assertScaffoldDirectory(directoryPath, directory);
      const files = filesByChild.get(directory.child) ?? [];
      const names = await readBoundedDirectoryNames(
        directoryPath,
        files.length,
        `repository transaction ${directory.child} directory`,
      );
      assertExactNames(
        names,
        files.map((file) => file.name),
        `repository transaction ${directory.child} directory`,
      );
      for (const file of files) {
        const filePath = join(directoryPath, file.name);
        const fileStatus = await lstat(filePath, { bigint: true });
        assertSinglyLinkedRegularFile(fileStatus, filePath);
        assertSameIdentity(fileStatus, file, filePath);
      }
    }
  }

  async #removeScaffoldEntries(
    root: string,
    rootIdentity: FileIdentity,
    directories: readonly TransactionScaffoldDirectory[],
    filesByChild: ReadonlyMap<
      TransactionScaffoldChild,
      readonly TransactionScaffoldFile[]
    >,
  ): Promise<void> {
    for (const directory of directories) {
      await this.#assertQuarantinedRoot(root, rootIdentity);
      const directoryPath = join(root, directory.name);
      const files = filesByChild.get(directory.child) ?? [];
      for (const file of files) {
        await this.#assertQuarantinedRoot(root, rootIdentity);
        await this.#assertScaffoldDirectory(directoryPath, directory);
        const filePath = join(directoryPath, file.name);
        const status = await lstat(filePath, { bigint: true });
        assertSinglyLinkedRegularFile(status, filePath);
        assertSameIdentity(status, file, filePath);
        await unlink(filePath);
      }
      await this.#assertScaffoldDirectory(directoryPath, directory);
      const remaining = await readBoundedDirectoryNames(
        directoryPath,
        0,
        `repository transaction ${directory.child} directory`,
      );
      assertExactNames(
        remaining,
        [],
        `repository transaction ${directory.child} directory`,
      );
      await rmdir(directoryPath);
    }
    await this.#assertQuarantinedRoot(root, rootIdentity);
    const remaining = await readBoundedDirectoryNames(
      root,
      0,
      "repository transaction root",
    );
    assertExactNames(remaining, [], "repository transaction root");
    await rmdir(root);
  }

  async #assertQuarantinedRoot(
    root: string,
    identity: FileIdentity,
  ): Promise<void> {
    await this.#context.assertControlRootIdentity();
    const status = await lstat(root, { bigint: true });
    assertDirectory(status, "quarantined repository transaction root");
    assertSameIdentity(
      status,
      identity,
      "quarantined repository transaction root",
    );
  }

  async #assertScaffoldDirectory(
    path: string,
    directory: TransactionScaffoldDirectory,
  ): Promise<void> {
    const status = await lstat(path, { bigint: true });
    assertDirectory(
      status,
      `repository transaction ${directory.child} directory`,
    );
    assertSameIdentity(
      status,
      directory,
      `repository transaction ${directory.child} directory`,
    );
  }
}

function assertExactNames(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    expected.some((name) => !actual.includes(name))
  ) {
    throw repositoryExternalChange(`${label} inventory`);
  }
}
