import { leanToolDefinition } from "./definitions.js";
import type { LightRequestOptions } from "../../config/schema.js";
import type { LLMTool } from "../../llm/types.js";
import type { Tool } from "../../tools/types.js";

const CORE = new Set(["exec_command", "FileRead", "Write", "apply_patch"]);
const PROCESS = new Set(["write_stdin", "kill_process"]);
// Explicitly activated features remain usable, including interactive planning.
const INTERACTIVE = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);

export function leanLightTools(
  tools: readonly LLMTool[],
  options: Required<LightRequestOptions>,
  canonical: readonly Tool[] = [],
  discovered: ReadonlySet<string> = new Set(),
): readonly LLMTool[] {
  return tools.filter(tool => {
    const name = tool.function.name;
    if (name === "system.searchTools") return options.tool_search;
    if (PROCESS.has(name)) return options.process_tools;
    return !options.core_tools_only || CORE.has(name) || discovered.has(name) || INTERACTIVE.has(name);
  }).map(tool => {
    const name = tool.function.name;
    const definition = canonical.find(candidate => candidate.name === name);
    const presented = leanToolDefinition(tool, definition, options.compact_tool_definitions);
    return name === "exec_command" && !options.process_tools
      ? { ...presented, function: { ...presented.function,
          description: "Run a foreground shell command and return output and exit status. Process tools are disabled: no background, detach or tty; commands stop after at most 29 seconds. Enable light_request_options.process_tools for long commands.",
        } }
      : presented;
  });
}

/** No poll tool means no inaccessible background session may escape a call. */
export const LEAN_FOREGROUND_TIMEOUT_MS = 29_000;
