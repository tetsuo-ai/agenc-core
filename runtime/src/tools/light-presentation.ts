import type { LLMTool } from "../llm/types.js";

const summaries: Readonly<Record<string, string>> = {
  exec_command: "Execute a command in the workspace shell. Supports reading, searching, writing files and running checks. cmd is required; workdir changes directory. Output defaults to 1500 tokens; max_output_tokens overrides it. A returned session_id means the command is still running: continue with write_stdin. Waits up to 30 seconds for the process exit event; yield_time_ms overrides waiting, timeout_ms sets the command deadline. Oversized collected output has a file reference. Detached services require detach and runtime authorization.",
  write_stdin: "Continue a running command by session_id. Omit chars to collect output, or supply input bytes. Waits for the process exit event, up to 30 seconds by default; yield_time_ms overrides waiting; max_output_tokens overrides the 1500-token output allowance.",
  "system.searchTools": "Find or load additional AgenC capabilities. select accepts an exact tool name (for example TodoWrite for planning); query searches names and descriptions. Call a selected tool once its schema appears. maxResults limits search matches.",
};

const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaValues = new Set(["items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keep data values and property names intact while normalizing schema keywords. */
export function compactLightSchema(value: unknown, schema = true): unknown {
  if (Array.isArray(value)) return value.map(item => compactLightSchema(item, schema));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([key]) => !schema || key !== "description")
    .map(([key, item]) => {
      if (schema && schemaMaps.has(key) && item !== null && typeof item === "object" && !Array.isArray(item)) {
        return [key, Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([name, child]) => [name, compactLightSchema(child)]))];
      }
      return [key, compactLightSchema(item, schema && schemaValues.has(key))];
    }));
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
      parameters: compactLightSchema(tool.function.parameters) as LLMTool["function"]["parameters"],
    },
  };
}
