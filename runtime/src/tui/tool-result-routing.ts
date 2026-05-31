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
  | "generic";

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
  return "generic";
}

/**
 * Collapse a tool result content value into a flat string for tag
 * extraction and fallback rendering. Mirrors the existing
 * `resultText` helper in `tool-rendering.tsx` (kept in sync by hand;
 * see test coverage).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
