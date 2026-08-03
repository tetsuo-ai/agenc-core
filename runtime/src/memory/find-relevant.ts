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
  scanMemoryRoots,
  type MemoryHeader,
} from "./scan.js";

export interface RelevantMemory {
  readonly path: string;
  readonly mtimeMs: number;
  readonly header: MemoryHeader;
}

export interface FindRelevantMemoriesOptions {
  readonly query: string;
  readonly memoryDirs: readonly string[];
  readonly signal: AbortSignal;
  readonly recentTools?: readonly string[];
  readonly alreadySurfaced?: ReadonlySet<string>;
  readonly mode?: MemoryRecallMode;
  readonly admittedMemorySelector?: AdmittedMemorySelector;
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
  const scan = await scanMemoryRoots(options.memoryDirs, options.signal);
  if (scan.kind !== "complete") return [];
  const headers = scan.headers.filter(
    (header) => !options.alreadySurfaced.has(header.filePath),
  );
  const ranked = rankMemoryHeaders(
    normalizeMemoryQuery(options.query),
    headers,
    options.mode,
    options.signal,
  );
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
    return toRelevantMemories(selected.slice(0, MAX_RELEVANT_MEMORIES));
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
): Required<
  Omit<FindRelevantMemoriesOptions, "admittedMemorySelector">
> &
  Pick<FindRelevantMemoriesOptions, "admittedMemorySelector"> {
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
  return toRelevantMemories(ranked.slice(0, MAX_RELEVANT_MEMORIES));
}

function toRelevantMemories(
  ranked: readonly RankedMemoryHeader[],
): RelevantMemory[] {
  return ranked.map(({ header }) => ({
    path: header.filePath,
    mtimeMs: header.mtimeMs,
    header,
  }));
}
