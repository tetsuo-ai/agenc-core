import type { LLMTool } from "../llm/types.js";

const summaries: Readonly<Record<string, string>> = {
  FileRead: "Read and refresh for edits. offset: line 1 onward; limit: 120 lines.",
  MultiEdit: "Replace exact text after FileRead; preserve surrounding code. Group same-file changes; submit independent files together. Create: old_string empty, new_string entire content.",
  exec_command: "Workspace shell; 30s wait, 700-token output. Continue session_id with write_stdin.",
  write_stdin: "Send chars or wait 30s for output, bounded to 700 tokens.",
  "system.searchTools": "Find additional capabilities. Listed tools are ready to use. select: extra tool name; query: capability search.",
};

const initialFields: Readonly<Record<string, readonly string[]>> = {
  FileRead: ["file_path", "offset", "limit"],
  exec_command: ["cmd", "workdir", "max_output_tokens"],
  write_stdin: ["session_id", "chars"],
  "system.searchTools": ["select", "query"],
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
        // Required fields follow the declared contract: choose the file, then
        // the old text, then its replacement. Optional fields remain sorted.
        const required = key === "properties" && Array.isArray((value as Record<string, unknown>).required)
          ? (value as { required: unknown[] }).required : [];
        const rank = (name: string) => { const i = required.indexOf(name); return i < 0 ? required.length : i; };
        return [key, Object.fromEntries(Object.entries(item).sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, child]) => [name, compactLightSchema(child)]))];
      }
      return [key, compactLightSchema(item, schema && schemaValues.has(key))];
    }));
}

/** Only presentation changes. The registry dispatches the original tool. */
export function lightPresentation(tool: LLMTool, expanded = false): LLMTool {
  const description = summaries[tool.function.name];
  if (description === undefined) return tool;
  const parameters = compactLightSchema(tool.function.parameters) as LLMTool["function"]["parameters"];
  const fields = expanded ? undefined : initialFields[tool.function.name];
  const properties = parameters.properties as Record<string, unknown> | undefined;
  const selected = fields && properties ? Object.fromEntries(fields
    .filter(name => properties[name] !== undefined)
    .map(name => {
      // Explicit discovery reveals every accepted alternative and extra field.
      const field = properties[name] as { anyOf?: Array<Record<string, unknown>> };
      const preferred = field.anyOf?.find(value => value.type === (name === "select" ? "string" : "number"));
      return [name, preferred ?? field];
    })) : properties;
  return {
    ...tool,
    function: {
      ...tool.function,
      description,
      parameters: selected ? { ...parameters, properties: selected } : parameters,
    },
  };
}
