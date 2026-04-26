/**
 * Tool name constants used by compact prompts.
 *
 * Values match AgenC's first-class openclaude-derived file/search tools.
 * The compact prompt references these names so the model knows which tools
 * are available after compaction.
 */

export const FILE_READ_TOOL_NAME = "FileRead";
export const FILE_WRITE_TOOL_NAME = "Write";
export const FILE_EDIT_TOOL_NAME = "Edit";
export const GLOB_TOOL_NAME = "Glob";
export const GREP_TOOL_NAME = "Grep";
export const NOTEBOOK_EDIT_TOOL_NAME = "Edit";
export const WEB_FETCH_TOOL_NAME = "system.httpFetch";
export const WEB_SEARCH_TOOL_NAME = "system.httpFetch";
export const SHELL_TOOL_NAMES: readonly string[] = ["system.bash"];

export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier FileRead tool_result in this conversation is still current — refer to that instead of re-reading.";
