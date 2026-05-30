/**
 * Ports the donor apply-patch line matcher onto AgenC.
 *
 * Shape differences from upstream:
 *   - The matching passes operate on readonly string arrays.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None.
 */

function normalizeCommonPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");
}

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  comparator: (line: string, patternLine: string) => boolean,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    const line = lines[start + offset];
    const patternLine = pattern[offset];
    if (line === undefined || patternLine === undefined) return false;
    if (!comparator(line, patternLine)) return false;
  }
  return true;
}

function findWithComparator(
  lines: readonly string[],
  pattern: readonly string[],
  searchStart: number,
  comparator: (line: string, patternLine: string) => boolean,
): number | null {
  const lastStart = lines.length - pattern.length;
  for (let index = searchStart; index <= lastStart; index += 1) {
    if (sequenceMatches(lines, pattern, index, comparator)) return index;
  }
  return null;
}

export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const runChain = (from: number): number | null =>
    findWithComparator(lines, pattern, from, (line, pat) => line === pat) ??
    findWithComparator(
      lines,
      pattern,
      from,
      (line, pat) => line.trimEnd() === pat.trimEnd(),
    ) ??
    findWithComparator(
      lines,
      pattern,
      from,
      (line, pat) => line.trim() === pat.trim(),
    ) ??
    findWithComparator(
      lines,
      pattern,
      from,
      (line, pat) =>
        normalizeCommonPunctuation(line) === normalizeCommonPunctuation(pat),
    );

  // For an end-of-file-anchored hunk, try the flush-against-EOF position first
  // (matching the donor), then fall back to a normal scan from `start`. The
  // previous port pinned the search to the EOF position only, so any EOF hunk
  // whose context/removed lines were not literally the final lines of the file
  // failed to apply — a silent loss of patch-application capability. The
  // fallback is strictly additive: a flush match still wins first.
  if (eof && lines.length >= pattern.length) {
    const anchored = runChain(lines.length - pattern.length);
    if (anchored !== null) return anchored;
    return runChain(start);
  }

  return runChain(start);
}
