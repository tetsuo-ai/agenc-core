/**
 * Build a compact green/red diff preview for an Edit / MultiEdit / Write tool
 * CALL ROW directly from the tool-use INPUT.
 *
 * The live daemon's Edit/MultiEdit/Write SUCCESS result string carries NO diff
 * data — only a "…updated successfully." sentence (the diff is suppressed from
 * the result body, see `tool-result-routing.ts`). The original change is only
 * available on the tool-use input (`old_string`/`new_string` for Edit, the
 * `edits[]` array for MultiEdit, `content` for Write). `AssistantToolUseMessage`
 * has that input on `param.input`, so the diff is rendered there.
 *
 * This module is JSX-free so it can be unit-tested without dragging the React
 * renderer chain into vitest. It reuses `getPatchFromContents` (the same diff
 * engine the FileEditTool uses) by diffing `old_string` against `new_string`
 * per edit — no file read required, so it works from input alone.
 *
 * @module
 */

import { getPatchFromContents } from "../utils/diff.js";
import { isRecord } from "../utils/record.js";

/** A single rendered diff row, shaped for the `DiffInline` primitive. */
export interface DiffPreviewLine {
  readonly kind: "add" | "rem" | "ctx" | "hunk";
  readonly oldLine?: string;
  readonly newLine?: string;
  readonly code: string;
}

export interface EditDiffPreview {
  readonly file: string;
  readonly stats: string;
  readonly lines: readonly DiffPreviewLine[];
  /** Rows dropped past the cap, surfaced as a "… +N more" continuation row. */
  readonly remaining: number;
  /** Total additions / removals across all hunks (before capping). */
  readonly additions: number;
  readonly removals: number;
}

/** Max changed rows shown inline before collapsing to "… +N more". */
const EDIT_PREVIEW_MAX_LINES = 8;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Normalized {old,new} pairs to diff, in apply order. */
interface EditPair {
  readonly oldString: string;
  readonly newString: string;
}

/**
 * Extract the diffable old/new pairs from a tool-use input.
 *  - Edit:      one pair from `old_string`/`new_string`.
 *  - MultiEdit: one pair per entry in `edits[]`.
 *  - Write:     one pair from `""` -> `content` (whole-file add).
 * Returns null when the input carries no usable change (so the caller can skip
 * rendering a diff, e.g. on a malformed/failed call).
 */
export function editPairsFromInput(
  toolName: string,
  input: unknown,
): { readonly file: string; readonly pairs: readonly EditPair[] } | null {
  if (!isRecord(input)) return null;
  const file = asString(input.file_path ?? input.path);

  if (toolName === "Write") {
    const content = asString(input.content);
    // A Write with no content still renders (empty new file) — but only if the
    // file path is present, otherwise there is nothing to show.
    return { file, pairs: [{ oldString: "", newString: content }] };
  }

  if (toolName === "MultiEdit") {
    const rawEdits = Array.isArray(input.edits) ? input.edits : [];
    const pairs: EditPair[] = [];
    for (const edit of rawEdits) {
      if (!isRecord(edit)) continue;
      pairs.push({
        oldString: asString(edit.old_string),
        newString: asString(edit.new_string),
      });
    }
    if (pairs.length === 0) return null;
    return { file, pairs };
  }

  // Edit (default).
  if (
    typeof input.old_string !== "string" &&
    typeof input.new_string !== "string"
  ) {
    return null;
  }
  return {
    file,
    pairs: [
      {
        oldString: asString(input.old_string),
        newString: asString(input.new_string),
      },
    ],
  };
}

/**
 * Build a capped diff preview from a tool-use input. Returns null when there is
 * no diffable change (caller renders nothing — e.g. a failed/empty Edit).
 */
export function buildEditDiffPreview(
  toolName: string,
  input: unknown,
): EditDiffPreview | null {
  const extracted = editPairsFromInput(toolName, input);
  if (extracted === null) return null;
  const { file, pairs } = extracted;

  const lines: DiffPreviewLine[] = [];
  let additions = 0;
  let removals = 0;

  for (const { oldString, newString } of pairs) {
    if (oldString === newString) continue;
    const hunks = getPatchFromContents({
      filePath: file.length > 0 ? file : "file",
      oldContent: oldString,
      newContent: newString,
    });
    for (const hunk of hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const raw of hunk.lines) {
        const marker = raw[0] ?? " ";
        const code = raw.slice(1);
        if (marker === "+") {
          additions++;
          lines.push({ kind: "add", newLine: String(newLine), code });
          newLine++;
        } else if (marker === "-") {
          removals++;
          lines.push({ kind: "rem", oldLine: String(oldLine), code });
          oldLine++;
        } else if (marker === "\\") {
          // "\ No newline at end of file" — skip from the preview.
          continue;
        } else {
          lines.push({
            kind: "ctx",
            oldLine: String(oldLine),
            newLine: String(newLine),
            code,
          });
          oldLine++;
          newLine++;
        }
      }
    }
  }

  if (additions === 0 && removals === 0) {
    return null;
  }

  const stats = `+${additions} -${removals}`;
  if (lines.length <= EDIT_PREVIEW_MAX_LINES) {
    return { file, stats, lines, remaining: 0, additions, removals };
  }
  return {
    file,
    stats,
    lines: lines.slice(0, EDIT_PREVIEW_MAX_LINES),
    remaining: lines.length - EDIT_PREVIEW_MAX_LINES,
    additions,
    removals,
  };
}
