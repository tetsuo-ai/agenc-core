import type { LLMTool } from "../llm/types.js";

/** Presentation only; canonical validation and execution stay intact. */
const PRESENTATIONS: Readonly<Record<string, string>> = {
  FileRead: "Read files. offset/limit are 1-indexed lines; display numbers may be sparse. PDFs over 10 pages require pages (max 20).",
  MultiEdit: "Batch exact replacements in one file, applied in order and written atomically. FileRead existing files first; shell reads do not count. Keep old_string small and unique, or set replace_all. Exclude display numbers. Create a new file with one edit: old_string empty, new_string is its content.",
  Edit: "Replace unique old_string (or replace_all) after FileRead. Exclude display numbers.",
  Write: "Write content; FileRead existing files first.",
  Grep: "Search file contents with ripgrep regex. Defaults to matching file paths; use output_mode content for lines. Escape literal regex metacharacters. Ignored/build files are excluded unless includeIgnored.",
  Glob: "Find file paths by glob pattern, sorted by modification time. Skips ignored/build/vendor files and lockfiles unless includeIgnored.",
  exec_command: "Run cmd in workdir. Time fields are milliseconds. Running commands load write_stdin for polling; load kill_process to stop. Child processes stop on exit unless detach; tty allows input.",
  write_stdin: "Poll a running exec_command session with chars empty, or send input if it started with tty=true. Use the same sandbox_permissions as the originating command.",
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

export function lightToolPresentation(tool: LLMTool): LLMTool {
  const presentation = PRESENTATIONS[tool.function.name];
  if (presentation === undefined) return tool;
  return { ...tool, function: { ...tool.function, description: presentation,
    parameters: compactSchema(tool.function.parameters) as LLMTool["function"]["parameters"] } };
}
