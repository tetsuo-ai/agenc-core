import {
  normalizeRipgrepMatchPath,
  parseRipgrepJsonLine,
} from "../../search/ripgrep-match.js";
import type { SearchGroup, SearchMatch } from "../types.js";

export function parseWorkbenchRipgrepJsonLine(line: string, cwd: string): SearchMatch | null {
  const match = parseRipgrepJsonLine(line);
  if (match === null) return null;
  const file = normalizeRipgrepMatchPath(match.file, cwd);
  return {
    id: `${file}:${match.line}:${match.text}`,
    file,
    line: match.line,
    text: match.text,
  };
}

export function groupSearchMatches(matches: readonly SearchMatch[]): SearchGroup[] {
  const groups = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const bucket = groups.get(match.file);
    if (bucket) {
      bucket.push(match);
    } else {
      groups.set(match.file, [match]);
    }
  }
  return [...groups.entries()].map(([file, fileMatches]) => ({
    file,
    matches: fileMatches,
  }));
}

export function visibleSearchRows(
  groups: readonly SearchGroup[],
): Array<
  | { readonly kind: "file"; readonly file: string; readonly count: number; readonly id: string }
  | { readonly kind: "match"; readonly match: SearchMatch; readonly id: string }
> {
  return groups.flatMap((group) => [
    { kind: "file" as const, file: group.file, count: group.matches.length, id: `file:${group.file}` },
    ...group.matches.map((match) => ({ kind: "match" as const, match, id: `match:${match.id}` })),
  ]);
}
