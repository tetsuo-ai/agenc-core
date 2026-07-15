// The launcher owns the lock implementation because it must serialize runtime
// installation before @tetsuo-ai/runtime exists. The runtime bundles that same
// reviewed implementation so both entry points share one algorithm and the
// process-wide Symbol.for registry instead of maintaining security-sensitive
// copies that can drift.

import type { DatabaseSync } from "node:sqlite";
import {
  acquireLocalSqliteLock as acquireLocalSqliteLockImplementation,
  acquireLocalSqliteLocks as acquireLocalSqliteLocksImplementation,
  assertLocalPrivateDirectory as assertLocalPrivateDirectoryImplementation,
  assertLocalPrivateFile as assertLocalPrivateFileImplementation,
  configureLocalSqliteLockConnection as configureLocalSqliteLockConnectionImplementation,
  isSqliteBusyError as isSqliteBusyErrorImplementation,
} from "../../../packages/agenc/lib/sqlite-lock.mjs";

export interface LocalSqliteLockOptions {
  readonly timeoutMs?: number;
  readonly label?: string;
  /** Shared monotonic deadline for a fixed-order sequence of lock calls. */
  readonly deadline?: number;
  /** Permit a root/current-user-owned sticky directory as the validated leaf. */
  readonly allowTrustedStickyLeaf?: boolean;
}

export type LocalSqliteLockRelease = () => void;

export async function acquireLocalSqliteLocks(
  requestedPaths: readonly string[],
  options?: LocalSqliteLockOptions,
): Promise<LocalSqliteLockRelease> {
  return acquireLocalSqliteLocksImplementation(requestedPaths, options);
}

export async function acquireLocalSqliteLock(
  path: string,
  options?: LocalSqliteLockOptions,
): Promise<LocalSqliteLockRelease> {
  return acquireLocalSqliteLockImplementation(path, options);
}

export async function assertLocalPrivateDirectory(
  path: string,
  options?: LocalSqliteLockOptions,
): Promise<string> {
  return assertLocalPrivateDirectoryImplementation(path, options);
}

export async function assertLocalPrivateFile(
  path: string,
  options?: LocalSqliteLockOptions,
): Promise<string> {
  return assertLocalPrivateFileImplementation(path, options);
}

export function configureLocalSqliteLockConnection(
  database: DatabaseSync,
): void {
  configureLocalSqliteLockConnectionImplementation(database);
}

export function isSqliteBusyError(error: unknown): boolean {
  return isSqliteBusyErrorImplementation(error);
}
