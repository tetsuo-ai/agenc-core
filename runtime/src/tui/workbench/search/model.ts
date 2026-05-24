import { relativePath } from "../../../utils/permissions/filesystem.js";
import { isRelativePathOutsideBase } from "../../pathDisplay.js";
import { normalizeWorkspacePathForReferences } from "../pathReferences.js";
import type { SearchGroup, SearchMatch } from "../types.js";

export function parseWorkbenchRipgrepJsonLine(line: string, cwd: string): SearchMatch | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const typedMessage = message as {
    readonly type?: unknown;
    readonly data?: {
      readonly path?: {
        readonly text?: unknown;
      };
      readonly line_number?: unknown;
      readonly lines?: {
        readonly text?: unknown;
      };
    };
  };
  if (typedMessage.type !== "match") return null;
  const rawFile = typedMessage.data?.path?.text;
  const lineNumber = Number(typedMessage.data?.line_number);
  const text = typedMessage.data?.lines?.text;
  if (
    typeof rawFile !== "string" ||
    !rawFile ||
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    typeof text !== "string"
  ) {
    return null;
  }
  const strippedText = stripJsonLineTerminator(text);
  const file = normalizeWorkbenchSearchPath(rawFile, cwd);
  return {
    id: `${file}:${lineNumber}:${strippedText}`,
    file,
    line: lineNumber,
    text: strippedText,
  };
}

function normalizeWorkbenchSearchPath(rawFile: string, cwd: string): string {
  const rel = isAbsoluteLike(rawFile) ? relativePath(cwd, rawFile) : rawFile;
  return normalizeWorkspacePathForReferences(isRelativePathOutsideBase(rel) ? rawFile : rel);
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

function stripJsonLineTerminator(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n") || text.endsWith("\r")) return text.slice(0, -1);
  return text;
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
