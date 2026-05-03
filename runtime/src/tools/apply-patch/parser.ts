/**
 * Ports the donor apply-patch grammar parser onto AgenC.
 *
 * Shape differences from upstream:
 *   - The parser emits TypeScript discriminated unions.
 *   - Lenient heredoc stripping is preserved, but shell AST extraction is
 *     intentionally not part of this file.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Tree-sitter shell parsing belongs to the later tool-runtime split.
 */

import {
  ApplyPatchParseError,
  type ApplyPatchArgs,
  type ApplyPatchHunk,
  type UpdateFileChunk,
} from "./types.js";

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

export type ParseMode = "strict" | "lenient";

function invalidPatch(message: string): ApplyPatchParseError {
  return new ApplyPatchParseError("invalid_patch", message);
}

function invalidHunk(
  message: string,
  lineNumber: number,
): ApplyPatchParseError {
  return new ApplyPatchParseError("invalid_hunk", message, lineNumber);
}

function linesOf(patch: string): string[] {
  const trimmed = patch.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\r?\n/u);
}

function checkStartAndEndLinesStrict(
  firstLine: string | undefined,
  lastLine: string | undefined,
): void {
  const first = firstLine?.trim();
  const last = lastLine?.trim();
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return;
  if (first !== BEGIN_PATCH_MARKER) {
    throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

function checkPatchBoundariesStrict(lines: readonly string[]): {
  readonly patchLines: readonly string[];
  readonly hunkLines: readonly string[];
} {
  checkStartAndEndLinesStrict(lines[0], lines.at(-1));
  return {
    patchLines: lines,
    hunkLines: lines.slice(1, Math.max(1, lines.length - 1)),
  };
}

function checkPatchBoundariesLenient(lines: readonly string[]): {
  readonly patchLines: readonly string[];
  readonly hunkLines: readonly string[];
} {
  try {
    return checkPatchBoundariesStrict(lines);
  } catch (error) {
    if (!(error instanceof ApplyPatchParseError)) throw error;
    const originalError = error;
    const first = lines[0];
    const last = lines.at(-1);
    if (
      first !== undefined &&
      last !== undefined &&
      (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
      last.endsWith("EOF") &&
      lines.length >= 4
    ) {
      return checkPatchBoundariesStrict(lines.slice(1, -1));
    }
    throw originalError;
  }
}

function parseUpdateFileChunk(
  lines: readonly string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { readonly chunk: UpdateFileChunk; readonly parsedLines: number } {
  if (lines.length === 0) {
    throw invalidHunk("Update hunk does not contain any lines", lineNumber);
  }

  const firstLine = lines[0] ?? "";
  const context =
    firstLine === EMPTY_CHANGE_CONTEXT_MARKER
      ? { changeContext: null as string | null, startIndex: 1 }
      : firstLine.startsWith(CHANGE_CONTEXT_MARKER)
        ? {
            changeContext: firstLine.slice(CHANGE_CONTEXT_MARKER.length),
            startIndex: 1,
          }
        : allowMissingContext
          ? { changeContext: null as string | null, startIndex: 0 }
          : null;

  if (context === null) {
    throw invalidHunk(
      `Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
      lineNumber,
    );
  }
  if (context.startIndex >= lines.length) {
    throw invalidHunk(
      "Update hunk does not contain any lines",
      lineNumber + 1,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let parsedLines = 0;

  for (const line of lines.slice(context.startIndex)) {
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          lineNumber + 1,
        );
      }
      isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line[0];
    if (marker === undefined) {
      oldLines.push("");
      newLines.push("");
    } else if (marker === " ") {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (marker === "+") {
      newLines.push(line.slice(1));
    } else if (marker === "-") {
      oldLines.push(line.slice(1));
    } else {
      if (parsedLines === 0) {
        throw invalidHunk(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNumber + 1,
        );
      }
      break;
    }
    parsedLines += 1;
  }

  return {
    chunk: {
      changeContext: context.changeContext,
      oldLines,
      newLines,
      isEndOfFile,
    },
    parsedLines: parsedLines + context.startIndex,
  };
}

function parseOneHunk(
  lines: readonly string[],
  lineNumber: number,
): { readonly hunk: ApplyPatchHunk; readonly parsedLines: number } {
  const firstLine = (lines[0] ?? "").trim();
  const addPath = firstLine.startsWith(ADD_FILE_MARKER)
    ? firstLine.slice(ADD_FILE_MARKER.length)
    : null;
  if (addPath !== null) {
    let contents = "";
    let parsedLines = 1;
    for (const line of lines.slice(1)) {
      if (!line.startsWith("+")) break;
      contents += `${line.slice(1)}\n`;
      parsedLines += 1;
    }
    return {
      hunk: { kind: "add", path: addPath, contents },
      parsedLines,
    };
  }

  const deletePath = firstLine.startsWith(DELETE_FILE_MARKER)
    ? firstLine.slice(DELETE_FILE_MARKER.length)
    : null;
  if (deletePath !== null) {
    return {
      hunk: { kind: "delete", path: deletePath },
      parsedLines: 1,
    };
  }

  const updatePath = firstLine.startsWith(UPDATE_FILE_MARKER)
    ? firstLine.slice(UPDATE_FILE_MARKER.length)
    : null;
  if (updatePath !== null) {
    let remainingLines = lines.slice(1);
    let parsedLines = 1;
    const rawMoveLine = remainingLines[0];
    const movePath = rawMoveLine?.startsWith(MOVE_TO_MARKER)
      ? rawMoveLine.slice(MOVE_TO_MARKER.length)
      : null;
    if (movePath !== null) {
      remainingLines = remainingLines.slice(1);
      parsedLines += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remainingLines.length > 0) {
      const nextLine = remainingLines[0] ?? "";
      if (nextLine.trim().length === 0) {
        parsedLines += 1;
        remainingLines = remainingLines.slice(1);
        continue;
      }
      if (nextLine.startsWith("*")) break;

      const parsed = parseUpdateFileChunk(
        remainingLines,
        lineNumber + parsedLines,
        chunks.length === 0,
      );
      chunks.push(parsed.chunk);
      parsedLines += parsed.parsedLines;
      remainingLines = remainingLines.slice(parsed.parsedLines);
    }

    if (chunks.length === 0) {
      throw invalidHunk(
        `Update file hunk for path '${updatePath}' is empty`,
        lineNumber,
      );
    }

    return {
      hunk: { kind: "update", path: updatePath, movePath, chunks },
      parsedLines,
    };
  }

  throw invalidHunk(
    `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber,
  );
}

export function parsePatch(
  patch: string,
  mode: ParseMode = "lenient",
): ApplyPatchArgs {
  const lines = linesOf(patch);
  const { patchLines, hunkLines } =
    mode === "strict"
      ? checkPatchBoundariesStrict(lines)
      : checkPatchBoundariesLenient(lines);

  const hunks: ApplyPatchHunk[] = [];
  let remainingLines = hunkLines;
  let lineNumber = 2;
  while (remainingLines.length > 0) {
    const parsed = parseOneHunk(remainingLines, lineNumber);
    hunks.push(parsed.hunk);
    lineNumber += parsed.parsedLines;
    remainingLines = remainingLines.slice(parsed.parsedLines);
  }

  return {
    hunks,
    patch: patchLines.join("\n"),
    workdir: null,
  };
}
