import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";

import { getSessionId } from "../bootstrap/state.js";
import { getCwd } from "../utils/cwd.js";
import { isRecord } from "../utils/record.js";
import { createBashTool } from "./system/bash.js";
import { createFileEditTool } from "./system/file-edit.js";
import { createFileReadTool } from "./system/file-read.js";
import { createFileWriteTool } from "./system/file-write.js";
import { createGlobTool } from "./system/glob.js";
import { createGrepTool } from "./system/grep.js";
import { withSignedSessionId } from "../agents/_deps/filesystem-args.js";
import { createNotebookEditTool as createSystemNotebookEditTool } from "./system/notebook-edit.js";
import type { Tool as RuntimeTool, ToolResult as RuntimeToolResult } from "./types.js";
import { buildTool, type Tool, type ToolCallProgress, type ToolUseContext } from "./Tool.js";

type RuntimeToolFactory = (workspaceRoot: string) => RuntimeTool;
type SearchOrReadClassification = {
  readonly isSearch: boolean;
  readonly isRead: boolean;
  readonly isList?: boolean;
};
type CanonicalToolData =
  | string
  | {
      readonly content: string;
      readonly contentItems?: RuntimeToolResult["contentItems"];
      readonly isError?: boolean;
      readonly metadata?: Record<string, unknown>;
    };

interface CanonicalToolOptions {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly searchHint: string;
  readonly maxResultSizeChars: number;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  readonly createRuntimeTool: RuntimeToolFactory;
  readonly mapInput?: (
    input: Record<string, unknown>,
    workspaceRoot: string,
  ) => Record<string, unknown>;
  readonly getPath?: (input: Record<string, unknown>) => string | undefined;
  readonly userFacingName?: (input: Partial<Record<string, unknown>>) => string;
  readonly summary?: (input: Partial<Record<string, unknown>>) => string | null;
  readonly classifierInput?: (input: Record<string, unknown>) => unknown;
  readonly isSearchOrReadCommand?: (
    input: Record<string, unknown>,
  ) => SearchOrReadClassification;
}

function workspaceRoot(): string {
  return getCwd() || process.cwd();
}

function defaultMapInput(
  input: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  return { ...input, cwd: typeof input.cwd === "string" ? input.cwd : root };
}

function runtimeEvaluatorContext(context: ToolUseContext) {
  return {
    getAppState: context.getAppState,
    session: null,
    signal: context.abortController.signal,
  };
}

function runtimeResultToData(result: RuntimeToolResult): CanonicalToolData {
  if (
    result.isError === true ||
    result.contentItems !== undefined ||
    result.metadata !== undefined
  ) {
    return {
      content: result.content,
      ...(result.contentItems !== undefined
        ? { contentItems: result.contentItems }
        : {}),
      ...(result.isError === true ? { isError: true } : {}),
      ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    };
  }
  return result.content;
}

function textToolResultBlock(
  content: unknown,
  toolUseID: string,
): ToolResultBlockParam {
  const isError = isCanonicalToolData(content) && content.isError === true;
  if (
    isCanonicalToolData(content) &&
    content.contentItems !== undefined &&
    !isError
  ) {
    return {
      type: "tool_result",
      tool_use_id: toolUseID,
      content: contentItemsToToolResultBlocks(
        content.contentItems,
        content.content,
      ) as unknown as ToolResultBlockParam["content"],
    };
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseID,
    content: isCanonicalToolData(content)
      ? content.content
      : String(content ?? ""),
    ...(isError ? { is_error: true } : {}),
  };
}

function canonicalResultText(content: unknown): string {
  if (isCanonicalToolData(content)) return content.content;
  return String(content ?? "");
}

function isCanonicalToolData(value: unknown): value is Exclude<CanonicalToolData, string> {
  return isRecord(value) && typeof value.content === "string";
}

function contentItemsToToolResultBlocks(
  items: NonNullable<RuntimeToolResult["contentItems"]>,
  fallbackText: string,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const item of items) {
    if (item.type === "input_text") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    const image = dataUrlToImageSource(item.image_url);
    blocks.push(
      image === undefined
        ? { type: "text", text: item.image_url }
        : { type: "image", source: image },
    );
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: fallbackText });
  }
  return blocks;
}

function dataUrlToImageSource(
  imageUrl: string,
): { type: "base64"; media_type: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(imageUrl);
  if (!match?.[1] || match[2] === undefined) return undefined;
  return {
    type: "base64",
    media_type: match[1],
    data: match[2],
  };
}

const BASH_SEARCH_COMMANDS = new Set([
  "find",
  "grep",
  "rg",
  "ag",
  "ack",
  "locate",
  "which",
  "whereis",
]);
const BASH_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "strings",
  "jq",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
]);
const BASH_LIST_COMMANDS = new Set(["ls", "tree", "du"]);
const BASH_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);
const BASH_CLASSIFICATION_SEPARATORS = new Set(["|", "||", "&&", "&", ";"]);
const BASH_CLASSIFICATION_REDIRECTS = new Set([">", ">>", ">&"]);

function splitBashCommandForClassification(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";
    if (quote !== null) {
      current += char;
      if (char === quote && command[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    const twoCharOperator = `${char}${next}`;
    if (twoCharOperator === "||" || twoCharOperator === "&&" || twoCharOperator === ">>") {
      if (current.trim().length > 0) parts.push(current.trim());
      parts.push(twoCharOperator);
      current = "";
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (current.trim().length > 0) parts.push(current.trim());
      parts.push(";");
      current = "";
      continue;
    }
    if (char === "|" || char === "&" || char === ";" || char === ">" || char === "<") {
      if (current.trim().length > 0) parts.push(current.trim());
      parts.push(char);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function classifyBashSearchOrRead(command: string): SearchOrReadClassification {
  if (/[`]/u.test(command) || /\$\s*\(/u.test(command) || /[<>]\s*\(/u.test(command)) {
    return { isSearch: false, isRead: false, isList: false };
  }
  const partsWithOperators = splitBashCommandForClassification(command);
  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let hasNonNeutral = false;
  let skipRedirectTarget = false;

  for (const part of partsWithOperators) {
    if (skipRedirectTarget) {
      skipRedirectTarget = false;
      continue;
    }
    if (BASH_CLASSIFICATION_REDIRECTS.has(part)) {
      skipRedirectTarget = true;
      continue;
    }
    if (BASH_CLASSIFICATION_SEPARATORS.has(part)) {
      continue;
    }

    const commandToken = part.trim().split(/\s+/u)[0];
    if (!commandToken) continue;
    const base = commandToken.split("/").pop() ?? commandToken;
    if (BASH_NEUTRAL_COMMANDS.has(base)) {
      continue;
    }
    hasNonNeutral = true;
    if (BASH_SEARCH_COMMANDS.has(base)) {
      hasSearch = true;
      continue;
    }
    if (BASH_READ_COMMANDS.has(base)) {
      hasRead = true;
      continue;
    }
    if (BASH_LIST_COMMANDS.has(base)) {
      hasList = true;
      continue;
    }
    return { isSearch: false, isRead: false, isList: false };
  }

  if (!hasNonNeutral) {
    return { isSearch: false, isRead: false, isList: false };
  }
  return { isSearch: hasSearch, isRead: hasRead, isList: hasList };
}

function buildBashProgressForwarder(
  input: Record<string, unknown>,
  onProgress: ToolCallProgress | undefined,
): ((event: {
  readonly chunk: string;
  readonly stream?: "stdout" | "stderr" | "status";
  readonly processId?: number;
}) => void) | undefined {
  if (onProgress === undefined) return undefined;

  const startTime = Date.now();
  const chunks: string[] = [];
  let progressCounter = 0;
  const timeoutMs =
    typeof input.timeoutMs === "number"
      ? input.timeoutMs
      : typeof input.timeout === "number"
        ? input.timeout
        : undefined;

  return (event) => {
    chunks.push(event.chunk);
    const fullOutput = chunks.join("");
    onProgress({
      toolUseID: `canonical-bash-progress-${progressCounter++}`,
      data: {
        type: "bash_progress",
        output: event.chunk,
        fullOutput,
        elapsedTimeSeconds: (Date.now() - startTime) / 1000,
        totalLines: fullOutput.length === 0
          ? 0
          : fullOutput.split(/\r\n|\r|\n/u).length,
        totalBytes: Buffer.byteLength(fullOutput, "utf8"),
        ...(event.processId !== undefined ? { taskId: event.processId } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
    });
  };
}

function createCanonicalTool(options: CanonicalToolOptions): Tool {
  // Phase 6 #41: every method below previously called
  // `options.createRuntimeTool(root)` on each invocation. For
  // hot-path methods (`prompt`, `isConcurrencySafe`, `isReadOnly`,
  // `checkPermissions`, `call`), each call rebuilt the underlying
  // runtime tool — re-allocating its closures, schema bindings, and
  // any per-tool memoized state. The runtime tool only depends on
  // `workspaceRoot()`, so memoize per-root. The cache size stays
  // bounded by the small number of workspace roots a session uses
  // (almost always 1). Keyed lookup keeps the right tool when the
  // session genuinely switches roots.
  const runtimeToolByRoot = new Map<string, ReturnType<typeof options.createRuntimeTool>>();
  function getRuntimeTool(root: string): ReturnType<typeof options.createRuntimeTool> {
    let tool = runtimeToolByRoot.get(root);
    if (tool === undefined) {
      tool = options.createRuntimeTool(root);
      runtimeToolByRoot.set(root, tool);
    }
    return tool;
  }
  return buildTool({
    name: options.name,
    ...(options.aliases !== undefined ? { aliases: [...options.aliases] } : {}),
    searchHint: options.searchHint,
    maxResultSizeChars: options.maxResultSizeChars,
    strict: true,
    get inputSchema() {
      return options.inputSchema;
    },
    async description(input) {
      return options.summary?.(input) ?? options.userFacingName?.(input) ?? options.name;
    },
    async prompt() {
      return getRuntimeTool(workspaceRoot()).description;
    },
    isConcurrencySafe(input) {
      const root = workspaceRoot();
      const runtimeTool = getRuntimeTool(root);
      return (
        runtimeTool.isConcurrencySafe?.(mapCanonicalInput(options, input, root)) ??
        runtimeTool.isReadOnly === true
      );
    },
    isReadOnly(input) {
      const root = workspaceRoot();
      const runtimeTool = getRuntimeTool(root);
      return (
        runtimeTool.isReadOnly === true ||
        runtimeTool.isConcurrencySafe?.(mapCanonicalInput(options, input, root)) === true
      );
    },
    async checkPermissions(input, context) {
      const root = workspaceRoot();
      const runtimeTool = getRuntimeTool(root);
      if (!runtimeTool.checkPermissions) {
        return { behavior: "allow", updatedInput: input };
      }
      return runtimeTool.checkPermissions(
        mapCanonicalInput(options, input, root),
        runtimeEvaluatorContext(context) as never,
      ) as never;
    },
    getPath(input) {
      return options.getPath?.(input) ?? "";
    },
    userFacingName(input) {
      return options.userFacingName?.(input ?? {}) ?? options.name;
    },
    getToolUseSummary(input) {
      return options.summary?.(input ?? {}) ?? null;
    },
    getActivityDescription(input) {
      return options.summary?.(input ?? {}) ?? options.userFacingName?.(input ?? {}) ?? options.name;
    },
    toAutoClassifierInput(input) {
      return options.classifierInput?.(input) ?? "";
    },
    isSearchOrReadCommand(input) {
      return options.isSearchOrReadCommand?.(input) ?? {
        isSearch: false,
        isRead: false,
        isList: false,
      };
    },
    async call(input, context, _canUseTool, _parentMessage, onProgress) {
      const root = workspaceRoot();
      const runtimeTool = getRuntimeTool(root);
      const runtimeInput = mapCanonicalInput(options, input, root);
      const progressForwarder =
        options.name === "system.bash"
          ? buildBashProgressForwarder(input, onProgress)
          : undefined;
      const result = await runtimeTool.execute({
        ...runtimeInput,
        __abortSignal: context.abortController.signal,
        ...(progressForwarder !== undefined ? { __onProgress: progressForwarder } : {}),
      });
      return { data: runtimeResultToData(result) };
    },
    mapToolResultToToolResultBlockParam: textToolResultBlock,
    renderToolUseMessage(input) {
      return options.summary?.(input ?? {}) ?? options.userFacingName?.(input ?? {}) ?? options.name;
    },
    renderToolResultMessage(content) {
      return canonicalResultText(content);
    },
    extractSearchText(content) {
      return canonicalResultText(content);
    },
  });
}

function mapCanonicalInput(
  options: CanonicalToolOptions,
  input: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  const mapped = options.mapInput?.(input, root) ?? defaultMapInput(input, root);
  // SECURITY: always inject the AUTHORITATIVE session id from the runtime
  // state (`getSessionId()`), never the model-supplied `input[...]` value.
  // The model arg could otherwise name an arbitrary session and unlock its
  // plan-file write carve-out (coding-common.ts `planFileContextFromArgs`).
  // The id is HMAC-signed so it verifies at that sink; if there is no
  // authoritative id, we inject nothing (no model-value fallback).
  const authoritativeSessionId = getSessionId();
  return typeof authoritativeSessionId === "string" &&
    authoritativeSessionId.trim().length > 0
    ? withSignedSessionId(mapped, authoritativeSessionId)
    : mapped;
}

const fileReadInputSchema = z.strictObject({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  pages: z.string().optional(),
});

const fileEditInputSchema = z.strictObject({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const fileWriteInputSchema = z.strictObject({
  file_path: z.string(),
  content: z.string(),
});

const grepInputSchema = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  "-B": z.number().optional(),
  "-A": z.number().optional(),
  "-C": z.number().optional(),
  context: z.number().optional(),
  "-n": z.boolean().optional(),
  "-i": z.boolean().optional(),
  head_limit: z.number().optional(),
  offset: z.number().optional(),
  multiline: z.boolean().optional(),
});

const globInputSchema = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
});

const bashInputSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
  timeoutMs: z.number().optional(),
});

const notebookEditInputSchema = z.strictObject({
  notebook_path: z.string(),
  cell_id: z.string().optional(),
  new_source: z.string().optional(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).optional(),
});

export const CanonicalBashTool = createCanonicalTool({
  name: "system.bash",
  aliases: ["Bash"],
  searchHint: "execute shell commands",
  maxResultSizeChars: Infinity,
  inputSchema: bashInputSchema,
  createRuntimeTool: (root) => createBashTool({ cwd: root }),
  mapInput: (input, root) => ({
    command: input.command,
    ...(Array.isArray(input.args) ? { args: input.args } : {}),
    cwd: typeof input.cwd === "string" ? input.cwd : root,
    ...(input.timeoutMs !== undefined
      ? { timeoutMs: input.timeoutMs }
      : input.timeout !== undefined
        ? { timeoutMs: input.timeout }
        : {}),
  }),
  userFacingName: () => "system.bash",
  summary: (input) =>
    typeof input.command === "string" ? input.command : "Run shell command",
  classifierInput: (input) => input.command,
  isSearchOrReadCommand: (input) =>
    typeof input.command === "string"
      ? classifyBashSearchOrRead(input.command)
      : { isSearch: false, isRead: false, isList: false },
});

export const CanonicalFileReadTool = createCanonicalTool({
  name: "FileRead",
  aliases: ["Read"],
  searchHint: "read local files",
  maxResultSizeChars: Infinity,
  inputSchema: fileReadInputSchema,
  createRuntimeTool: (root) => createFileReadTool({ allowedPaths: [root] }),
  getPath: (input) =>
    typeof input.file_path === "string" ? input.file_path : undefined,
  userFacingName: () => "FileRead",
  summary: (input) =>
    typeof input.file_path === "string" ? input.file_path : "Read file",
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
});

export const CanonicalFileEditTool = createCanonicalTool({
  name: "Edit",
  aliases: ["FileEdit"],
  searchHint: "edit local files",
  maxResultSizeChars: 30_000,
  inputSchema: fileEditInputSchema,
  createRuntimeTool: (root) => createFileEditTool({ allowedPaths: [root] }),
  getPath: (input) =>
    typeof input.file_path === "string" ? input.file_path : undefined,
  userFacingName: () => "Edit",
  summary: (input) =>
    typeof input.file_path === "string" ? input.file_path : "Edit file",
  classifierInput: (input) => ({
    file_path: input.file_path,
    old_string: input.old_string,
    new_string: input.new_string,
  }),
});

export const CanonicalFileWriteTool = createCanonicalTool({
  name: "Write",
  aliases: ["FileWrite"],
  searchHint: "write local files",
  maxResultSizeChars: 30_000,
  inputSchema: fileWriteInputSchema,
  createRuntimeTool: (root) => createFileWriteTool({ allowedPaths: [root] }),
  getPath: (input) =>
    typeof input.file_path === "string" ? input.file_path : undefined,
  userFacingName: () => "Write",
  summary: (input) =>
    typeof input.file_path === "string" ? input.file_path : "Write file",
  classifierInput: (input) => ({
    file_path: input.file_path,
    content: input.content,
  }),
});

export const CanonicalGrepTool = createCanonicalTool({
  name: "Grep",
  aliases: ["system.grep"],
  searchHint: "search file contents",
  maxResultSizeChars: 30_000,
  inputSchema: grepInputSchema,
  createRuntimeTool: (root) => createGrepTool({ allowedPaths: [root] }),
  getPath: (input) => (typeof input.path === "string" ? input.path : undefined),
  userFacingName: () => "Grep",
  summary: (input) =>
    typeof input.pattern === "string" ? input.pattern : "Search files",
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
});

export const CanonicalGlobTool = createCanonicalTool({
  name: "Glob",
  aliases: ["system.glob"],
  searchHint: "find files by pattern",
  maxResultSizeChars: 30_000,
  inputSchema: globInputSchema,
  createRuntimeTool: (root) => createGlobTool({ allowedPaths: [root] }),
  getPath: (input) => (typeof input.path === "string" ? input.path : undefined),
  userFacingName: () => "Glob",
  summary: (input) =>
    typeof input.pattern === "string" ? input.pattern : "Find files",
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
});

export const CanonicalNotebookEditTool = createCanonicalTool({
  name: "NotebookEdit",
  searchHint: "edit Jupyter notebook cells",
  maxResultSizeChars: 100_000,
  inputSchema: notebookEditInputSchema,
  createRuntimeTool: (root) =>
    createSystemNotebookEditTool({ workspaceRoot: root }),
  getPath: (input) =>
    typeof input.notebook_path === "string" ? input.notebook_path : undefined,
  userFacingName: () => "NotebookEdit",
  summary: (input) =>
    typeof input.notebook_path === "string"
      ? input.notebook_path
      : "Edit notebook",
  classifierInput: (input) => ({
    notebook_path: input.notebook_path,
    edit_mode: input.edit_mode,
    new_source: input.new_source,
  }),
});
