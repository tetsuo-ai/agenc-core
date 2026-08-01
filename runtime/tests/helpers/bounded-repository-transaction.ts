import { link, lstat, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertDirectory,
  assertSameIdentity,
  assertSinglyLinkedRegularFile,
  assertStagedRegularFileLink,
  type FileIdentity,
  identityFromStatus,
  lstatOrNull,
  type OwnedRepositoryEntry,
  type RemovalResult,
} from "./bounded-repository-filesystem.js";
import {
  type PreparedPath,
  type PreparedWrite,
} from "./bounded-repository-policy.js";
import {
  repositoryExternalChange,
  repositoryQuotaError,
} from "./bounded-repository-types.js";
import {
  type BoundedRepositoryTransactionContext,
  committedRepositoryFailure,
  type CommittedRepositoryLedger,
  createCommittedRepositoryLedger,
  ownedRepositoryEntryIdentity,
  type PortableSiblingExpectation,
  type TransactionTransientDirectory,
} from "./bounded-repository-transaction-contract.js";
import {
  BoundedRepositoryTransactionPlanner,
  type TransactionBatchPlan,
  type TransactionPlannedDirectory,
  type TransactionPlannedFile,
} from "./bounded-repository-transaction-plan.js";
import {
  BoundedRepositoryTransactionFilesystem,
  type TransactionScaffold,
  type TransactionScaffoldFile,
} from "./bounded-repository-transaction-filesystem.js";

export type {
  BoundedRepositoryTransactionContext,
  CommittedRepositoryDirectory,
  CommittedRepositoryFile,
  CommittedRepositoryLedger,
  PortableSiblingExpectation,
  PortableSiblingSnapshot,
  TransactionTransientDirectory,
} from "./bounded-repository-transaction-contract.js";

const PRIVATE_FILE_MODE = 0o600;

type PlannedDirectory = TransactionPlannedDirectory;
type PlannedFile = TransactionPlannedFile;
type BatchPlan = TransactionBatchPlan;
type CreatedDirectoryJournal = FileIdentity & PlannedDirectory;
type BackupJournal = TransactionScaffoldFile &
  Readonly<{
    destination: string;
    backup: string;
    existing: OwnedRepositoryEntry;
  }>;
type InstallJournal = FileIdentity &
  Readonly<{
    destination: string;
    stage: string;
    relativePath: string;
  }>;
type StagedFile = TransactionScaffoldFile & Readonly<{ path: string }>;
type BatchJournal = Readonly<{
  directories: CreatedDirectoryJournal[];
  backups: BackupJournal[];
  installs: InstallJournal[];
  scaffoldFiles: Map<string, TransactionScaffoldFile>;
}>;

export class BoundedRepositoryTransaction {
  readonly #context: Readonly<BoundedRepositoryTransactionContext>;
  readonly #filesystem: BoundedRepositoryTransactionFilesystem;
  readonly #planner: BoundedRepositoryTransactionPlanner;

  constructor(context: BoundedRepositoryTransactionContext) {
    this.#context = Object.freeze({ ...context });
    this.#filesystem = new BoundedRepositoryTransactionFilesystem(
      this.#context,
    );
    this.#planner = new BoundedRepositoryTransactionPlanner(this.#context);
  }

  async makeDirectories(path: PreparedPath): Promise<void> {
    await this.#context.assertMutableRoot();
    const directories = await this.#planner.planDirectories(path);
    if (directories.length === 0) return;
    const usage = { ...this.#context.currentUsage() };
    if (usage.entries + directories.length > this.#context.limits.maxEntries) {
      throw repositoryQuotaError(
        "repository directory creation exceeds maxEntries",
      );
    }
    const created: CreatedDirectoryJournal[] = [];
    try {
      for (let index = 0; index < directories.length; index += 1) {
        const item = directories[index]!;
        this.#context.hit(`directory:before-mkdir:${index}`);
        await this.#assertRepositoryTarget(
          item.absolutePath,
          item.relativePath,
          created,
          "absent",
        );
        const identity = await this.#filesystem.createVerifiedDirectory(
          item.absolutePath,
          item.relativePath,
          `directory:after-mkdir-before-verify:${index}`,
          () =>
            this.#context.assertRepositoryMutationParents(
              item.absolutePath,
              created,
            ),
        );
        created.push({ ...identity, ...item });
        this.#context.hit(`directory:after-mkdir:${index}`);
      }
      await this.#verifyCreatedDirectories(created);
    } catch (error) {
      const rollbackErrors = await this.#rollbackDirectories(created);
      if (rollbackErrors.length > 0) {
        this.#context.poison();
        throw new AggregateError(
          [error, ...rollbackErrors],
          "repository directory creation failed and rollback was incomplete",
        );
      }
      throw error;
    }
    usage.entries += created.length;
    usage.directories += created.length;
    const applied = this.#applyLedger(() =>
      createCommittedRepositoryLedger(created, [], usage),
    );
    if (applied.failed) {
      this.#context.poison();
      throw committedRepositoryFailure(
        "repository directories were created but ledger commit failed",
        [applied.error],
      );
    }
  }

  async writeBatch(writes: readonly PreparedWrite[]): Promise<void> {
    await this.#context.assertMutableRoot();
    if (writes.length === 0) return;
    await this.#context.assertControlIdentity();
    const plan = await this.#planner.planBatch(writes);
    const transaction = await this.#filesystem.createScaffold();
    const staged = await this.#stageFilesOrCleanup(plan, transaction);
    const journal: BatchJournal = {
      directories: [],
      backups: [],
      installs: [],
      scaffoldFiles: new Map(
        staged.map((file) => [scaffoldFileKey(file), file]),
      ),
    };
    try {
      await this.#commitDirectories(plan.directories, journal);
      await this.#commitFiles(plan.files, staged, transaction, journal);
      await this.#verifyCreatedDirectories(journal.directories);
      await this.#verifyInstalledFiles(plan.files, journal);
    } catch (error) {
      const rollbackErrors = await this.#rollbackBatch(journal, transaction);
      if (rollbackErrors.length > 0) {
        this.#context.poison();
        throw new AggregateError(
          [error, ...rollbackErrors],
          "repository byte-write batch failed and rollback was incomplete",
        );
      }
      throw error;
    }

    const applied = this.#applyLedger(() =>
      createCommittedRepositoryLedger(
        journal.directories,
        plan.files.map((file, index) => ({
          write: file.write,
          ...journal.installs[index]!,
        })),
        plan.projectedUsage,
      ),
    );
    const cleanup = await this.#filesystem.removeTransaction(transaction, [
      ...journal.scaffoldFiles.values(),
    ]);
    if (applied.failed || cleanup.failed) {
      this.#context.poison();
      const errors: unknown[] = [];
      if (applied.failed) errors.push(applied.error);
      if (cleanup.failed) errors.push(cleanup.error);
      throw committedRepositoryFailure(
        applied.failed
          ? "repository batch committed but ledger publication failed"
          : "repository batch committed but transaction cleanup failed",
        errors,
      );
    }
  }

  async #stageFilesOrCleanup(
    plan: BatchPlan,
    transaction: TransactionScaffold,
  ): Promise<readonly StagedFile[]> {
    const staged = new Array<StagedFile | undefined>(plan.files.length);
    try {
      for (let index = 0; index < plan.files.length; index += 1) {
        const path = join(transaction.stageRoot, String(index));
        await this.#filesystem.assertScaffoldChild(transaction, "stage");
        await writeFile(path, plan.files[index]!.write.bytes, {
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        });
        const status = await lstat(path, { bigint: true });
        assertSinglyLinkedRegularFile(status, `staged file ${index}`);
        staged[index] = Object.freeze({
          path,
          child: "stage",
          name: String(index),
          ...identityFromStatus(status),
        });
        this.#context.hit(`batch:after-stage:${index}`);
      }
      return Object.freeze(
        staged.map((file, index) => {
          if (file === undefined) {
            throw repositoryExternalChange(`missing staged file ${index}`);
          }
          return file;
        }),
      );
    } catch (error) {
      const cleanup = await this.#filesystem.removeTransaction(
        transaction,
        staged.filter((file): file is StagedFile => file !== undefined),
      );
      if (cleanup.failed) {
        this.#context.poison();
        throw new AggregateError(
          [error, cleanup.error],
          "repository staging failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async #commitDirectories(
    directories: readonly PlannedDirectory[],
    journal: BatchJournal,
  ): Promise<void> {
    for (let index = 0; index < directories.length; index += 1) {
      const item = directories[index]!;
      this.#context.hit(`batch:before-mkdir:${index}`);
      await this.#assertRepositoryTarget(
        item.absolutePath,
        item.relativePath,
        journal.directories,
        "absent",
      );
      const identity = await this.#filesystem.createVerifiedDirectory(
        item.absolutePath,
        item.relativePath,
        `batch:after-mkdir-before-verify:${index}`,
        () =>
          this.#context.assertRepositoryMutationParents(
            item.absolutePath,
            journal.directories,
          ),
      );
      journal.directories.push({ ...identity, ...item });
      this.#context.hit(`batch:after-mkdir:${index}`);
    }
  }

  async #commitFiles(
    files: readonly PlannedFile[],
    staged: readonly StagedFile[],
    transaction: TransactionScaffold,
    journal: BatchJournal,
  ): Promise<void> {
    for (let index = 0; index < files.length; index += 1) {
      const plan = files[index]!;
      if (plan.existing !== null) {
        const backup = join(transaction.backupRoot, String(index));
        const backupJournal: BackupJournal = {
          child: "backup",
          name: String(index),
          destination: plan.absolutePath,
          backup,
          existing: plan.existing,
          ...ownedRepositoryEntryIdentity(plan.existing),
        };
        this.#context.hit(`batch:before-backup:${index}`);
        await this.#context.assertOwnedFileContent(
          plan.absolutePath,
          plan.existing,
          plan.write.relativePath,
        );
        await this.#filesystem.assertScaffoldChild(transaction, "backup");
        await this.#assertRepositoryTarget(
          plan.absolutePath,
          plan.write.relativePath,
          journal.directories,
          "owned",
        );
        const source = await lstat(plan.absolutePath, { bigint: true });
        this.#context.assertOwnedStatus(
          source,
          plan.write.relativePath,
          "file",
        );
        await link(plan.absolutePath, backup);
        journal.backups.push(backupJournal);
        journal.scaffoldFiles.set(
          scaffoldFileKey(backupJournal),
          backupJournal,
        );
        const [linkedSource, linkedBackup] = await Promise.all([
          lstat(plan.absolutePath, { bigint: true }),
          lstat(backup, { bigint: true }),
        ]);
        assertStagedRegularFileLink(linkedSource, plan.write.relativePath);
        assertSameIdentity(
          linkedSource,
          plan.existing,
          plan.write.relativePath,
        );
        assertStagedRegularFileLink(linkedBackup, backup);
        assertSameIdentity(linkedBackup, plan.existing, backup);
        await unlink(plan.absolutePath);
        const captured = await lstat(backup, { bigint: true });
        assertSinglyLinkedRegularFile(captured, backup);
        assertSameIdentity(captured, plan.existing, backup);
        this.#context.hit(`batch:after-backup:${index}`);
      }
      const stagedFile = staged[index]!;
      this.#context.hit(`batch:before-install:${index}`);
      await this.#filesystem.assertPreparedContent(
        stagedFile.path,
        stagedFile,
        plan.write,
        `staged file ${index}`,
      );
      await this.#filesystem.assertScaffoldChild(transaction, "stage");
      await this.#assertRepositoryTarget(
        plan.absolutePath,
        plan.write.relativePath,
        journal.directories,
        "absent",
      );
      const status = await lstat(stagedFile.path, { bigint: true });
      assertSinglyLinkedRegularFile(status, `staged file ${index}`);
      assertSameIdentity(status, stagedFile, `staged file ${index}`);
      await link(stagedFile.path, plan.absolutePath);
      const installed = {
        destination: plan.absolutePath,
        stage: stagedFile.path,
        relativePath: plan.write.relativePath,
        ...identityFromStatus(status),
      };
      journal.installs.push(installed);
      const linked = await lstat(plan.absolutePath, { bigint: true });
      assertStagedRegularFileLink(linked, plan.write.relativePath);
      assertSameIdentity(linked, installed, plan.write.relativePath);
      this.#context.hit(`batch:after-link:${index}`);
      await unlink(stagedFile.path);
      journal.scaffoldFiles.delete(scaffoldFileKey(stagedFile));
      this.#context.hit(`batch:after-install:${index}`);
      await this.#assertRepositoryTarget(
        plan.absolutePath,
        plan.write.relativePath,
        journal.directories,
        "owned",
      );
      await this.#filesystem.assertPreparedContent(
        plan.absolutePath,
        installed,
        plan.write,
        plan.write.relativePath,
      );
    }
  }

  async #verifyInstalledFiles(
    files: readonly PlannedFile[],
    journal: BatchJournal,
  ): Promise<void> {
    if (journal.installs.length !== files.length) {
      throw repositoryExternalChange("installed file journal length");
    }
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const installed = journal.installs[index]!;
      await this.#assertRepositoryTarget(
        installed.destination,
        file.write.relativePath,
        journal.directories,
        "owned",
      );
      await this.#filesystem.assertPreparedContent(
        installed.destination,
        installed,
        file.write,
        file.write.relativePath,
      );
    }
  }

  async #verifyCreatedDirectories(
    directories: readonly CreatedDirectoryJournal[],
  ): Promise<void> {
    for (const directory of directories) {
      await this.#assertRepositoryTarget(
        directory.absolutePath,
        directory.relativePath,
        directories,
        "owned",
      );
      const status = await lstat(directory.absolutePath, { bigint: true });
      assertDirectory(status, directory.relativePath);
      assertSameIdentity(status, directory, directory.relativePath);
    }
  }

  async #assertRepositoryTarget(
    absolutePath: string,
    relativePath: string,
    transientDirectories: readonly TransactionTransientDirectory[],
    expectation: PortableSiblingExpectation,
  ): Promise<void> {
    await this.#context.assertRepositoryMutationParents(
      absolutePath,
      transientDirectories,
    );
    await this.#context.assertPortableSiblingState(
      absolutePath,
      relativePath,
      expectation,
    );
    await this.#context.assertRepositoryMutationParents(
      absolutePath,
      transientDirectories,
    );
  }

  async #rollbackBatch(
    journal: BatchJournal,
    transaction: TransactionScaffold,
  ): Promise<readonly unknown[]> {
    const errors: unknown[] = [];
    for (let index = journal.installs.length - 1; index >= 0; index -= 1) {
      const installed = journal.installs[index]!;
      try {
        this.#context.hit(`batch:rollback:before-remove-install:${index}`);
        await this.#assertRepositoryTarget(
          installed.destination,
          installed.relativePath,
          journal.directories,
          "owned",
        );
        const status = await lstat(installed.destination, { bigint: true });
        assertSameIdentity(status, installed, installed.destination);
        const stageKey = scaffoldFileKey({
          child: "stage",
          name: String(index),
        });
        const stage = journal.scaffoldFiles.get(stageKey);
        if (stage === undefined) {
          assertSinglyLinkedRegularFile(status, installed.destination);
        } else {
          assertStagedRegularFileLink(status, installed.destination);
          await this.#filesystem.assertScaffoldChild(transaction, "stage");
          const stagePath = join(transaction.stageRoot, stage.name);
          const stageStatus = await lstat(stagePath, { bigint: true });
          assertStagedRegularFileLink(stageStatus, stagePath);
          assertSameIdentity(stageStatus, stage, stagePath);
          await unlink(stagePath);
          journal.scaffoldFiles.delete(stageKey);
          const detached = await lstat(installed.destination, { bigint: true });
          assertSinglyLinkedRegularFile(detached, installed.destination);
          assertSameIdentity(detached, installed, installed.destination);
        }
        await unlink(installed.destination);
      } catch (error) {
        errors.push(error);
      }
    }
    for (let index = journal.backups.length - 1; index >= 0; index -= 1) {
      const backup = journal.backups[index]!;
      try {
        this.#context.hit(`batch:rollback:before-restore-backup:${index}`);
        if ((await lstatOrNull(backup.destination)) !== null) {
          throw repositoryExternalChange(
            `rollback destination was recreated: ${backup.destination}`,
          );
        }
        this.#context.hit(`batch:rollback:before-restore-link:${index}`);
        await this.#assertRepositoryTarget(
          backup.destination,
          backup.existing.relativePath,
          journal.directories,
          "absent",
        );
        await this.#context.assertOwnedFileContent(
          backup.backup,
          backup.existing,
          backup.existing.relativePath,
        );
        const status = await lstat(backup.backup, { bigint: true });
        assertSinglyLinkedRegularFile(status, backup.backup);
        assertSameIdentity(status, backup, backup.backup);
        await link(backup.backup, backup.destination);
        const linked = await lstat(backup.destination, { bigint: true });
        assertStagedRegularFileLink(linked, backup.destination);
        assertSameIdentity(linked, backup, backup.destination);
        await unlink(backup.backup);
        journal.scaffoldFiles.delete(scaffoldFileKey(backup));
        const restored = await lstat(backup.destination, { bigint: true });
        assertSinglyLinkedRegularFile(restored, backup.destination);
        assertSameIdentity(restored, backup, backup.destination);
        this.#context.hit(`batch:rollback:before-verify-restored:${index}`);
        await this.#context.assertOwnedFileContent(
          backup.destination,
          backup.existing,
          backup.existing.relativePath,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    errors.push(...(await this.#rollbackDirectories(journal.directories)));
    if (errors.length === 0) {
      const cleanup = await this.#filesystem.removeTransaction(transaction, [
        ...journal.scaffoldFiles.values(),
      ]);
      if (cleanup.failed) errors.push(cleanup.error);
    }
    return errors;
  }

  async #rollbackDirectories(
    directories: readonly CreatedDirectoryJournal[],
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const directory = directories[index]!;
      try {
        this.#context.hit(`directory:rollback:before-remove:${index}`);
        await this.#assertRepositoryTarget(
          directory.absolutePath,
          directory.relativePath,
          directories,
          "owned",
        );
        const status = await lstat(directory.absolutePath, { bigint: true });
        assertSameIdentity(status, directory, directory.relativePath);
        assertDirectory(status, directory.relativePath);
        await rmdir(directory.absolutePath);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  #applyLedger(createLedger: () => CommittedRepositoryLedger): RemovalResult {
    try {
      const ledger = createLedger();
      const result = this.#context.applyCommittedLedger(ledger);
      if (result !== undefined) {
        throw new TypeError("repository ledger callback must be synchronous");
      }
      return Object.freeze({ failed: false });
    } catch (error) {
      return Object.freeze({ failed: true, error });
    }
  }
}

function scaffoldFileKey(
  file: Pick<TransactionScaffoldFile, "child" | "name">,
): string {
  return `${file.child}/${file.name}`;
}
