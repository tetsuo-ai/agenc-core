import { assertApplyPatchActive, type ApplyPatchControl } from "./control.js";
import {
  APPLY_PATCH_CONTROL_CHECK_INTERVAL,
  MAX_APPLY_PATCH_MATCH_WORK_UNITS,
} from "./limits.js";
import { ApplyPatchRuntimeError } from "./types.js";

type NormalizationTier = "exact" | "trimEnd" | "trim" | "punctuation";

const NORMALIZATION_TIERS: readonly NormalizationTier[] = [
  "exact",
  "trimEnd",
  "trim",
  "punctuation",
];

export interface PreparedSeekCorpus {
  readonly exact: readonly string[];
  readonly trimEnd: readonly string[];
  readonly trim: readonly string[];
  readonly punctuation: readonly string[];
}

export class ApplyPatchMatchWorkBudget {
  readonly limit: number;
  #used = 0;
  #nextControlCheck = APPLY_PATCH_CONTROL_CHECK_INTERVAL;

  constructor(limit = MAX_APPLY_PATCH_MATCH_WORK_UNITS) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new ApplyPatchRuntimeError(
        "apply_patch match-work limit must be a positive safe integer",
      );
    }
    this.limit = limit;
  }

  get used(): number {
    return this.#used;
  }

  consume(units: number, control?: ApplyPatchControl): void {
    if (!Number.isSafeInteger(units) || units < 0) {
      throw new ApplyPatchRuntimeError(
        "apply_patch match-work accounting received invalid units",
      );
    }
    this.#used += units;
    if (this.#used > this.limit) {
      throw new ApplyPatchRuntimeError(
        `apply_patch matching exceeded the ${this.limit}-unit work budget`,
      );
    }
    if (this.#used >= this.#nextControlCheck) {
      assertApplyPatchActive(control, "line matching");
      this.#nextControlCheck = this.#used + APPLY_PATCH_CONTROL_CHECK_INTERVAL;
    }
  }
}

export interface SeekSequenceControl extends ApplyPatchControl {
  readonly budget?: ApplyPatchMatchWorkBudget;
}

function normalizeCommonPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

function normalizeLine(line: string, tier: NormalizationTier): string {
  switch (tier) {
    case "exact":
      return line;
    case "trimEnd":
      return line.trimEnd();
    case "trim":
      return line.trim();
    case "punctuation":
      return normalizeCommonPunctuation(line);
  }
}

function normalizationCost(line: string, tier: NormalizationTier): number {
  return tier === "exact" ? 1 : line.length + 1;
}

function normalizeLines(
  lines: readonly string[],
  tier: NormalizationTier,
  budget: ApplyPatchMatchWorkBudget,
  control: ApplyPatchControl | undefined,
): readonly string[] {
  const normalized = new Array<string>(lines.length);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    budget.consume(normalizationCost(line, tier), control);
    normalized[index] = normalizeLine(line, tier);
  }
  return normalized;
}

export function prepareSeekCorpus(
  lines: readonly string[],
  control: SeekSequenceControl = {},
): PreparedSeekCorpus {
  const budget = control.budget ?? new ApplyPatchMatchWorkBudget();
  assertApplyPatchActive(control, "line normalization");
  return {
    exact: normalizeLines(lines, "exact", budget, control),
    trimEnd: normalizeLines(lines, "trimEnd", budget, control),
    trim: normalizeLines(lines, "trim", budget, control),
    punctuation: normalizeLines(lines, "punctuation", budget, control),
  };
}

function prefixTable(
  pattern: readonly string[],
  budget: ApplyPatchMatchWorkBudget,
  control: ApplyPatchControl | undefined,
): readonly number[] {
  const prefix = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (matched > 0) {
      budget.consume(1, control);
      if (pattern[index] === pattern[matched]) break;
      matched = prefix[matched - 1] ?? 0;
    }
    budget.consume(1, control);
    if (pattern[index] === pattern[matched]) matched += 1;
    prefix[index] = matched;
  }
  return prefix;
}

function findKmp(
  lines: readonly string[],
  pattern: readonly string[],
  searchStart: number,
  budget: ApplyPatchMatchWorkBudget,
  control: ApplyPatchControl | undefined,
): number | null {
  if (pattern.length === 0) return searchStart;
  const prefix = prefixTable(pattern, budget, control);
  let matched = 0;
  for (let index = searchStart; index < lines.length; index += 1) {
    while (matched > 0) {
      budget.consume(1, control);
      if (lines[index] === pattern[matched]) break;
      matched = prefix[matched - 1] ?? 0;
    }
    budget.consume(1, control);
    if (lines[index] === pattern[matched]) matched += 1;
    if (matched === pattern.length) return index - pattern.length + 1;
  }
  return null;
}

function matchesAt(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  budget: ApplyPatchMatchWorkBudget,
  control: ApplyPatchControl | undefined,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    budget.consume(1, control);
    if (lines[start + offset] !== pattern[offset]) return false;
  }
  return true;
}

function normalizedPattern(
  pattern: readonly string[],
  tier: NormalizationTier,
  budget: ApplyPatchMatchWorkBudget,
  control: ApplyPatchControl | undefined,
): readonly string[] {
  return normalizeLines(pattern, tier, budget, control);
}

function corpusTier(
  corpus: PreparedSeekCorpus,
  tier: NormalizationTier,
): readonly string[] {
  return corpus[tier];
}

export function seekPreparedSequence(
  corpus: PreparedSeekCorpus,
  pattern: readonly string[],
  start: number,
  eof: boolean,
  control: SeekSequenceControl = {},
): number | null {
  const budget = control.budget ?? new ApplyPatchMatchWorkBudget();
  const sourceLength = corpus.exact.length;
  const searchStart = Math.max(0, Math.min(sourceLength, Math.trunc(start)));
  if (pattern.length === 0) return searchStart;
  if (pattern.length > sourceLength) return null;

  const patterns = new Map<NormalizationTier, readonly string[]>();
  for (const tier of NORMALIZATION_TIERS) {
    patterns.set(tier, normalizedPattern(pattern, tier, budget, control));
  }

  if (eof) {
    const anchoredStart = sourceLength - pattern.length;
    for (const tier of NORMALIZATION_TIERS) {
      if (
        matchesAt(
          corpusTier(corpus, tier),
          patterns.get(tier) ?? [],
          anchoredStart,
          budget,
          control,
        )
      ) {
        return anchoredStart;
      }
    }
  }

  for (const tier of NORMALIZATION_TIERS) {
    const found = findKmp(
      corpusTier(corpus, tier),
      patterns.get(tier) ?? [],
      searchStart,
      budget,
      control,
    );
    if (found !== null) return found;
  }
  return null;
}

export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  control: SeekSequenceControl = {},
): number | null {
  const budget = control.budget ?? new ApplyPatchMatchWorkBudget();
  const sharedControl = { ...control, budget };
  const corpus = prepareSeekCorpus(lines, sharedControl);
  return seekPreparedSequence(corpus, pattern, start, eof, sharedControl);
}
