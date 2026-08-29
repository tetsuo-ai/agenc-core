import { constants as fsConstants, rmSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { logForDebugging } from "../utils/debug.js";
import { VERSION } from "../version.js";

const DEFAULT_MAX_OWNERLESS_ROOTS = 8;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const SAFE_WRITE_FLAGS =
  process.platform === "win32"
    ? "wx"
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      O_NOFOLLOW;

interface ExtractionRootEntry {
  readonly sessionTempRoot: string;
  readonly root: string;
  ownerCount: number;
  activeOperations: number;
  lastUsed: number;
  retired: boolean;
  writeTail: Promise<void>;
}

export interface BundledSkillExtractionLease {
  readonly root: string;
  release(): Promise<void>;
}

export interface BundledSkillExtractionRegistryOptions {
  readonly maxOwnerlessRoots?: number;
  readonly createNonce?: () => string;
}

export interface BundledSkillExtractionRegistrySnapshot {
  readonly roots: readonly {
    readonly sessionTempRoot: string;
    readonly root: string;
    readonly ownerCount: number;
    readonly activeOperations: number;
  }[];
  readonly ownerlessRootCount: number;
}

/**
 * Owns every process-local bundled-skill extraction root.
 *
 * Live Sessions retain a root with an explicit captured temp authority. Paths
 * used outside a Session are kept in a small LRU so CLI-only callers cannot
 * grow process memory without bound. File writes are serialized per root with
 * one promise tail; there is deliberately no per-skill promise cache.
 */
export class BundledSkillExtractionRegistry {
  private readonly entries = new Map<string, ExtractionRootEntry>();
  private readonly maxOwnerlessRoots: number;
  private readonly createNonce: () => string;
  private useSequence = 0;
  private cleanupTail: Promise<void> = Promise.resolve();

  constructor(options: BundledSkillExtractionRegistryOptions = {}) {
    this.maxOwnerlessRoots = Math.max(
      1,
      options.maxOwnerlessRoots ?? DEFAULT_MAX_OWNERLESS_ROOTS,
    );
    this.createNonce =
      options.createNonce ?? (() => randomBytes(16).toString("hex"));
  }

  rootForSessionTempRoot(sessionTempRoot: string): string {
    const normalizedTempRoot = normalizeSessionTempRoot(sessionTempRoot);
    let entry = this.findBySessionTempRoot(normalizedTempRoot);
    if (entry === undefined) {
      entry = {
        sessionTempRoot: normalizedTempRoot,
        root: join(
          normalizedTempRoot,
          `agenc-bundled-skills-${VERSION}-${this.createNonce()}`,
        ),
        ownerCount: 0,
        activeOperations: 0,
        lastUsed: 0,
        retired: false,
        writeTail: Promise.resolve(),
      };
      this.entries.set(entry.root, entry);
    }
    this.touch(entry);
    this.trimOwnerlessRoots();
    return entry.root;
  }

  retain(sessionTempRoot: string): BundledSkillExtractionLease {
    const root = this.rootForSessionTempRoot(sessionTempRoot);
    const entry = this.entries.get(root);
    if (entry === undefined || entry.retired) {
      throw new Error("bundled-skill extraction root was retired during retain");
    }
    entry.ownerCount += 1;
    this.touch(entry);
    let released = false;
    return {
      root,
      release: async () => {
        if (released) return;
        released = true;
        if (entry.retired) return;
        entry.ownerCount = Math.max(0, entry.ownerCount - 1);
        if (entry.ownerCount === 0) {
          await this.retire(entry);
        }
      },
    };
  }

  skillDirectory(root: string, skillName: string): string {
    return resolveRelativePath(root, skillName, "bundled skill name");
  }

  async extractFiles(
    root: string,
    skillName: string,
    files: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    const entry = this.entries.get(root);
    if (entry === undefined || entry.retired) {
      logForDebugging(
        `Cannot extract bundled skill '${skillName}': extraction root is no longer active`,
      );
      return null;
    }
    const skillDirectory = this.skillDirectory(root, skillName);
    if (Object.keys(files).length === 0) return skillDirectory;

    entry.activeOperations += 1;
    this.touch(entry);
    const extraction = entry.writeTail.then(() =>
      writeSkillFiles(entry.root, skillDirectory, files),
    );
    entry.writeTail = extraction.catch(() => undefined);
    try {
      await extraction;
      return skillDirectory;
    } catch (error) {
      logForDebugging(
        `Failed to extract bundled skill '${skillName}' to ${skillDirectory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      entry.activeOperations -= 1;
      this.touch(entry);
      this.trimOwnerlessRoots();
    }
  }

  async cleanupAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.retired = true;
    await Promise.all(entries.map((entry) => this.cleanupEntry(entry)));
    await this.cleanupTail;
  }

  cleanupAllSync(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.retired = true;
      try {
        rmSync(entry.root, { recursive: true, force: true });
      } catch {
        // Process exit is already in progress; cleanup remains best effort.
      }
    }
  }

  async waitForCleanup(): Promise<void> {
    await this.cleanupTail;
  }

  snapshot(): BundledSkillExtractionRegistrySnapshot {
    const roots = [...this.entries.values()]
      .filter((entry) => !entry.retired)
      .map((entry) => ({
        sessionTempRoot: entry.sessionTempRoot,
        root: entry.root,
        ownerCount: entry.ownerCount,
        activeOperations: entry.activeOperations,
      }));
    return {
      roots,
      ownerlessRootCount: roots.filter((entry) => entry.ownerCount === 0)
        .length,
    };
  }

  private findBySessionTempRoot(
    sessionTempRoot: string,
  ): ExtractionRootEntry | undefined {
    for (const entry of this.entries.values()) {
      if (!entry.retired && entry.sessionTempRoot === sessionTempRoot) {
        return entry;
      }
    }
    return undefined;
  }

  private touch(entry: ExtractionRootEntry): void {
    this.useSequence += 1;
    entry.lastUsed = this.useSequence;
  }

  private trimOwnerlessRoots(): void {
    while (true) {
      const ownerless = [...this.entries.values()].filter(
        (entry) =>
          !entry.retired &&
          entry.ownerCount === 0 &&
          entry.activeOperations === 0,
      );
      if (ownerless.length <= this.maxOwnerlessRoots) return;
      ownerless.sort((left, right) => left.lastUsed - right.lastUsed);
      void this.retire(ownerless[0]!);
    }
  }

  private retire(entry: ExtractionRootEntry): Promise<void> {
    if (entry.retired) return Promise.resolve();
    entry.retired = true;
    const cleanup = this.cleanupEntry(entry).finally(() => {
      this.entries.delete(entry.root);
    });
    this.cleanupTail = Promise.all([
      this.cleanupTail.catch(() => undefined),
      cleanup.catch(() => undefined),
    ]).then(() => undefined);
    return cleanup;
  }

  private async cleanupEntry(entry: ExtractionRootEntry): Promise<void> {
    await entry.writeTail.catch(() => undefined);
    try {
      await rm(entry.root, { recursive: true, force: true });
    } catch (error) {
      try {
        rmSync(entry.root, { recursive: true, force: true });
      } catch {
        throw error;
      }
    }
  }
}

const bundledSkillExtractionRegistry =
  new BundledSkillExtractionRegistry();

export function getBundledSkillExtractionRoot(
  sessionTempRoot: string,
): string {
  return bundledSkillExtractionRegistry.rootForSessionTempRoot(sessionTempRoot);
}

export function retainBundledSkillExtractionRoot(
  sessionTempRoot: string,
): BundledSkillExtractionLease {
  return bundledSkillExtractionRegistry.retain(sessionTempRoot);
}

export function getBundledSkillDirectory(
  root: string,
  skillName: string,
): string {
  return bundledSkillExtractionRegistry.skillDirectory(root, skillName);
}

export function extractBundledSkillFiles(
  root: string,
  skillName: string,
  files: Readonly<Record<string, string>>,
): Promise<string | null> {
  return bundledSkillExtractionRegistry.extractFiles(root, skillName, files);
}

export async function cleanupBundledSkillExtractionsForProcess(): Promise<void> {
  await bundledSkillExtractionRegistry.cleanupAll();
}

function normalizeSessionTempRoot(sessionTempRoot: string): string {
  const trimmed = sessionTempRoot.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new Error("bundled-skill session temp root must be an absolute path");
  }
  return normalize(trimmed);
}

function resolveRelativePath(
  baseDirectory: string,
  relativePath: string,
  label: string,
): string {
  const normalized = normalize(relativePath);
  const segments = normalized.split(/[\\/]/u);
  if (
    normalized.length === 0 ||
    normalized === "." ||
    isAbsolute(normalized) ||
    segments.includes("..")
  ) {
    throw new Error(`${label} escapes extraction root: ${relativePath}`);
  }
  return join(baseDirectory, normalized);
}

async function writeSkillFiles(
  root: string,
  skillDirectory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("bundled-skill extraction root is not a private directory");
  }
  await chmod(root, 0o700);

  for (const [relativePath, content] of Object.entries(files)) {
    const target = resolveRelativePath(
      skillDirectory,
      relativePath,
      "bundled skill file path",
    );
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await safeWriteFile(target, content);
  }
}

async function safeWriteFile(path: string, content: string): Promise<void> {
  let fileHandle;
  try {
    fileHandle = await open(path, SAFE_WRITE_FLAGS, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingStat = await lstat(path);
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) throw error;
    const existingContent = await readFile(path, "utf8");
    if (existingContent !== content) {
      throw new Error(
        `bundled skill file already exists with different content: ${path}`,
      );
    }
    return;
  }
  try {
    await fileHandle.writeFile(content, "utf8");
  } finally {
    await fileHandle.close();
  }
}

process.once("exit", () => {
  bundledSkillExtractionRegistry.cleanupAllSync();
});
