import { Buffer } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import { parseFrontmatter } from "../utils/frontmatterParser.js";
import {
  MAX_C3A_CANDIDATE_FILES,
  MAX_C3A_HEADER_BYTES_PER_FILE,
  MAX_C3A_PATH_UTF8_BYTES,
  MAX_C3A_ROOT_PATH_UTF8_BYTES,
  MAX_C3A_ROOTS,
  MAX_C3A_SCAN_FILES,
  MAX_C3A_SCAN_MS,
  MAX_C3A_TOTAL_HEADER_BYTES,
  MAX_C3A_TOTAL_PATH_UTF8_BYTES,
  MAX_C3A_TRAVERSAL_ENTRIES,
  throwIfMemoryRecallAborted,
} from "./recall-contract.js";
import { type MemoryType, parseMemoryType } from "./types.js";

export const MAX_MEMORY_FILES = MAX_C3A_SCAN_FILES;

const MAX_SCAN_DEPTH = 3;
const FILE_INSPECTION_CONCURRENCY = 16;
const FRONTMATTER_MAX_LINES = 30;
const MAX_CONTENT_READ_BYTES = 4_096;

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface MemoryRootBinding {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
}

export interface MemoryHeader {
  readonly filename: string;
  readonly relativePath: string;
  readonly filePath: string;
  readonly pathBytes: Buffer;
  readonly mtimeMs: number;
  readonly title: string;
  readonly description: string | null;
  readonly type: MemoryType | undefined;
  readonly root: MemoryRootBinding;
  readonly identity: FileIdentity;
}

export type MemoryScanResult =
  | {
      readonly kind: "complete";
      readonly headers: readonly MemoryHeader[];
    }
  | {
      readonly kind: "unavailable" | "limit" | "deadline" | "unsupported";
      readonly headers: readonly [];
      readonly reason: string;
    };

export interface MemoryScanTestHooks {
  readonly now?: () => number;
  readonly openDirectory?: typeof opendir;
  readonly beforeDirectoryOpen?: (path: string) => void | Promise<void>;
  readonly afterDirectoryEnumeration?: (path: string) => void | Promise<void>;
  readonly beforeCandidateOpen?: (path: string) => void | Promise<void>;
  readonly afterCandidateOpen?: (path: string) => void | Promise<void>;
  readonly beforeHeaderRead?: (path: string) => void | Promise<void>;
}

interface ScanBudget {
  traversalEntries: number;
  candidateFiles: number;
  totalPathBytes: number;
  totalHeaderBytes: number;
  readonly deadline: number;
  readonly now: () => number;
}

interface Candidate {
  readonly root: BoundMemoryRoot;
  readonly relativePath: string;
  readonly filePath: string;
  readonly pathBytes: Buffer;
  readonly identity: FileIdentity;
  readonly mtimeMs: number;
}

interface CandidatePath {
  readonly root: BoundMemoryRoot;
  readonly relativePath: string;
  readonly pathBytes: Buffer;
}

interface BoundMemoryRoot {
  readonly binding: MemoryRootBinding;
  readonly handle: FileHandle;
}

interface PendingDirectory {
  readonly relativePath: string;
  readonly depth: number;
  readonly identity: FileIdentity;
}

interface OpenedDirectory {
  readonly directory: Awaited<ReturnType<typeof opendir>>;
  readonly handle: FileHandle | null;
}

class MemoryScanFailure extends Error {
  constructor(
    readonly kind: Exclude<MemoryScanResult["kind"], "complete">,
    message: string,
  ) {
    super(message);
    this.name = "MemoryScanFailure";
  }
}

export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<MemoryHeader[]> {
  const result = await scanMemoryRoots([memoryDir], signal);
  return result.kind === "complete" ? [...result.headers] : [];
}

export async function scanMemoryRoots(
  memoryDirs: readonly string[],
  signal: AbortSignal,
  hooks: MemoryScanTestHooks = {},
): Promise<MemoryScanResult> {
  throwIfMemoryRecallAborted(signal);
  const now = hooks.now ?? performance.now.bind(performance);
  const budget: ScanBudget = {
    traversalEntries: 0,
    candidateFiles: 0,
    totalPathBytes: 0,
    totalHeaderBytes: 0,
    deadline: now() + MAX_C3A_SCAN_MS,
    now,
  };
  const roots: BoundMemoryRoot[] = [];

  try {
    if (memoryDirs.length > MAX_C3A_ROOTS) {
      throw new MemoryScanFailure("limit", "memory root count exceeds limit");
    }
    if (process.platform === "win32") {
      throw new MemoryScanFailure(
        "unsupported",
        "descriptor final-path verification is unavailable on Windows",
      );
    }

    const rootIdentities = new Set<string>();
    for (const directory of memoryDirs) {
      checkScanBudget(budget, signal);
      if (Buffer.byteLength(directory, "utf8") > MAX_C3A_ROOT_PATH_UTF8_BYTES) {
        throw new MemoryScanFailure("limit", "memory root path exceeds limit");
      }
      const root = await bindMemoryRoot(directory, signal);
      if (root !== null) {
        const identity = `${root.binding.identity.dev}:${root.binding.identity.ino}`;
        if (!rootIdentities.has(identity)) {
          rootIdentities.add(identity);
          roots.push(root);
        } else {
          await closeHandle(root.handle, signal);
        }
      }
    }

    const paths: CandidatePath[] = [];
    for (const root of roots) {
      await collectCandidatePaths(root, paths, budget, signal, hooks);
    }
    paths.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));

    const candidates = (
      await mapWithConcurrency(
        paths,
        FILE_INSPECTION_CONCURRENCY,
        async ({ root, relativePath, pathBytes }) => {
          checkScanBudget(budget, signal);
          return inspectCandidate(
            root,
            relativePath,
            pathBytes,
            signal,
            hooks,
          );
        },
      )
    ).filter((candidate): candidate is Candidate => candidate !== null);
    checkScanBudget(budget, signal);

    const newest = selectNewestCandidates(candidates, MAX_C3A_SCAN_FILES);
    const headers: MemoryHeader[] = [];
    for (const candidate of newest) {
      checkScanBudget(budget, signal);
      const header = await readMemoryHeader(candidate, budget, signal, hooks);
      if (header !== null) headers.push(header);
    }
    headers.sort(compareMemoryHeadersByRecency);
    return { kind: "complete", headers };
  } catch (error) {
    throwIfMemoryRecallAborted(signal);
    if (error instanceof MemoryScanFailure) {
      return { kind: error.kind, headers: [], reason: error.message };
    }
    return {
      kind: "unavailable",
      headers: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.all(
      roots.map((root) => root.handle.close().catch(() => undefined)),
    );
    throwIfMemoryRecallAborted(signal);
  }
}

export async function readMemoryContent(
  header: MemoryHeader,
  signal: AbortSignal,
  maximumBytes = MAX_CONTENT_READ_BYTES,
  maximumLines = 200,
): Promise<{
  readonly content: string;
  readonly lineCount: number;
  readonly truncated: boolean;
}> {
  throwIfMemoryRecallAborted(signal);
  const root = await bindMemoryRoot(header.root.requestedPath, signal);
  if (
    root === null ||
    !sameIdentity(root.binding.identity, header.root.identity)
  ) {
    if (root !== null) await closeHandle(root.handle, signal);
    throw new Error("memory root identity changed before content read");
  }
  try {
    const handle = await openVerifiedCandidate(
      root,
      header.relativePath,
      signal,
    );
    if (handle === null) throw new Error("memory candidate is no longer safe");
    try {
      const before = identityFromStats(await handle.stat({ bigint: true }));
      throwIfMemoryRecallAborted(signal);
      if (!sameIdentity(before, header.identity)) {
        throw new Error("memory candidate identity changed before content read");
      }
      const bytes = await readPrefix(handle, maximumBytes, signal);
      const text = decodeUtf8Prefix(bytes.content, bytes.truncated);
      const lines = text.split("\n");
      const lineTruncated = lines.length > maximumLines;
      const content = lineTruncated
        ? lines.slice(0, maximumLines).join("\n")
        : text;
      await assertCandidateUnchanged(
        handle,
        descriptorRelativePath(root, header.relativePath),
        before,
        signal,
      );
      return {
        content,
        lineCount: Math.min(lines.length, maximumLines),
        truncated: bytes.truncated || lineTruncated,
      };
    } finally {
      await closeHandle(handle, signal);
    }
  } finally {
    await closeHandle(root.handle, signal);
  }
}

async function bindMemoryRoot(
  directory: string,
  signal: AbortSignal,
): Promise<BoundMemoryRoot | null> {
  throwIfMemoryRecallAborted(signal);
  const requestedPath = resolve(directory);
  let before: BigIntStats;
  try {
    before = await lstat(requestedPath, { bigint: true });
  } catch {
    throwIfMemoryRecallAborted(signal);
    return null;
  }
  throwIfMemoryRecallAborted(signal);
  if (before.isSymbolicLink() || !before.isDirectory()) return null;
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    throwIfMemoryRecallAborted(signal);
    return null;
  }
  throwIfMemoryRecallAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(
      requestedPath,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throwIfMemoryRecallAborted(signal);
    return null;
  }
  let retainHandle = false;
  try {
    throwIfMemoryRecallAborted(signal);
    const opened = await handle.stat({ bigint: true });
    throwIfMemoryRecallAborted(signal);
    const after = await lstat(requestedPath, { bigint: true });
    throwIfMemoryRecallAborted(signal);
    if (
      !opened.isDirectory() ||
      !sameStats(before, opened) ||
      !sameStats(opened, after)
    ) {
      throw new MemoryScanFailure("unavailable", "memory root changed while binding");
    }
    const finalPath = await finalDescriptorPath(handle, canonicalPath, signal);
    if (finalPath !== canonicalPath) {
      throw new MemoryScanFailure("unavailable", "memory root final path changed");
    }
    retainHandle = true;
    return {
      binding: {
        requestedPath,
        canonicalPath,
        identity: identityFromStats(opened),
      },
      handle,
    };
  } finally {
    if (!retainHandle) await closeHandle(handle, signal);
  }
}

async function collectCandidatePaths(
  root: BoundMemoryRoot,
  output: CandidatePath[],
  budget: ScanBudget,
  signal: AbortSignal,
  hooks: MemoryScanTestHooks,
): Promise<void> {
  const pending: PendingDirectory[] = [
    {
      relativePath: "",
      depth: 0,
      identity: root.binding.identity,
    },
  ];
  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    checkScanBudget(budget, signal);
    const current = pending[pendingIndex]!;
    pendingIndex += 1;
    const opened = await openVerifiedDirectory(
      root,
      current,
      signal,
      hooks,
    );
    try {
      throwIfMemoryRecallAborted(signal);
      for await (const entry of opened.directory) {
        checkScanBudget(budget, signal);
        budget.traversalEntries += 1;
        if (budget.traversalEntries > MAX_C3A_TRAVERSAL_ENTRIES) {
          throw new MemoryScanFailure("limit", "memory traversal entry limit crossed");
        }
        const relativePath = current.relativePath
          ? join(current.relativePath, entry.name)
          : entry.name;
        const pathBytes = portablePathBytes(root, relativePath);
        accountPath(pathBytes, budget);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (current.depth + 1 < MAX_SCAN_DEPTH) {
            const identity = await inspectDirectoryIdentity(
              root,
              relativePath,
              signal,
            );
            pending.push({
              relativePath,
              depth: current.depth + 1,
              identity,
            });
          }
          continue;
        }
        if (
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          basename(entry.name) !== "MEMORY.md"
        ) {
          budget.candidateFiles += 1;
          if (budget.candidateFiles > MAX_C3A_CANDIDATE_FILES) {
            throw new MemoryScanFailure("limit", "memory candidate limit crossed");
          }
          output.push({ root, relativePath, pathBytes });
        }
      }
      const logicalPath = current.relativePath
        ? join(root.binding.requestedPath, current.relativePath)
        : root.binding.requestedPath;
      await hooks.afterDirectoryEnumeration?.(logicalPath);
      throwIfMemoryRecallAborted(signal);
      await assertBoundDirectoryUnchanged(
        root,
        current,
        opened.handle ?? root.handle,
        signal,
      );
    } finally {
      await opened.directory.close().catch(() => undefined);
      if (opened.handle !== null) await closeHandle(opened.handle, signal);
      else throwIfMemoryRecallAborted(signal);
    }
  }
}

async function assertBoundDirectoryUnchanged(
  root: BoundMemoryRoot,
  pending: PendingDirectory,
  handle: FileHandle,
  signal: AbortSignal,
): Promise<void> {
  const opened = await handle.stat({ bigint: true });
  throwIfMemoryRecallAborted(signal);
  const currentPath = pending.relativePath
    ? descriptorRelativePath(root, pending.relativePath)
    : root.binding.requestedPath;
  const current = await lstat(currentPath, { bigint: true });
  throwIfMemoryRecallAborted(signal);
  const finalPath = await finalDescriptorPath(
    handle,
    canonicalRelativePath(root, pending.relativePath),
    signal,
  );
  if (
    !opened.isDirectory() ||
    current.isSymbolicLink() ||
    !sameStats(opened, pending.identity) ||
    !sameStats(opened, current) ||
    finalPath === null ||
    !isBoundDirectoryPath(root.binding.canonicalPath, finalPath)
  ) {
    throw new MemoryScanFailure(
      "unavailable",
      "memory directory changed during descriptor-bound enumeration",
    );
  }
}

async function openVerifiedDirectory(
  root: BoundMemoryRoot,
  pending: PendingDirectory,
  signal: AbortSignal,
  hooks: MemoryScanTestHooks,
): Promise<OpenedDirectory> {
  throwIfMemoryRecallAborted(signal);
  const descriptorPath = descriptorRelativePath(root, pending.relativePath);
  const logicalPath = pending.relativePath
    ? join(root.binding.requestedPath, pending.relativePath)
    : root.binding.requestedPath;
  await hooks.beforeDirectoryOpen?.(logicalPath);
  throwIfMemoryRecallAborted(signal);
  if (pending.relativePath.length === 0) {
    return openBoundRootDirectory(root, pending, signal, hooks);
  }
  let handle: FileHandle;
  try {
    handle = await open(
      descriptorPath,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throwIfMemoryRecallAborted(signal);
    throw new MemoryScanFailure(
      "unavailable",
      "admitted memory directory could not be opened by descriptor",
    );
  }
  try {
    const opened = await handle.stat({ bigint: true });
    throwIfMemoryRecallAborted(signal);
    const current = await lstat(descriptorPath, { bigint: true });
    throwIfMemoryRecallAborted(signal);
    if (
      !opened.isDirectory() ||
      opened.nlink < 1n ||
      !sameStats(opened, pending.identity) ||
      !sameStats(opened, current)
    ) {
      throw new MemoryScanFailure(
        "unavailable",
        "admitted memory directory identity changed before enumeration",
      );
    }
    const finalPath = await finalDescriptorPath(
      handle,
      canonicalRelativePath(root, pending.relativePath),
      signal,
    );
    if (
      finalPath === null ||
      !isBoundDirectoryPath(root.binding.canonicalPath, finalPath)
    ) {
      throw new MemoryScanFailure(
        "unavailable",
        "admitted memory directory escaped its canonical root",
      );
    }
    let directory;
    try {
      directory = await (hooks.openDirectory ?? opendir)(
        descriptorHandlePath(handle, descriptorPath),
      );
    } catch {
      throwIfMemoryRecallAborted(signal);
      throw new MemoryScanFailure(
        "unavailable",
        "admitted memory directory could not be enumerated",
      );
    }
    if (signal.aborted) {
      await directory.close().catch(() => undefined);
      throwIfMemoryRecallAborted(signal);
    }
    return { directory, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throwIfMemoryRecallAborted(signal);
    if (error instanceof MemoryScanFailure) throw error;
    throw new MemoryScanFailure(
      "unavailable",
      "admitted memory directory verification failed",
    );
  }
}

async function openBoundRootDirectory(
  root: BoundMemoryRoot,
  pending: PendingDirectory,
  signal: AbortSignal,
  hooks: MemoryScanTestHooks,
): Promise<OpenedDirectory> {
  const opened = await root.handle.stat({ bigint: true });
  throwIfMemoryRecallAborted(signal);
  const current = await lstat(root.binding.requestedPath, { bigint: true });
  throwIfMemoryRecallAborted(signal);
  if (
    !opened.isDirectory() ||
    !sameStats(opened, pending.identity) ||
    !sameStats(opened, current)
  ) {
    throw new MemoryScanFailure(
      "unavailable",
      "bound memory root identity changed before enumeration",
    );
  }
  const finalPath = await finalDescriptorPath(
    root.handle,
    root.binding.canonicalPath,
    signal,
  );
  if (finalPath !== root.binding.canonicalPath) {
    throw new MemoryScanFailure(
      "unavailable",
      "bound memory root left its canonical path before enumeration",
    );
  }
  let directory;
  try {
    directory = await (hooks.openDirectory ?? opendir)(
      descriptorHandlePath(root.handle, root.binding.requestedPath),
    );
  } catch {
    throwIfMemoryRecallAborted(signal);
    throw new MemoryScanFailure(
      "unavailable",
      "bound memory root could not be enumerated",
    );
  }
  if (signal.aborted) {
    await directory.close().catch(() => undefined);
    throwIfMemoryRecallAborted(signal);
  }
  return { directory, handle: null };
}

async function inspectDirectoryIdentity(
  root: BoundMemoryRoot,
  relativePath: string,
  signal: AbortSignal,
): Promise<FileIdentity> {
  try {
    const stats = await lstat(descriptorRelativePath(root, relativePath), {
      bigint: true,
    });
    throwIfMemoryRecallAborted(signal);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new MemoryScanFailure(
        "unavailable",
        "enumerated memory directory changed before identity binding",
      );
    }
    return identityFromStats(stats);
  } catch (error) {
    throwIfMemoryRecallAborted(signal);
    if (error instanceof MemoryScanFailure) throw error;
    throw new MemoryScanFailure(
      "unavailable",
      "enumerated memory directory could not be identity-bound",
    );
  }
}

async function inspectCandidate(
  root: BoundMemoryRoot,
  relativePath: string,
  pathBytes: Buffer,
  signal: AbortSignal,
  hooks: MemoryScanTestHooks,
): Promise<Candidate | null> {
  const filePath = join(root.binding.requestedPath, relativePath);
  await hooks.beforeCandidateOpen?.(filePath);
  throwIfMemoryRecallAborted(signal);
  const handle = await openVerifiedCandidate(root, relativePath, signal);
  if (handle === null) return null;
  try {
    await hooks.afterCandidateOpen?.(filePath);
    throwIfMemoryRecallAborted(signal);
    const stats = await handle.stat({ bigint: true });
    throwIfMemoryRecallAborted(signal);
    if (!stats.isFile() || stats.nlink !== 1n) return null;
    const identity = identityFromStats(stats);
    await assertCandidateUnchanged(
      handle,
      descriptorRelativePath(root, relativePath),
      identity,
      signal,
    );
    return {
      root,
      relativePath,
      filePath,
      pathBytes,
      identity,
      mtimeMs: Number(stats.mtimeNs / 1_000_000n),
    };
  } catch (error) {
    throwIfMemoryRecallAborted(signal);
    if (error instanceof MemoryScanFailure) throw error;
    return null;
  } finally {
    await closeHandle(handle, signal);
  }
}

async function readMemoryHeader(
  candidate: Candidate,
  budget: ScanBudget,
  signal: AbortSignal,
  hooks: MemoryScanTestHooks,
): Promise<MemoryHeader | null> {
  await hooks.beforeHeaderRead?.(candidate.filePath);
  throwIfMemoryRecallAborted(signal);
  const handle = await openVerifiedCandidate(
    candidate.root,
    candidate.relativePath,
    signal,
  );
  if (handle === null) return null;
  try {
    const before = identityFromStats(await handle.stat({ bigint: true }));
    throwIfMemoryRecallAborted(signal);
    if (!sameIdentity(before, candidate.identity)) return null;
    const remaining = MAX_C3A_TOTAL_HEADER_BYTES - budget.totalHeaderBytes;
    if (remaining <= 0) {
      throw new MemoryScanFailure(
        "limit",
        "memory aggregate header byte limit crossed",
      );
    }
    const maximumBytes = Math.min(MAX_C3A_HEADER_BYTES_PER_FILE, remaining);
    const { content, truncated } = await readPrefix(handle, maximumBytes, signal);
    budget.totalHeaderBytes += content.byteLength;
    if (maximumBytes < MAX_C3A_HEADER_BYTES_PER_FILE && truncated) {
      throw new MemoryScanFailure(
        "limit",
        "memory aggregate header byte limit crossed",
      );
    }
    const text = decodeUtf8Prefix(content, truncated);
    await assertCandidateUnchanged(
      handle,
      descriptorRelativePath(candidate.root, candidate.relativePath),
      before,
      signal,
    );
    const { frontmatter } = parseFrontmatter(
      firstLines(text, FRONTMATTER_MAX_LINES),
      candidate.filePath,
    );
    const title =
      typeof frontmatter.title === "string"
        ? frontmatter.title
        : typeof frontmatter.name === "string"
          ? frontmatter.name
          : basename(candidate.relativePath, ".md");
    return {
      filename: candidate.relativePath,
      relativePath: candidate.relativePath,
      filePath: candidate.filePath,
      pathBytes: candidate.pathBytes,
      mtimeMs: candidate.mtimeMs,
      title,
      description:
        typeof frontmatter.description === "string"
          ? frontmatter.description
          : null,
      type: parseMemoryType(frontmatter.type),
      root: candidate.root.binding,
      identity: candidate.identity,
    };
  } catch (error) {
    throwIfMemoryRecallAborted(signal);
    if (error instanceof MemoryScanFailure) throw error;
    return null;
  } finally {
    await closeHandle(handle, signal);
  }
}

async function openVerifiedCandidate(
  root: BoundMemoryRoot,
  relativePath: string,
  signal: AbortSignal,
): Promise<FileHandle | null> {
  throwIfMemoryRecallAborted(signal);
  const filePath = join(root.binding.requestedPath, relativePath);
  if (!isContained(root.binding.requestedPath, filePath)) return null;
  if (!(await verifyParentChain(root, relativePath, signal))) return null;
  const descriptorPath = descriptorRelativePath(root, relativePath);
  let pathStats: BigIntStats;
  try {
    pathStats = await lstat(descriptorPath, { bigint: true });
  } catch {
    throwIfMemoryRecallAborted(signal);
    return null;
  }
  throwIfMemoryRecallAborted(signal);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) return null;
  let handle: FileHandle;
  try {
    handle = await open(
      descriptorPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throwIfMemoryRecallAborted(signal);
    return null;
  }
  try {
    throwIfMemoryRecallAborted(signal);
    const opened = await handle.stat({ bigint: true });
    throwIfMemoryRecallAborted(signal);
    if (!opened.isFile() || opened.nlink !== 1n || !sameStats(pathStats, opened)) {
      await handle.close();
      throwIfMemoryRecallAborted(signal);
      return null;
    }
    const finalPath = await finalDescriptorPath(
      handle,
      canonicalRelativePath(root, relativePath),
      signal,
    );
    if (
      finalPath === null ||
      !isContained(root.binding.canonicalPath, finalPath)
    ) {
      await handle.close();
      throwIfMemoryRecallAborted(signal);
      return null;
    }
    const finalStats = await lstat(finalPath, { bigint: true });
    throwIfMemoryRecallAborted(signal);
    if (!sameStats(opened, finalStats)) {
      await handle.close();
      throwIfMemoryRecallAborted(signal);
      return null;
    }
    throwIfMemoryRecallAborted(signal);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throwIfMemoryRecallAborted(signal);
    throw error;
  }
}

async function verifyParentChain(
  root: BoundMemoryRoot,
  relativePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  const segments = relativePath.split(sep);
  let cursor = descriptorHandlePath(root.handle, root.binding.requestedPath);
  const parentSegments = segments.slice(0, -1);
  for (const segment of parentSegments) {
    throwIfMemoryRecallAborted(signal);
    cursor = join(cursor, segment);
    const stats = await lstat(cursor, { bigint: true });
    throwIfMemoryRecallAborted(signal);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const canonical = await realpath(cursor);
    throwIfMemoryRecallAborted(signal);
    if (!isContained(root.binding.canonicalPath, canonical)) return false;
  }
  const openedRoot = await root.handle.stat({ bigint: true });
  throwIfMemoryRecallAborted(signal);
  const currentRoot = await lstat(root.binding.requestedPath, { bigint: true });
  throwIfMemoryRecallAborted(signal);
  return (
    !currentRoot.isSymbolicLink() &&
    sameStats(openedRoot, root.binding.identity) &&
    sameStats(currentRoot, root.binding.identity)
  );
}

async function assertCandidateUnchanged(
  handle: FileHandle,
  descriptorPath: string,
  before: FileIdentity,
  signal: AbortSignal,
): Promise<void> {
  throwIfMemoryRecallAborted(signal);
  const openedAfter = identityFromStats(await handle.stat({ bigint: true }));
  throwIfMemoryRecallAborted(signal);
  const pathAfter = identityFromStats(
    await lstat(descriptorPath, { bigint: true }),
  );
  throwIfMemoryRecallAborted(signal);
  if (!sameIdentity(before, openedAfter) || !sameIdentity(before, pathAfter)) {
    throw new Error("memory candidate changed during descriptor-bound read");
  }
}

/**
 * Resolve the path an open descriptor currently refers to, or `null` when it
 * can no longer be proven to sit at `expectedPath`.
 *
 * Linux exposes the live target through `/proc/self/fd/N`. darwin and freebsd
 * do not: `realpath("/dev/fd/N")` yields `/dev/fd/<basename>` instead of the
 * target, so a string comparison against the canonical path can never match
 * and every recall root used to fail closed. Those platforms instead prove the
 * descriptor identity (dev/ino/mode/size/mtime/ctime) against `expectedPath`,
 * which is the property the alias comparison was buying.
 */
async function finalDescriptorPath(
  handle: FileHandle,
  expectedPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (process.platform === "linux") {
    const path = await realpath(`/proc/self/fd/${handle.fd}`);
    throwIfMemoryRecallAborted(signal);
    return path;
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const opened = await handle.stat({ bigint: true });
    throwIfMemoryRecallAborted(signal);
    let expected: BigIntStats;
    try {
      expected = await lstat(expectedPath, { bigint: true });
    } catch {
      throwIfMemoryRecallAborted(signal);
      return null;
    }
    throwIfMemoryRecallAborted(signal);
    return !expected.isSymbolicLink() && sameStats(opened, expected)
      ? expectedPath
      : null;
  }
  throw new MemoryScanFailure(
    "unsupported",
    "descriptor final-path verification is unavailable on this platform",
  );
}

async function readPrefix(
  handle: FileHandle,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<{ readonly content: Buffer; readonly truncated: boolean }> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    throwIfMemoryRecallAborted(signal);
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    throwIfMemoryRecallAborted(signal);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return {
    content: buffer.subarray(0, Math.min(offset, maximumBytes)),
    truncated: offset > maximumBytes,
  };
}

function decodeUtf8Prefix(
  bytes: Uint8Array,
  allowIncompleteEnding: boolean,
): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const minimumEnd = allowIncompleteEnding
    ? Math.max(0, bytes.byteLength - 3)
    : bytes.byteLength;
  for (let end = bytes.byteLength; end >= minimumEnd; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      continue;
    }
  }
  throw new Error("memory candidate header is not valid UTF-8");
}

function selectNewestCandidates(
  candidates: readonly Candidate[],
  limit: number,
): Candidate[] {
  if (candidates.length <= limit) {
    return [...candidates].sort(compareCandidatesByRecency);
  }
  const heap: Candidate[] = [];
  for (const candidate of candidates) {
    if (heap.length < limit) {
      heap.push(candidate);
      bubbleWorstUp(heap, heap.length - 1);
      continue;
    }
    if (compareCandidatesByRecency(candidate, heap[0]!) < 0) {
      heap[0] = candidate;
      sinkWorstDown(heap, 0);
    }
  }
  return heap.sort(compareCandidatesByRecency);
}

function bubbleWorstUp(heap: Candidate[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareCandidatesByRecency(heap[parent]!, heap[index]!) >= 0) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

function sinkWorstDown(heap: Candidate[], start: number): void {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (
      left < heap.length &&
      compareCandidatesByRecency(heap[worst]!, heap[left]!) < 0
    ) {
      worst = left;
    }
    if (
      right < heap.length &&
      compareCandidatesByRecency(heap[worst]!, heap[right]!) < 0
    ) {
      worst = right;
    }
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
    index = worst;
  }
}

function compareCandidatesByRecency(left: Candidate, right: Candidate): number {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  return Buffer.compare(left.pathBytes, right.pathBytes);
}

function compareMemoryHeadersByRecency(
  left: MemoryHeader,
  right: MemoryHeader,
): number {
  if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
  return Buffer.compare(left.pathBytes, right.pathBytes);
}

function portablePathBytes(root: BoundMemoryRoot, relativePath: string): Buffer {
  return Buffer.from(
    `${root.binding.canonicalPath.replaceAll(sep, "/")}/${relativePath.replaceAll(sep, "/")}`,
    "utf8",
  );
}

/**
 * Path used to enumerate and open entries below an already-verified
 * descriptor. Linux traverses through `/proc/self/fd/N`. On darwin and
 * freebsd `/dev/fd/N` is not traversable (`opendir` fails with ENOTDIR and
 * children resolve to ENOENT), so the real requested path is used while the
 * retained descriptor, `O_NOFOLLOW`, `nlink === 1`, and the before/after
 * identity checks continue to guard against exchanges.
 */
function descriptorHandlePath(handle: FileHandle, requestedPath: string): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return requestedPath;
  }
  throw new MemoryScanFailure(
    "unsupported",
    "descriptor-relative traversal is unavailable on this platform",
  );
}

function descriptorRelativePath(
  root: BoundMemoryRoot,
  relativePath: string,
): string {
  const descriptorPath = descriptorHandlePath(
    root.handle,
    root.binding.requestedPath,
  );
  return relativePath.length === 0
    ? descriptorPath
    : join(descriptorPath, relativePath);
}

function canonicalRelativePath(
  root: BoundMemoryRoot,
  relativePath: string,
): string {
  return relativePath.length === 0
    ? root.binding.canonicalPath
    : join(root.binding.canonicalPath, relativePath);
}

function isBoundDirectoryPath(root: string, candidate: string): boolean {
  return candidate === root || isContained(root, candidate);
}

async function closeHandle(
  handle: FileHandle,
  signal: AbortSignal,
): Promise<void> {
  await handle.close().catch(() => undefined);
  throwIfMemoryRecallAborted(signal);
}

function accountPath(pathBytes: Buffer, budget: ScanBudget): void {
  if (pathBytes.byteLength > MAX_C3A_PATH_UTF8_BYTES) {
    throw new MemoryScanFailure("limit", "memory candidate path exceeds limit");
  }
  budget.totalPathBytes += pathBytes.byteLength;
  if (budget.totalPathBytes > MAX_C3A_TOTAL_PATH_UTF8_BYTES) {
    throw new MemoryScanFailure("limit", "memory path storage limit crossed");
  }
}

function checkScanBudget(budget: ScanBudget, signal: AbortSignal): void {
  throwIfMemoryRecallAborted(signal);
  if (budget.now() > budget.deadline) {
    throw new MemoryScanFailure("deadline", "memory scan deadline crossed");
  }
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation.length > 0 &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function identityFromStats(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameStats(left: BigIntStats | FileIdentity, right: BigIntStats | FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameStats(left, right);
}

function firstLines(text: string, maximumLines: number): string {
  return text.split("\n", maximumLines + 1).slice(0, maximumLines).join("\n");
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let failure: unknown;
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      async () => {
        while (true) {
          if (failure !== undefined) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= items.length) return;
          try {
            results[index] = await mapper(items[index]!);
          } catch (error) {
            failure ??= error;
            return;
          }
        }
      },
    ),
  );
  if (failure !== undefined) throw failure;
  return results;
}

export function formatMemoryManifest(memories: readonly MemoryHeader[]): string {
  return memories
    .map((memory) => {
      const tag = memory.type ? `[${memory.type}] ` : "";
      const timestamp = new Date(memory.mtimeMs).toISOString();
      return memory.description
        ? `- ${tag}${memory.filename} (${timestamp}): ${memory.description}`
        : `- ${tag}${memory.filename} (${timestamp})`;
    })
    .join("\n");
}
