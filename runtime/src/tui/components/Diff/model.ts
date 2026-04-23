import { buildDiffDisplayLines } from "../../../watch/agenc-watch-diff-render.mjs";

export interface DiffDisplayLine {
  readonly text: string;
  readonly plainText: string;
  readonly mode: string;
  readonly filePath?: string;
  readonly fileLinkText?: string;
  readonly [key: string]: unknown;
}

export interface DiffFileSummary {
  readonly path: string;
  readonly label: string;
  readonly status: string;
}

export interface DiffRenderOptions {
  readonly cwd?: string;
  readonly maxPathChars?: number;
}

export function buildDiffLines(
  event: unknown,
  options: DiffRenderOptions = {},
): DiffDisplayLine[] {
  return (buildDiffDisplayLines(event, {
    cwd: options.cwd,
    maxPathChars: options.maxPathChars,
  }) as readonly Record<string, unknown>[]).map((line) => ({
    ...line,
    text: String(line.text ?? ""),
    plainText: String(line.plainText ?? line.text ?? ""),
    mode: String(line.mode ?? "plain"),
    filePath:
      typeof line.filePath === "string" && line.filePath.length > 0
        ? line.filePath
        : undefined,
    fileLinkText:
      typeof line.fileLinkText === "string" && line.fileLinkText.length > 0
        ? line.fileLinkText
        : undefined,
  }));
}

export function extractDiffFileSummaries(
  lines: readonly DiffDisplayLine[],
): DiffFileSummary[] {
  const seen = new Set<string>();
  const files: DiffFileSummary[] = [];
  for (const line of lines) {
    if (line.mode !== "diff-header" || line.filePath === undefined || seen.has(line.filePath)) {
      continue;
    }
    seen.add(line.filePath);
    const [status] = line.text.split(" · ", 1);
    files.push({
      path: line.filePath,
      label:
        line.fileLinkText ??
        line.filePath.split(/[\\/]/).filter(Boolean).at(-1) ??
        line.filePath,
      status: status?.trim() || "patch",
    });
  }
  return files;
}
