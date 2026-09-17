/**
 * File-tool path copy and TUI display.
 *
 * `/root` is the agent-tree address prefix in agent-control APIs
 * (`assertValidAgentPath`). File tools take filesystem paths: an absolute
 * Linux path under `/root` is a file, not an agent address. Do not classify
 * `file_path` by string prefix.
 */

export const FILE_TOOL_PATH_USAGE =
  "Use workspace-relative paths like `game.py` unless the user provided a real absolute path. Absolute Linux paths under `/root` are filesystem paths. Agent-tree identifiers such as `/root/task1` belong to agent-control APIs, not file tools.";

export const FILE_TOOL_PATH_SCHEMA =
  "Workspace-relative path, or a real absolute filesystem path. `/root/...` is a valid Linux filesystem path when it refers to a file. Agent-tree identifiers such as `/root/task1` belong to agent-control APIs, not file tools.";

export function formatToolPathForDisplay(path: string): string {
  return path;
}
