import type { LLMTool } from "../llm/types.js";

const FILE_PATH = "Workspace-relative or absolute filesystem path, not an agent address.";

/** Presentation only: canonical schemas, validators, permissions and executors stay intact. */
const PRESENTATIONS: Readonly<Record<string, {
  readonly description: string;
  readonly parameters?: Readonly<Record<string, string>>;
}>> = {
  FileRead: {
    description: "Read files, images, PDFs or notebooks. Text has display line numbers. Use offset/limit for large files; oversized reads fail. PDFs over 10 pages require pages, at most 20 per call. Cannot read directories.",
    parameters: {
      file_path: FILE_PATH,
      offset: "Start line, 1-indexed. Numeric strings accepted.",
      limit: "Maximum lines. Numeric strings accepted.",
    },
  },
  Edit: {
    description: "Replace exact text in a file already read with FileRead. old_string must be unique unless replace_all. Exclude display line numbers. Fails if the file changed since read.",
    parameters: { file_path: FILE_PATH },
  },
  Write: {
    description: "Create or overwrite a file. Read existing files with FileRead first; fails if changed since read. Prefer Edit for partial changes.",
    parameters: { file_path: FILE_PATH },
  },
  Grep: {
    description: "Search file contents with ripgrep regex. Defaults to matching file paths; use output_mode content for lines. Escape literal regex metacharacters. Ignored/build files are excluded unless includeIgnored.",
    parameters: {
      pattern: "Ripgrep regular expression.",
      path: "File or directory; defaults to cwd.",
      glob: 'File filter, e.g. "*.{ts,tsx}".',
      output_mode: "Default files_with_matches. content returns lines; count returns match counts.",
      "-B": "Context lines before matches; content mode only.",
      "-A": "Context lines after matches; content mode only.",
      "-C": "Context lines before and after matches; content mode only.",
      "-n": "Line numbers in content mode; default true.",
      type: "Ripgrep file type, e.g. js, py, rust.",
      head_limit: "Maximum lines/entries; default 250. Zero disables pagination, not safety limits.",
      offset: "Skip this many lines/entries; default 0.",
      multiline: "Allow patterns and dot to span lines; default false.",
      includeIgnored: "Include gitignored and build/vendor files; default false.",
    },
  },
  Glob: {
    description: "Find file paths by glob pattern, sorted by modification time. Skips ignored/build/vendor files and lockfiles unless includeIgnored.",
    parameters: { includeIgnored: "Include ignored/build/vendor files and lockfiles; default false." },
  },
  exec_command: {
    description: "Run shell commands. For long work use yield_time_ms; a running process returns session_id for write_stdin. Load kill_process to stop it. Child processes stop when the command ends; detach is required for persistent services. Use file tools for edits and call MCP tools directly.",
    parameters: {
      cmd: "Shell command to execute, not an MCP function or commentary.",
      timeoutMs: "Hard timeout in milliseconds. Use yield_time_ms to keep long work alive.",
      yield_time_ms: "Wait before returning output or a running session_id.",
      max_output_tokens: "Output token limit; longer output is truncated head/tail.",
      tty: "Interactive PTY, required for nonempty write_stdin input. Unavailable in contained operations; use noninteractive flags or the app's Run button.",
      detach: "Persistent service; returns pid/log. Requires danger-full-access, forbids tty. Waits yield_time_ms (default 2000) for early exit.",
    },
  },
  write_stdin: {
    description: "Poll a running exec_command session with chars empty, or send input if it started with tty=true. Use the same sandbox_permissions as the originating command.",
  },
  "system.searchTools": {
    description: "Find tools by capability or name. A unique best query match loads its schema; otherwise select exact result names to load. Discovery grants no execution permission.",
  },
};

/** Replace selected descriptions only, retaining every schema constraint and extension. */
export function lightToolPresentation(tool: LLMTool): LLMTool {
  const presentation = PRESENTATIONS[tool.function.name];
  if (presentation === undefined) return tool;
  const schema = tool.function.parameters;
  const properties = schema.properties;
  const parameters = presentation.parameters !== undefined && properties !== null &&
      typeof properties === "object" && !Array.isArray(properties)
    ? {
        ...schema,
        properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => {
          const description = presentation.parameters?.[name];
          return [name, description !== undefined && property !== null &&
            typeof property === "object" && !Array.isArray(property)
            ? { ...property, description } : property];
        })),
      }
    : schema;
  return { ...tool, function: { ...tool.function, description: presentation.description, parameters } };
}
