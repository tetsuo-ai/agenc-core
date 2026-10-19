import type { LLMTool } from "../llm/types.js";

// Presentation only. Every field, alternative, default and validation keyword
// remains on the wire; execution and discovery retain the canonical tool.
// null removes only a redundant property description, never its schema.
const descriptions: Readonly<Record<string, string>> = {
  FileRead: "Read text/images/PDFs/notebooks; authorizes edits. Prefer 1-based offset/limit line windows: default 2000 lines, cap 25000 tokens. Display-only numbers are sparse unless dense_line_numbers. PDFs >10 pages require pages (e.g. 1-5), max 20/read. Empty files warn; directories fail. Successful edits need no reread.",
  Edit: "FileRead first. Replace shortest unique exact old_string with new_string, preserving indentation, omitting unchanged context/display numbers. replace_all replaces every match (default false). Prefer existing files; create only as needed. Emojis only on request.",
  Write: "Create/replace complete files; existing files require FileRead first. Use Edit for partial changes. Documentation/emojis only on request.",
  exec_command: "Workspace inspection/tests/builds; use a listed editing tool for source changes, delete/rename use rm/mv. Call tools directly, not printed placeholders/commentary. Batch bounded independent reads. Yielded session_id exposes write_stdin; kill_process stops it. No trailing &: leftovers stop on return, yielded processes at session end. Lasting services need detach.",
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
    yield_time_ms: "Wait ms; live processes return session_id. Default 30000 (tty 10000).",
    max_output_tokens: "Token cap; head/tail truncation.",
    login: "Login shell if supported.", shell: "Default: user's shell.",
    tty: "Interactive PTY, required for persistent shells/write_stdin input. Unavailable in contained operations: use tty=false and non-interactive flags, or ask the user to use the app's Run button.",
    detach: "Service in its own session; stdout/stderr logged. AgenC never stops it; survives command/session end. Wait yield_time_ms (default 2000) for early exit; return pid/log path. Only outside the sandbox (danger-full-access or an approved require_escalated launch), never tty.",
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
export function lightPresentation(tool: LLMTool, options: { readonly leanExec?: boolean } = {}): LLMTool {
  const presented = lightPresentationCanonical(tool);
  if (options.leanExec !== true || tool.function.name !== "exec_command") return presented;
  return withOnlyFields(presented, LEAN_EXEC_FIELDS, LEAN_EXEC_POINTER);
}

/** Show only `fields`; execution still accepts the rest, and `pointer` says how to load them. */
function withOnlyFields(presented: LLMTool, fields: ReadonlySet<string>, pointer: string): LLMTool {
  const parameters = presented.function.parameters;
  const properties = parameters.properties as Record<string, unknown> | undefined;
  if (properties === undefined) return presented;
  const required = Array.isArray(parameters.required)
    ? (parameters.required as string[]).filter(name => fields.has(name))
    : undefined;
  return { ...presented, function: {
    ...presented.function,
    description: `${presented.function.description ?? ""}${pointer}`,
    parameters: {
      ...parameters,
      ...(required !== undefined ? { required } : {}),
      properties: Object.fromEntries(Object.entries(properties).filter(([name]) => fields.has(name))),
    },
  } };
}

/**
 * The exec_command fields a Light session sees until it asks for more. GPT models write every
 * presented field on every call (on GPT-6 Luna the other fields were about 13 percent of the
 * input per task), so the rest load through system.searchTools (select:exec_command), after which
 * the session sees the full schema. Execution accepts every field either way. yield_time_ms is
 * among the rest: shown, GPT models set it to 1000 for test runs, so a Go test still compiling
 * after 1 s yielded and cost a write_stdin call; omitted, Light's 30 s default applies.
 */
const LEAN_EXEC_FIELDS: ReadonlySet<string> = new Set(["cmd", "workdir", "timeoutMs"]);
const LEAN_EXEC_POINTER =
  " Advanced fields (yield_time_ms, tty, login, shell, detach, max_output_tokens, sandbox escalation) are accepted; system.searchTools select:exec_command loads their schema.";

/**
 * The Grep fields a standard session sees until system.searchTools selects Grep. In 80 qb-ten
 * runs on DeepSeek (2026-10-16), the 28 Grep calls passed only pattern, output_mode, path, -n
 * (default true), -i and head_limit; the rest cost every request about 800 characters.
 */
const LEAN_GREP_FIELDS: ReadonlySet<string> = new Set(["pattern", "path", "glob", "output_mode", "-i"]);
const LEAN_GREP_POINTER =
  " Other fields (-n, -A, -B, -C, type, head_limit, offset, multiline, includeIgnored) are accepted; system.searchTools select:Grep loads their schema.";

/**
 * Standard sessions' own wording for core tools whose Light text does not fit them: FileRead
 * keeps dense line numbers in standard sessions, and Light has no MultiEdit. Same fields and
 * schema as the canonical tool.
 */
const standardDescriptions: Readonly<Record<string, string>> = {
  FileRead: "Read text, images, PDFs or Jupyter notebooks. Default: the first 2000 lines, numbered from 1 (cat -n); for a large file pass offset (1-based) and limit and read only what you need. A read over 25000 tokens fails. PDFs over 10 pages need pages (at most 20 per read). Directories fail: list them with the shell. A whole-file read authorizes edits; Edit and Write fail if their change did not land, so do not re-read to check one.",
  MultiEdit: "Several exact replacements in one file, applied in order, each to the result of the one before. Read the file first (FileRead, or exec_command output that printed it whole). Each old_string must be unique when its edit applies unless replace_all is set. The file is written only if every edit succeeds.",
  Skill: "Run a skill listed in the system reminders within this conversation; when one matches the request, call it before responding. Skill names only: MCP tools are called through their own function after system.searchTools loads them.",
};
const standardFieldHints: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  FileRead: { file_path: path },
  MultiEdit: { file_path: path },
  Skill: { skill: "A listed skill name.", args: null },
};

/** AgenC's own validation keys (x-agenc-*) inform the runtime validator, not the model. */
function withoutVendorKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVendorKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("x-agenc-"))
    .map(([key, child]) => [key, withoutVendorKeys(child)]));
}

/**
 * Standard-session wording for a built-in tool: Light's compact text where it fits
 * (`lightWording`), the standard text above for FileRead, MultiEdit and Skill, and the lean
 * exec_command and Grep until system.searchTools selects them. The schema keeps every
 * field, default and standard validation keyword; only AgenC's x-agenc-* keys stay off the wire.
 */
export function standardPresentation(
  tool: LLMTool,
  options: { readonly lightWording?: boolean; readonly leanExec?: boolean; readonly leanGrep?: boolean } = {},
): LLMTool {
  const name = tool.function.name;
  const description = standardDescriptions[name];
  const presented = options.lightWording === true
    ? lightPresentation(tool, { leanExec: options.leanExec === true })
    : description === undefined
      ? tool
      : presentWith(tool, description, standardFieldHints[name] ?? {});
  const worded = options.leanGrep === true && name === "Grep"
    ? withOnlyFields(presented, LEAN_GREP_FIELDS, LEAN_GREP_POINTER)
    : presented;
  return {
    ...worded,
    function: {
      ...worded.function,
      parameters: withoutVendorKeys(worded.function.parameters) as LLMTool["function"]["parameters"],
    },
  };
}

function presentWith(
  tool: LLMTool,
  description: string,
  hints: Readonly<Record<string, string | null>>,
): LLMTool {
  const parameters = tool.function.parameters;
  const properties = parameters.properties as Record<string, unknown> | undefined;
  return {
    ...tool,
    function: {
      ...tool.function, description,
      parameters: properties ? {
        ...parameters,
        properties: Object.fromEntries(Object.entries(properties).map(([field, schema]) => [field,
          presentProperty(schema, hints[field]),
        ])),
      } : parameters,
    },
  };
}

function lightPresentationCanonical(tool: LLMTool): LLMTool {
  const description = descriptions[tool.function.name];
  if (description === undefined) return tool;
  return presentWith(tool, description, fieldHints[tool.function.name] ?? {});
}
