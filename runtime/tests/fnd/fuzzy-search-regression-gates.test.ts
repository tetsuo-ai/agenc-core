import { describe, expect, test } from "vitest";

import {
  BoundedFuzzyMatcher,
  type PreparedFuzzyCandidate,
  prepareFuzzyCandidate,
} from "../../src/search/fuzzy-match.js";
import { FileIndex } from "../../src/tui/ink/native-ts/file-index/index.js";

const ASYMPTOTIC_QUERY = "aaaaaaaa";
const ASYMPTOTIC_CANDIDATE_LENGTHS = Object.freeze([128, 256, 512]);
const MAXIMUM_COMPARISON_READS_PER_CELL = 12;
const MAXIMUM_DOUBLING_GROWTH = 2.1;

describe("D2 fuzzy-search regression gates", () => {
  test("matches every character after the historical 64-code-unit cutoff", () => {
    const prefix = "a".repeat(64);
    const query = `${prefix}RIGHT`;
    const index = new FileIndex();
    index.loadFromFileList([`${prefix}WRONG`, query]);

    expect(index.search(query, 1).map((result) => result.path)).toEqual([
      query,
    ]);
  });

  test("keeps the exact optimal matrix ceiling and a full-query fallback", () => {
    const query = "a".repeat(256);

    expect(new BoundedFuzzyMatcher(query).match("a".repeat(400))).toMatchObject(
      {
        indices: expect.arrayContaining([0, 255]),
        quality: "optimal",
      },
    );
    expect(new BoundedFuzzyMatcher(query).match("a".repeat(401))).toMatchObject(
      {
        indices: expect.arrayContaining([0, 255]),
        quality: "degraded",
      },
    );
  });

  test("bounds adversarial comparison growth to O(query * candidate)", () => {
    const reads = ASYMPTOTIC_CANDIDATE_LENGTHS.map((length) => {
      const observed = countedComparisonCandidate(
        "ax".repeat(Math.ceil(length / 2)).slice(0, length),
      );
      const match = new BoundedFuzzyMatcher(ASYMPTOTIC_QUERY).match(
        observed.candidate,
        { includeIndices: false },
      );

      expect(match?.quality).toBe("optimal");
      expect(observed.reads()).toBeLessThanOrEqual(
        length * ASYMPTOTIC_QUERY.length * MAXIMUM_COMPARISON_READS_PER_CELL,
      );
      return observed.reads();
    });

    for (let index = 1; index < reads.length; index += 1) {
      expect(reads[index]! / reads[index - 1]!).toBeLessThanOrEqual(
        MAXIMUM_DOUBLING_GROWTH,
      );
    }
  });
});

function countedComparisonCandidate(value: string): {
  readonly candidate: PreparedFuzzyCandidate;
  readonly reads: () => number;
} {
  const prepared = prepareFuzzyCandidate(value);
  let comparisonReads = 0;
  const foldedNormalizedCodePoints = new Proxy(
    prepared.foldedNormalizedCodePoints,
    {
      get(target, property) {
        if (
          typeof property === "string" &&
          /^(?:0|[1-9][0-9]*)$/u.test(property)
        ) {
          comparisonReads += 1;
        }
        const result = Reflect.get(target, property, target) as unknown;
        return typeof result === "function" ? result.bind(target) : result;
      },
    },
  );
  return {
    candidate: {
      ...prepared,
      foldedNormalizedCodePoints,
    },
    reads: () => comparisonReads,
  };
}
