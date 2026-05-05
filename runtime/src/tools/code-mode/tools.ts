import type { FunctionCallOutputContentItem } from "../context.js";
import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import {
  buildExecToolDescription,
  buildWaitToolDescription,
  codeModeToolDefinitionsFromTools,
  parseExecSource,
} from "./description.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_WAIT_YIELD_TIME_MS,
  type CodeModeRuntimeResponse,
  type CodeModeService,
  type CodeModeToolFactoryOptions,
} from "./types.js";

export interface CodeModeToolResultOptions {
  readonly maxOutputTokens?: number;
}

function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

function renderContentItem(item: FunctionCallOutputContentItem): string {
  if (item.type === "input_text") return item.text;
  const suffix = item.detail ? ` detail=${item.detail}` : "";
  return `[image ${item.image_url}${suffix}]`;
}

function renderContentItems(
  contentItems: readonly FunctionCallOutputContentItem[],
): string {
  return contentItems.map(renderContentItem).join("\n");
}

function truncateApproxTokens(text: string, maxOutputTokens: number): string {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return text;
  const maxChars = Math.max(256, Math.floor(maxOutputTokens * 4));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[output truncated to approximately ${maxOutputTokens} tokens]`;
}

export function codeModeRuntimeResponseToToolResult(
  response: CodeModeRuntimeResponse,
  options: CodeModeToolResultOptions = {},
): ToolResult {
  const maxOutputTokens =
    options.maxOutputTokens !== undefined
      ? options.maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const output = renderContentItems(response.contentItems);
  const lines: string[] = [];

  switch (response.type) {
    case "yielded":
      lines.push(`Script running with cell ID ${response.cellId}`);
      break;
    case "terminated":
      lines.push("Script terminated");
      break;
    case "result":
      lines.push(response.errorText ? "Script failed" : "Script completed");
      break;
  }

  lines.push(`Wall time ${seconds(response.durationMs)} seconds`);
  if (output.length > 0) {
    lines.push("Output:");
    lines.push(output);
  }
  if (response.type === "result" && response.errorText) {
    lines.push("Script error:");
    lines.push(response.errorText);
  }

  const content = truncateApproxTokens(lines.join("\n"), maxOutputTokens);
  const richItems: FunctionCallOutputContentItem[] = [
    { type: "input_text", text: lines.slice(0, 2).join("\n") },
  ];
  if (response.contentItems.length > 0) richItems.push(...response.contentItems);
  if (response.type === "result" && response.errorText) {
    richItems.push({
      type: "input_text",
      text: `Script error:\n${response.errorText}`,
    });
  }

  return {
    content,
    isError: response.type === "result" && response.errorText !== undefined,
    contentItems: richItems,
    metadata: {
      codeMode: true,
      cellId: response.cellId,
      responseType: response.type,
      durationMs: response.durationMs,
    },
  };
}

function readStringArg(
  args: Record<string, unknown>,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return value;
  }
  throw new Error(`${names[0] ?? "value"} must be a string`);
}

function readOptionalInteger(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return number;
}

function callId(args: Record<string, unknown>): string {
  const injected = args as ToolExecutionInjectedArgs;
  return injected.__callId ?? `exec-${Date.now().toString(36)}`;
}

async function executeCodeMode(
  service: CodeModeService,
  enabledTools: readonly Tool[],
  stringArgumentFields: Readonly<Record<string, string>> | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const source = readStringArg(args, ["code", "source", "input"]);
  const parsed = parseExecSource(source);
  const response = await service.execute({
    cellId: service.allocateCellId(),
    toolCallId: callId(args),
    enabledTools: codeModeToolDefinitionsFromTools(enabledTools, {
      stringArgumentFields,
    }),
    source: parsed.code,
    storedValues: await service.storedValues(),
    yieldTimeMs: parsed.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
    maxOutputTokens: parsed.maxOutputTokens,
  });
  return codeModeRuntimeResponseToToolResult(response, {
    maxOutputTokens: parsed.maxOutputTokens,
  });
}

async function waitCodeMode(
  service: CodeModeService,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const cellId = readStringArg(args, ["cell_id", "cellId"]);
  const maxOutputTokens =
    readOptionalInteger(args, "max_tokens") ??
    readOptionalInteger(args, "maxOutputTokens");
  const response = await service.wait({
    cellId,
    yieldTimeMs:
      readOptionalInteger(args, "yield_time_ms") ??
      readOptionalInteger(args, "yieldTimeMs") ??
      DEFAULT_WAIT_YIELD_TIME_MS,
    maxOutputTokens,
    terminate: args["terminate"] === true,
  });
  return codeModeRuntimeResponseToToolResult(response, {
    maxOutputTokens,
  });
}

export function createCodeModeTools(
  opts: CodeModeToolFactoryOptions,
): readonly Tool[] {
  const execTool: Tool = {
    name: CODE_MODE_EXEC_TOOL_NAME,
    description: buildExecToolDescription(
      codeModeToolDefinitionsFromTools(
        opts.descriptionTools ?? opts.getEnabledTools(),
        { stringArgumentFields: opts.stringArgumentFields },
      ),
    ),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: {
          type: "string",
          description:
            "Raw JavaScript source. May start with // @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}.",
        },
      },
      required: ["code"],
    },
    metadata: {
      family: "code_mode",
      source: "builtin",
      mutating: true,
      keywords: ["javascript", "compose", "tools", "exec", "code mode"],
    },
    supportsParallelToolCalls: false,
    recoveryCategory: "side-effecting",
    interruptBehavior: () => "cancel",
    execute: (args) =>
      executeCodeMode(
        opts.service,
        opts.getEnabledTools(),
        opts.stringArgumentFields,
        args,
      ),
  };

  const waitTool: Tool = {
    name: CODE_MODE_WAIT_TOOL_NAME,
    description: buildWaitToolDescription(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cell_id: {
          type: "string",
          description: "Cell ID returned by exec.",
        },
        yield_time_ms: {
          type: "integer",
          minimum: 0,
          description: "Milliseconds to wait before yielding again.",
        },
        max_tokens: {
          type: "integer",
          minimum: 0,
          description: "Approximate maximum output tokens for this wait call.",
        },
        terminate: {
          type: "boolean",
          description: "Terminate the running cell instead of waiting.",
        },
      },
      required: ["cell_id"],
    },
    metadata: {
      family: "code_mode",
      source: "builtin",
      mutating: false,
      keywords: ["javascript", "wait", "cell", "code mode"],
    },
    isReadOnly: true,
    supportsParallelToolCalls: false,
    recoveryCategory: "side-effecting",
    execute: (args) => waitCodeMode(opts.service, args),
  };

  return [execTool, waitTool];
}
