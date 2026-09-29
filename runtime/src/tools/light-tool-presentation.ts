import type { LLMTool } from "../llm/types.js";

/** Presentation only; canonical validation and execution stay intact. */
const PRESENTATIONS: Readonly<Record<string, string>> = {
  FileRead: "Read files. Text defaults to 200 lines; offset is 1-indexed and limit is a line count. Display numbers may be sparse. PDFs over 10 pages require pages (max 20).",
  MultiEdit: "FileRead existing files first; shell reads do not count. Batch small, unique replacements applied in order; replace_all allows repeats. New file: one edit, old_string empty.",
  Edit: "Replace unique old_string (or replace_all) after FileRead. Exclude display numbers.",
  Write: "Write content; FileRead existing files first.",
  Grep: "Search file contents with ripgrep regex. Defaults to matching file paths; use output_mode content for lines. Escape literal regex metacharacters. Ignored/build files are excluded unless includeIgnored.",
  Glob: "Find file paths by glob pattern, sorted by modification time. Skips ignored/build/vendor files and lockfiles unless includeIgnored.",
  exec_command: "Run cmd in workdir. Time fields are milliseconds. Output is bounded. Running commands load write_stdin for polling.",
  write_stdin: "Output defaults to 1000 tokens; max_output_tokens overrides. Poll a running exec_command session with chars empty, or send input if it started with tty=true. Use the same sandbox_permissions as the originating command.",
  "system.searchTools": "Query/select tools; unique matches load. instructions loads guidance.",
};

/** Only JSON Schema prose is removed. Constraints, extensions and canonical tools stay intact. */
function compactSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const result = { ...schema } as Record<string, unknown>;
  delete result.description;
  if (result.properties && typeof result.properties === "object") {
    result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, compactSchema(value)]));
  }
  if (result.items) result.items = compactSchema(result.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(result[key])) result[key] = result[key].map(compactSchema);
  }
  return result;
}

export function lightToolPresentation(tool: LLMTool, extended = false): LLMTool {
  const presentation = PRESENTATIONS[tool.function.name];
  if (presentation === undefined) return tool;
  const parameters = compactSchema(tool.function.parameters) as LLMTool["function"]["parameters"];
  if (tool.function.name === "exec_command" && !extended) {
    // Advanced execution and escalation fields remain canonical and load after
    // discovery or a denial. Admission, sandboxing and receipts are unchanged.
    const properties = parameters.properties as Record<string, unknown> | undefined;
    return { ...tool, function: { ...tool.function, description: presentation,
      parameters: { ...parameters, properties: Object.fromEntries(
        ["cmd", "workdir", "timeoutMs", "yield_time_ms", "max_output_tokens"]
          .filter(key => properties?.[key] !== undefined).map(key => [key, properties![key]]),
      ) } } };
  }
  return { ...tool, function: { ...tool.function, description: presentation, parameters } };
}
