import type { LLMTool } from "../../llm/types.js";
import { REQUIRED_CHECK_DESCRIPTION } from "../../tools/edit-then-run.js";
import type { Tool } from "../../tools/types.js";

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  exec_command: "Run a shell command. Returns output and status; a running session_id can be polled with write_stdin. background starts a tracked job; detach starts a lasting service when permitted. Linux sandbox jobs have private loopback: run servers and clients together. Residual processes stop on return.",
  FileRead: "Read a text file, an image, PDF pages or a notebook. offset is 1-based; limit counts lines (default 2000). PDFs over 10 pages need pages (at most 20). Reads authorize edits; a file listing does not.",
  Write: "Create or replace a whole file. Read an existing file before overwriting it.",
  apply_patch: "Patch files: *** Begin Patch, then *** Update File: path with @@ chunks (optional *** Move to: path), *** Add File: path with + lines, or *** Delete File: path; end with *** End Patch. Read existing files first.",
  write_stdin: "Poll session_id with empty chars, or send input (requires an initial tty=true). Include input newlines. Input uses the session's sandbox_permissions.",
  kill_process: "Stop this conversation's exec sessions: session_id, session_ids, or all=true. Never find processes to kill by matching command text or file names.",
};

const FIELD_HINTS: Readonly<Record<string, string>> = {
  offset: "First line, 1-based.", limit: "Number of lines.", pages: "PDF page range, for example 1-5; at most 20 pages.",
  timeoutMs: "Timeout in ms; normally yields a running session, or stops it when hard timeout is configured.",
  yield_time_ms: "Wait in ms before returning output and any running session_id.",
  max_output_tokens: "Maximum output tokens to return.",
  sandbox_permissions: "Use require_escalated only when the permission policy allows requesting approval.",
  additional_permissions: "Additional sandbox permissions requested for this call.",
  justification: "Why the requested permission is needed.", prefix_rule: "Optional reusable command prefix for an approval.",
  extract_text: "Request approval to upload the entire file to DeepSeek OCR for text extraction. Omit pages.",
};

function conciseSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(conciseSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !key.startsWith("x-agenc-") && !["description", "title", "examples"].includes(key))
    .map(([key, child]) => [key, conciseSchema(child)]));
}

/** Keep every supported operational/approval field when search is unavailable. */
export function leanToolDefinition(tool: LLMTool, canonical: Tool | undefined, compact: boolean): LLMTool {
  const name = tool.function.name;
  if (!(name in DESCRIPTIONS)) return tool;
  const original = canonical?.inputSchema ?? tool.function.parameters;
  const parameters = compact ? conciseSchema(original) as LLMTool["function"]["parameters"] : original;
  if (compact && parameters.properties != null && typeof parameters.properties === "object") {
    // edit_mode = "check" requires the check command, so its purpose stays in the compact schema.
    const hints = Array.isArray(parameters.required) && parameters.required.includes("check")
      ? { ...FIELD_HINTS, check: REQUIRED_CHECK_DESCRIPTION } : FIELD_HINTS;
    parameters.properties = Object.fromEntries(Object.entries(parameters.properties).map(([key, schema]) =>
      [key, hints[key] === undefined ? schema : { ...schema as object, description: hints[key] }]));
  }
  const extraction = name === "FileRead" && parameters.properties != null &&
    typeof parameters.properties === "object" && "extract_text" in parameters.properties;
  return { ...tool, function: { ...tool.function, parameters,
    description: compact ? DESCRIPTIONS[name]! + (extraction
      ? " For PDF, Word, PowerPoint or images, extract_text=true requests approval to upload the entire file to DeepSeek OCR (100 MiB, 1,000 pages). Omit pages for extraction; offset and limit select returned text. OCR output does not authorize edits."
      : "") : canonical?.description ?? tool.function.description,
  } };
}
