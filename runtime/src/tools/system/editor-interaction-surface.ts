import { EDITOR_PROPOSAL_TOOL_NAME } from "./editor-proposal.js";
import { FILE_READ_TOOL_NAME } from "./file-read.js";
import { GLOB_TOOL_NAME } from "./glob.js";
import { GREP_TOOL_NAME } from "./grep.js";
import { ORIENT_TOOL_NAME } from "./orient.js";

/**
 * Runtime-owned tools that may cross the request-scoped Editor boundary.
 *
 * These names are reserved by the production registry. A plugin, MCP tool,
 * dynamic tool, or caller-supplied model-facing tool may not replace their
 * specs: Editor authorization relies on the exact built-in object identity,
 * not on forgeable metadata.
 */
export const EDITOR_INTERACTION_READ_TOOL_NAMES = [
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  ORIENT_TOOL_NAME,
] as const;

export const EDITOR_INTERACTION_TOOL_NAMES = [
  ...EDITOR_INTERACTION_READ_TOOL_NAMES,
  EDITOR_PROPOSAL_TOOL_NAME,
] as const;

export type EditorInteractionToolName =
  (typeof EDITOR_INTERACTION_TOOL_NAMES)[number];

const EDITOR_INTERACTION_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  EDITOR_INTERACTION_TOOL_NAMES,
);

export function isEditorInteractionToolName(
  name: string,
): name is EditorInteractionToolName {
  return EDITOR_INTERACTION_TOOL_NAME_SET.has(name);
}
