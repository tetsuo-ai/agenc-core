import type { LLMTool } from "../llm/types.js";

/**
 * exec_command's server guidance for Light sessions on abliteration.ai Large V2, sent with every
 * request, so their exec result notes leave it out. It opens with SERVER_CHECK_GUIDANCE
 * (tools/system/exec-result-format.ts), the pattern other sessions get once in a note, and adds
 * what Large V2 got wrong: `wait` on a live server blocks the command until its timeout.
 */
export const LIGHT_GLM_SERVER_CHECKS =
  "To check a server, start it in the background, wait for its port or log line in a bounded loop instead of a fixed sleep or timeout (for example up to 50 tries of `curl -sf <url>` with `sleep 0.1`), then make the requests and `kill $!` in the same command. Never use `wait` on a server: it keeps the command blocked until its timeout.";

// Presentation only; execution and discovery retain the canonical tool. The
// shared Light wording keeps every field, alternative, default and validation
// keyword on the wire (null removes only a redundant property description,
// never its schema). A Light session's own tools also drop path hints and
// FileRead's numeric-string alternatives, and the lean tools show their common
// fields until system.searchTools selects them (lightPresentation).
const descriptions: Readonly<Record<string, string>> = {
  FileRead: "Read text/images/PDFs/notebooks; authorizes edits. Prefer 1-based offset/limit line windows: default 2000 lines, cap 25000 tokens. Display-only numbers are sparse unless dense_line_numbers. PDFs >10 pages require pages (e.g. 1-5), max 20/read. Empty files warn; directories fail. Successful edits need no reread.",
  Edit: "FileRead first. Replace shortest unique exact old_string with new_string, preserving indentation, omitting unchanged context/display numbers. replace_all replaces every match (default false). Prefer existing files; create only as needed. Emojis only on request.",
  Write: "Create/replace complete files; existing files require FileRead first. Use Edit for partial changes. Documentation/emojis only on request.",
  exec_command: "Workspace inspection/tests/builds; use a listed editing tool for source changes, delete/rename use rm/mv. Call tools directly, not printed placeholders/commentary. Batch bounded independent reads. Yielded session_id exposes write_stdin; kill_process stops it. Long jobs: background=true, never & or nohup; leftovers stop on return. Lasting services need detach.",
  write_stdin: "Continue exec_command's session_id. Empty chars polls; input requires initial tty=true. Include command newlines; match the session's sandbox_permissions.",
  Glob: "Find file paths by glob, newest modification first. Skip gitignored/build/vendor files unless includeIgnored=true.",
  Grep: "Search with packaged ripgrep, not shell grep/rg; escape literal braces. output_mode: files_with_matches (default paths), content (lines), count. Context/line numbers apply to content. multiline matches across lines with dot-all. Skip ignored/build/vendor files unless includeIgnored=true. Missing ripgrep: agenc doctor, reinstall same version; no fallback.",
  "system.searchTools": "Find unlisted tools by name or keyword (tools, not files or code). Listed tools are ready. select loads a tool's schema by exact name.",
};

const path = "Workspace/absolute path; not an agent-tree ID.";
const fieldHints: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  FileRead: { file_path: path, offset: null, limit: null, pages: null, dense_line_numbers: null },
  Edit: { file_path: path, old_string: null, new_string: null, replace_all: null },
  Write: { file_path: path, content: null },
  exec_command: {
    cmd: null, workdir: "Default: workspace root.", timeoutMs: "Max wait, ms; then runs on as a session.",
    // The description says what it is for ("Long jobs: background=true"); the
    // first background result says how the session is polled and reported.
    background: null,
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

/**
 * Adapt the earlier Light summaries without hiding accepted arguments. The lean exec_command,
 * FileRead and system.searchTools show their common fields until system.searchTools selects them.
 * `lightSession` marks a Light session's own registry: standard sessions reuse the Light wording
 * for some core tools (standardPresentation) and keep their field hints.
 */
export function lightPresentation(
  tool: LLMTool,
  options: {
    readonly leanExec?: boolean;
    readonly leanSearch?: boolean;
    readonly leanRead?: boolean;
    readonly lightSession?: boolean;
    readonly glmServerChecks?: boolean;
  } = {},
): LLMTool {
  const canonical = tool.function.name === "Edit" && (tool.function.parameters.properties as Record<string, unknown> | undefined)?.edits !== undefined
    ? tool
    : lightPresentationCanonical(tool);
  const sessionTool = options.lightSession === true ? withLightSessionFields(canonical) : canonical;
  const presented = options.lightSession === true && options.glmServerChecks === true && tool.function.name === "exec_command"
    ? { ...sessionTool, function: { ...sessionTool.function, description: `${sessionTool.function.description} ${LIGHT_GLM_SERVER_CHECKS}` } }
    : sessionTool;
  if (options.leanExec === true && tool.function.name === "exec_command") {
    return withOnlyFields(presented, LEAN_EXEC_FIELDS, LEAN_EXEC_POINTER);
  }
  if (options.leanRead === true && tool.function.name === "FileRead") {
    return withOnlyFields(
      { ...presented, function: { ...presented.function, description: LEAN_READ_DESCRIPTION } },
      LEAN_READ_FIELDS,
      LEAN_READ_POINTER,
    );
  }
  if (options.leanSearch === true && tool.function.name === "system.searchTools") {
    return withFieldSchemas(
      withOnlyFields(presented, LEAN_SEARCH_FIELDS, options.lightSession === true ? "" : LEAN_SEARCH_POINTER),
      { select: { type: "string" } },
    );
  }
  return presented;
}

/**
 * Field presentation for a Light session's own tools. Light resends every schema on every model
 * call, so: path fields carry no hint (the head already says "Use workspace-relative paths", and
 * agent-tree IDs only exist once spawn_agent is loaded), and FileRead's line window shows only its
 * numeric form. Execution validates against the canonical schema, which still accepts a numeric
 * string for offset and limit.
 */
const LIGHT_SESSION_FIELDS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  FileRead: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
  Edit: { file_path: { type: "string" }, path: { type: "string" } },
  Write: { file_path: { type: "string" } },
};

/**
 * A Light session's own wording where the shared Light text repeats the head or speaks about a
 * state the session may never reach. The head already says "Put independent tool calls in one
 * response"; what a yielded session offers is said by write_stdin, which loads when exec_command
 * yields one.
 */
const LIGHT_SESSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  exec_command: "Workspace inspection/tests/builds; use a listed editing tool for source changes, delete/rename use rm/mv. Call tools directly, not printed placeholders/commentary. Long jobs: background=true, never & or nohup; leftovers stop on return. Lasting services need detach.",
  write_stdin: "Continue exec_command's session_id; kill_process stops it. Empty chars polls; input requires initial tty=true. Include command newlines; match the session's sandbox_permissions.",
};

/** Size keywords the model never needs to see; execution still validates them. */
const LIGHT_SESSION_HIDDEN_KEYWORDS: ReadonlySet<string> = new Set(["minItems", "minLength"]);

function withoutKeywords(value: unknown, keywords: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map(item => withoutKeywords(item, keywords));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keywords.has(key))
    .map(([key, child]) => [key, withoutKeywords(child, keywords)]));
}

function withLightSessionFields(tool: LLMTool): LLMTool {
  const name = tool.function.name;
  const fields = LIGHT_SESSION_FIELDS[name];
  const described = LIGHT_SESSION_DESCRIPTIONS[name];
  const withFields = fields === undefined ? tool : withFieldSchemas(tool, fields);
  const worded = described === undefined
    ? withFields
    : { ...withFields, function: { ...withFields.function, description: described } };
  return name === "Edit"
    ? { ...worded, function: {
        ...worded.function,
        parameters: withoutKeywords(worded.function.parameters, LIGHT_SESSION_HIDDEN_KEYWORDS) as LLMTool["function"]["parameters"],
      } }
    : worded;
}

/** Replace the presented schema of the named fields that the tool has; other fields are kept. */
function withFieldSchemas(tool: LLMTool, fields: Readonly<Record<string, unknown>>): LLMTool {
  const parameters = tool.function.parameters;
  const properties = parameters.properties as Record<string, unknown> | undefined;
  if (properties === undefined) return tool;
  return { ...tool, function: {
    ...tool.function,
    parameters: {
      ...parameters,
      properties: Object.fromEntries(Object.entries(properties).map(([name, schema]) =>
        [name, Object.hasOwn(fields, name) ? fields[name] : schema])),
    },
  } };
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
 * background is shown: it is the supported way to start a long job, and without it in the schema
 * models reach for `nohup ... &`, which exec_command refuses (tools/system/background-job-refusal.ts).
 */
const LEAN_EXEC_FIELDS: ReadonlySet<string> = new Set(["cmd", "workdir", "timeoutMs", "background"]);
/**
 * The escalation fields are left out of the list: every mode whose text lets the model request
 * escalation names sandbox_permissions there (prompts/permissions-prompt.ts), and a sandbox notice
 * that advises a retry loads the full schema (tools/exec-session-discovery.ts).
 */
const LEAN_EXEC_POINTER =
  " Advanced fields (yield_time_ms, tty, login, shell, detach, max_output_tokens): system.searchTools select:exec_command loads them.";

/**
 * The system.searchTools fields a Light session sees until it selects system.searchTools. Of 296
 * recorded searches (round 3 and 4 swarm runs, all modes), 289 used query or select; 45 of the 53
 * that passed a filter passed maxResults beside a query, which caps results at five anyway. Shown,
 * the six filters cost every request about 60 tokens, and the pointer to them 10 more, so a Light
 * session's own registry leaves the pointer out too; selecting system.searchTools still shows them.
 * select is shown as a string: a comma-separated list selects several tools. Execution accepts
 * every field and form either way.
 */
const LEAN_SEARCH_FIELDS: ReadonlySet<string> = new Set(["query", "select"]);
const LEAN_SEARCH_POINTER = " select:system.searchTools adds its filters.";

/**
 * The FileRead fields a Light session sees until it selects FileRead. GPT models write every
 * presented field on every call: in the Luna API race (round 4, 61 FileRead calls) each one sent
 * pages "" and dense_line_numbers, mostly true, which also numbered every line of the result.
 * pages matters only for a PDF over 10 pages, and that read fails with a message naming pages;
 * dense numbering is never needed to edit. Execution accepts every field either way.
 */
const LEAN_READ_FIELDS: ReadonlySet<string> = new Set(["file_path", "offset", "limit"]);
const LEAN_READ_DESCRIPTION =
  "Read text/images/PDFs/notebooks; authorizes edits. Prefer 1-based offset/limit line windows: default 2000 lines, cap 25000 tokens. Line numbers are sparse and display-only. Successful edits need no reread.";
const LEAN_READ_POINTER = " PDF pages and dense line numbers: system.searchTools select:FileRead.";

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
 * schema as the canonical tool. That a successful edit needs no reread is said once, by the
 * standard head's tool section (prompts/system-prompt.ts getUsingYourToolsSection).
 */
const standardDescriptions: Readonly<Record<string, string>> = {
  FileRead: "Read text, images, PDFs or Jupyter notebooks. Default: the first 2000 lines, numbered from 1 (cat -n); for a large file pass offset (1-based) and limit and read only what you need. A read over 25000 tokens fails. PDFs over 10 pages need pages (at most 20 per read). Directories fail: list them with the shell. A whole-file read authorizes edits.",
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
 * exec_command, Grep and system.searchTools until system.searchTools selects them (the search
 * filters with the same pointer as {@link LEAN_SEARCH_FIELDS} describes). The schema of every
 * other tool keeps every field, default and standard validation keyword; only AgenC's x-agenc-*
 * keys stay off the wire.
 */
export function standardPresentation(
  tool: LLMTool,
  options: {
    readonly lightWording?: boolean;
    readonly leanExec?: boolean;
    readonly leanGrep?: boolean;
    readonly leanSearch?: boolean;
  } = {},
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
    : options.leanSearch === true && name === "system.searchTools"
      ? withFieldSchemas(withOnlyFields(presented, LEAN_SEARCH_FIELDS, LEAN_SEARCH_POINTER), { select: { type: "string" } })
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
