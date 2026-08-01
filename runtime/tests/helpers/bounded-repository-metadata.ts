import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

import { readBoundedRegularFile } from "./bounded-file-io.js";
import {
  BoundedRepositoryGit,
  BoundedRepositoryGitError,
} from "./bounded-repository-git.js";
import {
  assertContainedPath,
  assertDirectory,
  assertSameIdentity,
  assertSinglyLinkedRegularFile,
  type FileIdentity,
  identityFromStatus,
  lstatOrNull,
  readBoundedDirectoryNames,
} from "./bounded-repository-filesystem.js";
import {
  digestBytes,
  MAX_GIT_COMMIT_COUNT,
} from "./bounded-repository-policy.js";
import {
  BoundedRepositoryError,
  invalidRepositoryInput,
  repositoryExternalChange,
  repositoryQuotaError,
} from "./bounded-repository-types.js";
import {
  portablePathIdentity,
  type PortableRepositoryPathLimits,
} from "./portable-repository-path.js";

export const GIT_METADATA_DIRECTORY = ".git";

const MAX_GIT_CONFIG_BYTES = 65_536;
const MAX_GIT_METADATA_ENTRIES = 100_000;
const MAX_GIT_METADATA_FILE_BYTES = 67_108_864;
const MAX_GIT_METADATA_TOTAL_BYTES = 268_435_456;

export class BoundedRepositoryMetadata {
  readonly #root: string;

  #initialized = false;
  #directoryIdentity: FileIdentity | undefined;
  #configIdentity: FileIdentity | undefined;
  #configDigest: string | undefined;

  constructor(root: string) {
    this.#root = root;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  async assertAbsent(): Promise<void> {
    if (
      this.#initialized ||
      (await lstatOrNull(join(this.#root, GIT_METADATA_DIRECTORY))) !== null
    ) {
      throw invalidRepositoryInput("repository Git metadata already exists");
    }
  }

  async capture(): Promise<void> {
    const gitDirectory = join(this.#root, GIT_METADATA_DIRECTORY);
    const gitConfig = join(gitDirectory, "config");
    const directoryStatus = await lstat(gitDirectory, { bigint: true });
    const configStatus = await lstat(gitConfig, { bigint: true });
    assertDirectory(directoryStatus, "repository Git directory");
    assertSinglyLinkedRegularFile(configStatus, "repository local Git config");
    if ((await realpath(gitDirectory)) !== gitDirectory) {
      throw repositoryExternalChange("repository Git directory canonical path");
    }
    const configBytes = await readBoundedRegularFile(gitConfig, {
      byteLimit: MAX_GIT_CONFIG_BYTES,
      label: "repository local Git config",
    });
    await this.#assertBoundedTree(gitDirectory);
    this.#directoryIdentity = identityFromStatus(directoryStatus);
    this.#configIdentity = identityFromStatus(configStatus);
    this.#configDigest = digestBytes(configBytes);
    this.#initialized = true;
  }

  async assertIdentity(): Promise<void> {
    if (
      !this.#initialized ||
      this.#directoryIdentity === undefined ||
      this.#configIdentity === undefined ||
      this.#configDigest === undefined
    ) {
      throw invalidRepositoryInput(
        "repository Git metadata is not initialized",
      );
    }
    const gitDirectory = join(this.#root, GIT_METADATA_DIRECTORY);
    const gitConfig = join(gitDirectory, "config");
    const directoryStatus = await lstat(gitDirectory, { bigint: true });
    const configStatus = await lstat(gitConfig, { bigint: true });
    assertDirectory(directoryStatus, "repository Git directory");
    assertSameIdentity(
      directoryStatus,
      this.#directoryIdentity,
      "repository Git directory",
    );
    assertSinglyLinkedRegularFile(configStatus, "repository local Git config");
    assertSameIdentity(
      configStatus,
      this.#configIdentity,
      "repository local Git config",
    );
    if ((await realpath(gitDirectory)) !== gitDirectory) {
      throw repositoryExternalChange("repository Git directory canonical path");
    }
    const configBytes = await readBoundedRegularFile(gitConfig, {
      byteLimit: MAX_GIT_CONFIG_BYTES,
      label: "repository local Git config",
    });
    if (digestBytes(configBytes) !== this.#configDigest) {
      throw repositoryExternalChange("repository local Git config contents");
    }
    await this.#assertBoundedTree(gitDirectory);
  }

  async #assertBoundedTree(gitRoot: string): Promise<void> {
    const directories = [gitRoot];
    let directoryIndex = 0;
    let entryCount = 0;
    let totalBytes = 0;
    while (directoryIndex < directories.length) {
      const directory = directories[directoryIndex++]!;
      const canonicalDirectory = await realpath(directory);
      assertContainedPath(
        gitRoot,
        canonicalDirectory,
        "Git metadata directory",
      );
      const names = await readBoundedDirectoryNames(
        directory,
        MAX_GIT_METADATA_ENTRIES - entryCount,
        "repository Git metadata",
      );
      for (const name of names) {
        entryCount += 1;
        const path = join(directory, name);
        const relativeMetadataPath = relative(gitRoot, path)
          .split(/[\\/]+/u)
          .join("/");
        if (isRedirectingMetadata(relativeMetadataPath)) {
          throw repositoryExternalChange(
            `redirect-capable Git metadata ${relativeMetadataPath}`,
          );
        }
        const status = await lstat(path, { bigint: true });
        if (status.isSymbolicLink()) {
          throw repositoryExternalChange(`Git metadata symlink ${path}`);
        }
        if (status.isDirectory()) {
          directories.push(path);
          continue;
        }
        assertSinglyLinkedRegularFile(status, `Git metadata file ${path}`);
        const fileBytes = Number(status.size);
        if (
          !Number.isSafeInteger(fileBytes) ||
          fileBytes > MAX_GIT_METADATA_FILE_BYTES ||
          totalBytes > MAX_GIT_METADATA_TOTAL_BYTES - fileBytes
        ) {
          throw repositoryQuotaError(
            "repository Git metadata exceeds its byte limit",
          );
        }
        totalBytes += fileBytes;
      }
    }
  }
}

export interface PreparedOwnedGitPath {
  readonly relativePath: string;
  readonly portableIdentity: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly audit: () => Promise<void>;
}

/** Coordinate Git state, bounded path auditing, and failure classification. */
export class BoundedRepositoryGitMetadata {
  readonly #root: string;
  readonly #pathLimits: PortableRepositoryPathLimits;
  readonly #metadata: BoundedRepositoryMetadata;
  readonly #git: BoundedRepositoryGit;
  readonly #assertMutableRoot: () => Promise<void>;
  readonly #assertReadableRoot: () => Promise<void>;
  readonly #assertControlIdentity: () => Promise<void>;
  readonly #prepareOwnedPath: (
    relativePath: string,
  ) => Promise<PreparedOwnedGitPath>;
  readonly #poison: () => void;
  readonly #hit: (checkpoint: string) => void;

  #commitCount = 0;
  #unprovenGitSurvivor = false;

  constructor(options: {
    readonly allocationRoot: string;
    readonly repositoryRoot: string;
    readonly controlRoot: string;
    readonly maxOutputBytes: number;
    readonly maxWallMs: number;
    readonly pathLimits: PortableRepositoryPathLimits;
    readonly metadata: BoundedRepositoryMetadata;
    readonly assertMutableRoot: () => Promise<void>;
    readonly assertReadableRoot: () => Promise<void>;
    readonly assertControlIdentity: () => Promise<void>;
    readonly prepareOwnedPath: (
      relativePath: string,
    ) => Promise<PreparedOwnedGitPath>;
    readonly poison: () => void;
    readonly hit: (checkpoint: string) => void;
  }) {
    this.#root = options.repositoryRoot;
    this.#pathLimits = options.pathLimits;
    this.#metadata = options.metadata;
    this.#assertMutableRoot = options.assertMutableRoot;
    this.#assertReadableRoot = options.assertReadableRoot;
    this.#assertControlIdentity = options.assertControlIdentity;
    this.#prepareOwnedPath = options.prepareOwnedPath;
    this.#poison = options.poison;
    this.#hit = options.hit;
    this.#git = new BoundedRepositoryGit({
      allocationRoot: options.allocationRoot,
      repositoryRoot: options.repositoryRoot,
      controlRoot: options.controlRoot,
      maxOutputBytes: options.maxOutputBytes,
      maxWallMs: options.maxWallMs,
    });
  }

  get unprovenGitSurvivor(): boolean {
    return this.#unprovenGitSurvivor;
  }

  async initialize(): Promise<void> {
    await this.#assertMutableRoot();
    await this.#metadata.assertAbsent();
    await this.#assertControlIdentity();
    try {
      await this.#git.initialize();
    } catch (error) {
      this.#recordFailure(error, false);
      if (
        (await lstatOrNull(join(this.#root, GIT_METADATA_DIRECTORY))) !== null
      ) {
        this.#poison();
      }
      throw error;
    }
    try {
      await this.#metadata.capture();
    } catch (error) {
      this.#poison();
      throw new BoundedRepositoryError(
        "committed_cleanup",
        "Git repository initialized but metadata verification failed",
        { cause: error, committed: true },
      );
    }
  }

  async add(paths: readonly string[]): Promise<void> {
    await this.#assertMutableRoot();
    await this.#prepareInvocation();
    const identities = new Set<string>();
    for (const path of paths) {
      const identity = portablePathIdentity(path, this.#pathLimits);
      if (identities.has(identity)) {
        throw invalidRepositoryInput(
          `gitAdd contains duplicate portable path ${path}`,
        );
      }
      identities.add(identity);
    }

    const prepared: PreparedOwnedGitPath[] = [];
    for (const path of paths) prepared.push(await this.#prepareOwnedPath(path));
    const minimalPaths = collapseGitPaths(prepared);
    const minimalRelativePaths = minimalPaths.map((path) => path.relativePath);
    this.#git.validateAddInvocation(minimalRelativePaths);
    try {
      this.#hit("git-add:before-supervised-run");
    } catch (error) {
      this.#recordFailure(error, true);
      throw error;
    }
    await this.#prepareInvocation();
    for (const path of minimalPaths) {
      this.#hit(`git-add:before-content-audit:${path.relativePath}`);
      await path.audit();
    }
    try {
      await this.#git.add(minimalRelativePaths);
    } catch (error) {
      this.#recordFailure(error, true);
      throw error;
    }
  }

  async commit(message: string): Promise<string> {
    await this.#assertMutableRoot();
    await this.#prepareInvocation();
    if (this.#commitCount >= MAX_GIT_COMMIT_COUNT) {
      throw repositoryQuotaError("repository exceeds its Git commit limit");
    }
    this.#git.validateCommitInvocation(message);
    try {
      this.#hit("git-commit:before-supervised-run");
    } catch (error) {
      this.#recordFailure(error, true);
      throw error;
    }
    await this.#prepareInvocation();
    try {
      const result = await this.#git.commitAndReadHead(message);
      this.#commitCount += 1;
      return result.head;
    } catch (error) {
      if (error instanceof BoundedRepositoryError && error.committed) {
        this.#commitCount += 1;
      }
      this.#recordFailure(error, true);
      if (error instanceof BoundedRepositoryError && error.committed) {
        throw new BoundedRepositoryError(
          "committed_cleanup",
          "Git commit succeeded but HEAD verification failed",
          { cause: error, committed: true },
        );
      }
      throw error;
    }
  }

  async head(): Promise<string> {
    await this.#assertReadableRoot();
    await this.#prepareInvocation();
    try {
      return await this.#git.readHead();
    } catch (error) {
      this.#recordFailure(error, false);
      throw error;
    }
  }

  async status(): Promise<string> {
    await this.#assertReadableRoot();
    await this.#prepareInvocation();
    try {
      return await this.#git.readStatus();
    } catch (error) {
      this.#recordFailure(error, false);
      throw error;
    }
  }

  async #prepareInvocation(): Promise<void> {
    await this.#assertControlIdentity();
    await this.#metadata.assertIdentity();
  }

  #recordFailure(error: unknown, mutatesRepository: boolean): void {
    if (
      error instanceof BoundedRepositoryGitError &&
      error.processState === "survivors_unproven"
    ) {
      this.#unprovenGitSurvivor = true;
      this.#poison();
    }
    if (
      mutatesRepository ||
      (error instanceof BoundedRepositoryError && error.committed)
    ) {
      this.#poison();
    }
  }
}

function collapseGitPaths(
  paths: readonly PreparedOwnedGitPath[],
): readonly PreparedOwnedGitPath[] {
  const directoryIdentities = new Set(
    paths
      .filter((path) => path.kind === "directory")
      .map((path) => path.portableIdentity),
  );
  return paths.filter(
    (path) => !hasRequestedDirectoryAncestor(path, directoryIdentities),
  );
}

function hasRequestedDirectoryAncestor(
  path: PreparedOwnedGitPath,
  directoryIdentities: ReadonlySet<string>,
): boolean {
  let separator = path.portableIdentity.lastIndexOf("/");
  while (separator >= 0) {
    if (directoryIdentities.has(path.portableIdentity.slice(0, separator))) {
      return true;
    }
    separator = path.portableIdentity.lastIndexOf("/", separator - 1);
  }
  return false;
}

function isRedirectingMetadata(relativePath: string): boolean {
  return (
    relativePath === "commondir" ||
    relativePath.endsWith("/commondir") ||
    relativePath === "objects/info/alternates" ||
    relativePath === "objects/info/http-alternates"
  );
}
