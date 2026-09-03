import { Buffer } from "node:buffer";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import {
  assertCandidateUnchanged as assertVerifiedCandidateUnchanged,
  bindVerifiedRoot,
  canonicalRelativePath as verifiedCanonicalRelativePath,
  closeVerifiedHandle,
  descriptorHandlePath as verifiedDescriptorHandlePath,
  descriptorRelativePath as verifiedDescriptorRelativePath,
  finalDescriptorPath as verifiedFinalDescriptorPath,
  identityFromStats as verifiedIdentityFromStats,
  isContained as verifiedIsContained,
  openVerifiedCandidate as openVerifiedCandidateHandle,
  sameDirectoryIdentity as verifiedSameDirectoryIdentity,
  sameStats as verifiedSameStats,
  verifiedDirectoryOpenFlags,
  VerifiedRootUnstableError,
  type FileIdentity,
  type VerifiedReadContext,
  type VerifiedRoot,
  type VerifiedRootBinding,
} from "../fs/verified-read.js";
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

export type { FileIdentity };

export type MemoryRootBinding = VerifiedRootBinding;

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
  readonly root: VerifiedRoot;
  readonly relativePath: string;
  readonly filePath: string;
  readonly pathBytes: Buffer;
  readonly identity: FileIdentity;
  readonly mtimeMs: number;
}

interface CandidatePath {
  readonly root: VerifiedRoot;
  readonly relativePath: string;
  readonly pathBytes: Buffer;
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

/**
 * Memory recall's flavour of the shared descriptor-bound primitives: recall
 * cancellation, and platform gaps reported as an "unsupported" scan result.
 */
const MEMORY_VERIFIED_READ_CONTEXT: VerifiedReadContext = {
  checkAborted: throwIfMemoryRecallAborted,
  unsupportedPlatform: (message) =>
    new MemoryScanFailure("unsupported", message),
};

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
  const roots: VerifiedRoot[] = [];

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
  // The root is a DIRECTORY and this comparison spans two separate binds, so
  // it is dev/ino/mode: any write into the memory directory between the scan
  // and the content read moves its timestamps, and rejecting on that turned
  // every ordinary neighbouring write into "memory root identity changed".
  // The candidate itself keeps the full identity, two checks below.
  if (
    root === null ||
    !sameDirectoryIdentity(root.binding.identity, header.root.identity)
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
): Promise<VerifiedRoot | null> {
  try {
    return await bindVerifiedRoot(
      directory,
      signal,
      MEMORY_VERIFIED_READ_CONTEXT,
    );
  } catch (error) {
    if (error instanceof VerifiedRootUnstableError) {
      throw new MemoryScanFailure(
        "unavailable",
        error.reason === "identity"
          ? "memory root changed while binding"
          : "memory root final path changed",
      );
    }
    throw error;
  }
}

async function collectCandidatePaths(
  root: VerifiedRoot,
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
  root: VerifiedRoot,
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
  // `sameDirectoryIdentity`, not `sameStats`. `pending.identity` was taken
  // before this directory was enumerated, and enumerating a memory directory
  // is exactly when the workspace is likely to be writing into it: a single
  // benign child add, remove, or rename moves this directory's `size`,
  // `mtime`, and `ctime`, and comparing those made the whole scan fail
  // closed. `scanMemoryFiles` swallows that failure and returns an empty
  // list, so the MCP memory listing simply lost every resource. Measured on
  // this machine with a separate process writing and removing one sibling
  // file in the memory directory, and no attacker at all: the memory listing
  // survived 113 of 76,583 attempts, 0.15%. Narrowed to dev/ino/mode, and
  // measured back to back against that same head, 22,561 of 22,561, 100.00%.
  // Controls: no churn 100.00%, churn in a directory outside the memory
  // directory 100.00%.
  if (
    !opened.isDirectory() ||
    current.isSymbolicLink() ||
    !sameDirectoryIdentity(opened, pending.identity) ||
    !sameDirectoryIdentity(opened, current) ||
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
  root: VerifiedRoot,
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
      verifiedDirectoryOpenFlags(),
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
    // Directory identity only: see `assertBoundDirectoryUnchanged`. What this
    // proves is that the descriptor landed on the directory whose identity was
    // recorded when its parent enumerated it, and dev/ino/mode is that proof.
    if (
      !opened.isDirectory() ||
      opened.nlink < 1n ||
      !sameDirectoryIdentity(opened, pending.identity) ||
      !sameDirectoryIdentity(opened, current)
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
  root: VerifiedRoot,
  pending: PendingDirectory,
  signal: AbortSignal,
  hooks: MemoryScanTestHooks,
): Promise<OpenedDirectory> {
  const opened = await root.handle.stat({ bigint: true });
  throwIfMemoryRecallAborted(signal);
  const current = await lstat(root.binding.requestedPath, { bigint: true });
  throwIfMemoryRecallAborted(signal);
  // Directory identity only: see `assertBoundDirectoryUnchanged`. `pending`
  // here carries the root's own binding identity, so a full comparison
  // required the memory directory's timestamps to stand still between the
  // bind and the enumeration a moment later.
  if (
    !opened.isDirectory() ||
    !sameDirectoryIdentity(opened, pending.identity) ||
    !sameDirectoryIdentity(opened, current)
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
  root: VerifiedRoot,
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
  root: VerifiedRoot,
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
  root: VerifiedRoot,
  relativePath: string,
  signal: AbortSignal,
): Promise<FileHandle | null> {
  return await openVerifiedCandidateHandle(
    root,
    relativePath,
    signal,
    MEMORY_VERIFIED_READ_CONTEXT,
  );
}

async function assertCandidateUnchanged(
  handle: FileHandle,
  descriptorPath: string,
  before: FileIdentity,
  signal: AbortSignal,
): Promise<void> {
  await assertVerifiedCandidateUnchanged(
    handle,
    descriptorPath,
    before,
    signal,
    MEMORY_VERIFIED_READ_CONTEXT,
  );
}

async function finalDescriptorPath(
  handle: FileHandle,
  expectedPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  return await verifiedFinalDescriptorPath(
    handle,
    expectedPath,
    signal,
    MEMORY_VERIFIED_READ_CONTEXT,
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

function portablePathBytes(root: VerifiedRoot, relativePath: string): Buffer {
  return Buffer.from(
    `${root.binding.canonicalPath.replaceAll(sep, "/")}/${relativePath.replaceAll(sep, "/")}`,
    "utf8",
  );
}

function descriptorHandlePath(handle: FileHandle, requestedPath: string): string {
  return verifiedDescriptorHandlePath(
    handle,
    requestedPath,
    MEMORY_VERIFIED_READ_CONTEXT,
  );
}

function descriptorRelativePath(
  root: VerifiedRoot,
  relativePath: string,
): string {
  return verifiedDescriptorRelativePath(
    root,
    relativePath,
    MEMORY_VERIFIED_READ_CONTEXT,
  );
}

function canonicalRelativePath(
  root: VerifiedRoot,
  relativePath: string,
): string {
  return verifiedCanonicalRelativePath(root, relativePath);
}

function isBoundDirectoryPath(root: string, candidate: string): boolean {
  return candidate === root || isContained(root, candidate);
}

async function closeHandle(
  handle: FileHandle,
  signal: AbortSignal,
): Promise<void> {
  await closeVerifiedHandle(handle, signal, MEMORY_VERIFIED_READ_CONTEXT);
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

const isContained = verifiedIsContained;
const identityFromStats = verifiedIdentityFromStats;
const sameStats = verifiedSameStats;
const sameDirectoryIdentity = verifiedSameDirectoryIdentity;

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
