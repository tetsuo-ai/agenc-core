import {
  lstatOrNull,
  assertDirectory,
  assertSinglyLinkedRegularFile,
} from "./bounded-repository-filesystem.js";
import { dirname, join, relative, resolve } from "node:path";

import {
  assertProjectedUsage,
  type MutableUsage,
  type PreparedPath,
  type PreparedWrite,
} from "./bounded-repository-policy.js";
import {
  invalidRepositoryInput,
  repositoryExternalChange,
} from "./bounded-repository-types.js";
import { portablePathIdentity } from "./portable-repository-path.js";
import {
  type BoundedRepositoryTransactionContext,
  type PortableSiblingSnapshot,
} from "./bounded-repository-transaction-contract.js";
import {
  type OwnedRepositoryEntry,
  type OwnedRepositoryEntryKind,
} from "./bounded-repository-filesystem.js";

export interface TransactionPlannedDirectory {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface TransactionPlannedFile {
  readonly write: PreparedWrite;
  readonly absolutePath: string;
  readonly existing: OwnedRepositoryEntry | null;
}

export interface TransactionBatchPlan {
  readonly directories: readonly TransactionPlannedDirectory[];
  readonly files: readonly TransactionPlannedFile[];
  readonly projectedUsage: Readonly<MutableUsage>;
}

interface SiblingScans {
  readonly cache: Map<string, PortableSiblingSnapshot>;
  entries: number;
}

export class BoundedRepositoryTransactionPlanner {
  readonly #context: Readonly<BoundedRepositoryTransactionContext>;

  constructor(context: Readonly<BoundedRepositoryTransactionContext>) {
    this.#context = context;
  }

  planDirectories(
    path: PreparedPath,
  ): Promise<readonly TransactionPlannedDirectory[]> {
    return this.#planMissingDirectories(path.segments, createSiblingScans());
  }

  async planBatch(
    writes: readonly PreparedWrite[],
  ): Promise<TransactionBatchPlan> {
    const context = this.#context;
    const kinds = new Map<string, OwnedRepositoryEntryKind>();
    const directories: TransactionPlannedDirectory[] = [];
    const files: TransactionPlannedFile[] = [];
    const usage = { ...context.currentUsage() };
    const siblingScans = createSiblingScans();
    for (const write of writes) {
      let current = context.root;
      const parentSegments: string[] = [];
      for (const segment of write.segments.slice(0, -1)) {
        current = join(current, segment);
        parentSegments.push(segment);
        const relativePath = parentSegments.join("/");
        const identity = portablePathIdentity(relativePath, context.pathLimits);
        const planned = kinds.get(identity);
        if (planned !== undefined) {
          if (planned !== "directory") {
            throw invalidRepositoryInput(
              `repository batch traverses planned non-directory ${relativePath}`,
            );
          }
          continue;
        }
        const status = await lstatOrNull(current);
        if (status === null) {
          await this.#assertNoSiblingCollision(
            current,
            relativePath,
            siblingScans,
          );
          if (context.ownedEntry(identity) !== undefined) {
            throw repositoryExternalChange(relativePath);
          }
          kinds.set(identity, "directory");
          directories.push({ relativePath, absolutePath: current });
          usage.entries += 1;
          usage.directories += 1;
        } else {
          assertDirectory(status, relativePath);
          context.assertOwnedStatus(status, relativePath, "directory");
          kinds.set(identity, "directory");
        }
      }
      if (kinds.has(write.identity)) {
        throw invalidRepositoryInput(
          `repository batch destination collides with another path: ${write.relativePath}`,
        );
      }
      kinds.set(write.identity, "file");
      const absolutePath = resolve(context.root, ...write.segments);
      const status = await lstatOrNull(absolutePath);
      const owned = context.ownedEntry(write.identity);
      if (status === null) {
        await this.#assertNoSiblingCollision(
          absolutePath,
          write.relativePath,
          siblingScans,
        );
        if (owned !== undefined) {
          throw repositoryExternalChange(write.relativePath);
        }
        usage.entries += 1;
        usage.files += 1;
        usage.totalBytes += write.bytes.byteLength;
        files.push({ write, absolutePath, existing: null });
      } else {
        assertSinglyLinkedRegularFile(status, write.relativePath);
        const existing = context.assertOwnedStatus(
          status,
          write.relativePath,
          "file",
        );
        await context.assertOwnedFileContent(
          absolutePath,
          existing,
          write.relativePath,
        );
        usage.totalBytes += write.bytes.byteLength - existing.bytes;
        files.push({ write, absolutePath, existing });
      }
    }
    assertProjectedUsage(usage, context.limits);
    return Object.freeze({
      directories: Object.freeze(directories),
      files: Object.freeze(files),
      projectedUsage: Object.freeze(usage),
    });
  }

  async #assertNoSiblingCollision(
    absolutePath: string,
    relativePath: string,
    scans: SiblingScans,
  ): Promise<void> {
    const parent = dirname(absolutePath);
    let snapshot = scans.cache.get(parent);
    if (snapshot === undefined) {
      const maximum = this.#context.limits.maxEntries - scans.entries;
      const parentRelative = relative(this.#context.root, parent)
        .split(/[\\/]+/u)
        .filter((segment) => segment.length > 0)
        .join("/");
      snapshot = await this.#context.scanPortableSiblings(
        parent,
        parentRelative,
        maximum,
      );
      if (
        !Number.isSafeInteger(snapshot.entries) ||
        snapshot.entries < 0 ||
        snapshot.entries > maximum
      ) {
        throw repositoryExternalChange("portable sibling scan accounting");
      }
      scans.entries += snapshot.entries;
      scans.cache.set(parent, snapshot);
    }
    const identity = portablePathIdentity(
      relativePath,
      this.#context.pathLimits,
    );
    const collision = snapshot.identities.get(identity);
    if (collision !== undefined) {
      throw repositoryExternalChange(
        `${relativePath} collides with existing sibling ${collision}`,
      );
    }
  }

  async #planMissingDirectories(
    segments: readonly string[],
    siblingScans: SiblingScans,
  ): Promise<readonly TransactionPlannedDirectory[]> {
    const missing: TransactionPlannedDirectory[] = [];
    let current = this.#context.root;
    const relativeSegments: string[] = [];
    for (const segment of segments) {
      current = join(current, segment);
      relativeSegments.push(segment);
      const relativePath = relativeSegments.join("/");
      const status = await lstatOrNull(current);
      if (status === null) {
        await this.#assertNoSiblingCollision(
          current,
          relativePath,
          siblingScans,
        );
        const identity = portablePathIdentity(
          relativePath,
          this.#context.pathLimits,
        );
        if (this.#context.ownedEntry(identity) !== undefined) {
          throw repositoryExternalChange(relativePath);
        }
        missing.push({ absolutePath: current, relativePath });
      } else {
        if (missing.length > 0) {
          throw repositoryExternalChange(relativePath);
        }
        assertDirectory(status, relativePath);
        this.#context.assertOwnedStatus(status, relativePath, "directory");
      }
    }
    return Object.freeze(missing);
  }
}

function createSiblingScans(): SiblingScans {
  return { cache: new Map(), entries: 0 };
}
