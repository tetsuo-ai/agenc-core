/**
 * Tool registry — the lean coding-profile surface.
 *
 * Holds the coding-profile tool catalog and exposes two things the
 * query loop needs:
 *
 *   - `toLLMTools()` → `LLMTool[]` for the provider request payload
 *   - `dispatch(toolCall)` → runs the tool and returns the result
 *     as a `ToolDispatchResult` that becomes the tool message body
 *
 * Build once per session. The registry is intentionally flat — every
 * surviving tool registers into one router-backed list with no grouping.
 * The provider-visible catalog is request scoped: Codex-primary tools
 * are visible by default, while compatibility built-ins, MCP, and
 * explicitly deferred tools become visible after discovery.
 *
 * @module
 */

import type { LLMTool, LLMToolCall } from "./llm/types.js";
import type { Tool, ToolCatalogEntry, ToolMetadata } from "./tools/types.js";
import { safeStringify } from "./tools/types.js";
import {
  createFilesystemTools,
  createCodingTools,
  createHttpTools,
  createBashTool,
  createExecCommandTool,
  createWriteStdinTool,
  createPlanningTools,
  createApplyPatchTool,
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
} from "./tools/system/index.js";
import type { BashExecObserver } from "./tools/system/types.js";
import type { WorkflowToolController } from "./tools/system/index.js";
import {
  UnifiedExecProcessManager,
  type UnifiedExecProcessManagerLike,
} from "./unified-exec/index.js";
import {
  defaultConcurrencyClassFor,
  isBashTool,
  isReadOnlyFilesystemTool,
  isWriteFilesystemTool,
  SHARED_READ,
  sharedServer,
  type ConcurrencyClass,
} from "./tools/concurrency.js";
import {
  ToolRouter,
  type ConfiguredToolSpec,
} from "./tools/router.js";

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  /**
   * Upstream-shaped value exposed to code-mode nested tool calls.
   * Normal model/TUI consumers keep using `content`.
   */
  readonly codeModeResult?: unknown;
}

export interface ToolRegistry {
  readonly tools: readonly Tool[];
  toLLMTools(): LLMTool[];
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult>;
  getDiscoveredToolNames?(): ReadonlySet<string>;
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
function inferMcpServerId(toolName: string): string | undefined {
  const parts = toolName.split(".");
  if (parts.length < 3 || parts[0] !== "mcp") return undefined;
  const serverId = parts[1]?.trim();
  return serverId && serverId.length > 0 ? serverId : undefined;
}

function tagTool(tool: Tool, opts: { readonly serverId?: string } = {}): Tool {
  const serverId = opts.serverId ?? tool.serverId ?? inferMcpServerId(tool.name);
  const inferredReadOnly =
    tool.metadata?.mutating === false || isReadOnlyFilesystemTool(tool.name);
  const baseClass: ConcurrencyClass =
    tool.concurrencyClass ??
    (serverId
      ? sharedServer(serverId)
      : inferredReadOnly
        ? SHARED_READ
        : defaultConcurrencyClassFor(tool.name));
  const isReadOnly = tool.isReadOnly ?? inferredReadOnly;
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
    ...(serverId ? { serverId } : {}),
    isReadOnly,
    supportsParallelToolCalls,
    requiresApproval,
    isConcurrencySafe,
  };
}

type ToolListProvider = {
  readonly getTools: () => readonly Tool[];
};

type ToolListInput = readonly Tool[] | (() => readonly Tool[]);

function readToolList(input: ToolListInput | undefined): readonly Tool[] {
  if (input === undefined) return [];
  return typeof input === "function" ? input() : input;
}

function toolMap(tools: readonly Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function withMetadata(
  tool: Tool,
  updates: {
    readonly source?: ToolMetadata["source"];
    readonly family?: string;
    readonly deferred?: boolean;
    readonly hiddenByDefault?: boolean;
    readonly mutating?: boolean;
  },
): Tool {
  const metadata: ToolMetadata = {
    ...(tool.metadata ?? {}),
    ...(updates.source !== undefined ? { source: updates.source } : {}),
    ...(updates.family !== undefined ? { family: updates.family } : {}),
    ...(updates.deferred !== undefined ? { deferred: updates.deferred } : {}),
    ...(updates.hiddenByDefault !== undefined
      ? { hiddenByDefault: updates.hiddenByDefault }
      : {}),
    ...(updates.mutating !== undefined ? { mutating: updates.mutating } : {}),
  };
  return { ...tool, metadata };
}

function catalogEntryForTool(
  tool: Tool,
  spec?: ConfiguredToolSpec,
): ToolCatalogEntry {
  const metadata = tool.metadata ?? {};
  const family = metadata.family ?? tool.name.split(".")[0] ?? "tool";
  const source = metadata.source ?? "builtin";
  const hiddenByDefault = metadata.hiddenByDefault ?? false;
  const mutating = metadata.mutating ?? tool.requiresApproval === true;
  const deferred = spec?.deferred === true || metadata.deferred === true;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    metadata: {
      family,
      source,
      hiddenByDefault,
      mutating,
      deferred,
      ...(metadata.keywords !== undefined ? { keywords: metadata.keywords } : {}),
      ...(metadata.preferredProfiles !== undefined
        ? { preferredProfiles: metadata.preferredProfiles }
        : {}),
    },
  };
}

function specForTool(tool: Tool): ConfiguredToolSpec {
  return {
    tool,
    supportsParallelToolCalls: tool.supportsParallelToolCalls ?? false,
    ...(tool.serverId !== undefined ? { serverId: tool.serverId } : {}),
    ...(tool.metadata?.deferred === true ? { deferred: true } : {}),
  };
}

const STRING_ARGUMENT_TOOL_FIELDS: Readonly<Record<string, string>> = {
  apply_patch: "patch",
  exec_command: "cmd",
  "system.bash": "command",
  "system.readFile": "path",
  "system.writeFile": "path",
  "system.appendFile": "path",
  "system.editFile": "path",
  "system.listDir": "path",
  "system.stat": "path",
  "system.mkdir": "path",
  "system.delete": "path",
  "system.glob": "pattern",
};

const DEFAULT_VISIBLE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "apply_patch",
  "update_plan",
  "TodoWrite",
  "EnterPlanMode",
  "ExitPlanMode",
  "system.agent.delegate",
  "system.searchTools",
]);

function codexPrimarySurface(tool: Tool): Tool {
  if (DEFAULT_VISIBLE_BUILTIN_TOOLS.has(tool.name)) return tool;
  if (tool.metadata?.source && tool.metadata.source !== "builtin") return tool;
  if (tool.metadata?.deferred === true) return tool;
  return withMetadata(tool, { deferred: true });
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
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (typeof parsed === "string") {
      const field = STRING_ARGUMENT_TOOL_FIELDS[toolCall.name];
      return field ? { [field]: parsed } : {};
    }
    return {};
  } catch {
    const field = STRING_ARGUMENT_TOOL_FIELDS[toolCall.name];
    if (field && raw.trim().length > 0) {
      return { [field]: raw };
    }
    return {};
  }
}

export interface BuildToolRegistryOptions {
  readonly workspaceRoot: string;
  readonly allowBashDelete?: boolean;
  /**
   * T6 gap #119: observer that receives `exec_command_begin` /
   * `exec_command_end` lifecycle hooks from the bash tool. Session
   * owners wire this through `createBashExecObserverForSession`
   * (runtime/src/session/observer-wiring.ts) so the events land in
   * the session event log + rollout. When omitted, the bash tool
   * runs without a lifecycle observer.
   */
  readonly bashExecObserver?: BashExecObserver;
  /** Shared Codex-style unified exec process manager for exec_command/write_stdin. */
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
  /**
   * Live MCP tool source. This is intentionally a provider instead of a
   * one-time array because MCP startup happens after SessionConfigured.
   */
  readonly mcpToolsProvider?: ToolListProvider;
  /**
   * Hide MCP tool schemas until `system.searchTools` discovers them.
   * This mirrors codex's deferred MCP catalog path and prevents large
   * MCP installs from bloating every request by default.
   */
  readonly deferMcpTools?: boolean;
  /** Runtime-injected dynamic tools. Tools with metadata.deferred are
   * hidden until discovery; all others are visible immediately. */
  readonly dynamicTools?: ToolListInput;
  /** Late-load tools that should be searchable but not advertised until
   * discovered. */
  readonly deferredTools?: ToolListInput;
  /** Optional discoverable tools. These are cataloged and visible unless
   * their own metadata marks them deferred. */
  readonly discoverableTools?: ToolListInput;
  readonly unavailableCalledTools?: readonly string[];
  readonly parallelMcpServerNames?: ReadonlySet<string>;
  /**
   * Include AgenC-owned structured git/symbol/repo-inventory tools in
   * the catalog. Defaults to true, but those tools stay deferred so the
   * default model-visible prompt remains Codex-small.
   */
  readonly codeIntelligenceTools?: boolean;
  /** Live plan-mode bridge for workflow.enterPlan/workflow.exitPlan. */
  readonly workflowController?: WorkflowToolController;
  /**
   * T9 integration seam: extra tools to register beyond the default
   * coding-profile catalog. The CLI entrypoint uses this to expose
   * `system.agent.delegate` (the subagent spawn dispatcher) as a
   * first-class tool the model can invoke.
   */
  readonly extraTools?: ReadonlyArray<Tool>;
}

/**
 * Build the coding-profile tool registry.
 *
 * Registers: filesystem (readFile, writeFile, editFile, appendFile,
 * listDir, stat, mkdir, delete, move, glob, grep), coding helpers,
 * http (fetch/get/post/browse/extractLinks/htmlToMarkdown), bash,
 * Codex-style apply_patch, and planning tools.
 *
 * The default visible set stays small. Heavy AgenC-owned git/symbol
 * inventory tools and Claude-compatible workflow aliases are registered
 * as deferred entries and load through `system.searchTools`.
 */
export function buildToolRegistry(
  options: BuildToolRegistryOptions,
): ToolRegistry {
  const unifiedExecManager =
    options.unifiedExecManager ??
    new UnifiedExecProcessManager({ cwd: options.workspaceRoot });
  const discoveredToolNames = new Set<string>();
  const markDiscovered = (toolNames: readonly string[]): void => {
    for (const name of toolNames) {
      if (typeof name === "string" && name.trim().length > 0) {
        discoveredToolNames.add(name);
      }
    }
  };

  const defaultBuiltinTools: Tool[] = [
    ...createFilesystemTools({
      allowedPaths: [options.workspaceRoot],
      allowDelete: options.allowBashDelete ?? false,
    }),
    ...createCodingTools({
      allowedPaths: [options.workspaceRoot],
      persistenceRootDir: options.workspaceRoot,
      codeIntelligenceTools: options.codeIntelligenceTools ?? true,
      getToolCatalog: () =>
        buildRouter()
          .getSpecs()
          .map((spec) => catalogEntryForTool(spec.tool, spec)),
      onDiscoverTools: markDiscovered,
    }),
    ...createHttpTools({
      allowedDomains: ["*"],
    }),
    createExecCommandTool({
      cwd: options.workspaceRoot,
      allowedPaths: [options.workspaceRoot],
      unifiedExecManager,
      ...(options.bashExecObserver !== undefined
        ? { execObserver: options.bashExecObserver }
        : {}),
    }),
    createWriteStdinTool({
      cwd: options.workspaceRoot,
      unifiedExecManager,
    }),
    createBashTool({
      cwd: options.workspaceRoot,
      ...(options.bashExecObserver !== undefined
        ? { execObserver: options.bashExecObserver }
        : {}),
    }),
    createApplyPatchTool({
      allowedPaths: [options.workspaceRoot],
    }),
    ...createPlanningTools({
      ...(options.workflowController !== undefined
        ? { workflowController: options.workflowController }
        : {}),
    }),
  ].map((tool) => tagTool(codexPrimarySurface(tool)));
  const extraTools: Tool[] = (options.extraTools ?? []).map((tool) =>
    tagTool(tool),
  );
  const staticTools: Tool[] = [...defaultBuiltinTools, ...extraTools];

  // T7: tag each registered tool with its ConcurrencyClass + flags.
  // Tools without explicit metadata get sensible defaults:
  //   - readFile/listDir/stat/glob/grep → SharedRead + isReadOnly
  //   - writeFile/editFile/delete/move    → Exclusive (never parallel)
  //   - http.*                            → SharedRead (network reads)
  //   - bash                              → BackgroundTerminal (subprocess)
  function currentMcpTools(): readonly Tool[] {
    return (options.mcpToolsProvider?.getTools() ?? []).map((tool) => {
      const serverId = inferMcpServerId(tool.name);
      return tagTool(
        withMetadata(tool, {
          source: "mcp",
          family: "mcp",
          deferred: options.deferMcpTools ?? true,
        }),
        serverId ? { serverId } : {},
      );
    });
  }

  function currentDynamicTools(): readonly Tool[] {
    return readToolList(options.dynamicTools).map((tool) =>
      tagTool(withMetadata(tool, { source: tool.metadata?.source ?? "plugin" })),
    );
  }

  function currentDeferredTools(): readonly Tool[] {
    return readToolList(options.deferredTools).map((tool) =>
      tagTool(
        withMetadata(tool, {
          source: tool.metadata?.source ?? "plugin",
          deferred: true,
        }),
      ),
    );
  }

  function currentDiscoverableTools(): readonly Tool[] {
    return readToolList(options.discoverableTools).map((tool) =>
      tagTool(withMetadata(tool, { source: tool.metadata?.source ?? "plugin" })),
    );
  }

  function buildRouter(): ToolRouter {
    const baseSpecs = staticTools.map(specForTool);
    const mcpTools = currentMcpTools();
    const directMcpTools = mcpTools.filter(
      (tool) => tool.metadata?.deferred !== true,
    );
    const deferredMcpTools = mcpTools.filter(
      (tool) => tool.metadata?.deferred === true,
    );
    return ToolRouter.fromConfig({
      baseSpecs,
      mcpTools: toolMap(directMcpTools),
      deferredMcpTools: toolMap(deferredMcpTools),
      discoverableTools: currentDiscoverableTools(),
      dynamicTools: [...currentDynamicTools(), ...currentDeferredTools()],
      unavailableCalledTools: options.unavailableCalledTools ?? [],
      ...(options.parallelMcpServerNames !== undefined
        ? { parallelMcpServerNames: options.parallelMcpServerNames }
        : {}),
    });
  }

  function allSpecs(): readonly ConfiguredToolSpec[] {
    return buildRouter().getSpecs();
  }

  function visibleSpecs(): readonly ConfiguredToolSpec[] {
    return allSpecs().filter(
      (spec) =>
        spec.deferred !== true || discoveredToolNames.has(spec.tool.name),
    );
  }

  return {
    get tools(): readonly Tool[] {
      return allSpecs().map((spec) => spec.tool);
    },
    toLLMTools(): LLMTool[] {
      return visibleSpecs().map((spec) => toolToLLMTool(spec.tool));
    },
    getDiscoveredToolNames(): ReadonlySet<string> {
      return discoveredToolNames;
    },
    async dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult> {
      const router = buildRouter();
      const spec = router.findSpec(toolCall.name);
      if (!spec) {
        return {
          content: safeStringify({
            error: `unknown tool: ${toolCall.name}`,
          }),
          isError: true,
        };
      }
      try {
        const args = parseToolCallArguments(toolCall);
        if (spec.tool.name === "system.searchTools") {
          Object.defineProperty(args, SESSION_ADVERTISED_TOOL_NAMES_ARG, {
            value: visibleSpecs().map((visible) => visible.tool.name),
            enumerable: false,
            configurable: true,
          });
        }
        const result = await spec.tool.execute(args);
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
