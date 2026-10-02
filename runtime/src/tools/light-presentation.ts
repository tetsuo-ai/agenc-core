import type { LLMTool } from "../llm/types.js";

// Presentation only. Every field, alternative, default and validation keyword
// remains on the wire; execution and discovery retain the canonical tool.
const descriptions: Readonly<Record<string, string>> = {
  FileRead: "Read files, images/screenshots, PDFs or notebooks; refreshes edit authorization. Prefer targeted offset/limit windows (default 2000 lines, 25000-token cap). Sparse line numbers are display only; dense_line_numbers numbers every line. PDFs over 10 pages require pages; at most 20 pages/read. Empty files return a reminder. Cannot read directories. Successful edits need no confirming reread.",
  Edit: "After FileRead of this file, replace exact text. Use the shortest unique old_string and replacement fragment; omit unchanged context and display line numbers, preserve indentation. replace_all changes every occurrence. Prefer existing files; create only as required. Use emojis only if requested.",
  Write: "Create a file or deliberately replace its full content. Existing files require FileRead first. Prefer Edit for partial changes to avoid repeating unchanged content. Create documentation or use emojis only if requested.",
  exec_command: "Run workspace shell commands for inspection, tests and builds. Use Edit/Write for source edits; rm/mv for deletion/renaming. Call tools directly, never print placeholders/commentary. Omit default workdir; batch independent bounded reads. A yielded session_id continues with write_stdin and stops with kill_process. Do not use trailing &: leftover processes are stopped on return, yielded processes at session end. detach starts a lasting service (danger-full-access only; no tty).",
  write_stdin: "Continue a live exec_command session. Empty chars polls any session; nonempty input requires tty=true at creation. Include newlines for shell commands. Match the session's sandbox_permissions.",
  Glob: "Find files by glob, sorted by modification time. Defaults to workspace root; skips gitignored/build/vendor output unless includeIgnored=true.",
  Grep: "Search file contents with packaged ripgrep regex; use this tool instead of shell grep/rg. Escape literal braces. Default files_with_matches returns paths; content returns lines; count returns counts. Context and line-number options apply only to content. multiline enables cross-line matches and dot-all. Skips ignored/build/vendor output unless includeIgnored=true. If packaged ripgrep is unavailable, use agenc doctor and reinstall the same version; no fallback.",
  "system.searchTools": "Find tools by name, family, source, keyword or profile. Listed tools are ready. select (or query select:<name>) loads exact names and returns their schemas; selection alone returns selected tools or scoped suggestions. Use query/filters for broader search.",
};

const path = "Workspace-relative path preferred; real absolute filesystem paths accepted. Agent-tree identifiers are not file paths.";
const fieldHints: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FileRead: { file_path: path, offset: "First line, 1-based; numeric strings accepted.", limit: "Maximum lines; numeric strings accepted.", pages: "PDF page range, e.g. 1-5.", dense_line_numbers: "Number every line (default false)." },
  Edit: { file_path: path, old_string: "Exact unique match, unless replace_all.", new_string: "Replacement fragment.", replace_all: "Replace every match (default false)." },
  Write: { file_path: path, content: "Complete file content." },
  exec_command: {
    cmd: "Shell command; MCP names are tool calls, not shell commands.", workdir: "Defaults to workspace root.",
    timeoutMs: "Hard timeout in ms; use yield_time_ms to keep long commands alive.",
    yield_time_ms: "Wait in ms before returning; a live process returns session_id.",
    max_output_tokens: "Output cap; truncates head/tail.", login: "Use a login shell where supported.",
    shell: "Executable; defaults to user's shell.",
    // tty, detach and permission fields keep all canonical restrictions.
  },
  write_stdin: { session_id: "Live exec_command session_id.", chars: "Input; empty string polls.", yield_time_ms: "Wait for output in ms.", max_output_tokens: "Output token cap." },
  Glob: { pattern: "File glob, e.g. src/**/*.ts.", path: "Search directory; default workspace root.", includeIgnored: "Include gitignored/build/vendor files (default false)." },
  Grep: {
    pattern: "Ripgrep regex.", path: "File/directory; default cwd.", glob: "File filter (rg --glob).", type: "File type (rg --type), e.g. py.",
    output_mode: "Default files_with_matches.", "-A": "Content: lines after match.", "-B": "Content: lines before match.", "-C": "Content: lines around match.",
    "-n": "Content: line numbers (default true).", "-i": "Case-insensitive.",
    head_limit: "First N lines/entries (default 250); 0 removes pagination, not safety ceilings.",
    offset: "Skip N lines/entries before head_limit (default 0).", multiline: "Cross-line/dot-all matching (default false).",
    includeIgnored: "Include gitignored/build/vendor files (default false).",
  },
  "system.searchTools": { query: "Search terms; select:<name> loads a tool.", select: "Exact tool name(s) to load." },
};

/** Adapt the earlier Light summaries without hiding accepted arguments. */
export function lightPresentation(tool: LLMTool): LLMTool {
  const description = descriptions[tool.function.name];
  if (description === undefined) return tool;
  const hints = fieldHints[tool.function.name] ?? {};
  const parameters = tool.function.parameters;
  const properties = parameters.properties as Record<string, unknown> | undefined;
  return {
    ...tool,
    function: {
      ...tool.function, description,
      parameters: properties ? {
        ...parameters,
        properties: Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name,
          hints[name] !== undefined && schema !== null && typeof schema === "object" && !Array.isArray(schema)
            ? { ...schema, description: hints[name] } : schema,
        ])),
      } : parameters,
    },
  };
}
