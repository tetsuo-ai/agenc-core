/**
 * Tool registry — the lean coding-profile surface.
 *
 * Holds the 35 surviving coding tools and exposes two things the
 * query loop needs:
 *
 *   - `toLLMTools()` → `LLMTool[]` for the provider request payload
 *   - `dispatch(toolCall)` → runs the tool and returns the result
 *     as a `ToolDispatchResult` that becomes the tool message body
 *
 * Build once per session. The registry is intentionally flat — every
 * surviving tool registers into one list with no grouping, no
 * permission gating layer (that comes later), no MCP forwarding yet.
 *
 * @module
 */

import type { LLMTool, LLMToolCall } from "./llm/types.js";
import type { Tool } from "./tools/types.js";
import { safeStringify } from "./tools/types.js";
import {
  createFilesystemTools,
  createCodingTools,
  createHttpTools,
  createBashTool,
} from "./tools/system/index.js";
import {
  defaultConcurrencyClassFor,
  isBashTool,
  isReadOnlyFilesystemTool,
  isWriteFilesystemTool,
  type ConcurrencyClass,
} from "./tools/concurrency.js";

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolRegistry {
  readonly tools: readonly Tool[];
  toLLMTools(): LLMTool[];
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult>;
}

function toolToLLMTool(tool: Tool): LLMTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * T7: attach ConcurrencyClass + other execution metadata to a Tool.
 * Idempotent — tools that already declared their own metadata win.
 */
function tagTool(tool: Tool): Tool {
  const baseClass: ConcurrencyClass =
    tool.concurrencyClass ?? defaultConcurrencyClassFor(tool.name);
  const isReadOnly = tool.isReadOnly ?? isReadOnlyFilesystemTool(tool.name);
  const supportsParallelToolCalls =
    tool.supportsParallelToolCalls ??
    (baseClass.kind === "shared_read" ||
      baseClass.kind === "shared_server");

  // write-filesystem + bash tools require approval under granular mode;
  // they never declare `requiresApproval` explicitly today so we surface
  // a conservative default via the orchestrator.
  const requiresApproval =
    tool.requiresApproval ??
    (isWriteFilesystemTool(tool.name) || isBashTool(tool.name));

  // isConcurrencySafe: SharedRead tools stay safe by default. The bash
  // tool's concurrency depends on its args (e.g. a read-only command
  // is safe, a `rm -rf` isn't) — leave the hook to the registered
  // tool's own implementation when it provides one.
  const isConcurrencySafe =
    tool.isConcurrencySafe ??
    (() =>
      baseClass.kind === "shared_read" || baseClass.kind === "shared_server");

  return {
    ...tool,
    concurrencyClass: baseClass,
    isReadOnly,
    supportsParallelToolCalls,
    requiresApproval,
    isConcurrencySafe,
  };
}

function parseToolCallArguments(
  toolCall: LLMToolCall,
): Record<string, unknown> {
  const raw = toolCall.arguments ?? "";
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface BuildToolRegistryOptions {
  readonly workspaceRoot: string;
  readonly allowBashDelete?: boolean;
}

/**
 * Build the coding-profile tool registry.
 *
 * Registers: filesystem (readFile, writeFile, editFile, appendFile,
 * listDir, stat, mkdir, delete, move, glob, grep), coding helpers,
 * http (fetch/get/post/browse/extractLinks/htmlToMarkdown), and bash.
 *
 * The 35-tool set in TODO.MD resolves to ~30 concrete Tool objects
 * because some namespaces (git*, symbol*, TodoWrite, workflow) are
 * still being wired in — they land in later tranches.
 */
export function buildToolRegistry(
  options: BuildToolRegistryOptions,
): ToolRegistry {
  const rawTools: Tool[] = [
    ...createFilesystemTools({
      allowedPaths: [options.workspaceRoot],
      allowDelete: options.allowBashDelete ?? false,
    }),
    ...createCodingTools({
      allowedPaths: [options.workspaceRoot],
      persistenceRootDir: options.workspaceRoot,
    }),
    ...createHttpTools({
      allowedDomains: ["*"],
    }),
    createBashTool({
      cwd: options.workspaceRoot,
    }),
  ];

  // T7: tag each registered tool with its ConcurrencyClass + flags.
  // Tools without explicit metadata get sensible defaults:
  //   - readFile/listDir/stat/glob/grep → SharedRead + isReadOnly
  //   - writeFile/editFile/delete/move    → Exclusive (never parallel)
  //   - http.*                            → SharedRead (network reads)
  //   - bash                              → BackgroundTerminal (subprocess)
  const tools: Tool[] = rawTools.map((tool) => tagTool(tool));

  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }

  return {
    tools,
    toLLMTools(): LLMTool[] {
      return tools.map(toolToLLMTool);
    },
    async dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult> {
      const tool = byName.get(toolCall.name);
      if (!tool) {
        return {
          content: safeStringify({
            error: `unknown tool: ${toolCall.name}`,
          }),
          isError: true,
        };
      }
      try {
        const args = parseToolCallArguments(toolCall);
        const result = await tool.execute(args);
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        return {
          content: safeStringify({
            error: error instanceof Error ? error.message : String(error),
          }),
          isError: true,
        };
      }
    },
  };
}
