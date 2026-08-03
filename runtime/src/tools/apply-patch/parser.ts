import { Buffer } from "node:buffer";

import {
  assertApplyPatchActive,
  periodicallyAssertApplyPatchActive,
  type ApplyPatchControl,
} from "./control.js";
import {
  MAX_APPLY_PATCH_BYTES,
  MAX_APPLY_PATCH_CHUNKS,
  MAX_APPLY_PATCH_HUNKS,
  MAX_APPLY_PATCH_LINE_BYTES,
  MAX_APPLY_PATCH_LINES,
} from "./limits.js";
import {
  ApplyPatchInputError,
  ApplyPatchParseError,
  type ApplyPatchArgs,
  type ApplyPatchHunk,
  type UpdateFileChunk,
} from "./types.js";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const NUL_CODE_UNIT = 0;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

export type ParseMode = "strict" | "lenient";

interface PatchBoundary {
  readonly firstHunkIndex: number;
  readonly endPatchIndex: number;
}

interface ParsedHunk {
  readonly hunk: ApplyPatchHunk;
  readonly nextIndex: number;
  readonly chunkCount: number;
}

function invalidPatch(message: string): ApplyPatchParseError {
  return new ApplyPatchParseError("invalid_patch", message);
}

function invalidHunk(
  message: string,
  lineNumber: number,
): ApplyPatchParseError {
  return new ApplyPatchParseError("invalid_hunk", message, lineNumber);
}

function validatePatchCodeUnits(
  patch: string,
  control: ApplyPatchControl | undefined,
): void {
  for (let offset = 0; offset < patch.length; offset += 1) {
    periodicallyAssertApplyPatchActive(control, offset, "payload validation");
    const codeUnit = patch.charCodeAt(offset);
    if (codeUnit === NUL_CODE_UNIT) {
      throw new ApplyPatchInputError(
        "nul_code_unit",
        "NUL code units are not allowed",
        offset,
      );
    }
    if (codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END) {
      const next = patch.charCodeAt(offset + 1);
      if (next < LOW_SURROGATE_START || next > LOW_SURROGATE_END) {
        throw new ApplyPatchInputError(
          "unpaired_surrogate",
          "unpaired high surrogate",
          offset,
        );
      }
      offset += 1;
      continue;
    }
    if (codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END) {
      throw new ApplyPatchInputError(
        "unpaired_surrogate",
        "unpaired low surrogate",
        offset,
      );
    }
  }
}

function splitPatchLines(
  patch: string,
  control: ApplyPatchControl | undefined,
): readonly string[] {
  validatePatchCodeUnits(patch, control);
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > MAX_APPLY_PATCH_BYTES) {
    throw new ApplyPatchInputError(
      "input_limit",
      `payload exceeds the ${MAX_APPLY_PATCH_BYTES}-byte limit`,
      patch.length,
    );
  }

  const trimmed = patch.trim();
  if (trimmed.length === 0) return [];

  const lines: string[] = [];
  let lineStart = 0;
  for (let offset = 0; offset <= trimmed.length; offset += 1) {
    periodicallyAssertApplyPatchActive(control, offset, "line scanning");
    if (offset !== trimmed.length && trimmed.charCodeAt(offset) !== 0x0a) {
      continue;
    }
    const lineEnd =
      offset > lineStart && trimmed.charCodeAt(offset - 1) === 0x0d
        ? offset - 1
        : offset;
    const line = trimmed.slice(lineStart, lineEnd);
    if (Buffer.byteLength(line, "utf8") > MAX_APPLY_PATCH_LINE_BYTES) {
      throw invalidPatch(
        `line ${lines.length + 1} exceeds the ${MAX_APPLY_PATCH_LINE_BYTES}-byte limit`,
      );
    }
    lines.push(line);
    if (lines.length > MAX_APPLY_PATCH_LINES) {
      throw invalidPatch(
        `patch exceeds the ${MAX_APPLY_PATCH_LINES}-line limit`,
      );
    }
    lineStart = offset + 1;
  }
  return lines;
}

function strictBoundary(
  lines: readonly string[],
  beginIndex = 0,
  endIndex = lines.length - 1,
): PatchBoundary {
  const first = lines[beginIndex]?.trim();
  const last = lines[endIndex]?.trim();
  if (first !== BEGIN_PATCH_MARKER) {
    throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  if (last !== END_PATCH_MARKER) {
    throw invalidPatch("The last line of the patch must be '*** End Patch'");
  }
  return { firstHunkIndex: beginIndex + 1, endPatchIndex: endIndex };
}

function patchBoundary(
  lines: readonly string[],
  mode: ParseMode,
): PatchBoundary {
  if (mode === "strict") return strictBoundary(lines);
  try {
    return strictBoundary(lines);
  } catch (error) {
    if (!(error instanceof ApplyPatchParseError)) throw error;
    const first = lines[0];
    const last = lines.at(-1);
    const isHeredocStart =
      first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
    if (
      isHeredocStart &&
      last !== undefined &&
      last.endsWith("EOF") &&
      lines.length >= 4
    ) {
      return strictBoundary(lines, 1, lines.length - 2);
    }
    throw error;
  }
}

function parseUpdateChunk(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
  patchLineOffset: number,
  allowMissingContext: boolean,
): { readonly chunk: UpdateFileChunk; readonly nextIndex: number } {
  if (startIndex >= endIndex) {
    throw invalidHunk(
      "Update hunk does not contain any lines",
      startIndex - patchLineOffset + 1,
    );
  }

  const firstLine = lines[startIndex] ?? "";
  const hasExplicitContext =
    firstLine === EMPTY_CHANGE_CONTEXT_MARKER ||
    firstLine.startsWith(CHANGE_CONTEXT_MARKER);
  if (!hasExplicitContext && !allowMissingContext) {
    throw invalidHunk(
      `Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
      startIndex - patchLineOffset + 1,
    );
  }
  const changeContext =
    firstLine === EMPTY_CHANGE_CONTEXT_MARKER
      ? null
      : firstLine.startsWith(CHANGE_CONTEXT_MARKER)
        ? firstLine.slice(CHANGE_CONTEXT_MARKER.length)
        : null;
  let index = hasExplicitContext ? startIndex + 1 : startIndex;
  if (index >= endIndex) {
    throw invalidHunk(
      "Update hunk does not contain any lines",
      index - patchLineOffset + 1,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let parsedBodyLines = 0;
  let isEndOfFile = false;
  while (index < endIndex) {
    const line = lines[index] ?? "";
    if (line === EOF_MARKER) {
      if (parsedBodyLines === 0) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          index - patchLineOffset + 1,
        );
      }
      isEndOfFile = true;
      index += 1;
      break;
    }

    const marker = line[0];
    if (marker === undefined) {
      oldLines.push("");
      newLines.push("");
    } else if (marker === " ") {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    } else if (marker === "+") {
      newLines.push(line.slice(1));
    } else if (marker === "-") {
      oldLines.push(line.slice(1));
    } else {
      if (parsedBodyLines === 0) {
        throw invalidHunk(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          index - patchLineOffset + 1,
        );
      }
      break;
    }
    parsedBodyLines += 1;
    index += 1;
  }

  return {
    chunk: { changeContext, oldLines, newLines, isEndOfFile },
    nextIndex: index,
  };
}

function parseHunk(
  lines: readonly string[],
  startIndex: number,
  endIndex: number,
  patchLineOffset: number,
): ParsedHunk {
  const firstLine = (lines[startIndex] ?? "").trim();
  const lineNumber = startIndex - patchLineOffset + 1;
  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const contentLines: string[] = [];
    let index = startIndex + 1;
    while (index < endIndex && lines[index]?.startsWith("+")) {
      contentLines.push((lines[index] ?? "").slice(1));
      index += 1;
    }
    const contents =
      contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`;
    return {
      hunk: {
        kind: "add",
        path: firstLine.slice(ADD_FILE_MARKER.length),
        contents,
      },
      nextIndex: index,
      chunkCount: 0,
    };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    return {
      hunk: {
        kind: "delete",
        path: firstLine.slice(DELETE_FILE_MARKER.length),
      },
      nextIndex: startIndex + 1,
      chunkCount: 0,
    };
  }

  if (!firstLine.startsWith(UPDATE_FILE_MARKER)) {
    throw invalidHunk(
      `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      lineNumber,
    );
  }

  const path = firstLine.slice(UPDATE_FILE_MARKER.length);
  let index = startIndex + 1;
  const rawMoveLine = lines[index];
  const movePath = rawMoveLine?.startsWith(MOVE_TO_MARKER)
    ? rawMoveLine.slice(MOVE_TO_MARKER.length)
    : null;
  if (movePath !== null) index += 1;

  const chunks: UpdateFileChunk[] = [];
  while (index < endIndex) {
    const nextLine = lines[index] ?? "";
    if (nextLine.trim().length === 0) {
      index += 1;
      continue;
    }
    if (nextLine.startsWith("*")) break;
    const parsed = parseUpdateChunk(
      lines,
      index,
      endIndex,
      patchLineOffset,
      chunks.length === 0,
    );
    chunks.push(parsed.chunk);
    index = parsed.nextIndex;
  }
  if (chunks.length === 0) {
    throw invalidHunk(
      `Update file hunk for path '${path}' is empty`,
      lineNumber,
    );
  }
  return {
    hunk: { kind: "update", path, movePath, chunks },
    nextIndex: index,
    chunkCount: chunks.length,
  };
}

export function parsePatch(
  patch: string,
  mode: ParseMode = "lenient",
  control?: ApplyPatchControl,
): ApplyPatchArgs {
  assertApplyPatchActive(control, "payload parsing");
  const lines = splitPatchLines(patch, control);
  const boundary = patchBoundary(lines, mode);
  const patchLineOffset = boundary.firstHunkIndex - 1;
  const hunks: ApplyPatchHunk[] = [];
  let chunkCount = 0;
  let index = boundary.firstHunkIndex;
  while (index < boundary.endPatchIndex) {
    periodicallyAssertApplyPatchActive(control, index, "hunk parsing");
    const parsed = parseHunk(
      lines,
      index,
      boundary.endPatchIndex,
      patchLineOffset,
    );
    hunks.push(parsed.hunk);
    if (hunks.length > MAX_APPLY_PATCH_HUNKS) {
      throw invalidPatch(
        `patch exceeds the ${MAX_APPLY_PATCH_HUNKS}-hunk limit`,
      );
    }
    chunkCount += parsed.chunkCount;
    if (chunkCount > MAX_APPLY_PATCH_CHUNKS) {
      throw invalidPatch(
        `patch exceeds the ${MAX_APPLY_PATCH_CHUNKS}-chunk limit`,
      );
    }
    index = parsed.nextIndex;
  }
  assertApplyPatchActive(control, "payload parsing");

  const firstPatchIndex = boundary.firstHunkIndex - 1;
  return {
    hunks,
    patch: lines.slice(firstPatchIndex, boundary.endPatchIndex + 1).join("\n"),
    workdir: null,
  };
}
