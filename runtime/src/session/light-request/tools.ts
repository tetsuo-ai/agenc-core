import { leanToolDefinition } from "./definitions.js";
import type { LightRequestOptions } from "../../config/schema.js";
import type { LLMTool } from "../../llm/types.js";
import type { Tool } from "../../tools/types.js";

const CORE = new Set(["exec_command", "FileRead", "Write", "apply_patch"]);
const PROCESS = new Set(["write_stdin", "kill_process"]);
// Explicitly activated features remain usable, including interactive planning.
const INTERACTIVE = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);
/** edit_mode = "shell": the file-writing tools leave the list and the shell line says how files are written. */
const SHELL_EDIT_HIDDEN = new Set(["Write", "apply_patch"]);
export const SHELL_EDIT_SENTENCE = "Create and edit files with shell commands. One command may write files and run the check together.";

export function leanLightTools(
  tools: readonly LLMTool[],
  options: Required<LightRequestOptions>,
  canonical: readonly Tool[] = [],
  discovered: ReadonlySet<string> = new Set(),
): readonly LLMTool[] {
  const shell = options.edit_mode === "shell";
  return tools.filter(tool => {
    const name = tool.function.name;
    if (shell && SHELL_EDIT_HIDDEN.has(name)) return false;
    if (name === "system.searchTools") return options.tool_search;
    if (PROCESS.has(name)) return options.process_tools;
    return !options.core_tools_only || CORE.has(name) || discovered.has(name) || INTERACTIVE.has(name);
  }).map(tool => {
    const name = tool.function.name;
    const definition = canonical.find(candidate => candidate.name === name);
    const presented = leanToolDefinition(tool, definition, options.compact_tool_definitions);
    if (name !== "exec_command") return presented;
    const description = !options.process_tools
      ? "Run a foreground shell command and return output and exit status. Process tools are disabled: no background, detach or tty; commands stop after at most 29 seconds. Enable light_request_options.process_tools for long commands."
      : presented.function.description;
    return description === presented.function.description && !shell ? presented
      : { ...presented, function: { ...presented.function,
          description: shell ? `${description} ${SHELL_EDIT_SENTENCE}` : description } };
  });
}

/** No poll tool means no inaccessible background session may escape a call. */
export const LEAN_FOREGROUND_TIMEOUT_MS = 29_000;
