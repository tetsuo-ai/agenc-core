import type { DatabaseSync } from "node:sqlite";

export interface LocalSqliteLockOptions {
  readonly timeoutMs?: number;
  readonly label?: string;
  readonly deadline?: number;
  /** Permit a root/current-user-owned sticky directory as the validated leaf. */
  readonly allowTrustedStickyLeaf?: boolean;
}

export type LocalSqliteLockRelease = () => void;

export class LocalSqliteLockTimeoutError extends Error {
  readonly code: "AGENC_LOCK_TIMEOUT";
  readonly path: string;
  readonly label: string;
  readonly timeoutMs: number;
}

export function acquireLocalSqliteLocks(
  requestedPaths: readonly string[],
  options?: LocalSqliteLockOptions,
): Promise<LocalSqliteLockRelease>;

export function acquireLocalSqliteLock(
  path: string,
  options?: LocalSqliteLockOptions,
): Promise<LocalSqliteLockRelease>;

export function assertLocalPrivateDirectory(
  path: string,
  options?: LocalSqliteLockOptions,
): Promise<string>;

export function assertLocalPrivateFile(
  path: string,
  options?: LocalSqliteLockOptions,
): Promise<string>;

export function configureLocalSqliteLockConnection(
  database: DatabaseSync,
): void;

export function isSqliteBusyError(error: unknown): boolean;
