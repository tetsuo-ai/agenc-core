/**
 * Pure dispatch logic for the AgenC TUI tool renderer's
 * `renderToolResultMessage`. Lives in a JSX-free `.ts` file (no React,
 * no renderer imports) so unit tests can exercise the dispatch
 * decision without dragging the moved component chain into vitest
 * (that chain reaches `config.ts` which `require()`s
 * feature-gated paths the source resolver cannot follow).
 *
 * @module
 */

import { isRecord } from "../utils/record.js";

/**
 * Hardcoded copies of the live registered tool names that the TUI
 * dispatches structurally. Canonical sources:
 *   - `runtime/src/tools/system/bash.ts`      -> "Bash"
 *   - `runtime/src/tools/system/file-edit.ts`  -> "Edit"
 *   - `runtime/src/tools/system/file-read.ts`  -> "FileRead"
 *   - `runtime/src/tools/system/file-write.ts` -> "Write"
 *   - `runtime/src/tools/system/grep.ts`       -> "Grep"
 *   - `runtime/src/tools/system/glob.ts`       -> "Glob"
 * Inlined here instead of imported because the live modules pull
 * heavy runtime dependencies (e.g. the `diff` package, OS-bound
 * exec); if the live names change, update these in lockstep.
 */
export const BASH_TOOL_NAME_FOR_DISPATCH = "Bash";
/**
 * The live daemon registers the shell tool as `exec_command` (shown "Run" in
 * the TUI), not "Bash". Its `exec_command_end` result is wrapped in the same
 * `<bash-stdout>` envelope as Bash (see
 * `session-transcript.formatStructuredToolResult`), so it dispatches to the
 * same bash-output view.
 */
export const EXEC_COMMAND_TOOL_NAME_FOR_DISPATCH = "exec_command";
export const EDIT_TOOL_NAME_FOR_DISPATCH = "Edit";
export const FILE_READ_TOOL_NAME_FOR_DISPATCH = "FileRead";
export const FILE_WRITE_TOOL_NAME_FOR_DISPATCH = "Write";
export const GREP_TOOL_NAME_FOR_DISPATCH = "Grep";
export const GLOB_TOOL_NAME_FOR_DISPATCH = "Glob";

/** Where the TUI should send a tool result for rendering. */
export type ToolResultDispatchTarget =
  | "bash-output-view"
  | "edit-diff-view"
  | "file-read-view"
  | "file-write-view"
  | "grep-matches-view"
  | "glob-paths-view"
  | "tool-error-view"
  | "suppress"
  | "generic";

/**
 * The live daemon's `exec_command` result is a PLAIN string (no
 * `<bash-stdout>` envelope): raw stdout, then a trailer line
 * `[exec exit_code=0 wall_time=0.0300s tokens=69]`. Match that trailer so the
 * raw exec result still routes to the capped bash-output view.
 */
const EXEC_TRAILER_RE = /\[exec exit_code=-?\d+/;

/**
 * The live daemon's `FileRead` result is the file body with line-number
 * prefixes, e.g. `  31→    ...` (number, then a `→` arrow). Detect at least one
 * such line so a raw read result routes to the "Read N lines" view.
 */
const FILE_READ_LINE_RE = /(^|\n)\s*\d+→/;

/**
 * The live daemon's `Grep` result is either a files-with-matches block
 * (`Found 1 file\n<path>`), a per-file count block ending in
 * `Found N total occurrences across M files.`, or a `file:line:content` /
 * `file:count` match list. Detect the `Found ...` summary or a `path:line`
 * shape so a raw grep result routes to the tidy count view.
 */
const GREP_FOUND_RE = /Found \d+ (file|files|match|matches|total occurrences)/;

/**
 * The live daemon's `Edit`/`MultiEdit`/`Write` SUCCESS result is a bare
 * success sentence (no diff data — the diff is rendered from the tool-use
 * INPUT on the call row instead). Suppress it so the result renders exactly
 * once (the diff), not twice. The daemon emits several success shapes that all
 * mean "the write applied", and the suppress predicate must cover every one or
 * the raw sentence double-renders alongside the diff:
 *
 *   - single Edit / existing-file Write:
 *       "The file <path> has been updated successfully."
 *   - replace_all Edit (`successText(_, true)`):
 *       "The file <path> has been updated. All occurrences were successfully
 *        replaced."
 *   - MultiEdit (`multiEditSuccessText`): the "...updated successfully." clause
 *       is FOLLOWED by " N edits applied with M replacements." — so the success
 *       phrase is mid-string, not end-anchored.
 *   - new-file Write (`file-write.ts`):
 *       "File created successfully at: <path>" — "successfully" is mid-string
 *       and the line ends with a path, not "successfully.".
 *
 * Each regex is unanchored at the tail so the MultiEdit trailer and the Write
 * path suffix don't defeat the match, but each still requires the specific
 * success wording so a FAILED edit/write (which uses different wording and is
 * routed through the error/generic path) never matches.
 */
const EDIT_SUCCESS_RE =
  /\bhas been updated successfully\.|\bhas been updated\. All occurrences were successfully replaced\./;
const WRITE_SUCCESS_RE =
  /\bhas been (created|written) successfully\.|\bFile created successfully at:/;

/**
 * Heuristic for a bare Grep match list with no `Found ...` summary line — every
 * non-empty line looks like `path:line:content` or `path:count` (the
 * files-with-counts and matches shapes the daemon emits). Used so a raw match
 * list still routes to the count view instead of dumping under the call row.
 */
function isGrepMatchList(content: string): boolean {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => /^[^:\n]+:\d+(:|$)/.test(line));
}

/**
 * Decide the rendering target for a tool result.
 *
 * Dispatch is deliberately exact-case (not lowercased) so a future
 * tool with a similar name doesn't accidentally inherit a routed
 * renderer. Each routed tool also requires its specific envelope
 * tag in the joined content (produced by
 * `session-transcript.formatStructuredToolResult`); bare-string results
 * (compatibility or error-path) always fall through to the generic renderer.
 *
 * The `<tool-error>` envelope is the cross-cutting error path —
 * dispatched regardless of tool name when the migrated renderer
 * paths a tool result through the error message channel. This is the
 * structured replacement for `FallbackToolUseErrorMessage`
 * fallback.
 */
export function pickToolResultDispatch(
  toolName: string,
  joinedContent: string,
): ToolResultDispatchTarget {
  // Error envelope is checked first and is tool-name-agnostic — any
  // tool that reports its result via the error channel renders through
  // the same structured error view.
  if (joinedContent.includes("<tool-error>")) {
    return "tool-error-view";
  }
  // -------------------------------------------------------------------------
  // Tagged-envelope paths (produced by
  // `session-transcript.formatStructuredToolResult` when the daemon emits a
  // structured `*_end` event). Kept for backward/forward compatibility.
  // -------------------------------------------------------------------------
  if (
    (toolName === BASH_TOOL_NAME_FOR_DISPATCH ||
      toolName === EXEC_COMMAND_TOOL_NAME_FOR_DISPATCH) &&
    joinedContent.includes("<bash-stdout>")
  ) {
    return "bash-output-view";
  }
  if (
    toolName === EDIT_TOOL_NAME_FOR_DISPATCH &&
    joinedContent.includes("<edit-diff>")
  ) {
    return "edit-diff-view";
  }
  if (
    toolName === FILE_READ_TOOL_NAME_FOR_DISPATCH &&
    joinedContent.includes("<read-content>")
  ) {
    return "file-read-view";
  }
  if (
    toolName === FILE_WRITE_TOOL_NAME_FOR_DISPATCH &&
    joinedContent.includes("<write-summary>")
  ) {
    return "file-write-view";
  }
  if (
    toolName === GREP_TOOL_NAME_FOR_DISPATCH &&
    joinedContent.includes("<grep-matches>")
  ) {
    return "grep-matches-view";
  }
  if (
    toolName === GLOB_TOOL_NAME_FOR_DISPATCH &&
    joinedContent.includes("<glob-paths>")
  ) {
    return "glob-paths-view";
  }
  // -------------------------------------------------------------------------
  // LIVE raw-string paths. The running daemon sends tool results as plain
  // strings WITHOUT any envelope tags (confirmed against session rollouts), so
  // the routing must recognize the actual shapes the daemon emits.
  // -------------------------------------------------------------------------
  if (
    toolName === BASH_TOOL_NAME_FOR_DISPATCH ||
    toolName === EXEC_COMMAND_TOOL_NAME_FOR_DISPATCH
  ) {
    if (EXEC_TRAILER_RE.test(joinedContent)) {
      return "bash-output-view";
    }
  }
  if (toolName === FILE_READ_TOOL_NAME_FOR_DISPATCH) {
    if (FILE_READ_LINE_RE.test(joinedContent)) {
      return "file-read-view";
    }
  }
  if (toolName === GREP_TOOL_NAME_FOR_DISPATCH) {
    if (GREP_FOUND_RE.test(joinedContent) || isGrepMatchList(joinedContent)) {
      return "grep-matches-view";
    }
  }
  // Edit/MultiEdit/Write success: the result has NO diff data — the compact
  // diff is rendered from the tool-use INPUT on the call row instead. Suppress
  // the redundant "updated successfully" body so the result shows once (the
  // diff), not twice. Failed edits do NOT match this and still render their
  // error through the generic/error path (P0).
  if (
    toolName === EDIT_TOOL_NAME_FOR_DISPATCH ||
    toolName === "MultiEdit" ||
    toolName === FILE_WRITE_TOOL_NAME_FOR_DISPATCH
  ) {
    const trimmed = joinedContent.trim();
    if (EDIT_SUCCESS_RE.test(trimmed) || WRITE_SUCCESS_RE.test(trimmed)) {
      return "suppress";
    }
  }
  return "generic";
}

/**
 * Collapse a tool result content value into a flat string for tag
 * extraction and fallback rendering. Mirrors the existing
 * `resultText` helper in `tool-rendering.tsx` (kept in sync by hand;
 * see test coverage).
 */
function shortJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 140) return text;
    return `${text.slice(0, 137)}...`;
  } catch {
    return String(value);
  }
}

function isStructuredTextBlock(
  item: unknown,
): item is { readonly type: "text"; readonly text: string } {
  return (
    isRecord(item) &&
    item.type === "text" &&
    typeof item.text === "string"
  );
}

export function resultTextForTuiTool(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    // Structured-content-block array shape (the shape that
    // `session-transcript.formatStructuredToolResult` produces). Flatten
    // by joining the `.text` fields with newlines so tag-extraction
    // helpers see one continuous string with the tool envelope.
    if (value.length > 0 && value.every(isStructuredTextBlock)) {
      return value
        .map((item) => (item as { readonly text: string }).text)
        .join("\n");
    }
    return value.map(resultTextForTuiTool).join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.content === "string") return value.content;
    if (
      Array.isArray(value.content) &&
      value.content.every(isStructuredTextBlock)
    ) {
      return value.content
        .map((item) => (item as { readonly text: string }).text)
        .join("\n");
    }
  }
  return shortJson(value);
}
