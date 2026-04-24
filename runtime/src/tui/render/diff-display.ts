import {
  buildDiffDisplayLines,
  type DiffDisplayLine,
} from "../_deps/diff-render.js";

function createLine(
  text: string,
  mode: string,
  metadata: Record<string, unknown> = {},
): DiffDisplayLine {
  return {
    text,
    plainText: text,
    mode,
    ...metadata,
  };
}

function compactPath(path: string): string {
  const normalized = path.trim();
  if (normalized.length <= 72) return normalized;
  return `…${normalized.slice(-71)}`;
}

function patchHeadline(kind: string): string {
  switch (kind) {
    case "Add":
      return "create";
    case "Delete":
      return "delete";
    case "Update":
      return "patch";
    default:
      return "patch";
  }
}

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
    text.includes("*** Begin Patch") ||
    /^\*\*\* (?:Add|Update|Delete) File:/mu.test(text) ||
    (text.includes("@@") &&
      (text.startsWith("diff --git ") ||
        text.startsWith("--- ") ||
        (text.includes("\n--- ") && text.includes("\n+++ "))))
  );
}

export function renderApplyPatchDisplayLines(
  patch: string,
): DiffDisplayLine[] {
  const source = String(patch ?? "").replace(/\r\n/g, "\n");
  if (
    !source.includes("*** Begin Patch") &&
    !/^\*\*\* (?:Add|Update|Delete) File:/mu.test(source)
  ) {
    return [];
  }

  const output: DiffDisplayLine[] = [];
  let currentFilePath = "";
  let sawFileHeader = false;
  let sawHunk = false;

  for (const row of source.split("\n")) {
    const fileHeader = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/u.exec(row);
    if (fileHeader) {
      if (output.length > 0 && output.at(-1)?.mode !== "blank") {
        output.push(createLine("", "blank"));
      }
      currentFilePath = fileHeader[2]?.trim() ?? "";
      sawFileHeader = true;
      sawHunk = false;
      output.push(
        createLine(
          `${patchHeadline(fileHeader[1] ?? "")} · ${compactPath(currentFilePath)}`,
          "diff-header",
          { filePath: currentFilePath },
        ),
      );
      continue;
    }

    if (row.startsWith("*** ")) {
      continue;
    }

    if (!sawFileHeader) {
      continue;
    }

    if (row.startsWith("@@")) {
      sawHunk = true;
      output.push(createLine(row, "diff-hunk", { filePath: currentFilePath }));
      continue;
    }

    if (row.startsWith("+")) {
      output.push(createLine(row, "diff-add", { filePath: currentFilePath }));
      continue;
    }

    if (row.startsWith("-")) {
      output.push(createLine(row, "diff-remove", { filePath: currentFilePath }));
      continue;
    }

    if (row.startsWith(" ")) {
      output.push(createLine(row, "diff-context", { filePath: currentFilePath }));
      continue;
    }

    if (sawHunk && row.startsWith("\\")) {
      output.push(createLine(row, "diff-meta", { filePath: currentFilePath }));
    }
  }

  return output.filter((line, index, allLines) => {
    if (line.mode !== "blank") return true;
    return Boolean(allLines[index - 1] && allLines[index + 1]);
  });
}

export function renderDiffDisplayLines(value: string): DiffDisplayLine[] {
  const source = String(value ?? "");
  const applyPatchLines = renderApplyPatchDisplayLines(source);
  if (applyPatchLines.length > 0) {
    return applyPatchLines;
  }
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
