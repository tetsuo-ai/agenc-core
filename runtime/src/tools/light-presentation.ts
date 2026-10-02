import type { LLMTool } from "../llm/types.js";

// Presentation only. Every field, alternative, default and validation keyword
// remains on the wire; execution and discovery retain the canonical tool.
// null removes only a redundant property description, never its schema.
const descriptions: Readonly<Record<string, string>> = {
  FileRead: "Read text/images/PDFs/notebooks; authorizes edits. Prefer 1-based offset/limit line windows: default 2000 lines, cap 25000 tokens. Display-only numbers are sparse unless dense_line_numbers. PDFs >10 pages require pages (e.g. 1-5), max 20/read. Empty files warn; directories fail. Successful edits need no reread.",
  Edit: "FileRead first. Replace shortest unique exact old_string with new_string, preserving indentation, omitting unchanged context/display numbers. replace_all replaces every match (default false). Prefer existing files; create only as needed. Emojis only on request.",
  Write: "Create/replace complete files; existing files require FileRead first. Use Edit for partial changes. Documentation/emojis only on request.",
  exec_command: "Workspace inspection/tests/builds; source changes require Edit/Write, delete/rename use rm/mv. Call tools directly, not printed placeholders/commentary. Batch bounded independent reads. Yielded session_id exposes write_stdin; kill_process stops it. No trailing &: leftovers stop on return, yielded processes at session end. Lasting services need detach.",
  write_stdin: "Continue exec_command's session_id. Empty chars polls; input requires initial tty=true. Include command newlines; match the session's sandbox_permissions.",
  Glob: "Find file paths by glob, newest modification first. Skip gitignored/build/vendor files unless includeIgnored=true.",
  Grep: "Search with packaged ripgrep, not shell grep/rg; escape literal braces. output_mode: files_with_matches (default paths), content (lines), count. Context/line numbers apply to content. multiline matches across lines with dot-all. Skip ignored/build/vendor files unless includeIgnored=true. Missing ripgrep: agenc doctor, reinstall same version; no fallback.",
  "system.searchTools": "Find by name/family/source/keyword/profile. Listed tools are ready. select or query select:<name> loads schemas; selection alone returns selected tools/scoped suggestions, query/filters search broadly.",
};

const path = "Workspace/absolute path; not an agent-tree ID.";
const fieldHints: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  FileRead: { file_path: path, offset: null, limit: null, pages: null, dense_line_numbers: null },
  Edit: { file_path: path, old_string: null, new_string: null, replace_all: null },
  Write: { file_path: path, content: null },
  exec_command: {
    cmd: null, workdir: "Default: workspace root.", timeoutMs: "Hard timeout, ms.",
    yield_time_ms: "Wait ms; live processes return session_id.",
    max_output_tokens: "Token cap; head/tail truncation.",
    login: "Login shell if supported.", shell: "Default: user's shell.",
    tty: "Interactive PTY, required for persistent shells/write_stdin input. Unavailable in contained operations: use tty=false and non-interactive flags, or ask the user to use the app's Run button.",
    detach: "Service in its own session; stdout/stderr logged. AgenC never stops it; survives command/session end. Wait yield_time_ms (default 2000) for early exit; return pid/log path. Only danger-full-access (--dangerously-bypass-approvals-and-sandbox), never tty.",
    sandbox_permissions: "Escalation mode; scoped requests use additional_permissions.",
    additional_permissions: 'Request these scopes with sandbox_permissions="with_additional_permissions".',
    justification: "Why elevated execution is needed.",
    prefix_rule: "Command prefix for approval caching.",
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
  "system.searchTools": { query: null, select: null },
};

function presentProperty(schema: unknown, hint: string | null | undefined): unknown {
  if (hint === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (hint !== null) return { ...schema, description: hint };
  const { description: _description, ...rest } = schema as Record<string, unknown>;
  return rest;
}

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
          presentProperty(schema, hints[name]),
        ])),
      } : parameters,
    },
  };
}
