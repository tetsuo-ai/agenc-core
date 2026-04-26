import {
  buildDiffDisplayLines,
  type DiffDisplayLine,
} from "../_deps/diff-render.js";

function truncatePreviewText(value: string, maxLines = 160): string {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length <= maxLines) {
    return normalized;
  }
  const headCount = Math.max(1, Math.floor(maxLines * 0.7));
  const tailCount = Math.max(1, maxLines - headCount - 1);
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    `… ${omitted} lines omitted from diff preview …`,
    ...lines.slice(-tailCount),
  ].join("\n");
}

export function looksLikeDiffText(value: string | undefined): boolean {
  const text = String(value ?? "");
  return (
    text.includes("@@") &&
    (text.startsWith("diff --git ") ||
      text.startsWith("--- ") ||
      (text.includes("\n--- ") && text.includes("\n+++ ")))
  );
}

export function renderDiffDisplayLines(value: string): DiffDisplayLine[] {
  const source = String(value ?? "");
  return buildDiffDisplayLines({ kind: "tool", body: source });
}

export function renderSourceMutationDisplayLines(opts: {
  readonly filePath: string;
  readonly mutationKind: "write" | "create" | "append" | "insert" | "replace";
  readonly beforeText?: string;
  readonly afterText?: string;
}): DiffDisplayLine[] {
  return buildDiffDisplayLines({
    kind: "tool",
    previewMode: "source-mutation",
    mutationKind: opts.mutationKind,
    filePath: opts.filePath,
    mutationBeforeText: truncatePreviewText(opts.beforeText ?? ""),
    mutationAfterText: truncatePreviewText(opts.afterText ?? ""),
  });
}
