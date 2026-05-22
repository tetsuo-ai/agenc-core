import { relativePath } from "../../../utils/permissions/filesystem.js";
import type { SearchGroup, SearchMatch } from "../types.js";

export function parseWorkbenchRipgrepLine(line: string, cwd: string): SearchMatch | null {
  const match = /^(.*?):(\d+):(.*)$/u.exec(line);
  if (!match) return null;
  const [, rawFile, lineText, text] = match;
  const lineNumber = Number.parseInt(lineText ?? "", 10);
  if (!rawFile || !Number.isFinite(lineNumber)) return null;
  const rel = isAbsoluteLike(rawFile) ? relativePath(cwd, rawFile) : rawFile;
  const file = rel.startsWith("..") ? rawFile : rel;
  return {
    id: `${file}:${lineNumber}:${text ?? ""}`,
    file,
    line: lineNumber,
    text: text ?? "",
  };
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
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
