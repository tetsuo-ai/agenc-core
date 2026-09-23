import { lstatSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

import {
  MAX_RELEVANT_MEMORIES,
  buildMemorySelectorRequest,
  isMemoryRecallAbort,
  normalizeMemoryQuery,
  rankMemoryHeaders,
  throwIfMemoryRecallAborted,
  type AdmittedMemorySelector,
  type MemoryRecallMode,
  type RankedMemoryHeader,
} from "./recall-contract.js";
import {
  PersistentMemoryIndex,
  type MemoryIndexRootSpec,
} from "./full-corpus-index.js";
import {
  scanMemoryRoots,
  type MemoryHeader,
} from "./scan.js";

export interface RelevantMemory {
  readonly path: string;
  readonly mtimeMs: number;
  readonly header: MemoryHeader;
  readonly selectionSource: "lexical" | "reranked";
}

export interface FindRelevantMemoriesOptions {
  readonly query: string;
  readonly memoryDirs: readonly string[];
  readonly signal: AbortSignal;
  readonly recentTools?: readonly string[];
  readonly alreadySurfaced?: ReadonlySet<string>;
  readonly mode?: MemoryRecallMode;
  readonly admittedMemorySelector?: AdmittedMemorySelector;
  readonly memoryIndexDatabasePath?: string;
}

type NormalizedFindRelevantMemoriesOptions = Required<
  Omit<
    FindRelevantMemoriesOptions,
    "admittedMemorySelector" | "memoryIndexDatabasePath"
  >
> &
  Pick<
    FindRelevantMemoriesOptions,
    "admittedMemorySelector" | "memoryIndexDatabasePath"
  >;

const fullCorpusIndexes = new Map<string, PersistentMemoryIndex>();
const MAX_RECALL_SNAPSHOT_ENTRIES = 2_048;
const MAX_CACHED_RECALLS = 64;

interface MemoryTreeSnapshot {
  readonly signature: string;
  readonly hasIndexableMemory: boolean;
}

interface CachedRecall {
  readonly snapshot: string;
  readonly ranked: readonly RankedMemoryHeader[];
}

const lastIndexSnapshots = new Map<string, string>();
const cachedRecalls = new Map<string, CachedRecall>();
const pendingIndexRecalls = new Map<string, Promise<void>>();

export function closeFullCorpusMemoryIndexes(): void {
  for (const index of fullCorpusIndexes.values()) index.close();
  fullCorpusIndexes.clear();
  lastIndexSnapshots.clear();
  cachedRecalls.clear();
}

export function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools?: readonly string[],
  alreadySurfaced?: ReadonlySet<string>,
): Promise<RelevantMemory[]>;
export function findRelevantMemories(
  options: FindRelevantMemoriesOptions,
): Promise<RelevantMemory[]>;
export async function findRelevantMemories(
  queryOrOptions: string | FindRelevantMemoriesOptions,
  memoryDir?: string,
  signal?: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const options = normalizeFindOptions(
    queryOrOptions,
    memoryDir,
    signal,
    recentTools,
    alreadySurfaced,
  );
  throwIfMemoryRecallAborted(options.signal);
  const indexed =
    options.memoryIndexDatabasePath === undefined
      ? await tryFullCorpusRanking(options)
      : await withIndexLock(
          options.memoryIndexDatabasePath,
          options.signal,
          () => tryFullCorpusRanking(options),
        );
  let ranked: RankedMemoryHeader[];
  if (indexed !== null) {
    ranked = indexed;
  } else {
    const scan = await scanMemoryRoots(options.memoryDirs, options.signal);
    if (scan.kind !== "complete") return [];
    const headers = scan.headers.filter(
      (header) => !options.alreadySurfaced.has(header.filePath),
    );
    ranked = rankMemoryHeaders(
      normalizeMemoryQuery(options.query),
      headers,
      options.mode,
      options.signal,
    );
  }
  if (ranked.length === 0) return [];

  const lexicalFallback = selectLexicalFallback(ranked);
  // The selector can only drop candidates. When every ranked candidate
  // already fits the attachment limit there is nothing for a rerank to
  // change, so skip the extra main-model round trip on the request path.
  if (
    options.admittedMemorySelector === undefined ||
    options.mode === "session_start" ||
    ranked.length <= MAX_RELEVANT_MEMORIES
  ) {
    return lexicalFallback;
  }
  const request = buildMemorySelectorRequest(
    options.query,
    options.mode,
    ranked,
    options.recentTools,
  );
  try {
    const selection = await options.admittedMemorySelector.select(
      request,
      options.signal,
    );
    throwIfMemoryRecallAborted(options.signal);
    if (selection.kind !== "selected") return lexicalFallback;
    const byId = new Map(
      request.candidates.map((candidate, index) => [candidate.id, ranked[index]!] as const),
    );
    const selected: RankedMemoryHeader[] = [];
    const seen = new Set<string>();
    for (const candidateId of selection.candidateIds) {
      const entry = byId.get(candidateId);
      if (entry === undefined || seen.has(candidateId)) return lexicalFallback;
      seen.add(candidateId);
      selected.push(entry);
    }
    return toRelevantMemories(
      selected.slice(0, MAX_RELEVANT_MEMORIES),
      "reranked",
    );
  } catch (error) {
    if (isMemoryRecallAbort(error, options.signal)) {
      throw options.signal.reason ?? error;
    }
    return lexicalFallback;
  }
}

function normalizeFindOptions(
  queryOrOptions: string | FindRelevantMemoriesOptions,
  memoryDir: string | undefined,
  signal: AbortSignal | undefined,
  recentTools: readonly string[],
  alreadySurfaced: ReadonlySet<string>,
): NormalizedFindRelevantMemoriesOptions {
  if (typeof queryOrOptions !== "string") {
    return {
      query: queryOrOptions.query,
      memoryDirs: queryOrOptions.memoryDirs,
      signal: queryOrOptions.signal,
      recentTools: queryOrOptions.recentTools ?? [],
      alreadySurfaced: queryOrOptions.alreadySurfaced ?? new Set(),
      mode: queryOrOptions.mode ?? "query",
      ...(queryOrOptions.admittedMemorySelector !== undefined
        ? { admittedMemorySelector: queryOrOptions.admittedMemorySelector }
        : {}),
      ...(queryOrOptions.memoryIndexDatabasePath !== undefined
        ? { memoryIndexDatabasePath: queryOrOptions.memoryIndexDatabasePath }
        : {}),
    };
  }
  if (memoryDir === undefined || signal === undefined) {
    throw new TypeError("legacy memory recall requires a directory and signal");
  }
  return {
    query: queryOrOptions,
    memoryDirs: [memoryDir],
    signal,
    recentTools,
    alreadySurfaced,
    mode: "query",
  };
}

function selectLexicalFallback(
  ranked: readonly RankedMemoryHeader[],
): RelevantMemory[] {
  return toRelevantMemories(
    ranked.slice(0, MAX_RELEVANT_MEMORIES),
    "lexical",
  );
}

function toRelevantMemories(
  ranked: readonly RankedMemoryHeader[],
  selectionSource: RelevantMemory["selectionSource"],
): RelevantMemory[] {
  return ranked.map(({ header }) => ({
    path: header.filePath,
    mtimeMs: header.mtimeMs,
    header,
    selectionSource,
  }));
}

async function tryFullCorpusRanking(
  options: NormalizedFindRelevantMemoriesOptions,
): Promise<RankedMemoryHeader[] | null> {
  if (
    options.memoryIndexDatabasePath === undefined ||
    options.mode === "session_start"
  ) {
    return null;
  }
  const normalizedQuery = normalizeMemoryQuery(options.query);
  if (normalizedQuery.terms.length === 0) return [];
  // The snapshot is bounded. An unreadable, changing, or very large tree
  // uses the ordinary index path. Include non-memory entries in the signature
  // so a rename into .md cannot reuse an earlier result.
  const snapshots = options.memoryDirs.map(snapshotMemoryTree);
  if (
    snapshots.every(
      (entry) => entry !== null && !entry.hasIndexableMemory,
    )
  ) {
    return null;
  }
  const snapshot = snapshots.every((entry) => entry !== null)
    ? JSON.stringify(snapshots.map((entry) => entry.signature))
    : null;
  const rootsKey = JSON.stringify(options.memoryDirs);
  const indexKey = JSON.stringify([options.memoryIndexDatabasePath, rootsKey]);
  const recallKey = JSON.stringify([indexKey, normalizedQuery.terms]);
  const cached = snapshot === null ? undefined : cachedRecalls.get(recallKey);
  if (cached?.snapshot === snapshot) {
    // Reuse only a response already produced by the contained query helper.
    // The manifest also covers file ctime, so an equal-size, restored-mtime
    // edit invalidates this response before the next request.
    return cached.ranked.filter(
      (entry) => !options.alreadySurfaced.has(entry.header.filePath),
    );
  }
  const index = getFullCorpusIndex(options.memoryIndexDatabasePath);
  const roots: MemoryIndexRootSpec[] = options.memoryDirs.map(
    (path, rootIndex) => ({
      path,
      role: rootIndex === 0 ? "global" : "project",
    }),
  );
  try {
    // Watcher delivery can lag a model or extractor write. A changed tree
    // requires an explicit rebuild so the very next request sees the edit,
    // even when its query was never cached before.
    const previousSnapshot = lastIndexSnapshots.get(indexKey);
    const changed =
      snapshot !== null &&
      previousSnapshot !== undefined &&
      previousSnapshot !== snapshot;
    const alreadyFresh = snapshot !== null && previousSnapshot === snapshot;
    const refreshed = alreadyFresh
      ? null
      : await index.refresh(
          roots,
          options.signal,
          changed ? { explicit: true } : {},
        );
    const result = await index.query(
      roots,
      normalizedQuery.terms,
      options.signal,
    );
    throwIfMemoryRecallAborted(options.signal);
    if (
      result.kind === "unavailable" ||
      result.kind === "query_resource_limited"
    ) {
      return null;
    }
    const ranked: RankedMemoryHeader[] = [];
    for (const candidate of result.candidates) {
      throwIfMemoryRecallAborted(options.signal);
      const header = index.readHeader(candidate);
      if (header === null) continue;
      ranked.push({
        header,
        exactPhrase: false,
        distinctTermCoverage: 1,
        cappedTermOccurrences: 1,
      });
    }
    if (
      snapshot !== null &&
      (alreadyFresh ||
        refreshed?.roots.every((root) => root.state === "complete")) &&
      JSON.stringify(
        options.memoryDirs.map((directory) => snapshotMemoryTree(directory)?.signature),
      ) === snapshot
    ) {
      lastIndexSnapshots.set(indexKey, snapshot);
      cachedRecalls.delete(recallKey);
      cachedRecalls.set(recallKey, { snapshot, ranked });
      if (cachedRecalls.size > MAX_CACHED_RECALLS) {
        cachedRecalls.delete(cachedRecalls.keys().next().value!);
      }
    }
    return ranked.filter(
      (entry) => !options.alreadySurfaced.has(entry.header.filePath),
    );
  } catch (error) {
    if (isMemoryRecallAbort(error, options.signal)) {
      throw options.signal.reason ?? error;
    }
    return null;
  }
}

function snapshotMemoryTree(root: string): MemoryTreeSnapshot | null {
  const entries: string[] = [];
  const pending = [root];
  let hasIndexableMemory = false;
  try {
    while (pending.length > 0) {
      if (entries.length >= MAX_RECALL_SNAPSHOT_ENTRIES) return null;
      const path = pending.pop()!;
      let stats;
      try {
        stats = lstatSync(path, { bigint: true });
      } catch (error) {
        if (path === root && isMissingPath(error)) {
          return { signature: "missing", hasIndexableMemory: false };
        }
        return null;
      }
      const name = relative(root, path);
      entries.push(
        JSON.stringify([
          name,
          stats.dev.toString(),
          stats.ino.toString(),
          stats.mode.toString(),
          stats.size.toString(),
          stats.mtimeNs.toString(),
          stats.ctimeNs.toString(),
        ]),
      );
      if (path === root && !stats.isDirectory()) return null;
      if (
        stats.isFile() &&
        basename(path).endsWith(".md") &&
        basename(path) !== "MEMORY.md"
      ) {
        hasIndexableMemory = true;
      }
      if (stats.isDirectory()) {
        const children = readdirSync(path);
        for (const child of children) pending.push(join(path, child));
        const after = lstatSync(path, { bigint: true });
        if (
          stats.dev !== after.dev ||
          stats.ino !== after.ino ||
          stats.mode !== after.mode ||
          stats.size !== after.size ||
          stats.mtimeNs !== after.mtimeNs ||
          stats.ctimeNs !== after.ctimeNs
        ) {
          return null;
        }
      }
    }
    entries.sort();
    return { signature: JSON.stringify(entries), hasIndexableMemory };
  } catch {
    return null;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function withIndexLock<T>(
  databasePath: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const previous = pendingIndexRecalls.get(databasePath);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingIndexRecalls.set(databasePath, current);
  try {
    if (previous !== undefined) await previous;
    throwIfMemoryRecallAborted(signal);
    return await run();
  } finally {
    if (pendingIndexRecalls.get(databasePath) === current) {
      pendingIndexRecalls.delete(databasePath);
    }
    release();
  }
}

function getFullCorpusIndex(databasePath: string): PersistentMemoryIndex {
  const existing = fullCorpusIndexes.get(databasePath);
  if (existing !== undefined) return existing;
  const index = new PersistentMemoryIndex({ databasePath });
  fullCorpusIndexes.set(databasePath, index);
  return index;
}
