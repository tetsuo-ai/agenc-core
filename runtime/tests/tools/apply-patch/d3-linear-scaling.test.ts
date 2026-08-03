import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ApplyPatchMatchWorkBudget, seekSequence } from "./seek-sequence.js";
import {
  applyTextReplacements,
  parseTextDocument,
  type TextReplacement,
} from "./text-document.js";
import { parsePatch } from "./parser.js";
import { applyPatchText } from "./runtime.js";
import { workspaceMutationCoordinators } from "../../workspace/mutation-coordinator.js";

const PROPERTY_CASE_COUNT = 600;
const SCALING_SMALL_LINE_COUNT = 20_000;
const SCALING_LARGE_LINE_COUNT = SCALING_SMALL_LINE_COUNT * 2;
const ADVERSARIAL_PATTERN_LINES = 512;
const TWO_HUNDRED_THOUSAND_LINES = 200_000;
const PARSER_SCALING_HUNK_COUNT = 25_000;
const LARGE_INSERTION_TEST_TIMEOUT_MS = 30_000;

type Tier = "exact" | "trimEnd" | "trim" | "punctuation";

const TIERS: readonly Tier[] = ["exact", "trimEnd", "trim", "punctuation"];

function normalizePunctuation(value: string): string {
  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018-\u201b]/gu, "'")
    .replace(/[\u201c-\u201f]/gu, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ");
}

function normalize(value: string, tier: Tier): string {
  switch (tier) {
    case "exact":
      return value;
    case "trimEnd":
      return value.trimEnd();
    case "trim":
      return value.trim();
    case "punctuation":
      return normalizePunctuation(value);
  }
}

function naiveFind(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  tier: Tier,
): number | null {
  const lastStart = lines.length - pattern.length;
  for (let index = start; index <= lastStart; index += 1) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (
        normalize(lines[index + offset] ?? "", tier) !==
        normalize(pattern[offset] ?? "", tier)
      ) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return null;
}

function naiveSeek(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;
  if (eof) {
    const anchored = lines.length - pattern.length;
    for (const tier of TIERS) {
      if (naiveFind(lines, pattern, anchored, tier) === anchored) {
        return anchored;
      }
    }
  }
  for (const tier of TIERS) {
    const found = naiveFind(lines, pattern, start, tier);
    if (found !== null) return found;
  }
  return null;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomInteger(random: () => number, maximumExclusive: number): number {
  return Math.floor(random() * maximumExclusive);
}

function measuredAdversarialSearch(lineCount: number): number {
  const lines = new Array<string>(lineCount).fill("aaaaaaaaaa");
  const pattern = new Array<string>(ADVERSARIAL_PATTERN_LINES).fill(
    "aaaaaaaaaa",
  );
  pattern[pattern.length - 1] = "aaaaaaaab";
  const budget = new ApplyPatchMatchWorkBudget();
  expect(seekSequence(lines, pattern, 0, false, { budget })).toBeNull();
  return budget.used;
}

afterEach(() => {
  workspaceMutationCoordinators.clearForTests();
});

describe("apply_patch linear parser, matcher, and output builder", () => {
  test("matches a naive tier-priority oracle across randomized corpora", () => {
    const random = seededRandom(0xd3a11ce);
    const vocabulary = [
      "alpha",
      "beta ",
      " gamma",
      "delta—value",
      "delta-value",
      "quoted “value”",
      'quoted "value"',
      "space\u00a0value",
    ];

    for (
      let propertyCase = 0;
      propertyCase < PROPERTY_CASE_COUNT;
      propertyCase += 1
    ) {
      const lineCount = 1 + randomInteger(random, 24);
      const lines = Array.from(
        { length: lineCount },
        () => vocabulary[randomInteger(random, vocabulary.length)]!,
      );
      const patternLength = 1 + randomInteger(random, Math.min(6, lineCount));
      const start = randomInteger(random, lineCount);
      const pattern = Array.from(
        { length: patternLength },
        () => vocabulary[randomInteger(random, vocabulary.length)]!,
      );
      const eof = random() < 0.5;
      expect(seekSequence(lines, pattern, start, eof)).toBe(
        naiveSeek(lines, pattern, start, eof),
      );
    }
  });

  test("matches a splice oracle for randomized non-overlapping edits", () => {
    const random = seededRandom(0xd3b017d);
    for (
      let propertyCase = 0;
      propertyCase < PROPERTY_CASE_COUNT;
      propertyCase += 1
    ) {
      const lineCount = 1 + randomInteger(random, 30);
      const sourceLines = Array.from(
        { length: lineCount },
        (_, index) => `source-${propertyCase}-${index}`,
      );
      const finalNewline = random() < 0.5;
      const source = `${sourceLines.join("\n")}${finalNewline ? "\n" : ""}`;
      const replacements: TextReplacement[] = [];
      let cursor = 0;
      while (cursor < lineCount && replacements.length < 5) {
        cursor += randomInteger(random, 4);
        if (cursor > lineCount) break;
        const oldLength = Math.min(
          randomInteger(random, 3),
          lineCount - cursor,
        );
        const newLineCount = randomInteger(random, 4);
        if (oldLength === 0 && newLineCount === 0) {
          cursor += 1;
          continue;
        }
        replacements.push({
          startIndex: cursor,
          oldLength,
          newLines: Array.from(
            { length: newLineCount },
            (_, index) => `replacement-${propertyCase}-${cursor}-${index}`,
          ),
        });
        cursor += Math.max(1, oldLength);
      }

      const reference = [...sourceLines];
      for (const replacement of [...replacements].reverse()) {
        reference.splice(
          replacement.startIndex,
          replacement.oldLength,
          ...replacement.newLines,
        );
      }
      const expected =
        reference.length === 0
          ? ""
          : `${reference.join("\n")}${finalNewline ? "\n" : ""}`;
      const document = parseTextDocument(source, "property.txt");
      expect(applyTextReplacements(document, replacements)).toBe(expected);
    }
  });

  test("keeps adversarial matching work linear when input doubles", () => {
    const smallWork = measuredAdversarialSearch(SCALING_SMALL_LINE_COUNT);
    const largeWork = measuredAdversarialSearch(SCALING_LARGE_LINE_COUNT);
    const fixedPatternAllowance = ADVERSARIAL_PATTERN_LINES * 32;
    expect(largeWork).toBeLessThanOrEqual(
      smallWork * 2 + fixedPatternAllowance,
    );
  });

  test("fails closed when a caller-supplied match budget is exhausted", () => {
    const budget = new ApplyPatchMatchWorkBudget(100);
    expect(() =>
      seekSequence(new Array<string>(100).fill("same"), ["absent"], 0, false, {
        budget,
      }),
    ).toThrow(/exceeded the 100-unit work budget/u);
  });

  test(
    "parses 25,000 independent hunks with a single forward cursor",
    () => {
      const hunks = Array.from(
        { length: PARSER_SCALING_HUNK_COUNT },
        (_, index) => `*** Delete File: stale-${index}.txt`,
      );
      const parsed = parsePatch(
        `*** Begin Patch\n${hunks.join("\n")}\n*** End Patch\n`,
      );
      expect(parsed.hunks).toHaveLength(PARSER_SCALING_HUNK_COUNT);
      expect(parsed.hunks.at(-1)).toEqual({
        kind: "delete",
        path: `stale-${PARSER_SCALING_HUNK_COUNT - 1}.txt`,
      });
    },
    LARGE_INSERTION_TEST_TIMEOUT_MS,
  );

  test(
    "inserts into a 200,000-line file without quadratic copying",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-d3-large-patch-"));
      const target = join(root, "large.txt");
      const insertionAfter = Math.floor(TWO_HUNDRED_THOUSAND_LINES / 2);
      const source = `${Array.from(
        { length: TWO_HUNDRED_THOUSAND_LINES },
        (_, index) => `line-${index}`,
      ).join("\n")}\n`;
      try {
        await writeFile(target, source, "utf8");
        await applyPatchText(
          `*** Begin Patch
*** Update File: large.txt
@@ line-${insertionAfter}
+INSERTED
*** End Patch
`,
          { cwd: root, allowedPaths: [root] },
        );
        const result = await readFile(target, "utf8");
        expect(result.length).toBe(source.length + "INSERTED\n".length);
        expect(result).toContain(
          `line-${insertionAfter}\nINSERTED\nline-${insertionAfter + 1}`,
        );
        expect(
          result.endsWith(`line-${TWO_HUNDRED_THOUSAND_LINES - 1}\n`),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    LARGE_INSERTION_TEST_TIMEOUT_MS,
  );
});
