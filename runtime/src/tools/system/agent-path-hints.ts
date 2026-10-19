/**
 * File-tool path copy and TUI display.
 *
 * `/root` is the agent-tree address prefix in agent-control APIs
 * (`assertValidAgentPath`). File tools take filesystem paths: an absolute
 * Linux path under `/root` is a file, not an agent address. Do not classify
 * `file_path` by string prefix.
 */
import { isAbsolute, relative, sep } from "node:path";
import { abbreviateHomePaths } from "../../utils/home-path-display.js";

export const FILE_TOOL_PATH_USAGE =
  "Use workspace-relative paths like `game.py` unless the user provided a real absolute path. Absolute Linux paths under `/root` are filesystem paths. Agent-tree identifiers such as `/root/task1` belong to agent-control APIs, not file tools.";

export const FILE_TOOL_PATH_SCHEMA =
  "Workspace-relative or absolute path. `/root/...` is a valid Linux filesystem path; agent-tree IDs such as `/root/task1` are not files.";

export function formatToolPathForDisplay(path: string): string {
  return abbreviateHomePaths(path);
}

/** Presentation only: leave validation and canonical paths untouched. */
export function workspaceRelativeToolPath(path: string, workspaceRoot: string | undefined, lightMode: boolean): string {
  if (!lightMode || !workspaceRoot || !isAbsolute(path)) return path;
  const rel = relative(workspaceRoot, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel : path;
}
