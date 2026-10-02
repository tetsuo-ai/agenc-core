import type { LLMTool } from "../llm/types.js";

// Presentation only. Every field, alternative, default and validation keyword
// remains on the wire; execution and discovery retain the canonical tool.
const descriptions: Readonly<Record<string, string>> = {
  FileRead: "Read text, images/screenshots, PDFs or notebooks, authorizing edits. Prefer offset/limit windows; default 2000 lines, cap 25000 tokens. Sparse numbers are display only; dense_line_numbers numbers every line. PDFs >10 pages require pages, maximum 20/read. Empty files yield a reminder; directories fail. Successful edits need no reread.",
  Edit: "Requires FileRead first. Replace the shortest unique old_string with new_string, preserving indentation and omitting unchanged context/display numbers. replace_all changes every match. Prefer existing files; create only as required. Emojis only on request.",
  Write: "Create or replace a whole file; existing files require FileRead first. Use Edit for partial changes. Documentation and emojis only on request.",
  exec_command: "Workspace shell for inspection/tests/builds; Edit/Write for source changes, rm/mv to delete/rename. Call tools directly; no printed placeholders/commentary. Batch bounded independent reads. Yielded session_id exposes write_stdin; kill_process stops it. No trailing &: leftovers stop on return, yielded processes at session end. Lasting services need detach (danger-full-access, no tty).",
  write_stdin: "Continue exec_command's session_id. Empty chars polls; input requires initial tty=true. Include command newlines; match the session's sandbox_permissions.",
  Glob: "Find file paths by glob, newest modification first. Skip gitignored/build/vendor files unless includeIgnored=true.",
  Grep: "Search with packaged ripgrep, not shell grep/rg; escape literal braces. output_mode: files_with_matches (default paths), content (lines), count. Context/line numbers apply to content. multiline matches across lines with dot-all. Skip ignored/build/vendor files unless includeIgnored=true. Missing ripgrep: agenc doctor, reinstall same version; no fallback.",
  "system.searchTools": "Find tools by name/family/source/keyword/profile. Listed tools are ready. select or query select:<name> loads exact schemas; select alone returns tools or scoped suggestions. query/filters search broadly.",
};

const path = "Filesystem path, preferably workspace-relative; absolute accepted. Not an agent-tree ID.";
const fieldHints: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  FileRead: { file_path: path, offset: "1-based line; numeric strings accepted.", limit: "Line limit; numeric strings accepted.", pages: "PDF pages, e.g. 1-5.", dense_line_numbers: "Number each line; default false." },
  Edit: { file_path: path, old_string: "Unique exact text unless replace_all.", new_string: "Replacement text.", replace_all: "All matches; default false." },
  Write: { file_path: path, content: "Complete file content." },
  exec_command: {
    cmd: "Command; call MCP tools directly.", workdir: "Default: workspace root.",
    timeoutMs: "Hard timeout (ms); yield_time_ms keeps processes alive.",
    yield_time_ms: "Wait ms; live processes return session_id.",
    max_output_tokens: "Token cap; head/tail truncation.", login: "Login shell, if supported.",
    shell: "Executable; default user's shell.",
    // tty, detach and permission fields keep all canonical restrictions.
  },
  write_stdin: { session_id: "exec_command session_id.", chars: "Input; empty polls.", yield_time_ms: "Wait ms.", max_output_tokens: "Output token cap." },
  Glob: { pattern: "Glob, e.g. src/**/*.ts.", path: "Directory; default workspace root.", includeIgnored: "Include ignored files; default false." },
  Grep: {
    pattern: "Regex.", path: "File/directory; default cwd.", glob: "rg --glob filter.", type: "rg --type, e.g. py.",
    output_mode: "Default: files_with_matches.", "-A": "Lines after match.", "-B": "Lines before match.", "-C": "Lines around match.",
    "-n": "Line numbers; default true.", "-i": "Ignore case.",
    head_limit: "Lines/entries, default 250; 0 unpaginates, preserving safety ceilings.",
    offset: "Skip N before head_limit; default 0.", multiline: "Cross-line/dot-all; default false.",
    includeIgnored: "Include ignored files; default false.",
  },
  "system.searchTools": { query: "Terms or select:<name>.", select: "Exact name(s) to load." },
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
