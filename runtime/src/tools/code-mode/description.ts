import type { Tool } from "../types.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  type CodeModeToolDefinition,
} from "./types.js";

const MAX_JS_SAFE_INTEGER = 2 ** 53 - 1;
const PRAGMA_PREFIX = "// @exec:";

const EXEC_DESCRIPTION_TEMPLATE = `Run JavaScript code to orchestrate and compose AgenC tool calls.
- Evaluates the provided JavaScript in an isolated QuickJS runtime, not Node.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command({ cmd: "pwd" })\`.
- Tool names are exposed as normalized JavaScript identifiers. For example, \`FileRead\` is \`tools.FileRead(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return the tool's code-mode result, usually an object for structured tools or a string for text tools.
- Runs raw JavaScript only. Do not pass markdown fences.
- You may optionally start the input with \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early after that many milliseconds if the script is still running.
- \`max_output_tokens\` caps direct \`exec\`/\`wait\` output. The default is 10000 tokens.

Global helpers:
- \`exit()\`: immediately ends the current script successfully.
- \`text(value)\`: appends a text item. Non-string values are JSON-stringified when possible.
- \`image(imageUrlOrItem, detail?)\`: appends an image item. MCP image blocks may request detail with \`_meta: { "agenc/imageDetail": "original" }\`.
- \`store(key, value)\`: stores a serializable value under a string key for later \`exec\` calls in the same session.
- \`load(key)\`: returns the stored value for a string key, or \`undefined\` when missing.
- \`notify(value)\`: emits an immediate progress notification for the current \`exec\` tool call.
- \`setTimeout(callback, delayMs?)\` / \`clearTimeout(timeoutId?)\`: timer helpers inside the isolated runtime.
- \`ALL_TOOLS\`: metadata for enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields accumulated output immediately while the script pauses until \`wait\` resumes it.`;

const WAIT_DESCRIPTION = `Use wait only after exec returns "Script running with cell ID ...".
- cell_id identifies the running exec cell.
- yield_time_ms controls how long to wait for more output before yielding again.
- max_tokens limits how much new output this wait call returns.
- terminate: true stops the running cell instead of waiting.
- wait returns only new output since the last yield, or the final completion/termination result for that cell.`;

export interface ParsedExecSource {
  readonly code: string;
  readonly yieldTimeMs?: number;
  readonly maxOutputTokens?: number;
}

function isSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_JS_SAFE_INTEGER
  );
}

export function parseExecSource(input: string): ParsedExecSource {
  if (input.trim().length === 0) {
    throw new Error(
      'exec expects raw JavaScript source text, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.',
    );
  }

  const [firstLine = "", ...restLines] = input.split(/\r?\n/);
  const trimmedFirstLine = firstLine.trimStart();
  if (!trimmedFirstLine.startsWith(PRAGMA_PREFIX)) {
    return { code: input };
  }

  const rest = restLines.join("\n");
  if (rest.trim().length === 0) {
    throw new Error("exec pragma must be followed by JavaScript source");
  }

  const directive = trimmedFirstLine.slice(PRAGMA_PREFIX.length).trim();
  if (directive.length === 0) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(directive);
  } catch (error) {
    throw new Error(
      `exec pragma must be valid JSON with supported fields \`yield_time_ms\` and \`max_output_tokens\`: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`",
    );
  }

  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(
        `exec pragma only supports \`yield_time_ms\` and \`max_output_tokens\`; got \`${key}\``,
      );
    }
  }

  const yieldTimeMs = object["yield_time_ms"];
  const maxOutputTokens = object["max_output_tokens"];
  if (yieldTimeMs !== undefined && !isSafeInteger(yieldTimeMs)) {
    throw new Error(
      "exec pragma field `yield_time_ms` must be a non-negative safe integer",
    );
  }
  if (maxOutputTokens !== undefined && !isSafeInteger(maxOutputTokens)) {
    throw new Error(
      "exec pragma field `max_output_tokens` must be a non-negative safe integer",
    );
  }

  return {
    code: rest,
    ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

export function normalizeCodeModeIdentifier(toolKey: string): string {
  let identifier = "";
  for (let index = 0; index < toolKey.length; index += 1) {
    const ch = toolKey[index] ?? "";
    const valid =
      index === 0
        ? /[$_A-Za-z]/.test(ch)
        : /[$_0-9A-Za-z]/.test(ch);
    identifier += valid ? ch : "_";
  }
  return identifier.length > 0 ? identifier : "_";
}

export function isCodeModeNestedTool(toolName: string): boolean {
  return toolName !== CODE_MODE_EXEC_TOOL_NAME && toolName !== CODE_MODE_WAIT_TOOL_NAME;
}

export function codeModeToolDefinitionsFromTools(
  tools: readonly Tool[],
): CodeModeToolDefinition[] {
  return tools
    .filter((tool) => isCodeModeNestedTool(tool.name))
    .map((tool) => ({
      name: tool.name,
      globalName: normalizeCodeModeIdentifier(tool.name),
      description: tool.description,
      kind: "function",
      inputSchema: tool.inputSchema,
    }));
}

export function buildExecToolDescription(
  enabledTools: readonly CodeModeToolDefinition[],
): string {
  if (enabledTools.length === 0) return EXEC_DESCRIPTION_TEMPLATE;
  const nested = enabledTools
    .map((tool) => {
      const heading =
        tool.globalName === tool.name
          ? `### \`${tool.globalName}\``
          : `### \`${tool.globalName}\` (\`${tool.name}\`)`;
      const declaration = `declare const tools: { ${tool.globalName}(args: unknown): Promise<unknown>; };`;
      return `${heading}\n${tool.description}\n\nexec tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
    })
    .join("\n\n");
  return `${EXEC_DESCRIPTION_TEMPLATE}\n\nEnabled nested tools:\n${nested}`;
}

export function buildWaitToolDescription(): string {
  return WAIT_DESCRIPTION;
}
