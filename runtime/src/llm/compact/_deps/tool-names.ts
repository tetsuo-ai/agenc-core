/**
 * Tool name constants used by compact prompts.
 *
 * Values match the gut runtime tool registry at `src/tools/system/`:
 * filesystem.ts registers `system.readFile`/`system.writeFile`/etc.,
 * coding.ts registers `system.glob`/`system.grep`. The compact prompt
 * references these names so the model knows which tools are available
 * after compaction.
 */

export const FILE_READ_TOOL_NAME = "system.readFile";
export const FILE_WRITE_TOOL_NAME = "system.writeFile";
export const FILE_EDIT_TOOL_NAME = "system.editFile";
export const GLOB_TOOL_NAME = "system.glob";
export const GREP_TOOL_NAME = "system.grep";
export const NOTEBOOK_EDIT_TOOL_NAME = "system.editFile";
export const WEB_FETCH_TOOL_NAME = "system.httpFetch";
export const WEB_SEARCH_TOOL_NAME = "system.httpFetch";
export const SHELL_TOOL_NAMES: readonly string[] = ["system.bash"];

export const FILE_UNCHANGED_STUB =
  "File unchanged since last read. The content from the earlier system.readFile tool_result in this conversation is still current — refer to that instead of re-reading.";
