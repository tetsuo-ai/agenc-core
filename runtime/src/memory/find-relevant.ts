import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
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
const MAX_RECALL_SNAPSHOT_FILE_BYTES = 1_048_576;
const MAX_RECALL_SNAPSHOT_BYTES = 8_388_608;
const MAX_CACHED_RECALLS = 64;

interface MemoryTreeSnapshot {
  readonly signature: string;
  readonly hasIndexableMemory: boolean;
}

interface CachedRecall {
  readonly snapshot: string;
  readonly ranked: readonly RankedMemoryHeader[];
}

interface KnownFreshTree {
  readonly snapshot: string;
  readonly generations: readonly string[];
}

const cachedRecalls = new Map<string, CachedRecall>();
const knownFreshTrees = new Map<string, KnownFreshTree>();
const pendingIndexRecalls = new Map<string, Promise<void>>();

export function closeFullCorpusMemoryIndexes(): void {
  for (const index of fullCorpusIndexes.values()) index.close();
  fullCorpusIndexes.clear();
  cachedRecalls.clear();
  knownFreshTrees.clear();
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
    // The signature includes the content of every memory file.
    return cached.ranked.filter(
      (entry) => !options.alreadySurfaced.has(entry.header.filePath),
    );
  }
  const knownFresh = snapshot === null ? undefined : knownFreshTrees.get(indexKey);
  let needsExplicitRefresh = snapshot !== null && knownFresh?.snapshot !== snapshot;
  const index = getFullCorpusIndex(options.memoryIndexDatabasePath);
  const roots: MemoryIndexRootSpec[] = options.memoryDirs.map(
    (path, rootIndex) => ({
      path,
      role: rootIndex === 0 ? "global" : "project",
    }),
  );
  try {
    // Query the proven generation directly when its content snapshot still
    // matches. An unseen tree needs an explicit rebuild.
    let refreshed = knownFresh?.snapshot === snapshot
      ? undefined
      : await index.refresh(
          roots,
          options.signal,
          needsExplicitRefresh ? { explicit: true } : {},
        );
    let result = await index.query(
      roots,
      normalizedQuery.terms,
      options.signal,
    );
    if (
      refreshed === undefined &&
      knownFresh !== undefined &&
      (result.freshness.length !== knownFresh.generations.length ||
        result.freshness.some(
          (root, rootIndex) =>
            generationKey(root) !== knownFresh.generations[rootIndex],
        ))
    ) {
      // A different generation cannot inherit the snapshot's proof.
      knownFreshTrees.delete(indexKey);
      needsExplicitRefresh = true;
      refreshed = await index.refresh(roots, options.signal, { explicit: true });
      result = await index.query(roots, normalizedQuery.terms, options.signal);
    }
    let ranked: RankedMemoryHeader[] = [];
    let unchangedSnapshot = false;
    for (;;) {
      throwIfMemoryRecallAborted(options.signal);
      if (
        result.kind === "unavailable" ||
        result.kind === "query_resource_limited"
      ) {
        return null;
      }
      ranked = [];
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
      unchangedSnapshot =
        snapshot !== null &&
        JSON.stringify(
          options.memoryDirs.map((directory) => snapshotMemoryTree(directory)?.signature),
        ) === snapshot;
      if (refreshed !== undefined || unchangedSnapshot) break;

      // The skipped query used a generation from before this tree changed.
      knownFreshTrees.delete(indexKey);
      needsExplicitRefresh = true;
      refreshed = await index.refresh(roots, options.signal, { explicit: true });
      result = await index.query(roots, normalizedQuery.terms, options.signal);
    }
    const matchingGenerations =
      result.freshness.length === roots.length &&
      (refreshed === undefined
        ? result.freshness.every((root, index) =>
            root.state === "complete" &&
            generationKey(root) === knownFresh?.generations[index],
          )
        : refreshed.roots.length === roots.length &&
          refreshed.roots.every((root, index) =>
            root.state === "complete" &&
            root.generationId !== null &&
            root.generationId === result.freshness[index]?.generationId &&
            root.generationToken === result.freshness[index]?.generationToken,
          ));
    const generations = result.freshness.map(generationKey);
    const provenFresh = refreshed === undefined
      ? knownFresh?.snapshot === snapshot
      : needsExplicitRefresh && refreshed.freshGeneration?.every(Boolean) === true;
    if (
      snapshot !== null &&
      matchingGenerations &&
      unchangedSnapshot &&
      provenFresh &&
      !options.signal.aborted
    ) {
      knownFreshTrees.delete(indexKey);
      knownFreshTrees.set(indexKey, { snapshot, generations });
      if (knownFreshTrees.size > MAX_CACHED_RECALLS) {
        knownFreshTrees.delete(knownFreshTrees.keys().next().value!);
      }
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

function generationKey(root: { generationId: number | null; generationToken: string | null }): string {
  return JSON.stringify([root.generationId, root.generationToken]);
}

function snapshotMemoryTree(root: string): MemoryTreeSnapshot | null {
  const entries: string[] = [];
  const pending = [root];
  let hasIndexableMemory = false;
  let memoryBytes = 0n;
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
      let contentHash: string | null = null;
      if (stats.isFile() && basename(path).endsWith(".md")) {
        memoryBytes += stats.size;
        if (
          stats.size > BigInt(MAX_RECALL_SNAPSHOT_FILE_BYTES) ||
          memoryBytes > BigInt(MAX_RECALL_SNAPSHOT_BYTES)
        ) return null;
        contentHash = createHash("sha256").update(readFileSync(path)).digest("hex");
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
      entries.push(
        JSON.stringify([
          name,
          stats.dev.toString(),
          stats.ino.toString(),
          stats.mode.toString(),
          stats.size.toString(),
          stats.mtimeNs.toString(),
          stats.ctimeNs.toString(),
          contentHash,
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
    // A deterministic code-point order, not a locale-aware one: the sorted
    // array only ever feeds a canonical signature, never a display list.
    entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  const tail = previous === undefined ? current : previous.then(() => current);
  pendingIndexRecalls.set(databasePath, tail);
  void tail.then(() => {
    if (pendingIndexRecalls.get(databasePath) === tail) {
      pendingIndexRecalls.delete(databasePath);
    }
  });
  try {
    if (previous !== undefined) await waitForIndexLock(previous, signal);
    throwIfMemoryRecallAborted(signal);
    return await run();
  } finally {
    release();
  }
}

function waitForIndexLock(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason ?? new DOMException("Memory recall aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    if (signal.aborted) onAbort();
  });
}

function getFullCorpusIndex(databasePath: string): PersistentMemoryIndex {
  const existing = fullCorpusIndexes.get(databasePath);
  if (existing !== undefined) return existing;
  const index = new PersistentMemoryIndex({ databasePath });
  fullCorpusIndexes.set(databasePath, index);
  return index;
}
