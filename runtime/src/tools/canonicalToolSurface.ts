import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/index.mjs";
import { z } from "zod/v4";

import { getSessionId } from "../bootstrap/state.js";
import { getCwd } from "../utils/cwd.js";
import { createBashTool } from "./system/bash.js";
import { createFileEditTool } from "./system/file-edit.js";
import { createFileReadTool } from "./system/file-read.js";
import { createFileWriteTool } from "./system/file-write.js";
import { createGlobTool } from "./system/glob.js";
import { createGrepTool } from "./system/grep.js";
import { SESSION_ID_ARG } from "./system/filesystem.js";
import { createNotebookEditTool as createSystemNotebookEditTool } from "./system/notebook-edit.js";
import type { Tool as RuntimeTool, ToolResult as RuntimeToolResult } from "./types.js";
import { buildTool, type Tool, type ToolUseContext } from "./Tool.js";

type RuntimeToolFactory = (workspaceRoot: string) => RuntimeTool;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function createCanonicalTool(options: CanonicalToolOptions): Tool {
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
      return options.createRuntimeTool(workspaceRoot()).description;
    },
    isConcurrencySafe(input) {
      const root = workspaceRoot();
      const runtimeTool = options.createRuntimeTool(root);
      return (
        runtimeTool.isConcurrencySafe?.(mapCanonicalInput(options, input, root)) ??
        runtimeTool.isReadOnly === true
      );
    },
    isReadOnly(input) {
      const root = workspaceRoot();
      const runtimeTool = options.createRuntimeTool(root);
      return (
        runtimeTool.isReadOnly === true ||
        runtimeTool.isConcurrencySafe?.(mapCanonicalInput(options, input, root)) === true
      );
    },
    async checkPermissions(input, context) {
      const root = workspaceRoot();
      const runtimeTool = options.createRuntimeTool(root);
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
    async call(input, context) {
      const root = workspaceRoot();
      const runtimeTool = options.createRuntimeTool(root);
      const result = await runtimeTool.execute({
        ...mapCanonicalInput(options, input, root),
        __abortSignal: context.abortController.signal,
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
  const suppliedSessionId = input[SESSION_ID_ARG];
  return {
    ...mapped,
    [SESSION_ID_ARG]:
      typeof suppliedSessionId === "string" && suppliedSessionId.trim().length > 0
        ? suppliedSessionId
        : getSessionId(),
  };
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
  maxResultSizeChars: 30_000,
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
  searchHint: "search file contents",
  maxResultSizeChars: 30_000,
  inputSchema: grepInputSchema,
  createRuntimeTool: (root) => createGrepTool({ allowedPaths: [root] }),
  getPath: (input) => (typeof input.path === "string" ? input.path : undefined),
  userFacingName: () => "Grep",
  summary: (input) =>
    typeof input.pattern === "string" ? input.pattern : "Search files",
});

export const CanonicalGlobTool = createCanonicalTool({
  name: "Glob",
  searchHint: "find files by pattern",
  maxResultSizeChars: 30_000,
  inputSchema: globInputSchema,
  createRuntimeTool: (root) => createGlobTool({ allowedPaths: [root] }),
  getPath: (input) => (typeof input.path === "string" ? input.path : undefined),
  userFacingName: () => "Glob",
  summary: (input) =>
    typeof input.pattern === "string" ? input.pattern : "Find files",
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
