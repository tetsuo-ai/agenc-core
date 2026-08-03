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

export function closeFullCorpusMemoryIndexes(): void {
  for (const index of fullCorpusIndexes.values()) index.close();
  fullCorpusIndexes.clear();
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
  const indexed = await tryFullCorpusRanking(options);
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
  if (
    options.admittedMemorySelector === undefined ||
    options.mode === "session_start"
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
  const index = getFullCorpusIndex(options.memoryIndexDatabasePath);
  const roots: MemoryIndexRootSpec[] = options.memoryDirs.map((path, rootIndex) => ({
    path,
    role: rootIndex === 0 ? "global" : "project",
  }));
  try {
    await index.refresh(roots, options.signal);
    const result = await index.query(roots, normalizedQuery.terms, options.signal);
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
      if (options.alreadySurfaced.has(candidate.canonicalPath)) continue;
      const header = index.readHeader(candidate);
      if (header === null) continue;
      ranked.push({
        header,
        exactPhrase: false,
        distinctTermCoverage: 1,
        cappedTermOccurrences: 1,
      });
    }
    return ranked;
  } catch (error) {
    if (isMemoryRecallAbort(error, options.signal)) {
      throw options.signal.reason ?? error;
    }
    return null;
  }
}

function getFullCorpusIndex(databasePath: string): PersistentMemoryIndex {
  const existing = fullCorpusIndexes.get(databasePath);
  if (existing !== undefined) return existing;
  const index = new PersistentMemoryIndex({ databasePath });
  fullCorpusIndexes.set(databasePath, index);
  return index;
}
