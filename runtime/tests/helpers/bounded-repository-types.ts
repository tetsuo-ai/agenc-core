import type { PortableRepositoryPathLimits } from "./portable-repository-path.js";

export interface BoundedRepositoryLimits extends PortableRepositoryPathLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxGitOutputBytes: number;
  readonly maxGitWallMs: number;
}

export interface BoundedRepositoryUsage {
  readonly entries: number;
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly totalBytes: number;
}

export interface MutableRepositoryUsage {
  entries: number;
  files: number;
  directories: number;
  symlinks: number;
  totalBytes: number;
}

export interface BoundedRepositoryByteWrite {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface BoundedTempRepository {
  readonly root: string;
  readonly limits: BoundedRepositoryLimits;

  usage(): BoundedRepositoryUsage;
  resolve(relativePath: string): string;
  makeDirectory(relativePath: string): Promise<void>;
  writeBytes(relativePath: string, bytes: Uint8Array): Promise<void>;
  writeBytesBatch(writes: readonly BoundedRepositoryByteWrite[]): Promise<void>;
  readBytes(relativePath: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  createSymlink(
    linkPath: string,
    target: string,
    kind: "file" | "directory",
  ): Promise<"created" | "unsupported">;

  initGit(): Promise<void>;
  gitAdd(paths: readonly string[]): Promise<void>;
  gitCommit(message: string): Promise<string>;
  gitHead(): Promise<string>;
  gitStatus(): Promise<string>;

  cleanup(): Promise<void>;
}

export interface BoundedRepositoryTestHooks {
  hit(checkpoint: string): void;
}

export type BoundedRepositoryErrorCode =
  | "cleaned"
  | "committed_cleanup"
  | "external_change"
  | "git"
  | "invalid_input"
  | "poisoned"
  | "quota"
  | "rollback";

export class BoundedRepositoryError extends Error {
  readonly code: BoundedRepositoryErrorCode;
  readonly committed: boolean;

  constructor(
    code: BoundedRepositoryErrorCode,
    message: string,
    options: ErrorOptions & { readonly committed?: boolean } = {},
  ) {
    super(message, options);
    this.name = "BoundedRepositoryError";
    this.code = code;
    this.committed = options.committed ?? false;
  }
}

export function invalidRepositoryInput(
  message: string,
): BoundedRepositoryError {
  return new BoundedRepositoryError("invalid_input", message);
}

export function repositoryQuotaError(message: string): BoundedRepositoryError {
  return new BoundedRepositoryError("quota", message);
}

export function repositoryExternalChange(
  label: string,
): BoundedRepositoryError {
  return new BoundedRepositoryError(
    "external_change",
    `bounded repository detected an external change: ${label}`,
  );
}
