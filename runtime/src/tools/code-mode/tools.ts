import type { Tool, ToolExecutionInjectedArgs, ToolResult } from "../types.js";
import {
  buildExecToolDescription,
  buildWaitToolDescription,
  codeModeToolDefinitionsFromTools,
  parseExecSource,
} from "./description.js";
import { codeModeRuntimeResponseToToolResult } from "./response-adapter.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_WAIT_YIELD_TIME_MS,
  type CodeModeService,
  type CodeModeToolFactoryOptions,
} from "./types.js";

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
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const source = readStringArg(args, ["code", "source", "input"]);
  const parsed = parseExecSource(source);
  const response = await service.execute({
    cellId: service.allocateCellId(),
    toolCallId: callId(args),
    enabledTools: codeModeToolDefinitionsFromTools(enabledTools),
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
    interruptBehavior: () => "cancel",
    execute: (args) =>
      executeCodeMode(opts.service, opts.getEnabledTools(), args),
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
    execute: (args) => waitCodeMode(opts.service, args),
  };

  return [execTool, waitTool];
}
