import type { LLMTool } from "../llm/types.js";

const summaries: Readonly<Record<string, string>> = {
  FileRead: "Inspect a workspace file and register its current version for editing. file_path identifies it; offset is a line number starting at 1, limit is the number of lines. Text defaults to 120 lines. Use focused ranges around search matches. Line labels are display annotations. pages selects PDF pages; images and notebooks are supported.",
  MultiEdit: "Apply a batch to file_path after FileRead. Each edits entry supplies old_string and new_string; old text must identify one location unless replace_all is true. Edits are checked in order against the evolving text, then committed together. Omit displayed line labels. Create a missing file with one entry whose old_string is empty. After another mutation, refresh with FileRead before the next batch.",
  exec_command: "Execute a command in the workspace shell for searches and checks. cmd is required; workdir changes directory. Output defaults to 700 tokens; max_output_tokens overrides it. A returned session_id means the command is still running: continue with write_stdin. Waits up to 30 seconds for the process exit event; yield_time_ms overrides waiting, timeout_ms sets the command deadline. Oversized collected output has a file reference. Detached services require detach and runtime authorization.",
  write_stdin: "Continue a running command by session_id. Omit chars to collect output, or supply input bytes. Waits for the process exit event, up to 30 seconds by default; yield_time_ms overrides waiting; max_output_tokens overrides the 700-token output allowance.",
  "system.searchTools": "Catalog loader for additional AgenC tools. Check here before declaring a requested capability unavailable. For a planning-tool request, call this function with select set to TodoWrite, then invoke the loaded tool. select also accepts other exact tool names; query searches names and descriptions and loads a single exact tool name mentioned in it. maxResults bounds search matches.",
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
