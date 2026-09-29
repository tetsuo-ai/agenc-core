import type { LLMTool } from "../llm/types.js";

const summaries: Readonly<Record<string, string>> = {
  exec_command: "Execute a command in the workspace shell. Supports reading, searching, writing files and running checks. cmd is required; workdir changes directory. Output defaults to 1500 tokens; max_output_tokens overrides it. A returned session_id means the command is still running: continue with write_stdin. yield_time_ms controls the initial wait, timeout_ms the deadline. Detached services require detach and runtime authorization.",
  write_stdin: "Continue a running command by session_id. Omit chars to collect output, or supply input bytes. yield_time_ms controls waiting; max_output_tokens overrides the 1500-token output allowance.",
  "system.searchTools": "Find or load additional AgenC capabilities. select accepts an exact tool name (for example TodoWrite for planning); query searches names and descriptions. Call a selected tool once its schema appears. maxResults limits search matches.",
};

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description")
    .map(([key, item]) => [key, withoutDescriptions(item)]));
}

/** Only presentation changes. The registry dispatches the original tool. */
export function lightPresentation(tool: LLMTool): LLMTool {
  const description = summaries[tool.function.name];
  if (description === undefined) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      description,
      parameters: withoutDescriptions(tool.function.parameters) as LLMTool["function"]["parameters"],
    },
  };
}
