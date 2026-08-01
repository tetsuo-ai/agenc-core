import { type BigIntStats } from "node:fs";

import {
  type FileIdentity,
  type OwnedRepositoryEntry,
  type OwnedRepositoryEntryKind,
  type RemovalResult,
} from "./bounded-repository-filesystem.js";
import {
  type MutableUsage,
  type PreparedWrite,
} from "./bounded-repository-policy.js";
import {
  BoundedRepositoryError,
  type BoundedRepositoryLimits,
} from "./bounded-repository-types.js";
import { type PortableRepositoryPathLimits } from "./portable-repository-path.js";

export interface TransactionTransientDirectory extends FileIdentity {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface CommittedRepositoryDirectory extends FileIdentity {
  readonly relativePath: string;
}

export interface CommittedRepositoryFile extends FileIdentity {
  readonly write: PreparedWrite;
}

export interface CommittedRepositoryLedger {
  readonly directories: readonly CommittedRepositoryDirectory[];
  readonly files: readonly CommittedRepositoryFile[];
  readonly usage: Readonly<MutableUsage>;
}

export interface PortableSiblingSnapshot {
  readonly entries: number;
  readonly identities: ReadonlyMap<string, string>;
}

export type PortableSiblingExpectation = "absent" | "owned";

export interface BoundedRepositoryTransactionContext {
  readonly root: string;
  readonly controlRoot: string;
  readonly limits: BoundedRepositoryLimits;
  readonly pathLimits: PortableRepositoryPathLimits;
  assertMutableRoot(): Promise<void>;
  assertControlIdentity(): Promise<void>;
  assertControlRootIdentity(): Promise<void>;
  currentUsage(): Readonly<MutableUsage>;
  ownedEntry(identity: string): OwnedRepositoryEntry | undefined;
  assertOwnedStatus(
    status: BigIntStats,
    relativePath: string,
    kind: OwnedRepositoryEntryKind,
  ): OwnedRepositoryEntry;
  assertOwnedFileContent(
    absolutePath: string,
    entry: OwnedRepositoryEntry,
    label: string,
  ): Promise<void>;
  scanPortableSiblings(
    parentAbsolutePath: string,
    parentRelativePath: string,
    maximumEntries: number,
  ): Promise<PortableSiblingSnapshot>;
  assertRepositoryMutationParents(
    absolutePath: string,
    transientDirectories: readonly TransactionTransientDirectory[],
  ): Promise<void>;
  assertPortableSiblingState(
    absolutePath: string,
    relativePath: string,
    expectation: PortableSiblingExpectation,
  ): Promise<void>;
  hit(checkpoint: string): void;
  poison(): void;
  applyCommittedLedger(ledger: CommittedRepositoryLedger): undefined;
}

export function createCommittedRepositoryLedger(
  directories: readonly CommittedRepositoryDirectory[],
  files: readonly CommittedRepositoryFile[],
  usage: Readonly<MutableUsage>,
): CommittedRepositoryLedger {
  return Object.freeze({
    directories: Object.freeze([...directories]),
    files: Object.freeze([...files]),
    usage: Object.freeze({ ...usage }),
  });
}

export function ownedRepositoryEntryIdentity(
  entry: OwnedRepositoryEntry,
): FileIdentity {
  return Object.freeze({
    device: entry.device,
    inode: entry.inode,
    mode: entry.mode,
    ownerUser: entry.ownerUser,
    ownerGroup: entry.ownerGroup,
  });
}

export function committedRepositoryFailure(
  message: string,
  errors: readonly unknown[],
): BoundedRepositoryError {
  const cause =
    errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${message}: multiple failures`);
  return new BoundedRepositoryError("committed_cleanup", message, {
    cause,
    committed: true,
  });
}

export function failedRemoval(error: unknown): RemovalResult {
  return Object.freeze({ failed: true, error });
}
