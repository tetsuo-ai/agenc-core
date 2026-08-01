import { randomBytes, randomUUID } from "node:crypto";
import { type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBoundedRegularFile } from "./bounded-file-io.js";
import {
  assertDirectory,
  assertSameIdentity,
  assertSinglyLinkedRegularFile,
  type FileIdentity,
  identityFromStatus,
  lstatOrNull,
  readBoundedDirectoryNames,
  removePath,
} from "./bounded-repository-filesystem.js";
import {
  BoundedRepositoryError,
  repositoryExternalChange,
} from "./bounded-repository-types.js";

const ALLOCATION_PREFIX = "agenc-fnd-allocation-";
const REPOSITORY_DIRECTORY = "repository";
const CONTROL_DIRECTORY = "control";
const QUARANTINE_PREFIX = "quarantine-";
const OWNER_MARKER = "owner";
const EMPTY_GIT_CONFIG = "gitconfig";
const GIT_EXCLUDES_FILE = "git-excludes";
const EMPTY_HOOKS_DIRECTORY = "hooks";
export const EMPTY_GIT_TEMPLATES_DIRECTORY = "templates";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OWNER_TOKEN_BYTES = 32;
const CONTROL_FILE_BYTE_LIMIT = 1;
const CONTROL_ENTRY_NAMES = Object.freeze([
  EMPTY_GIT_CONFIG,
  GIT_EXCLUDES_FILE,
  EMPTY_HOOKS_DIRECTORY,
  EMPTY_GIT_TEMPLATES_DIRECTORY,
]);

export interface BoundedRepositoryAllocation {
  readonly allocation: string;
  readonly allocationIdentity: FileIdentity;
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly controlIdentity: FileIdentity;
  readonly hooksIdentity: FileIdentity;
  readonly templatesIdentity: FileIdentity;
  readonly gitConfigIdentity: FileIdentity;
  readonly gitExcludesIdentity: FileIdentity;
  readonly ownerMarkerIdentity: FileIdentity;
  readonly ownerToken: Buffer;
}

export interface BoundedRepositoryCleanupOptions {
  readonly unprovenGitSurvivor: boolean;
  readonly hit: (checkpoint: string) => void;
  readonly onRootQuarantined: () => void;
}

export class BoundedRepositoryLifecycle {
  readonly allocation: string;
  readonly root: string;
  readonly controlRoot: string;

  readonly #allocationIdentity: FileIdentity;
  readonly #rootIdentity: FileIdentity;
  readonly #controlIdentity: FileIdentity;
  readonly #hooksIdentity: FileIdentity;
  readonly #templatesIdentity: FileIdentity;
  readonly #gitConfigIdentity: FileIdentity;
  readonly #gitExcludesIdentity: FileIdentity;
  readonly #ownerMarkerIdentity: FileIdentity;
  readonly #ownerToken: Buffer;

  #quarantinePath: string | undefined;
  #controlQuarantinePath: string | undefined;
  #quarantineRemoved = false;
  #controlRemoved = false;
  #allocationMarkerRemoved = false;
  #cleaned = false;

  constructor(allocation: BoundedRepositoryAllocation) {
    this.allocation = allocation.allocation;
    this.root = allocation.root;
    this.controlRoot = join(this.allocation, CONTROL_DIRECTORY);
    this.#allocationIdentity = allocation.allocationIdentity;
    this.#rootIdentity = allocation.rootIdentity;
    this.#controlIdentity = allocation.controlIdentity;
    this.#hooksIdentity = allocation.hooksIdentity;
    this.#templatesIdentity = allocation.templatesIdentity;
    this.#gitConfigIdentity = allocation.gitConfigIdentity;
    this.#gitExcludesIdentity = allocation.gitExcludesIdentity;
    this.#ownerMarkerIdentity = allocation.ownerMarkerIdentity;
    this.#ownerToken = Buffer.from(allocation.ownerToken);
  }

  async assertRootIdentity(): Promise<void> {
    await this.assertAllocation();
    const status = await lstat(this.root, { bigint: true });
    assertDirectory(status, "repository root");
    assertSameIdentity(status, this.#rootIdentity, "repository root");
    if ((await realpath(this.root)) !== this.root) {
      throw repositoryExternalChange("repository root");
    }
  }

  async assertAllocation(): Promise<void> {
    await this.assertAllocationIdentity();
    const markerPath = join(this.allocation, OWNER_MARKER);
    this.#assertOwnerMarkerStatus(await lstat(markerPath, { bigint: true }));
    const marker = await readBoundedRegularFile(markerPath, {
      byteLimit: OWNER_TOKEN_BYTES,
      label: "repository owner marker",
    });
    this.#assertOwnerMarkerStatus(await lstat(markerPath, { bigint: true }));
    if (!marker.equals(this.#ownerToken)) {
      throw repositoryExternalChange("repository owner marker");
    }
  }

  async assertAllocationIdentity(): Promise<void> {
    const status = await lstat(this.allocation, { bigint: true });
    assertDirectory(status, "repository allocation");
    assertSameIdentity(
      status,
      this.#allocationIdentity,
      "repository allocation",
    );
  }

  async assertControlIdentity(): Promise<void> {
    await this.assertControlRootIdentity();
    const hooks = join(this.controlRoot, EMPTY_HOOKS_DIRECTORY);
    const templates = join(this.controlRoot, EMPTY_GIT_TEMPLATES_DIRECTORY);
    const gitConfig = join(this.controlRoot, EMPTY_GIT_CONFIG);
    const gitExcludes = join(this.controlRoot, GIT_EXCLUDES_FILE);
    const hooksStatus = await lstat(hooks, { bigint: true });
    const templatesStatus = await lstat(templates, { bigint: true });
    const gitConfigStatus = await lstat(gitConfig, { bigint: true });
    const gitExcludesStatus = await lstat(gitExcludes, { bigint: true });
    assertDirectory(hooksStatus, "repository Git hooks directory");
    assertSameIdentity(
      hooksStatus,
      this.#hooksIdentity,
      "repository Git hooks directory",
    );
    assertDirectory(templatesStatus, "repository Git templates directory");
    assertSameIdentity(
      templatesStatus,
      this.#templatesIdentity,
      "repository Git templates directory",
    );
    assertSinglyLinkedRegularFile(
      gitConfigStatus,
      "repository Git config file",
    );
    assertSameIdentity(
      gitConfigStatus,
      this.#gitConfigIdentity,
      "repository Git config file",
    );
    assertSinglyLinkedRegularFile(
      gitExcludesStatus,
      "repository Git excludes file",
    );
    assertSameIdentity(
      gitExcludesStatus,
      this.#gitExcludesIdentity,
      "repository Git excludes file",
    );
    const [configBytes, excludesBytes] = await Promise.all([
      readBoundedRegularFile(gitConfig, {
        byteLimit: CONTROL_FILE_BYTE_LIMIT,
        label: "repository Git config file",
      }),
      readBoundedRegularFile(gitExcludes, {
        byteLimit: CONTROL_FILE_BYTE_LIMIT,
        label: "repository Git excludes file",
      }),
    ]);
    if (configBytes.byteLength !== 0 || excludesBytes.byteLength !== 0) {
      throw repositoryExternalChange("repository Git control contents");
    }
    const [controlNames, hookNames, templateNames] = await Promise.all([
      readBoundedDirectoryNames(
        this.controlRoot,
        CONTROL_ENTRY_NAMES.length,
        "repository control directory",
      ),
      readBoundedDirectoryNames(hooks, 0, "repository Git hooks directory"),
      readBoundedDirectoryNames(
        templates,
        0,
        "repository Git templates directory",
      ),
    ]);
    if (
      controlNames.length !== CONTROL_ENTRY_NAMES.length ||
      CONTROL_ENTRY_NAMES.some((name) => !controlNames.includes(name)) ||
      hookNames.length !== 0 ||
      templateNames.length !== 0
    ) {
      throw repositoryExternalChange("repository Git control inventory");
    }
  }

  async assertControlRootIdentity(): Promise<void> {
    await this.assertAllocationIdentity();
    const status = await lstat(this.controlRoot, { bigint: true });
    assertDirectory(status, "repository control directory");
    assertSameIdentity(
      status,
      this.#controlIdentity,
      "repository control directory",
    );
    if ((await realpath(this.controlRoot)) !== this.controlRoot) {
      throw repositoryExternalChange(
        "repository control directory canonical path",
      );
    }
  }

  async cleanup(options: BoundedRepositoryCleanupOptions): Promise<void> {
    if (this.#cleaned) return;
    if (options.unprovenGitSurvivor) {
      throw new BoundedRepositoryError(
        "poisoned",
        "repository cleanup is unsafe because Git process cleanup is unproven",
      );
    }
    if (this.#allocationMarkerRemoved) await this.assertAllocationIdentity();
    else await this.assertAllocation();

    if (this.#quarantinePath === undefined) {
      await this.assertRootIdentity();
      this.#quarantinePath = await this.#quarantineOwnedDirectory(
        this.root,
        this.#rootIdentity,
        "repository root",
      );
      options.onRootQuarantined();
      this.#assertDirectoryIdentity(
        await lstat(this.#quarantinePath, { bigint: true }),
        this.#rootIdentity,
        "quarantined repository root",
      );
      options.hit("cleanup:after-quarantine");
    }
    if (!this.#quarantineRemoved) {
      await this.#removeQuarantinedDirectory(
        this.#quarantinePath,
        this.#rootIdentity,
        "quarantined repository",
        "cleanup:before-repository-remove",
        "cleanup:after-repository-remove-before-verify",
        options.hit,
        () => {
          this.#quarantineRemoved = true;
        },
      );
    }
    if (!this.#controlRemoved) {
      this.#controlQuarantinePath ??= await this.#quarantineOwnedDirectory(
        this.controlRoot,
        this.#controlIdentity,
        "repository control directory",
      );
      await this.#removeQuarantinedDirectory(
        this.#controlQuarantinePath,
        this.#controlIdentity,
        "quarantined repository control",
        "cleanup:before-control-remove",
        "cleanup:after-control-remove-before-verify",
        options.hit,
        () => {
          this.#controlRemoved = true;
        },
      );
    }
    if (!this.#allocationMarkerRemoved) {
      const markerPath = join(this.allocation, OWNER_MARKER);
      this.#assertOwnerMarkerStatus(await lstat(markerPath, { bigint: true }));
      await unlink(markerPath);
      this.#allocationMarkerRemoved = true;
    }
    try {
      await rmdir(this.allocation);
    } catch (error) {
      throw new BoundedRepositoryError(
        "external_change",
        "private repository allocation is not empty after quarantine cleanup",
        { cause: error },
      );
    }
    this.#cleaned = true;
  }

  async #quarantineOwnedDirectory(
    source: string,
    identity: FileIdentity,
    label: string,
  ): Promise<string> {
    await this.assertAllocationIdentity();
    this.#assertDirectoryIdentity(
      await lstat(source, { bigint: true }),
      identity,
      label,
    );
    const quarantine = join(
      this.allocation,
      `${QUARANTINE_PREFIX}${randomUUID()}`,
    );
    await rename(source, quarantine);
    return quarantine;
  }

  async #removeQuarantinedDirectory(
    path: string,
    identity: FileIdentity,
    label: string,
    beforeCheckpoint: string,
    afterCheckpoint: string,
    hit: (checkpoint: string) => void,
    markRemoved: () => void,
  ): Promise<void> {
    let status = await lstatOrNull(path);
    if (status === null) throw repositoryExternalChange(`${label} is missing`);
    this.#assertDirectoryIdentity(status, identity, label);
    hit(beforeCheckpoint);
    status = await lstatOrNull(path);
    if (status === null) {
      throw repositoryExternalChange(`${label} is missing before removal`);
    }
    this.#assertDirectoryIdentity(status, identity, `${label} before removal`);
    await rm(path, { recursive: true, force: false });
    markRemoved();
    hit(afterCheckpoint);
    if ((await lstatOrNull(path)) !== null) {
      throw repositoryExternalChange(`${label} was recreated after removal`);
    }
  }

  #assertOwnerMarkerStatus(status: BigIntStats): void {
    assertSinglyLinkedRegularFile(status, "repository owner marker");
    assertSameIdentity(
      status,
      this.#ownerMarkerIdentity,
      "repository owner marker",
    );
  }

  #assertDirectoryIdentity(
    status: BigIntStats,
    identity: FileIdentity,
    label: string,
  ): void {
    assertDirectory(status, label);
    assertSameIdentity(status, identity, label);
  }
}

export async function createBoundedRepositoryAllocation(): Promise<BoundedRepositoryAllocation> {
  const temporaryBase = await realpath(tmpdir());
  const allocation = await mkdtemp(join(temporaryBase, ALLOCATION_PREFIX));
  try {
    if ((await realpath(allocation)) !== allocation) {
      throw new Error("temporary repository allocation is not canonical");
    }
    const allocationStatus = await lstat(allocation, { bigint: true });
    const ownerToken = randomBytes(OWNER_TOKEN_BYTES);
    const ownerMarker = join(allocation, OWNER_MARKER);
    await writeFile(ownerMarker, ownerToken, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    const ownerMarkerStatus = await lstat(ownerMarker, { bigint: true });
    const root = join(allocation, REPOSITORY_DIRECTORY);
    await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
    const rootStatus = await lstat(root, { bigint: true });
    const control = join(allocation, CONTROL_DIRECTORY);
    await mkdir(control, { mode: PRIVATE_DIRECTORY_MODE });
    const controlStatus = await lstat(control, { bigint: true });
    const hooksDirectory = join(control, EMPTY_HOOKS_DIRECTORY);
    await mkdir(hooksDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    const hooksStatus = await lstat(hooksDirectory, { bigint: true });
    const templatesDirectory = join(control, EMPTY_GIT_TEMPLATES_DIRECTORY);
    await mkdir(templatesDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    const templatesStatus = await lstat(templatesDirectory, { bigint: true });
    const gitConfig = join(control, EMPTY_GIT_CONFIG);
    await writeFile(gitConfig, "", { flag: "wx", mode: PRIVATE_FILE_MODE });
    const gitConfigStatus = await lstat(gitConfig, { bigint: true });
    const gitExcludes = join(control, GIT_EXCLUDES_FILE);
    await writeFile(gitExcludes, "", { flag: "wx", mode: PRIVATE_FILE_MODE });
    const gitExcludesStatus = await lstat(gitExcludes, { bigint: true });
    return Object.freeze({
      allocation,
      allocationIdentity: identityFromStatus(allocationStatus),
      root,
      rootIdentity: identityFromStatus(rootStatus),
      controlIdentity: identityFromStatus(controlStatus),
      hooksIdentity: identityFromStatus(hooksStatus),
      templatesIdentity: identityFromStatus(templatesStatus),
      gitConfigIdentity: identityFromStatus(gitConfigStatus),
      gitExcludesIdentity: identityFromStatus(gitExcludesStatus),
      ownerMarkerIdentity: identityFromStatus(ownerMarkerStatus),
      ownerToken: Buffer.from(ownerToken),
    });
  } catch (error) {
    const cleanup = await removePath(allocation);
    if (cleanup.failed) {
      throw new AggregateError(
        [error, cleanup.error],
        "bounded repository creation failed and cleanup was incomplete",
      );
    }
    throw error;
  }
}
