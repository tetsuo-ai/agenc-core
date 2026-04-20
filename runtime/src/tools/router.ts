/**
 * ToolRouter — dispatch to tool handlers with parallel-support
 * classification.
 *
 * Hand-port of codex `core/src/tools/router.rs` (306 LOC). Holds the
 * per-tool spec registry + the parallel-MCP-server allowlist so
 * `toolSupportsParallel(call)` has the information it needs without
 * plumbing through the ToolCallRuntime.
 *
 * AgenC keeps this focused: function tools (from the registry),
 * MCP tools (from T9 connections), and a discoverable-tool future slot.
 *
 * @module
 */

import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { Tool } from "./types.js";
import {
  parseToolName,
  type ToolCallSource,
  type ToolInvocation,
  type ToolName,
  type ToolPayload,
} from "./context.js";

export interface ToolCall {
  readonly toolName: ToolName;
  readonly callId: string;
  readonly payload: ToolPayload;
}

export interface ConfiguredToolSpec {
  readonly tool: Tool;
  readonly supportsParallelToolCalls: boolean;
  readonly serverId?: string;
}

// ─────────────────────────────────────────────────────────────────────
// ToolRouter
// ─────────────────────────────────────────────────────────────────────

export interface ToolRouterOpts {
  /**
   * Allowlist of MCP server IDs whose tools can run in parallel
   * within a batch. Mirrors codex `parallel_mcp_server_names`
   * (router.rs:42). Empty by default = MCP tools serialize per server.
   * T9 wires from config.
   */
  readonly parallelMcpServerNames?: ReadonlySet<string>;
}

export class ToolRouter {
  private readonly specs: ConfiguredToolSpec[];
  private readonly byName = new Map<string, ConfiguredToolSpec>();
  private readonly parallelMcpServerNames: ReadonlySet<string>;

  constructor(
    specs: ReadonlyArray<ConfiguredToolSpec>,
    opts: ToolRouterOpts = {},
  ) {
    this.specs = [...specs];
    for (const spec of this.specs) this.byName.set(spec.tool.name, spec);
    this.parallelMcpServerNames = opts.parallelMcpServerNames ?? new Set();
  }

  /** All registered configured-tool specs. */
  getSpecs(): ReadonlyArray<ConfiguredToolSpec> {
    return this.specs;
  }

  /** LLMTool array for provider requests. */
  modelVisibleSpecs(): ReadonlyArray<LLMTool> {
    return this.specs.map((config) => ({
      type: "function",
      function: {
        name: config.tool.name,
        description: config.tool.description,
        parameters: config.tool.inputSchema,
      },
    }));
  }

  /** Look up a single spec. */
  findSpec(toolName: ToolName | string): ConfiguredToolSpec | undefined {
    const name =
      typeof toolName === "string" ? toolName : toolName.namespace
        ? `${toolName.namespace}.${toolName.name}`
        : toolName.name;
    return this.byName.get(name);
  }

  /**
   * Port of codex `tool_supports_parallel` (router.rs:161-169).
   *
   *   - MCP tools: parallel iff the owning server is in the allowlist.
   *   - Everything else: check the registered spec's
   *     `supportsParallelToolCalls` flag.
   */
  toolSupportsParallel(call: ToolCall): boolean {
    if (call.payload.kind === "mcp") {
      return this.parallelMcpServerNames.has(call.payload.server);
    }
    const spec = this.findSpec(call.toolName);
    return spec?.supportsParallelToolCalls === true;
  }

  /**
   * Dispatch a ToolCall. Returns the raw ToolDispatchResult from the
   * underlying Tool's `execute` method. Higher-level timeout / size-cap
   * / hook wrapping lives in `tools/execution.ts`.
   */
  async dispatchToolCall(
    invocation: ToolInvocation,
    args: Record<string, unknown>,
  ): Promise<ToolDispatchResult> {
    const spec = this.findSpec(invocation.toolName);
    if (!spec) {
      return {
        content: JSON.stringify({
          error: `unknown tool: ${
            invocation.toolName.namespace
              ? `${invocation.toolName.namespace}.${invocation.toolName.name}`
              : invocation.toolName.name
          }`,
        }),
        isError: true,
      };
    }
    try {
      const result = await spec.tool.execute(args);
      return { content: result.content, isError: result.isError };
    } catch (err) {
      return {
        content: JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
        isError: true,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience: build a ToolRouter from an existing ToolRegistry.
// ─────────────────────────────────────────────────────────────────────

/**
 * Bridges the existing `ToolRegistry` (tool-registry.ts) into a
 * `ToolRouter` — the router subsumes the registry's dispatch surface
 * and adds parallel-support classification. T7-C updates the
 * registry to tag each tool with the flag.
 */
export function routerFromRegistry(
  registry: ToolRegistry,
  opts: ToolRouterOpts = {},
): ToolRouter {
  const specs: ConfiguredToolSpec[] = registry.tools.map((tool) => ({
    tool,
    supportsParallelToolCalls:
      (tool as Tool & { supportsParallelToolCalls?: boolean })
        .supportsParallelToolCalls ?? false,
    ...((tool as Tool & { serverId?: string }).serverId !== undefined
      ? { serverId: (tool as Tool & { serverId?: string }).serverId }
      : {}),
  }));
  return new ToolRouter(specs, opts);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers: build a ToolCall envelope from a raw LLMToolCall.
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert an incoming LLMToolCall into the ToolCall envelope the
 * router expects. Raw args stay as a string; execution.ts does the
 * large-int-safe parsing (I-79).
 */
export function toolCallFromLLMToolCall(
  llmCall: LLMToolCall,
  opts: { readonly source?: ToolCallSource } = {},
): ToolCall {
  void opts;
  const toolName = parseToolName(llmCall.name);
  const args = llmCall.arguments ?? "";
  const payload: ToolPayload = toolName.namespace?.startsWith("mcp")
    ? {
        kind: "mcp",
        server: toolName.namespace ?? "",
        tool: toolName.name,
        rawArguments: args,
      }
    : { kind: "function", arguments: args };
  return {
    toolName,
    callId: llmCall.id,
    payload,
  };
}
