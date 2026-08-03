/**
 * One bounded fuzzy-subsequence matcher for daemon and TUI file search.
 *
 * The dynamic program is the linear-state form of the fzf/nucleo scoring
 * family: each query/candidate pair is O(query code points * candidate code
 * points), while gap transitions use a running maximum instead of rescanning
 * every earlier candidate position. Highlight offsets are UTF-16 offsets so
 * they remain compatible with JavaScript renderers and the daemon protocol.
 */

import { basename } from "node:path";

/** Shared-core ceiling; the daemon applies its stricter 256-code-point limit. */
export const MAX_FUZZY_QUERY_UTF8_BYTES = 262_144;
export const MAX_FUZZY_QUERY_CODE_POINTS = 65_535;
export const MAX_FUZZY_CANDIDATE_UTF8_BYTES = 262_144;
export const MAX_FUZZY_CANDIDATE_CODE_POINTS = 65_535;
/** Pinned Nucleo v0.4.0 MatrixSlab cell ceiling (100 * 1024). */
export const MAX_FUZZY_MATRIX_CELLS = 102_400;
export const MAX_FUZZY_OPTIMAL_NEEDLE_CODE_POINTS = 2_048;
export const MAX_FUZZY_OPTIMAL_HAYSTACK_CODE_POINTS = 65_535;
export const MAX_FUZZY_TRACE_BYTES = 2_097_152;
export const MAX_FUZZY_CANDIDATES = 1_000_000;
export const MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES = 134_217_728;
export const MAX_FUZZY_RESULT_LIMIT = 1_000;

const SCORE_MATCH = 16;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;
const BONUS_BOUNDARY = 8;
const BONUS_BOUNDARY_DELIMITER = 9;
const BONUS_CAMEL_OR_NUMBER = 5;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHARACTER_MULTIPLIER = 2;
const SCORE_LENGTH_BONUS_CEILING = 32;
const SCORE_LENGTH_BONUS_DIVISOR = 4;
const TEST_PATH_RANK_DIVISOR = 1.05;
const UNREACHABLE_SCORE = Number.NEGATIVE_INFINITY;
const UTF16_HIGH_SURROGATE_START = 0xd800;
const UTF16_HIGH_SURROGATE_END = 0xdbff;
const UTF16_LOW_SURROGATE_START = 0xdc00;
const UTF16_LOW_SURROGATE_END = 0xdfff;
const BYTE_NUL = 0x00;
const NUCLEO_MATRIX_SLAB_BYTES = 133_120;
const NUCLEO_SCORE_CELL_BYTES = 8;
const NUCLEO_MATRIX_CELL_BYTES = 1;
const NUCLEO_ASCII_CODE_POINT_BYTES = 1;
const NUCLEO_UNICODE_CODE_POINT_BYTES = 4;
const NUCLEO_ROW_OFFSET_BYTES = 2;
const NUCLEO_LAYOUT_MAX_ALIGNMENT = 8;
const PREPARED_FUZZY_CODE_POINT_ARRAY_COUNT = 5;
const PREPARED_FUZZY_SIGNATURE_COUNT = 4;
const PREPARED_FUZZY_TYPED_ARRAY_COUNT =
  PREPARED_FUZZY_CODE_POINT_ARRAY_COUNT + PREPARED_FUZZY_SIGNATURE_COUNT + 1;
// Admission reserves conservative 64-bit V8 object/view/header space in
// addition to the exact packed backing-buffer and two-byte string payloads.
// These values are deliberately upper estimates, not heap-size promises.
const PREPARED_FUZZY_OBJECT_OVERHEAD_BYTES = 128;
const PREPARED_FUZZY_ARRAY_BUFFER_OVERHEAD_BYTES = 64;
const PREPARED_FUZZY_TYPED_ARRAY_OVERHEAD_BYTES = 64;
const JAVASCRIPT_STRING_OVERHEAD_BYTES = 24;
const JAVASCRIPT_CODE_UNIT_BYTES = 2;
const trustedPreparedFuzzyCandidates = new WeakSet<object>();
const FUZZY_WORK_BUDGET_EXHAUSTED = Symbol("fuzzy-work-budget-exhausted");

// Every consecutive-run boundary bonus is one of these values. Keeping the
// state explicit preserves the best future consecutive chain without the
// recursive O(m*n^2) search previously used by the daemon.
const RUN_BONUSES = Object.freeze([
  0,
  BONUS_CONSECUTIVE + 1,
  BONUS_BOUNDARY,
  BONUS_BOUNDARY_DELIMITER,
]);
const RUN_BONUS_STATE_COUNT = RUN_BONUSES.length;

export type FuzzyBoundaryReason =
  | "EMPTY_QUERY"
  | "TEXT_NUL"
  | "TEXT_LONE_SURROGATE"
  | "QUERY_BYTE_LIMIT"
  | "QUERY_CODE_POINT_LIMIT"
  | "CANDIDATE_BYTE_LIMIT"
  | "CANDIDATE_CODE_POINT_LIMIT"
  | "MATRIX_LIMIT"
  | "CANDIDATE_COUNT_LIMIT"
  | "CANDIDATE_TOTAL_BYTE_LIMIT"
  | "RESULT_LIMIT";

export class FuzzyBoundaryError extends Error {
  readonly reason: FuzzyBoundaryReason;

  constructor(reason: FuzzyBoundaryReason, message: string) {
    super(message);
    this.name = "FuzzyBoundaryError";
    this.reason = reason;
  }
}

export type FuzzyCaseMode = "insensitive" | "sensitive" | "smart";

export interface FuzzyMatchOptions {
  readonly caseMode?: FuzzyCaseMode;
  readonly includeIndices?: boolean;
  readonly lengthBonus?: boolean;
  readonly matchBasename?: boolean;
  /** Internal request-budget switch; still matches the complete query. */
  readonly forceDegraded?: boolean;
  /** Shared request budget; all full-path and basename work is charged here. */
  readonly workBudget?: FuzzyMatchWorkBudget;
}

export interface FuzzyMatch {
  readonly score: number;
  readonly indices: readonly number[];
  readonly quality: FuzzyMatchQuality;
}

export type FuzzyMatchQuality = "optimal" | "degraded";

export interface FuzzyMatchWorkBudgetOptions {
  readonly maximumMatrixCells: number;
  readonly maximumCodePointVisits: number;
}

/** Mutable request-wide meter shared by every candidate and top-k rematch. */
export class FuzzyMatchWorkBudget {
  readonly #maximumMatrixCells: number;
  readonly #maximumCodePointVisits: number;
  #matrixCells = 0;
  #codePointVisits = 0;
  #matrixLimited = false;
  #exhausted = false;
  #indexMaterializations = 0;

  constructor(options: FuzzyMatchWorkBudgetOptions) {
    this.#maximumMatrixCells = validateWorkLimit(
      "maximumMatrixCells",
      options.maximumMatrixCells,
    );
    this.#maximumCodePointVisits = validateWorkLimit(
      "maximumCodePointVisits",
      options.maximumCodePointVisits,
    );
  }

  get matrixCells(): number {
    return this.#matrixCells;
  }

  get codePointVisits(): number {
    return this.#codePointVisits;
  }

  get matrixLimited(): boolean {
    return this.#matrixLimited;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get indexMaterializations(): number {
    return this.#indexMaterializations;
  }

  canConsumeCodePointVisits(count: number): boolean {
    return boundedSumFits(
      this.#codePointVisits,
      count,
      this.#maximumCodePointVisits,
    );
  }

  tryConsumeCodePointVisits(count: number): boolean {
    if (!this.canConsumeCodePointVisits(count)) {
      this.#exhausted = true;
      return false;
    }
    this.#codePointVisits += count;
    return true;
  }

  tryConsumeMatrixCells(count: number): boolean {
    if (!boundedSumFits(this.#matrixCells, count, this.#maximumMatrixCells)) {
      this.#matrixLimited = true;
      return false;
    }
    this.#matrixCells += count;
    return true;
  }

  recordIndexMaterialization(): void {
    this.#indexMaterializations += 1;
  }
}

export interface FuzzyRankedCandidate extends FuzzyMatch {
  readonly candidate: string;
}

export class FuzzyCandidateBudget {
  #count = 0;
  #totalBytes = 0;

  add(candidate: string | PreparedFuzzyCandidate): void {
    if (this.#count >= MAX_FUZZY_CANDIDATES) {
      throw new FuzzyBoundaryError(
        "CANDIDATE_COUNT_LIMIT",
        `fuzzy candidate count exceeds ${MAX_FUZZY_CANDIDATES}`,
      );
    }
    const candidateBytes =
      typeof candidate === "string"
        ? validateFuzzyCandidate(candidate)
        : validatePreparedFuzzyCandidate(candidate);
    if (
      !Number.isSafeInteger(this.#totalBytes + candidateBytes) ||
      this.#totalBytes + candidateBytes > MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES
    ) {
      throw new FuzzyBoundaryError(
        "CANDIDATE_TOTAL_BYTE_LIMIT",
        `fuzzy candidates exceed ${MAX_FUZZY_TOTAL_CANDIDATE_UTF8_BYTES} UTF-8 bytes`,
      );
    }
    this.#count += 1;
    this.#totalBytes += candidateBytes;
  }
}

interface PreparedText {
  readonly length: number;
  readonly comparisonCodePoints: Uint32Array;
  readonly utf16Offsets: Uint32Array;
  readonly boundaryBonuses: Uint8Array;
  readonly signature: Uint32Array;
  readonly ascii: boolean;
  readonly normalizeLatin: boolean;
}

export interface PreparedFuzzyCandidate {
  readonly text: string;
  readonly portableText: string;
  readonly codePoints: Uint32Array;
  readonly foldedCodePoints: Uint32Array;
  readonly normalizedCodePoints: Uint32Array;
  readonly foldedNormalizedCodePoints: Uint32Array;
  readonly utf16Offsets: Uint32Array;
  readonly boundaryBonuses: Uint8Array;
  readonly signature: Uint32Array;
  readonly foldedSignature: Uint32Array;
  readonly normalizedSignature: Uint32Array;
  readonly foldedNormalizedSignature: Uint32Array;
  readonly utf8Bytes: number;
  readonly ascii: boolean;
}

/** True only when filtering the previous match set cannot create false negatives. */
export function isFuzzyQueryExtension(
  previousQuery: string,
  nextQuery: string,
  caseMode: FuzzyCaseMode,
): boolean {
  validateFuzzyQuery(previousQuery);
  validateFuzzyQuery(nextQuery);
  const previousCaseSensitive = resolveCaseSensitivity(previousQuery, caseMode);
  const nextCaseSensitive = resolveCaseSensitivity(nextQuery, caseMode);
  if (previousCaseSensitive !== nextCaseSensitive) return false;
  const previous = prepareQueryText(previousQuery, previousCaseSensitive);
  const next = prepareQueryText(nextQuery, nextCaseSensitive);
  if (
    next.length <= previous.length ||
    next.normalizeLatin !== previous.normalizeLatin
  ) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (
      previous.comparisonCodePoints[index] !== next.comparisonCodePoints[index]
    ) {
      return false;
    }
  }
  return true;
}

interface FuzzyMatchWindow {
  readonly start: number;
  readonly greedyEnd: number;
  readonly end: number;
}

type FuzzyMatchWindowResult =
  FuzzyMatchWindow | null | typeof FUZZY_WORK_BUDGET_EXHAUSTED;

interface HeapCandidate {
  readonly candidate: string;
  readonly score: number;
  readonly rankScore: number;
}

type CharacterClass =
  "whitespace" | "delimiter" | "nonWord" | "lower" | "upper" | "number";

export class BoundedFuzzyMatcher {
  readonly #query: PreparedText;
  readonly #caseSensitive: boolean;
  #scoreScratchA = new Float64Array(0);
  #scoreScratchB = new Float64Array(0);
  #predecessorScratch = new Int32Array(0);
  #usedDegradedFallback = false;

  constructor(
    readonly query: string,
    options: Pick<FuzzyMatchOptions, "caseMode"> = {},
  ) {
    validateFuzzyQuery(query);
    const caseMode = options.caseMode ?? "insensitive";
    this.#caseSensitive = resolveCaseSensitivity(query, caseMode);
    this.#query = prepareQueryText(query, this.#caseSensitive);
  }

  get usedDegradedFallback(): boolean {
    return this.#usedDegradedFallback;
  }

  match(
    candidate: string | PreparedFuzzyCandidate,
    options: FuzzyMatchOptions = {},
  ): FuzzyMatch | null {
    const preparedCandidate =
      typeof candidate === "string"
        ? prepareFuzzyCandidate(candidate)
        : (validatePreparedFuzzyCandidate(candidate), candidate);
    const includeIndices = options.includeIndices ?? true;
    const includeLengthBonus = options.lengthBonus ?? true;
    const full = this.#matchPrepared(
      preparedTextForCandidate(
        preparedCandidate,
        this.#caseSensitive,
        this.#query.normalizeLatin,
      ),
      includeIndices,
      includeLengthBonus,
      options.forceDegraded ?? false,
      options.workBudget,
    );
    // A basename is a suffix of the full candidate, so it cannot turn a
    // subsequence miss into a match. Avoid preparing that suffix for the
    // dominant non-match population.
    if (options.matchBasename !== true || full === null) return full;

    const fileName = portableBasename(preparedCandidate.portableText);
    if (fileName === preparedCandidate.portableText) return full;
    const name = this.#matchPrepared(
      preparedTextForCandidate(
        prepareFuzzyCandidate(fileName),
        this.#caseSensitive,
        this.#query.normalizeLatin,
      ),
      includeIndices,
      includeLengthBonus,
      options.forceDegraded ?? false,
      options.workBudget,
    );
    if (name === null) return full;
    const prefixUtf16Length =
      preparedCandidate.portableText.length - fileName.length;
    const adjustedName: FuzzyMatch = {
      score: name.score,
      indices: name.indices.map((index) => index + prefixUtf16Length),
      quality: name.quality,
    };
    if (full === null || adjustedName.score > full.score) return adjustedName;
    return full;
  }

  #matchPrepared(
    candidate: PreparedText,
    includeIndices: boolean,
    includeLengthBonus: boolean,
    forceDegraded: boolean,
    workBudget: FuzzyMatchWorkBudget | undefined,
  ): FuzzyMatch | null {
    const queryLength = this.#query.length;
    const candidateLength = candidate.length;
    if (queryLength > candidateLength) return null;
    if (!signatureContains(candidate.signature, this.#query.signature)) {
      return null;
    }
    const window = findMatchWindow(
      this.#query.comparisonCodePoints,
      candidate.comparisonCodePoints,
      workBudget,
    );
    if (window === FUZZY_WORK_BUDGET_EXHAUSTED) return null;
    if (window === null) return null;
    const windowLength = window.end - window.start;
    const matrixCells = queryLength * windowLength;
    const traceBytes =
      matrixCells * RUN_BONUS_STATE_COUNT * Int32Array.BYTES_PER_ELEMENT;
    const optimalEligible =
      !forceDegraded &&
      (!includeIndices || traceBytes <= MAX_FUZZY_TRACE_BYTES) &&
      isNucleoOptimalMatrixEligible({
        ascii: this.#query.ascii && candidate.ascii,
        haystackCodePoints: windowLength,
        needleCodePoints: queryLength,
      });
    const optimalBudgetAvailable =
      optimalEligible &&
      (workBudget === undefined ||
        (workBudget.canConsumeCodePointVisits(matrixCells) &&
          workBudget.tryConsumeMatrixCells(matrixCells)));
    if (!optimalBudgetAvailable) {
      const greedyVisits = windowLength + queryLength;
      if (workBudget?.tryConsumeCodePointVisits(greedyVisits) === false) {
        return null;
      }
      this.#usedDegradedFallback = true;
      const match = greedyMatch(
        this.#query,
        candidate,
        window,
        includeIndices,
        includeLengthBonus,
      );
      if (includeIndices) workBudget?.recordIndexMaterialization();
      return match;
    }
    if (workBudget?.tryConsumeCodePointVisits(matrixCells) === false) {
      return null;
    }
    const rowWidth = windowLength * RUN_BONUS_STATE_COUNT;
    const scoreScratch = this.#scoreScratch(rowWidth);
    let previousScores = scoreScratch.previous;
    let currentScores = scoreScratch.current;
    previousScores.fill(UNREACHABLE_SCORE);
    currentScores.fill(UNREACHABLE_SCORE);
    const predecessors = includeIndices
      ? this.#predecessors(matrixCells * RUN_BONUS_STATE_COUNT)
      : undefined;

    for (let queryIndex = 0; queryIndex < queryLength; queryIndex += 1) {
      currentScores.fill(UNREACHABLE_SCORE);
      let bestGapAdjustedScore = UNREACHABLE_SCORE;
      let bestGapPredecessor = -1;

      for (
        let candidateIndex = 0;
        candidateIndex < windowLength;
        candidateIndex += 1
      ) {
        if (queryIndex > 0 && candidateIndex >= 2) {
          const predecessorIndex = candidateIndex - 2;
          for (let state = 0; state < RUN_BONUS_STATE_COUNT; state += 1) {
            const encoded = encodeCell(predecessorIndex, state);
            const score = previousScores[encoded]!;
            if (score === UNREACHABLE_SCORE) continue;
            const adjusted = score + predecessorIndex * PENALTY_GAP_EXTENSION;
            if (
              adjusted > bestGapAdjustedScore ||
              (adjusted === bestGapAdjustedScore &&
                encoded < bestGapPredecessor)
            ) {
              bestGapAdjustedScore = adjusted;
              bestGapPredecessor = encoded;
            }
          }
        }

        if (
          this.#query.comparisonCodePoints[queryIndex] !==
          candidate.comparisonCodePoints[window.start + candidateIndex]
        ) {
          continue;
        }

        const boundaryBonus =
          candidate.boundaryBonuses[window.start + candidateIndex]!;
        if (queryIndex === 0) {
          const state = stateForRunBonus(boundaryBonus);
          const encoded = encodeCell(candidateIndex, state);
          currentScores[encoded] =
            SCORE_MATCH + boundaryBonus * BONUS_FIRST_CHARACTER_MULTIPLIER;
          continue;
        }

        if (candidateIndex > 0) {
          const priorCandidateIndex = candidateIndex - 1;
          for (let state = 0; state < RUN_BONUS_STATE_COUNT; state += 1) {
            const predecessor = encodeCell(priorCandidateIndex, state);
            const previousScore = previousScores[predecessor]!;
            if (previousScore === UNREACHABLE_SCORE) continue;
            const priorRunBonus = RUN_BONUSES[state]!;
            const nextRunBonus = Math.max(priorRunBonus, boundaryBonus);
            const nextState = stateForRunBonus(nextRunBonus);
            const encoded = encodeCell(candidateIndex, nextState);
            const score =
              previousScore +
              SCORE_MATCH +
              Math.max(BONUS_CONSECUTIVE, priorRunBonus, boundaryBonus);
            setBestCell(
              currentScores,
              predecessors,
              queryIndex,
              rowWidth,
              encoded,
              score,
              predecessor,
            );
          }
        }

        if (bestGapPredecessor >= 0) {
          const gapPenalty =
            PENALTY_GAP_START + (candidateIndex - 2) * PENALTY_GAP_EXTENSION;
          const score =
            Math.max(0, bestGapAdjustedScore - gapPenalty) +
            SCORE_MATCH +
            boundaryBonus;
          const state = stateForRunBonus(boundaryBonus);
          const encoded = encodeCell(candidateIndex, state);
          setBestCell(
            currentScores,
            predecessors,
            queryIndex,
            rowWidth,
            encoded,
            score,
            bestGapPredecessor,
          );
        }
      }

      const swap = previousScores;
      previousScores = currentScores;
      currentScores = swap;
    }

    let bestEncoded = -1;
    let bestScore = UNREACHABLE_SCORE;
    for (let encoded = 0; encoded < rowWidth; encoded += 1) {
      const score = previousScores[encoded]!;
      if (score > bestScore || (score === bestScore && encoded < bestEncoded)) {
        bestScore = score;
        bestEncoded = encoded;
      }
    }
    if (bestEncoded < 0 || bestScore === UNREACHABLE_SCORE) return null;

    const lengthBonus = includeLengthBonus
      ? Math.max(
          0,
          SCORE_LENGTH_BONUS_CEILING -
            Math.floor(candidateLength / SCORE_LENGTH_BONUS_DIVISOR),
        )
      : 0;
    if (!includeIndices || predecessors === undefined) {
      return {
        score: bestScore + lengthBonus,
        indices: [],
        quality: "optimal",
      };
    }

    const indices = new Array<number>(queryLength);
    workBudget?.recordIndexMaterialization();
    let encoded = bestEncoded;
    for (let queryIndex = queryLength - 1; queryIndex >= 0; queryIndex -= 1) {
      const candidateIndex = Math.floor(encoded / RUN_BONUS_STATE_COUNT);
      indices[queryIndex] =
        candidate.utf16Offsets[window.start + candidateIndex]!;
      encoded = predecessors[queryIndex * rowWidth + encoded]!;
    }
    return { score: bestScore + lengthBonus, indices, quality: "optimal" };
  }

  #scoreScratch(rowWidth: number): {
    readonly previous: Float64Array;
    readonly current: Float64Array;
  } {
    if (this.#scoreScratchA.length < rowWidth) {
      this.#scoreScratchA = new Float64Array(rowWidth);
      this.#scoreScratchB = new Float64Array(rowWidth);
    }
    return {
      previous: this.#scoreScratchA.subarray(0, rowWidth),
      current: this.#scoreScratchB.subarray(0, rowWidth),
    };
  }

  #predecessors(cellCount: number): Int32Array {
    if (this.#predecessorScratch.length < cellCount) {
      this.#predecessorScratch = new Int32Array(cellCount);
    }
    const predecessors = this.#predecessorScratch.subarray(0, cellCount);
    predecessors.fill(-1);
    return predecessors;
  }
}

export function rankFuzzyCandidatesSync(
  query: string,
  candidates: readonly (string | PreparedFuzzyCandidate)[],
  options: FuzzyMatchOptions & { readonly limit: number },
): readonly FuzzyRankedCandidate[] {
  validateFuzzyCandidateCollection(candidates);
  validateFuzzyResultLimit(options.limit);
  if (options.limit === 0) return [];
  const matcher = new BoundedFuzzyMatcher(query, options);
  const heap: HeapCandidate[] = [];
  for (const candidateInput of candidates) {
    const candidate =
      typeof candidateInput === "string"
        ? prepareFuzzyCandidate(candidateInput)
        : candidateInput;
    const match = matcher.match(candidate, {
      ...options,
      includeIndices: false,
    });
    if (match === null) continue;
    retainTopCandidate(
      heap,
      {
        candidate: candidate.text,
        score: match.score,
        rankScore: fuzzyPathRankScore(candidate.text, match.score),
      },
      options.limit,
    );
  }
  return materializeRankedCandidates(matcher, heap, options);
}

export async function rankFuzzyCandidates(
  query: string,
  candidates: readonly (string | PreparedFuzzyCandidate)[],
  options: FuzzyMatchOptions & {
    readonly limit: number;
    readonly signal?: AbortSignal;
    readonly yieldInterval?: number;
  },
): Promise<readonly FuzzyRankedCandidate[]> {
  validateFuzzyCandidateCollection(candidates);
  validateFuzzyResultLimit(options.limit);
  if (options.limit === 0 || isAborted(options.signal)) return [];
  const matcher = new BoundedFuzzyMatcher(query, options);
  const heap: HeapCandidate[] = [];
  const yieldInterval = options.yieldInterval ?? 256;
  if (!Number.isSafeInteger(yieldInterval) || yieldInterval <= 0) {
    throw new TypeError("fuzzy yieldInterval must be a positive safe integer");
  }
  for (const [index, candidateInput] of candidates.entries()) {
    if (isAborted(options.signal)) return [];
    if (index > 0 && index % yieldInterval === 0) {
      await yieldToEventLoop();
      if (isAborted(options.signal)) return [];
    }
    const candidate =
      typeof candidateInput === "string"
        ? prepareFuzzyCandidate(candidateInput)
        : candidateInput;
    const match = matcher.match(candidate, {
      ...options,
      includeIndices: false,
    });
    if (match === null) continue;
    retainTopCandidate(
      heap,
      {
        candidate: candidate.text,
        score: match.score,
        rankScore: fuzzyPathRankScore(candidate.text, match.score),
      },
      options.limit,
    );
  }
  if (isAborted(options.signal)) return [];
  return materializeRankedCandidates(matcher, heap, options);
}

export function validateFuzzyQuery(query: string): void {
  validateTextEncoding(query, "fuzzy query");
  if (query.length === 0) {
    throw new FuzzyBoundaryError(
      "EMPTY_QUERY",
      "fuzzy query must not be empty",
    );
  }
  const bytes = Buffer.byteLength(query, "utf8");
  if (bytes > MAX_FUZZY_QUERY_UTF8_BYTES) {
    throw new FuzzyBoundaryError(
      "QUERY_BYTE_LIMIT",
      `fuzzy query is ${bytes} UTF-8 bytes; maximum is ${MAX_FUZZY_QUERY_UTF8_BYTES}`,
    );
  }
  const codePoints = Array.from(query).length;
  if (codePoints > MAX_FUZZY_QUERY_CODE_POINTS) {
    throw new FuzzyBoundaryError(
      "QUERY_CODE_POINT_LIMIT",
      `fuzzy query has ${codePoints} code points; maximum is ${MAX_FUZZY_QUERY_CODE_POINTS}`,
    );
  }
}

export function validateFuzzyCandidate(candidate: string): number {
  validateTextEncoding(candidate, "fuzzy candidate");
  const bytes = Buffer.byteLength(candidate, "utf8");
  if (bytes > MAX_FUZZY_CANDIDATE_UTF8_BYTES) {
    throw new FuzzyBoundaryError(
      "CANDIDATE_BYTE_LIMIT",
      `fuzzy candidate is ${bytes} UTF-8 bytes; maximum is ${MAX_FUZZY_CANDIDATE_UTF8_BYTES}`,
    );
  }
  const codePoints = Array.from(candidate).length;
  if (codePoints > MAX_FUZZY_CANDIDATE_CODE_POINTS) {
    throw new FuzzyBoundaryError(
      "CANDIDATE_CODE_POINT_LIMIT",
      `fuzzy candidate has ${codePoints} code points; maximum is ${MAX_FUZZY_CANDIDATE_CODE_POINTS}`,
    );
  }
  return bytes;
}

export function validateFuzzyCandidateCollection(
  candidates: readonly (string | PreparedFuzzyCandidate)[],
): void {
  if (candidates.length > MAX_FUZZY_CANDIDATES) {
    throw new FuzzyBoundaryError(
      "CANDIDATE_COUNT_LIMIT",
      `fuzzy candidate count is ${candidates.length}; maximum is ${MAX_FUZZY_CANDIDATES}`,
    );
  }
  const budget = new FuzzyCandidateBudget();
  for (const candidate of candidates) budget.add(candidate);
}

export function comparePortablePaths(left: string, right: string): number {
  const portable = Buffer.compare(
    Buffer.from(toPortablePath(left).normalize("NFC"), "utf8"),
    Buffer.from(toPortablePath(right).normalize("NFC"), "utf8"),
  );
  if (portable !== 0) return portable;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Frozen compatibility factor; higher remains better after the penalty. */
export function fuzzyPathRankScore(candidate: string, score: number): number {
  return candidate.includes("test") ? score / TEST_PATH_RANK_DIVISOR : score;
}

function validateFuzzyResultLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > MAX_FUZZY_RESULT_LIMIT
  ) {
    throw new FuzzyBoundaryError(
      "RESULT_LIMIT",
      `fuzzy result limit must be an integer from 0 to ${MAX_FUZZY_RESULT_LIMIT}`,
    );
  }
}

function validateWorkLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function boundedSumFits(
  current: number,
  addition: number,
  maximum: number,
): boolean {
  return (
    Number.isSafeInteger(addition) &&
    addition >= 0 &&
    Number.isSafeInteger(current + addition) &&
    current + addition <= maximum
  );
}

function validateTextEncoding(value: string, label: string): void {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === BYTE_NUL) {
      throw new FuzzyBoundaryError(
        "TEXT_NUL",
        `${label} contains an embedded NUL`,
      );
    }
    if (
      codeUnit >= UTF16_HIGH_SURROGATE_START &&
      codeUnit <= UTF16_HIGH_SURROGATE_END
    ) {
      const following = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        following < UTF16_LOW_SURROGATE_START ||
        following > UTF16_LOW_SURROGATE_END
      ) {
        throw new FuzzyBoundaryError(
          "TEXT_LONE_SURROGATE",
          `${label} contains a lone UTF-16 high surrogate`,
        );
      }
      index += 1;
      continue;
    }
    if (
      codeUnit >= UTF16_LOW_SURROGATE_START &&
      codeUnit <= UTF16_LOW_SURROGATE_END
    ) {
      throw new FuzzyBoundaryError(
        "TEXT_LONE_SURROGATE",
        `${label} contains a lone UTF-16 low surrogate`,
      );
    }
  }
}

const FUZZY_SIGNATURE_WORDS = 8;

export function prepareFuzzyCandidate(value: string): PreparedFuzzyCandidate {
  const utf8Bytes = validateFuzzyCandidate(value);
  const portableText = toPortablePath(value);
  const characters = Array.from(portableText);
  const storage = allocatePreparedFuzzyStorage(characters.length);
  const {
    codePoints,
    foldedCodePoints,
    normalizedCodePoints,
    foldedNormalizedCodePoints,
    utf16Offsets,
    boundaryBonuses,
  } = storage;
  let offset = 0;
  for (const [index, character] of characters.entries()) {
    const codePoint = character.codePointAt(0)!;
    const normalized = normalizeLatinCodePoint(character);
    codePoints[index] = codePoint;
    foldedCodePoints[index] = simpleFoldCodePoint(character);
    normalizedCodePoints[index] = normalized;
    foldedNormalizedCodePoints[index] = simpleFoldCodePoint(
      String.fromCodePoint(normalized),
    );
    utf16Offsets[index] = offset;
    boundaryBonuses[index] = bonusAt(characters, index);
    offset += character.length;
  }
  const prepared = Object.freeze({
    text: value,
    portableText,
    codePoints,
    foldedCodePoints,
    normalizedCodePoints,
    foldedNormalizedCodePoints,
    utf16Offsets,
    boundaryBonuses,
    signature: createFuzzySignature(codePoints, storage.signature),
    foldedSignature: createFuzzySignature(
      foldedCodePoints,
      storage.foldedSignature,
    ),
    normalizedSignature: createFuzzySignature(
      normalizedCodePoints,
      storage.normalizedSignature,
    ),
    foldedNormalizedSignature: createFuzzySignature(
      foldedNormalizedCodePoints,
      storage.foldedNormalizedSignature,
    ),
    utf8Bytes,
    ascii:
      portableText.length === characters.length &&
      /^[\x00-\x7f]*$/u.test(portableText),
  });
  trustedPreparedFuzzyCandidates.add(prepared);
  return prepared;
}

/** Bytes retained by the candidate's strings and typed-array payloads. */
export function estimateFuzzyCandidateRetainedBytes(
  candidate: string | PreparedFuzzyCandidate,
): number {
  if (typeof candidate !== "string") {
    validatePreparedFuzzyCandidate(candidate);
    const buffers = new Set<ArrayBufferLike>();
    for (const array of preparedCandidateArrays(candidate)) {
      buffers.add(array.buffer);
    }
    let payloadBytes = 0;
    for (const buffer of buffers) payloadBytes += buffer.byteLength;
    return (
      estimateJavascriptStringRetainedBytes(candidate.text) +
      estimateJavascriptStringRetainedBytes(candidate.portableText) +
      payloadBytes +
      buffers.size * PREPARED_FUZZY_ARRAY_BUFFER_OVERHEAD_BYTES +
      PREPARED_FUZZY_TYPED_ARRAY_COUNT *
        PREPARED_FUZZY_TYPED_ARRAY_OVERHEAD_BYTES +
      PREPARED_FUZZY_OBJECT_OVERHEAD_BYTES
    );
  }

  validateFuzzyCandidate(candidate);
  const portableText = toPortablePath(candidate);
  let codePointCount = 0;
  for (const _character of portableText) codePointCount += 1;
  return (
    estimateJavascriptStringRetainedBytes(candidate) +
    estimateJavascriptStringRetainedBytes(portableText) +
    packedPreparedFuzzyPayloadBytes(codePointCount) +
    PREPARED_FUZZY_ARRAY_BUFFER_OVERHEAD_BYTES +
    PREPARED_FUZZY_TYPED_ARRAY_COUNT *
      PREPARED_FUZZY_TYPED_ARRAY_OVERHEAD_BYTES +
    PREPARED_FUZZY_OBJECT_OVERHEAD_BYTES
  );
}

interface PreparedFuzzyStorage {
  readonly codePoints: Uint32Array;
  readonly foldedCodePoints: Uint32Array;
  readonly normalizedCodePoints: Uint32Array;
  readonly foldedNormalizedCodePoints: Uint32Array;
  readonly utf16Offsets: Uint32Array;
  readonly boundaryBonuses: Uint8Array;
  readonly signature: Uint32Array;
  readonly foldedSignature: Uint32Array;
  readonly normalizedSignature: Uint32Array;
  readonly foldedNormalizedSignature: Uint32Array;
}

function allocatePreparedFuzzyStorage(
  codePointCount: number,
): PreparedFuzzyStorage {
  const codePointArrayBytes = codePointCount * Uint32Array.BYTES_PER_ELEMENT;
  const boundaryOffset =
    PREPARED_FUZZY_CODE_POINT_ARRAY_COUNT * codePointArrayBytes;
  const signatureOffset = alignOffset(
    boundaryOffset + codePointCount * Uint8Array.BYTES_PER_ELEMENT,
    Uint32Array.BYTES_PER_ELEMENT,
  );
  const signatureBytes = FUZZY_SIGNATURE_WORDS * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(
    signatureOffset + PREPARED_FUZZY_SIGNATURE_COUNT * signatureBytes,
  );
  let offset = 0;
  const nextCodePointArray = (): Uint32Array => {
    const array = new Uint32Array(buffer, offset, codePointCount);
    offset += codePointArrayBytes;
    return array;
  };
  const codePoints = nextCodePointArray();
  const foldedCodePoints = nextCodePointArray();
  const normalizedCodePoints = nextCodePointArray();
  const foldedNormalizedCodePoints = nextCodePointArray();
  const utf16Offsets = nextCodePointArray();
  const boundaryBonuses = new Uint8Array(
    buffer,
    boundaryOffset,
    codePointCount,
  );
  const signature = new Uint32Array(
    buffer,
    signatureOffset,
    FUZZY_SIGNATURE_WORDS,
  );
  const foldedSignature = new Uint32Array(
    buffer,
    signatureOffset + signatureBytes,
    FUZZY_SIGNATURE_WORDS,
  );
  const normalizedSignature = new Uint32Array(
    buffer,
    signatureOffset + signatureBytes * 2,
    FUZZY_SIGNATURE_WORDS,
  );
  const foldedNormalizedSignature = new Uint32Array(
    buffer,
    signatureOffset + signatureBytes * 3,
    FUZZY_SIGNATURE_WORDS,
  );
  return {
    codePoints,
    foldedCodePoints,
    normalizedCodePoints,
    foldedNormalizedCodePoints,
    utf16Offsets,
    boundaryBonuses,
    signature,
    foldedSignature,
    normalizedSignature,
    foldedNormalizedSignature,
  };
}

function packedPreparedFuzzyPayloadBytes(codePointCount: number): number {
  const codePointBytes =
    codePointCount *
    PREPARED_FUZZY_CODE_POINT_ARRAY_COUNT *
    Uint32Array.BYTES_PER_ELEMENT;
  const signatureOffset = alignOffset(
    codePointBytes + codePointCount * Uint8Array.BYTES_PER_ELEMENT,
    Uint32Array.BYTES_PER_ELEMENT,
  );
  return (
    signatureOffset +
    FUZZY_SIGNATURE_WORDS *
      PREPARED_FUZZY_SIGNATURE_COUNT *
      Uint32Array.BYTES_PER_ELEMENT
  );
}

function preparedCandidateArrays(
  candidate: PreparedFuzzyCandidate,
): readonly (Uint32Array | Uint8Array)[] {
  return [
    candidate.codePoints,
    candidate.foldedCodePoints,
    candidate.normalizedCodePoints,
    candidate.foldedNormalizedCodePoints,
    candidate.utf16Offsets,
    candidate.boundaryBonuses,
    candidate.signature,
    candidate.foldedSignature,
    candidate.normalizedSignature,
    candidate.foldedNormalizedSignature,
  ];
}

function estimateJavascriptStringRetainedBytes(value: string): number {
  return (
    JAVASCRIPT_STRING_OVERHEAD_BYTES + value.length * JAVASCRIPT_CODE_UNIT_BYTES
  );
}

function alignOffset(offset: number, alignment: number): number {
  return offset + ((alignment - (offset % alignment)) % alignment);
}

function validatePreparedFuzzyCandidate(
  candidate: PreparedFuzzyCandidate,
): number {
  if (trustedPreparedFuzzyCandidates.has(candidate)) return candidate.utf8Bytes;
  const utf8Bytes = validateFuzzyCandidate(candidate.text);
  if (candidate.utf8Bytes !== utf8Bytes) {
    throw new TypeError(
      "prepared fuzzy candidate byte metadata is inconsistent",
    );
  }
  const portableText = toPortablePath(candidate.text);
  if (candidate.portableText !== portableText) {
    throw new TypeError(
      "prepared fuzzy candidate path metadata is inconsistent",
    );
  }
  const codePointCount = Array.from(portableText).length;
  for (const array of [
    candidate.codePoints,
    candidate.foldedCodePoints,
    candidate.normalizedCodePoints,
    candidate.foldedNormalizedCodePoints,
    candidate.utf16Offsets,
  ]) {
    if (!(array instanceof Uint32Array) || array.length !== codePointCount) {
      throw new TypeError(
        "prepared fuzzy candidate code-point metadata is inconsistent",
      );
    }
  }
  if (
    !(candidate.boundaryBonuses instanceof Uint8Array) ||
    candidate.boundaryBonuses.length !== codePointCount
  ) {
    throw new TypeError(
      "prepared fuzzy candidate boundary metadata is inconsistent",
    );
  }
  for (const signature of [
    candidate.signature,
    candidate.foldedSignature,
    candidate.normalizedSignature,
    candidate.foldedNormalizedSignature,
  ]) {
    if (
      !(signature instanceof Uint32Array) ||
      signature.length !== FUZZY_SIGNATURE_WORDS
    ) {
      throw new TypeError(
        "prepared fuzzy candidate signature metadata is inconsistent",
      );
    }
  }
  return utf8Bytes;
}

function prepareQueryText(value: string, caseSensitive: boolean): PreparedText {
  const characters = Array.from(value);
  const comparisonCodePoints = new Uint32Array(characters.length);
  const utf16Offsets = new Uint32Array(characters.length);
  const boundaryBonuses = new Uint8Array(characters.length);
  const normalizeLatin = characters.every(
    (character) =>
      normalizeLatinCodePoint(character) === character.codePointAt(0),
  );
  let offset = 0;
  for (const [index, character] of characters.entries()) {
    comparisonCodePoints[index] = caseSensitive
      ? character.codePointAt(0)!
      : simpleFoldCodePoint(character);
    utf16Offsets[index] = offset;
    boundaryBonuses[index] = bonusAt(characters, index);
    offset += character.length;
  }
  return {
    length: characters.length,
    comparisonCodePoints,
    utf16Offsets,
    boundaryBonuses,
    signature: createFuzzySignature(comparisonCodePoints),
    ascii: value.length === characters.length && /^[\x00-\x7f]*$/u.test(value),
    normalizeLatin,
  };
}

function resolveCaseSensitivity(
  query: string,
  caseMode: FuzzyCaseMode,
): boolean {
  return (
    caseMode === "sensitive" ||
    (caseMode === "smart" && query !== query.toLowerCase())
  );
}

function preparedTextForCandidate(
  candidate: PreparedFuzzyCandidate,
  caseSensitive: boolean,
  normalizeLatin: boolean,
): PreparedText {
  const comparisonCodePoints = normalizeLatin
    ? caseSensitive
      ? candidate.normalizedCodePoints
      : candidate.foldedNormalizedCodePoints
    : caseSensitive
      ? candidate.codePoints
      : candidate.foldedCodePoints;
  const signature = normalizeLatin
    ? caseSensitive
      ? candidate.normalizedSignature
      : candidate.foldedNormalizedSignature
    : caseSensitive
      ? candidate.signature
      : candidate.foldedSignature;
  return {
    length: candidate.codePoints.length,
    comparisonCodePoints,
    utf16Offsets: candidate.utf16Offsets,
    boundaryBonuses: candidate.boundaryBonuses,
    signature,
    ascii: candidate.ascii,
    normalizeLatin,
  };
}

function simpleFoldCodePoint(character: string): number {
  const folded = Array.from(character.toLowerCase())[0] ?? character;
  return folded.codePointAt(0)!;
}

function normalizeLatinCodePoint(character: string): number {
  const decomposed = Array.from(character.normalize("NFKD"));
  const normalized = decomposed.find((value) => !/^\p{Mark}$/u.test(value));
  return (normalized ?? character).codePointAt(0)!;
}

function createFuzzySignature(
  codePoints: Uint32Array,
  destination?: Uint32Array,
): Uint32Array {
  const signature = destination ?? new Uint32Array(FUZZY_SIGNATURE_WORDS);
  if (signature.length !== FUZZY_SIGNATURE_WORDS) {
    throw new TypeError("fuzzy signature destination has an invalid length");
  }
  signature.fill(0);
  for (const codePoint of codePoints) {
    const bucket = codePoint & 0xff;
    const word = bucket >>> 5;
    signature[word] = signature[word]! | (1 << (bucket & 31));
  }
  return signature;
}

function signatureContains(
  candidate: Uint32Array,
  query: Uint32Array,
): boolean {
  for (let index = 0; index < FUZZY_SIGNATURE_WORDS; index += 1) {
    if ((candidate[index]! & query[index]!) !== query[index]!) return false;
  }
  return true;
}

function encodeCell(candidateIndex: number, state: number): number {
  return candidateIndex * RUN_BONUS_STATE_COUNT + state;
}

function findMatchWindow(
  query: Uint32Array,
  candidate: Uint32Array,
  workBudget: FuzzyMatchWorkBudget | undefined,
): FuzzyMatchWindowResult {
  const maximumStart = candidate.length - query.length;
  let start = -1;
  for (let index = 0; index <= maximumStart; index += 1) {
    if (workBudget?.tryConsumeCodePointVisits(1) === false) {
      return FUZZY_WORK_BUDGET_EXHAUSTED;
    }
    if (candidate[index] === query[0]) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;

  let queryIndex = 1;
  let greedyEnd = start + 1;
  while (queryIndex < query.length) {
    let found = -1;
    for (let index = greedyEnd; index < candidate.length; index += 1) {
      if (workBudget?.tryConsumeCodePointVisits(1) === false) {
        return FUZZY_WORK_BUDGET_EXHAUSTED;
      }
      if (candidate[index] === query[queryIndex]) {
        found = index;
        break;
      }
    }
    if (found < 0) return null;
    greedyEnd = found + 1;
    queryIndex += 1;
  }

  let end = greedyEnd;
  for (let index = candidate.length - 1; index >= greedyEnd; index -= 1) {
    if (workBudget?.tryConsumeCodePointVisits(1) === false) {
      return FUZZY_WORK_BUDGET_EXHAUSTED;
    }
    if (candidate[index] === query[query.length - 1]) {
      end = index + 1;
      break;
    }
  }
  return { start, greedyEnd, end };
}

export function isNucleoOptimalMatrixEligible(options: {
  readonly ascii: boolean;
  readonly haystackCodePoints: number;
  readonly needleCodePoints: number;
}): boolean {
  const { haystackCodePoints, needleCodePoints } = options;
  if (
    !Number.isSafeInteger(haystackCodePoints) ||
    !Number.isSafeInteger(needleCodePoints) ||
    needleCodePoints <= 0 ||
    haystackCodePoints < needleCodePoints ||
    haystackCodePoints > MAX_FUZZY_OPTIMAL_HAYSTACK_CODE_POINTS ||
    needleCodePoints > MAX_FUZZY_OPTIMAL_NEEDLE_CODE_POINTS
  ) {
    return false;
  }
  const cells = haystackCodePoints * needleCodePoints;
  if (!Number.isSafeInteger(cells) || cells > MAX_FUZZY_MATRIX_CELLS) {
    return false;
  }
  const codePointBytes = options.ascii
    ? NUCLEO_ASCII_CODE_POINT_BYTES
    : NUCLEO_UNICODE_CODE_POINT_BYTES;
  let layoutBytes = 0;
  layoutBytes = extendLayout(
    layoutBytes,
    codePointBytes,
    haystackCodePoints * codePointBytes,
  );
  layoutBytes = extendLayout(layoutBytes, 1, haystackCodePoints);
  layoutBytes = extendLayout(
    layoutBytes,
    NUCLEO_ROW_OFFSET_BYTES,
    needleCodePoints * NUCLEO_ROW_OFFSET_BYTES,
  );
  layoutBytes = extendLayout(
    layoutBytes,
    NUCLEO_LAYOUT_MAX_ALIGNMENT,
    (haystackCodePoints + 1 - needleCodePoints) * NUCLEO_SCORE_CELL_BYTES,
  );
  layoutBytes = extendLayout(
    layoutBytes,
    NUCLEO_MATRIX_CELL_BYTES,
    (haystackCodePoints + 1 - needleCodePoints) *
      needleCodePoints *
      NUCLEO_MATRIX_CELL_BYTES,
  );
  return layoutBytes <= NUCLEO_MATRIX_SLAB_BYTES;
}

function extendLayout(
  offset: number,
  alignment: number,
  bytes: number,
): number {
  const padding = (alignment - (offset % alignment)) % alignment;
  return offset + padding + bytes;
}

function greedyMatch(
  query: PreparedText,
  candidate: PreparedText,
  window: FuzzyMatchWindow,
  includeIndices: boolean,
  includeLengthBonus: boolean,
): FuzzyMatch {
  const positions = new Array<number>(query.length);
  let queryIndex = query.length - 1;
  for (
    let candidateIndex = window.greedyEnd - 1;
    candidateIndex >= window.start && queryIndex >= 0;
    candidateIndex -= 1
  ) {
    if (
      candidate.comparisonCodePoints[candidateIndex] !==
      query.comparisonCodePoints[queryIndex]
    ) {
      continue;
    }
    positions[queryIndex] = candidateIndex;
    queryIndex -= 1;
  }
  if (queryIndex >= 0) {
    throw new Error("fuzzy greedy fallback lost a prefiltered query character");
  }

  const firstPosition = positions[0]!;
  let firstBonus = candidate.boundaryBonuses[firstPosition]!;
  let score = SCORE_MATCH + firstBonus * BONUS_FIRST_CHARACTER_MULTIPLIER;
  let previousPosition = firstPosition;
  for (let index = 1; index < positions.length; index += 1) {
    const position = positions[index]!;
    const gap = position - previousPosition - 1;
    let bonus = candidate.boundaryBonuses[position]!;
    if (gap === 0) {
      if (bonus >= BONUS_BOUNDARY && bonus > firstBonus) firstBonus = bonus;
      bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
    } else {
      const penalty = PENALTY_GAP_START + (gap - 1) * PENALTY_GAP_EXTENSION;
      score = Math.max(0, score - penalty);
      firstBonus = bonus;
    }
    score += SCORE_MATCH + bonus;
    previousPosition = position;
  }
  if (includeLengthBonus) {
    score += Math.max(
      0,
      SCORE_LENGTH_BONUS_CEILING -
        Math.floor(candidate.length / SCORE_LENGTH_BONUS_DIVISOR),
    );
  }
  return {
    score,
    indices: includeIndices
      ? positions.map((position) => candidate.utf16Offsets[position]!)
      : [],
    quality: "degraded",
  };
}

function stateForRunBonus(bonus: number): number {
  const exact = RUN_BONUSES.indexOf(bonus);
  if (exact >= 0) return exact;
  // BONUS_CONSECUTIVE itself is never a boundary state; camel/number is five.
  if (bonus <= 0) return 0;
  if (bonus < BONUS_BOUNDARY) return 1;
  if (bonus < BONUS_BOUNDARY_DELIMITER) return 2;
  return 3;
}

function setBestCell(
  scores: Float64Array,
  predecessors: Int32Array | undefined,
  queryIndex: number,
  rowWidth: number,
  encoded: number,
  score: number,
  predecessor: number,
): void {
  const current = scores[encoded]!;
  const predecessorOffset = queryIndex * rowWidth + encoded;
  const currentPredecessor = predecessors?.[predecessorOffset] ?? -1;
  if (
    score > current ||
    (score === current &&
      (currentPredecessor < 0 || predecessor < currentPredecessor))
  ) {
    scores[encoded] = score;
    if (predecessors !== undefined)
      predecessors[predecessorOffset] = predecessor;
  }
}

function bonusAt(characters: readonly string[], index: number): number {
  const current = characterClassFor(characters[index]!);
  const previous =
    index === 0 ? "delimiter" : characterClassFor(characters[index - 1]!);
  if (isWordClass(current)) {
    if (previous === "delimiter") return BONUS_BOUNDARY_DELIMITER;
    if (previous === "whitespace" || previous === "nonWord") {
      return BONUS_BOUNDARY;
    }
  }
  if (
    (previous === "lower" && current === "upper") ||
    (previous !== "number" && current === "number")
  ) {
    return BONUS_CAMEL_OR_NUMBER;
  }
  if (current === "whitespace" || current === "nonWord") {
    return BONUS_BOUNDARY;
  }
  return 0;
}

function characterClassFor(character: string): CharacterClass {
  if (/^\s$/u.test(character)) return "whitespace";
  if (character === "/" || character === "\\") return "delimiter";
  if (/^[0-9]$/u.test(character)) return "number";
  if (/^[a-z]$/u.test(character)) return "lower";
  if (/^[A-Z]$/u.test(character)) return "upper";
  if (/^\p{L}$/u.test(character)) {
    return character === character.toUpperCase() &&
      character !== character.toLowerCase()
      ? "upper"
      : "lower";
  }
  return "nonWord";
}

function isWordClass(characterClass: CharacterClass): boolean {
  return (
    characterClass === "lower" ||
    characterClass === "upper" ||
    characterClass === "number"
  );
}

function portableBasename(value: string): string {
  const portable = toPortablePath(value);
  return basename(portable);
}

function toPortablePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function retainTopCandidate(
  heap: HeapCandidate[],
  candidate: HeapCandidate,
  limit: number,
): void {
  if (heap.length < limit) {
    heap.push(candidate);
    bubbleHeapUp(heap, heap.length - 1);
    return;
  }
  if (!isBetterCandidate(candidate, heap[0]!)) return;
  heap[0] = candidate;
  bubbleHeapDown(heap, 0);
}

function bubbleHeapUp(heap: HeapCandidate[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!isWorseCandidate(heap[index]!, heap[parent]!)) return;
    [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
    index = parent;
  }
}

function bubbleHeapDown(heap: HeapCandidate[], start: number): void {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && isWorseCandidate(heap[left]!, heap[worst]!)) {
      worst = left;
    }
    if (right < heap.length && isWorseCandidate(heap[right]!, heap[worst]!)) {
      worst = right;
    }
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst]!, heap[index]!];
    index = worst;
  }
}

function isBetterCandidate(left: HeapCandidate, right: HeapCandidate): boolean {
  return (
    left.rankScore > right.rankScore ||
    (left.rankScore === right.rankScore && left.score > right.score) ||
    (left.rankScore === right.rankScore &&
      left.score === right.score &&
      comparePortablePaths(left.candidate, right.candidate) < 0)
  );
}

function isWorseCandidate(left: HeapCandidate, right: HeapCandidate): boolean {
  return (
    left.rankScore < right.rankScore ||
    (left.rankScore === right.rankScore && left.score < right.score) ||
    (left.rankScore === right.rankScore &&
      left.score === right.score &&
      comparePortablePaths(left.candidate, right.candidate) > 0)
  );
}

function materializeRankedCandidates(
  matcher: BoundedFuzzyMatcher,
  heap: readonly HeapCandidate[],
  options: FuzzyMatchOptions,
): readonly FuzzyRankedCandidate[] {
  const ordered = [...heap].sort((left, right) => {
    const rankScore = right.rankScore - left.rankScore;
    if (rankScore !== 0) return rankScore;
    const score = right.score - left.score;
    if (score !== 0) return score;
    return comparePortablePaths(left.candidate, right.candidate);
  });
  return ordered.map(({ candidate, score }) => {
    const withIndices = matcher.match(candidate, {
      ...options,
      includeIndices: true,
    });
    if (withIndices === null || withIndices.score !== score) {
      throw new Error("fuzzy candidate disappeared during materialization");
    }
    return {
      candidate,
      score,
      indices: withIndices.indices,
      quality: withIndices.quality,
    };
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
