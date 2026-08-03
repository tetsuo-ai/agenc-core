import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  BoundedFuzzyMatcher,
  comparePortablePaths,
  estimateFuzzyCandidateRetainedBytes,
  FuzzyBoundaryError,
  FuzzyMatchWorkBudget,
  MAX_FUZZY_CANDIDATE_UTF8_BYTES,
  MAX_FUZZY_MATRIX_CELLS,
  MAX_FUZZY_QUERY_UTF8_BYTES,
  isNucleoOptimalMatrixEligible,
  isFuzzyQueryExtension,
  prepareFuzzyCandidate,
  rankFuzzyCandidates,
  rankFuzzyCandidatesSync,
} from "../../src/search/fuzzy-match.js";

describe("bounded fuzzy matcher", () => {
  test("matches the full query instead of truncating after 64 code units", () => {
    const shared = "a".repeat(64);
    const query = `${shared}RIGHT`;
    const matcher = new BoundedFuzzyMatcher(query);

    expect(matcher.match(`${shared}WRONG`)).toBeNull();
    expect(matcher.match(`prefix/${query}.ts`)).toMatchObject({
      indices: expect.arrayContaining([7, 7 + query.length - 1]),
    });
    expect(
      rankFuzzyCandidatesSync(query, [`${shared}WRONG`, `prefix/${query}.ts`], {
        limit: 10,
      }).map((result) => result.candidate),
    ).toEqual([`prefix/${query}.ts`]);
  });

  test("uses UTF-16 highlight offsets while matching Unicode code points", () => {
    const matcher = new BoundedFuzzyMatcher("😀b");

    expect(matcher.match("a😀/b.ts")).toMatchObject({ indices: [1, 4] });
  });

  test("applies smart Latin normalization without changing literal accented queries", () => {
    expect(new BoundedFuzzyMatcher("resume").match("résumé.ts")).not.toBeNull();
    expect(new BoundedFuzzyMatcher("résumé").match("resume.ts")).toBeNull();
  });

  test("supports smart case and basename scoring through the same matcher", () => {
    expect(
      new BoundedFuzzyMatcher("fb", { caseMode: "smart" }).match(
        "src/FooBar.ts",
      ),
    ).not.toBeNull();
    expect(
      new BoundedFuzzyMatcher("FB", { caseMode: "smart" }).match(
        "src/fooBar.ts",
      ),
    ).toBeNull();

    const match = new BoundedFuzzyMatcher("abc").match("long/path/a-b-c.ts", {
      matchBasename: true,
    });
    expect(match?.indices.every((index) => index >= "long/path/".length)).toBe(
      true,
    );
    expect(
      new BoundedFuzzyMatcher("missing").match("long/path/file.ts", {
        matchBasename: true,
      }),
    ).toBeNull();
  });

  test("reuses match sets only for normalization- and case-stable query extensions", () => {
    expect(isFuzzyQueryExtension("foo", "foobar", "insensitive")).toBe(true);
    expect(isFuzzyQueryExtension("foo", "food", "smart")).toBe(true);
    expect(isFuzzyQueryExtension("foo", "fooD", "smart")).toBe(false);
    expect(isFuzzyQueryExtension("resume", "resumeé", "insensitive")).toBe(
      false,
    );
    expect(isFuzzyQueryExtension("foo", "foo", "insensitive")).toBe(false);
    expect(isFuzzyQueryExtension("foobar", "foo", "insensitive")).toBe(false);
  });

  test("agrees with an exhaustive small-string scoring oracle", () => {
    const candidates = generateStrings(["a", "b", "-", "/", "A", "1"], 5);
    const queries = generateStrings(["a", "b", "1"], 3).filter(Boolean);

    for (const query of queries) {
      const matcher = new BoundedFuzzyMatcher(query);
      for (const candidate of candidates) {
        const expected = exhaustiveMatch(candidate, query);
        const actual = matcher.match(candidate);
        expect(actual, `${JSON.stringify({ candidate, query })}`).toEqual(
          expected,
        );
      }
    }
  });

  test("agrees with the frozen pinned-Nucleo literal path oracle", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/nucleo-v0.4.0-literal-path-oracle.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly oracle: { readonly commit: string };
      readonly cases: readonly {
        readonly query: string;
        readonly candidate: string;
        readonly caseMode: "insensitive" | "smart";
        readonly score: number | null;
        readonly indices: readonly number[];
      }[];
    };
    expect(fixture.oracle.commit).toBe(
      "e9cca9fd56480c6a4aca7a9df5edf115eb58ba17",
    );

    for (const oracleCase of fixture.cases) {
      const match = new BoundedFuzzyMatcher(oracleCase.query, {
        caseMode: oracleCase.caseMode,
      }).match(oracleCase.candidate, { lengthBonus: false });
      const expected =
        oracleCase.score === null
          ? null
          : {
              score: oracleCase.score,
              indices: codePointIndicesToUtf16(
                oracleCase.candidate,
                oracleCase.indices,
              ),
              quality: "optimal",
            };
      expect(match, JSON.stringify(oracleCase)).toEqual(expected);
    }
  });

  test("orders ties by portable UTF-8 bytes on every platform", () => {
    const candidates = ["src/é.ts", "src/z.ts", "src/a.ts", "src\\b.ts"];
    const ranked = rankFuzzyCandidatesSync("s", candidates, { limit: 10 });
    const expected = [...ranked].sort((left, right) => {
      const score = right.score - left.score;
      return score !== 0
        ? score
        : comparePortablePaths(left.candidate, right.candidate);
    });

    expect(ranked).toEqual(expected);
  });

  test("applies path penalties before bounded top-k eviction", () => {
    const ordinary = Array.from(
      { length: 1_001 },
      (_, index) => `a/${index.toString(36).padStart(4, "0")}`,
    );
    const candidates = ["a/test", ...ordinary].reverse();
    const ranked = rankFuzzyCandidatesSync("a", candidates, { limit: 1_000 });

    expect(ranked).toHaveLength(1_000);
    expect(ranked.map((result) => result.candidate)).not.toContain("a/test");
    expect(
      rankFuzzyCandidatesSync("a", [...candidates].reverse(), { limit: 1_000 }),
    ).toEqual(ranked);
  });

  test("returns no partial ranking when cancellation wins", async () => {
    const controller = new AbortController();
    const candidates = Array.from(
      { length: 2_000 },
      (_, index) => `src/path-${index}/needle.ts`,
    );
    const search = rankFuzzyCandidates("needle", candidates, {
      limit: 50,
      signal: controller.signal,
      yieldInterval: 1,
    });
    controller.abort();

    await expect(search).resolves.toEqual([]);
  });

  test("rejects malformed text and uses a full-query degraded matrix fallback", () => {
    for (const value of ["a\0b", "\ud800", "\udc00"]) {
      expect(() => new BoundedFuzzyMatcher(value)).toThrow(FuzzyBoundaryError);
    }
    expect(
      () => new BoundedFuzzyMatcher("x".repeat(MAX_FUZZY_QUERY_UTF8_BYTES + 1)),
    ).toThrow(/QUERY_BYTE_LIMIT|maximum/u);
    expect(() =>
      new BoundedFuzzyMatcher("x").match(
        "x".repeat(MAX_FUZZY_CANDIDATE_UTF8_BYTES + 1),
      ),
    ).toThrow(/CANDIDATE_BYTE_LIMIT|maximum/u);

    const query = `${"x".repeat(319)}z`;
    const matcher = new BoundedFuzzyMatcher(query);
    const match = matcher.match(`${"x".repeat(320)}z`);
    expect(match).toMatchObject({ quality: "degraded" });
    expect(match?.indices).toHaveLength(320);
    expect(matcher.usedDegradedFallback).toBe(true);
  });

  test("rejects forged prepared-candidate bounds metadata", () => {
    const prepared = prepareFuzzyCandidate("src/file.ts");
    const forged = { ...prepared, utf8Bytes: 0 };

    expect(() => new BoundedFuzzyMatcher("file").match(forged)).toThrow(
      /byte metadata/u,
    );
    expect(() =>
      rankFuzzyCandidatesSync("file", [forged], { limit: 1 }),
    ).toThrow(/byte metadata/u);
  });

  test("packs prepared candidate payloads and accounts their retained objects", () => {
    const prepared = prepareFuzzyCandidate("src/needle.ts");
    const buffers = new Set([
      prepared.codePoints.buffer,
      prepared.foldedCodePoints.buffer,
      prepared.normalizedCodePoints.buffer,
      prepared.foldedNormalizedCodePoints.buffer,
      prepared.utf16Offsets.buffer,
      prepared.boundaryBonuses.buffer,
      prepared.signature.buffer,
      prepared.foldedSignature.buffer,
      prepared.normalizedSignature.buffer,
      prepared.foldedNormalizedSignature.buffer,
    ]);

    expect(buffers.size).toBe(1);
    expect(estimateFuzzyCandidateRetainedBytes(prepared)).toBeGreaterThan(900);
  });

  test("charges the compact match window instead of a long path tail", () => {
    const candidate = `${"x".repeat(20_000)}/needle.ts`;
    const budget = new FuzzyMatchWorkBudget({
      maximumMatrixCells: 100,
      maximumCodePointVisits: 30_000,
    });

    expect(
      new BoundedFuzzyMatcher("needle").match(candidate, {
        workBudget: budget,
      }),
    ).toMatchObject({ quality: "optimal" });
    expect(budget.matrixCells).toBe(36);
    expect(budget.exhausted).toBe(false);
  });

  test("charges basename scoring to the same request budget", () => {
    const fullOnly = new FuzzyMatchWorkBudget({
      maximumMatrixCells: 1_000,
      maximumCodePointVisits: 1_000,
    });
    const withBasename = new FuzzyMatchWorkBudget({
      maximumMatrixCells: 1_000,
      maximumCodePointVisits: 1_000,
    });
    const matcher = new BoundedFuzzyMatcher("needle");

    expect(
      matcher.match("deep/path/needle.ts", {
        includeIndices: false,
        workBudget: fullOnly,
      }),
    ).not.toBeNull();
    expect(
      matcher.match("deep/path/needle.ts", {
        includeIndices: false,
        matchBasename: true,
        workBudget: withBasename,
      }),
    ).not.toBeNull();
    expect(withBasename.matrixCells).toBeGreaterThan(fullOnly.matrixCells);
    expect(withBasename.codePointVisits).toBeGreaterThan(
      fullOnly.codePointVisits,
    );
  });

  test("materializes indices only for the retained top-k", () => {
    const candidates = Array.from(
      { length: 100 },
      (_, index) => `src/${index.toString().padStart(3, "0")}/needle.ts`,
    );
    const budget = new FuzzyMatchWorkBudget({
      maximumMatrixCells: 10_000_000,
      maximumCodePointVisits: 10_000_000,
    });

    expect(
      rankFuzzyCandidatesSync("needle", candidates, {
        limit: 3,
        workBudget: budget,
      }),
    ).toHaveLength(3);
    expect(budget.indexMaterializations).toBe(3);
  });

  test("reproduces every pinned Nucleo matrix eligibility boundary", () => {
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 400,
        needleCodePoints: 256,
      }),
    ).toBe(true);
    expect(400 * 256).toBe(MAX_FUZZY_MATRIX_CELLS);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 401,
        needleCodePoints: 256,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 65_536,
        needleCodePoints: 1,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 2_049,
        needleCodePoints: 2_049,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 12_101,
        needleCodePoints: 1,
      }),
    ).toBe(true);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 12_102,
        needleCodePoints: 1,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: false,
        haystackCodePoints: 9_508,
        needleCodePoints: 1,
      }),
    ).toBe(true);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: false,
        haystackCodePoints: 9_509,
        needleCodePoints: 1,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 65_535,
        needleCodePoints: 1,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 65_536,
        needleCodePoints: 1,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: 2_049,
        needleCodePoints: 2_049,
      }),
    ).toBe(false);
    expect(
      isNucleoOptimalMatrixEligible({
        ascii: true,
        haystackCodePoints: Number.MAX_SAFE_INTEGER,
        needleCodePoints: 2,
      }),
    ).toBe(false);
  });

  test("uses optimal scoring at 102,400 cells and full-query greedy immediately above it", () => {
    const query = "a".repeat(256);
    const atBoundary = new BoundedFuzzyMatcher(query).match("a".repeat(400), {
      lengthBonus: false,
    });
    const aboveBoundary = new BoundedFuzzyMatcher(query).match(
      "a".repeat(401),
      { lengthBonus: false },
    );

    expect(atBoundary).toMatchObject({
      quality: "optimal",
    });
    expect(aboveBoundary).toMatchObject({
      quality: "degraded",
    });
    expect(atBoundary?.indices).toHaveLength(256);
    expect(aboveBoundary?.indices).toHaveLength(256);
    expect(aboveBoundary?.indices.at(-1)).toBe(255);
  });

  test("keeps generated scale work within the named matrix bound", () => {
    const candidates = Array.from(
      { length: 10_000 },
      (_, index) => `runtime/src/generated/${index.toString(36)}/file-index.ts`,
    );
    const started = performance.now();
    const results = rankFuzzyCandidatesSync("rtsfi", candidates, { limit: 50 });
    const elapsed = performance.now() - started;

    expect(results).toHaveLength(50);
    expect(elapsed).toBeLessThan(10_000);
  });
});

function generateStrings(
  alphabet: readonly string[],
  maximum: number,
): string[] {
  const values = [""];
  let frontier = [""];
  for (let length = 1; length <= maximum; length += 1) {
    const next: string[] = [];
    for (const prefix of frontier) {
      for (const character of alphabet) next.push(`${prefix}${character}`);
    }
    values.push(...next);
    frontier = next;
  }
  return values;
}

function exhaustiveMatch(
  candidate: string,
  query: string,
): {
  readonly score: number;
  readonly indices: readonly number[];
  readonly quality: "optimal";
} | null {
  const candidateCharacters = Array.from(candidate);
  const queryCharacters = Array.from(query.toLowerCase());
  const matches: number[][] = [];
  enumerateMatches(candidateCharacters, queryCharacters, 0, 0, [], matches);
  let best: {
    readonly score: number;
    readonly indices: readonly number[];
    readonly quality: "optimal";
  } | null = null;
  for (const indices of matches) {
    const score = scoreIndices(candidateCharacters, indices);
    if (best === null || score > best.score) {
      best = { score, indices, quality: "optimal" };
    }
  }
  return best;
}

function enumerateMatches(
  candidate: readonly string[],
  query: readonly string[],
  queryIndex: number,
  start: number,
  current: readonly number[],
  output: number[][],
): void {
  if (queryIndex === query.length) {
    output.push([...current]);
    return;
  }
  const remaining = query.length - queryIndex - 1;
  for (let index = start; index < candidate.length - remaining; index += 1) {
    if (candidate[index]!.toLowerCase() !== query[queryIndex]) continue;
    enumerateMatches(
      candidate,
      query,
      queryIndex + 1,
      index + 1,
      [...current, index],
      output,
    );
  }
}

function scoreIndices(
  candidate: readonly string[],
  indices: readonly number[],
): number {
  let score = 0;
  let runBonus = 0;
  for (const [queryIndex, candidateIndex] of indices.entries()) {
    const boundary = oracleBonusAt(candidate, candidateIndex);
    if (queryIndex === 0) {
      runBonus = boundary;
      score += 16 + boundary * 2;
      continue;
    }
    const gap = candidateIndex - indices[queryIndex - 1]! - 1;
    if (gap === 0) {
      score += 16 + Math.max(4, runBonus, boundary);
      runBonus = Math.max(runBonus, boundary);
    } else {
      score += 16 + boundary - (3 + (gap - 1));
      runBonus = boundary;
    }
  }
  return score + Math.max(0, 32 - Math.floor(candidate.length / 4));
}

function oracleBonusAt(candidate: readonly string[], index: number): number {
  const current = oracleClass(candidate[index]!);
  const previous =
    index === 0 ? "delimiter" : oracleClass(candidate[index - 1]!);
  if (["lower", "upper", "number"].includes(current)) {
    if (previous === "delimiter") return 9;
    if (previous === "whitespace" || previous === "nonWord") return 8;
  }
  if (
    (previous === "lower" && current === "upper") ||
    (previous !== "number" && current === "number")
  ) {
    return 5;
  }
  if (current === "whitespace" || current === "nonWord") return 8;
  return 0;
}

function oracleClass(character: string): string {
  if (/^\s$/u.test(character)) return "whitespace";
  if (character === "/" || character === "\\") return "delimiter";
  if (/^[0-9]$/u.test(character)) return "number";
  if (/^[a-z]$/u.test(character)) return "lower";
  if (/^[A-Z]$/u.test(character)) return "upper";
  return "nonWord";
}

function codePointIndicesToUtf16(
  text: string,
  indices: readonly number[],
): number[] {
  const offsets: number[] = [];
  let utf16Offset = 0;
  for (const character of Array.from(text)) {
    offsets.push(utf16Offset);
    utf16Offset += character.length;
  }
  return indices.map((index) => offsets[index]!);
}
