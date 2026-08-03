/**
 * Immutable, bounded file-name index used by the TUI.
 *
 * Builds happen in a shadow array and publish with one reference swap. A
 * search therefore observes either the preceding complete generation or the
 * next complete generation, never a partially prepared prefix.
 */

import {
  FuzzyCandidateBudget,
  MAX_FUZZY_RESULT_LIMIT,
  prepareFuzzyCandidate,
  rankFuzzyCandidatesSync,
  type PreparedFuzzyCandidate,
} from "../../../../search/fuzzy-match.js";

export type SearchResult = {
  path: string;
  score: number;
};

export const DEFAULT_TUI_FUZZY_RESULTS = 100;
const TEST_PATH_PENALTY = 1.05;
const NORMALIZED_SCORE_MAXIMUM = 1;
const ASYNC_CLOCK_CHECK_MASK = 0xff;

// Yield after this much synchronous preparation. The build remains private
// until it is complete, so yielding affects responsiveness but not visibility.
const CHUNK_MS = 4;

interface FileIndexGeneration {
  readonly id: number;
  readonly paths: readonly PreparedFuzzyCandidate[];
  readonly topLevel: readonly SearchResult[];
}

const EMPTY_GENERATION: FileIndexGeneration = Object.freeze({
  id: 0,
  paths: Object.freeze([]),
  topLevel: Object.freeze([]),
});

export class FileIndex {
  private generation: FileIndexGeneration = EMPTY_GENERATION;
  private requestedGeneration = 0;

  /** Build and atomically publish a complete generation. */
  loadFromFileList(fileList: string[]): void {
    const generationId = this.nextGenerationId();
    const paths = preparePaths(fileList);
    this.publishGeneration(generationId, paths);
  }

  /**
   * Build without blocking the event loop for an unbounded interval.
   *
   * `queryable` remains as an API-compatibility alias for `done`; partial
   * generations are deliberately not queryable. If a newer build starts, an
   * older completion is superseded and cannot replace it.
   */
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>;
    done: Promise<void>;
  } {
    const generationId = this.nextGenerationId();
    const done = this.buildAsync(fileList, generationId);
    return { queryable: done, done };
  }

  /** Search one immutable generation with the shared bounded matcher. */
  search(query: string, limit: number): SearchResult[] {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > MAX_FUZZY_RESULT_LIMIT
    )
      return [];
    const snapshot = this.generation;
    if (query.length === 0) {
      if (limit <= DEFAULT_TUI_FUZZY_RESULTS) {
        return snapshot.topLevel.slice(0, limit);
      }
      return computeTopLevelEntries(snapshot.paths, limit);
    }

    const ranked = rankFuzzyCandidatesSync(query, snapshot.paths, {
      caseMode: "smart",
      limit,
    });
    const denominator = Math.max(ranked.length, 1);
    return ranked.map((match, index) => {
      const normalized = index / denominator;
      const score = match.candidate.includes("test")
        ? Math.min(normalized * TEST_PATH_PENALTY, NORMALIZED_SCORE_MAXIMUM)
        : normalized;
      return { path: match.candidate, score };
    });
  }

  private nextGenerationId(): number {
    this.requestedGeneration += 1;
    return this.requestedGeneration;
  }

  private async buildAsync(
    fileList: readonly string[],
    generationId: number,
  ): Promise<void> {
    // Preserve asynchronous API semantics even for a tiny list: callers keep
    // the preceding generation for the remainder of their current turn.
    await yieldToEventLoop();
    if (generationId !== this.requestedGeneration) return;
    const seen = new Set<string>();
    const paths: PreparedFuzzyCandidate[] = [];
    const budget = new FuzzyCandidateBudget();
    let chunkStartedAt = performance.now();
    for (const [index, path] of fileList.entries()) {
      if (generationId !== this.requestedGeneration) return;
      if (path.length > 0 && !seen.has(path)) {
        const prepared = prepareFuzzyCandidate(path);
        budget.add(prepared);
        seen.add(path);
        paths.push(prepared);
      }
      if (
        (index & ASYNC_CLOCK_CHECK_MASK) === ASYNC_CLOCK_CHECK_MASK &&
        performance.now() - chunkStartedAt > CHUNK_MS
      ) {
        await yieldToEventLoop();
        if (generationId !== this.requestedGeneration) return;
        chunkStartedAt = performance.now();
      }
    }
    this.publishGeneration(generationId, paths);
  }

  private publishGeneration(
    generationId: number,
    preparedPaths: readonly PreparedFuzzyCandidate[],
  ): void {
    if (generationId !== this.requestedGeneration) return;
    const paths = Object.freeze([...preparedPaths]);
    const topLevel = Object.freeze(
      computeTopLevelEntries(paths, DEFAULT_TUI_FUZZY_RESULTS),
    );
    this.generation = Object.freeze({ id: generationId, paths, topLevel });
  }
}

function preparePaths(
  fileList: readonly string[],
): readonly PreparedFuzzyCandidate[] {
  const seen = new Set<string>();
  const paths: PreparedFuzzyCandidate[] = [];
  const budget = new FuzzyCandidateBudget();
  for (const path of fileList) {
    if (path.length === 0 || seen.has(path)) continue;
    const prepared = prepareFuzzyCandidate(path);
    budget.add(prepared);
    seen.add(path);
    paths.push(prepared);
  }
  return paths;
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export { CHUNK_MS };

function computeTopLevelEntries(
  paths: readonly PreparedFuzzyCandidate[],
  limit: number,
): SearchResult[] {
  const topLevel: string[] = [];
  const selected = new Set<string>();
  for (const candidate of paths) {
    const path = candidate.text;
    const forwardSlash = path.indexOf("/");
    const backslash = path.indexOf("\\");
    const separator =
      forwardSlash < 0
        ? backslash
        : backslash < 0
          ? forwardSlash
          : Math.min(forwardSlash, backslash);
    const segment = path.slice(0, separator < 0 ? path.length : separator);
    if (segment.length > 0) retainTopLevel(topLevel, selected, segment, limit);
  }
  return topLevel.sort(compareTopLevel).map((path) => ({ path, score: 0 }));
}

function retainTopLevel(
  heap: string[],
  selected: Set<string>,
  candidate: string,
  limit: number,
): void {
  if (limit <= 0 || selected.has(candidate)) return;
  if (heap.length < limit) {
    heap.push(candidate);
    selected.add(candidate);
    bubbleTopLevelUp(heap, heap.length - 1);
    return;
  }
  if (compareTopLevel(candidate, heap[0]!) >= 0) return;
  selected.delete(heap[0]!);
  heap[0] = candidate;
  selected.add(candidate);
  bubbleTopLevelDown(heap, 0);
}

function bubbleTopLevelUp(heap: string[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareTopLevel(heap[index]!, heap[parent]!) <= 0) return;
    const childValue = heap[index]!;
    heap[index] = heap[parent]!;
    heap[parent] = childValue;
    index = parent;
  }
}

function bubbleTopLevelDown(heap: string[], start: number): void {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && compareTopLevel(heap[left]!, heap[worst]!) > 0) {
      worst = left;
    }
    if (
      right < heap.length &&
      compareTopLevel(heap[right]!, heap[worst]!) > 0
    ) {
      worst = right;
    }
    if (worst === index) return;
    const currentValue = heap[index]!;
    heap[index] = heap[worst]!;
    heap[worst] = currentValue;
    index = worst;
  }
}

function compareTopLevel(left: string, right: string): number {
  const length = left.length - right.length;
  if (length !== 0) return length;
  const portableLeft = left.replace(/\\/gu, "/");
  const portableRight = right.replace(/\\/gu, "/");
  if (portableLeft < portableRight) return -1;
  if (portableLeft > portableRight) return 1;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export default FileIndex;
export type { FileIndex as FileIndexType };
