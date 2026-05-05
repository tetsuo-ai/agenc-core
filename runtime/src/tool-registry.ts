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
 * The provider-visible catalog is request scoped: runtime-primary tools
 * are visible by default, while compatibility built-ins, MCP, and
 * explicitly deferred tools become visible after discovery.
 *
 * Prompt attachment surfaces, including File mention rendering for
 * `@path`, are catalog-adjacent but are not provider-visible tools.
 * They are resolved in `runtime/src/prompts/attachments/` before the
 * request reaches this registry's provider tool payload.
 *
 * @module
 */

import type { LLMTool, LLMToolCall } from "./llm/types.js";
import type { FunctionCallOutputContentItem } from "./tools/context.js";
import type {
  Tool,
  ToolCatalogEntry,
  ToolMetadata,
  ToolRecoveryCategory,
} from "./tools/types.js";
import { safeStringify } from "./tools/types.js";
import type { ToolsConfig } from "./config/schema.js";
import {
  createFilesystemTools,
  createCodingTools,
  createBashTool,
  createExecCommandTool,
  createWriteStdinTool,
  createPlanningTools,
  createAskUserQuestionTool,
  createSleepTool,
  createMonitorTool,
  createEnterWorktreeTool,
  createExitWorktreeTool,
  // AgenC-owned file/search tools (lifted into AgenC).
  // These are the canonical file-content and search surface.
  createFileReadTool,
  createFileEditTool,
  createFileMultiEditTool,
  createFileWriteTool,
  createGlobTool,
  createGrepTool,
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_MULTI_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  SESSION_ADVERTISED_TOOL_NAMES_ARG,
} from "./tools/system/index.js";
import type { BashExecObserver } from "./tools/system/types.js";
import type { WorkflowToolController } from "./tools/system/index.js";
import {
  UnifiedExecProcessManager,
  type UnifiedExecProcessManagerLike,
} from "./unified-exec/index.js";
import {
  createCodeModeTools,
  type CodeModeService,
} from "./tools/code-mode/index.js";
import {
  APPLY_PATCH_TOOL_NAME,
  createApplyPatchTool,
} from "./tools/apply-patch/index.js";
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
import {
  resolvePerToolConfig,
  toolConfigAllowsTool,
} from "./tools/config.js";

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  /**
   * Upstream-shaped value exposed to code-mode nested tool calls.
   * Normal model/TUI consumers keep using `content`.
   */
  readonly codeModeResult?: unknown;
  readonly contentItems?: readonly FunctionCallOutputContentItem[];
  readonly metadata?: Record<string, unknown>;
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
  const recoveryCategory = resolveToolRecoveryCategory(tool, isReadOnly);

  return {
    ...tool,
    concurrencyClass: baseClass,
    ...(serverId ? { serverId } : {}),
    isReadOnly,
    recoveryCategory,
    supportsParallelToolCalls,
    requiresApproval,
    isConcurrencySafe,
  };
}

function resolveToolRecoveryCategory(
  tool: Tool,
  _isReadOnly: boolean,
): ToolRecoveryCategory {
  const declared = (tool as { readonly recoveryCategory?: unknown })
    .recoveryCategory;
  if (isToolRecoveryCategory(declared)) return declared;
  try {
    if (tool.requiresUserInteraction?.() === true) return "interactive";
  } catch {
    return "side-effecting";
  }
  return "side-effecting";
}

function isToolRecoveryCategory(value: unknown): value is ToolRecoveryCategory {
  return (
    value === "idempotent" ||
    value === "side-effecting" ||
    value === "interactive"
  );
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

interface BuiltinToolSurfaceGroup {
  readonly id: string;
  readonly tools: readonly Tool[];
  readonly visibleByDefault?: readonly string[];
  readonly stringArgumentFields?: Readonly<Record<string, string>>;
}

interface BuiltinToolSurface {
  readonly tools: readonly Tool[];
  readonly visibleToolNames: ReadonlySet<string>;
  readonly stringArgumentFields: Readonly<Record<string, string>>;
}

function buildBuiltinToolSurface(
  groups: readonly BuiltinToolSurfaceGroup[],
): BuiltinToolSurface {
  const visibleToolNames = new Set<string>();
  const stringArgumentFields: Record<string, string> = {};
  const tools: Tool[] = [];
  for (const group of groups) {
    assertBuiltinToolsDeclareRecoveryCategory(group);
    const groupToolNames = new Set(group.tools.map((tool) => tool.name));
    for (const name of group.visibleByDefault ?? []) {
      if (groupToolNames.has(name)) visibleToolNames.add(name);
    }
    for (const [toolName, field] of Object.entries(
      group.stringArgumentFields ?? {},
    )) {
      if (groupToolNames.has(toolName)) stringArgumentFields[toolName] = field;
    }
    tools.push(...group.tools);
  }
  return { tools, visibleToolNames, stringArgumentFields };
}

function assertBuiltinToolsDeclareRecoveryCategory(
  group: BuiltinToolSurfaceGroup,
): void {
  const missing = group.tools
    .filter((tool) => !isToolRecoveryCategory(tool.recoveryCategory))
    .map((tool) => tool.name);
  if (missing.length === 0) return;
  throw new Error(
    `builtin tool group ${group.id} missing recoveryCategory: ${missing.join(", ")}`,
  );
}

function applyBuiltinVisibility(
  tool: Tool,
  visibleToolNames: ReadonlySet<string>,
): Tool {
  if (visibleToolNames.has(tool.name)) return tool;
  if (tool.metadata?.source && tool.metadata.source !== "builtin") return tool;
  if (tool.metadata?.deferred === true) return tool;
  return withMetadata(tool, { deferred: true });
}

function parseToolCallArguments(
  toolCall: LLMToolCall,
  stringArgumentFields: Readonly<Record<string, string>>,
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
      const field = stringArgumentFields[toolCall.name];
      return field ? { [field]: parsed } : {};
    }
    return {};
  } catch {
    const field = stringArgumentFields[toolCall.name];
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
  /** Shared AgenC-style unified exec process manager for exec_command/write_stdin. */
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
  /**
   * Live MCP tool source. This is intentionally a provider instead of a
   * one-time array because MCP startup happens after SessionConfigured.
   */
  readonly mcpToolsProvider?: ToolListProvider;
  /**
   * Hide MCP tool schemas until `system.searchTools` discovers them.
   * This mirrors the deferred MCP catalog path and prevents large
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
  /**
   * Product/model-facing tools owned by the registry surface. Bootstrap
   * wires WebFetch, agent, task, skill, notebook, and workflow tools here
   * so `tool-registry.ts` remains the single place that combines the
   * runtime-visible tool catalog.
   */
  readonly modelFacingTools?: ToolListInput;
  readonly unavailableCalledTools?: readonly string[];
  readonly parallelMcpServerNames?: ReadonlySet<string>;
  /**
   * Include AgenC-owned structured git/symbol/repo-inventory tools in
   * the catalog. Defaults to true, but those tools stay deferred so the
   * default model-visible prompt remains small.
   */
  readonly codeIntelligenceTools?: boolean;
  /** Live plan-mode bridge for EnterPlanMode/ExitPlanMode. */
  readonly workflowController?: WorkflowToolController;
  /** Upstream-style JavaScript code-mode service for exec/wait. */
  readonly codeModeService?: CodeModeService;
  /**
   * Config-driven tool policy. Boolean entries are enable/disable
   * shorthands; object entries can set `enabled` and
   * `default_permission_mode` per tool.
   */
  readonly toolsConfig?: ToolsConfig;
  /**
   * Runtime integration seam: extra tools to register beyond the default
   * coding-profile catalog. The CLI uses this for model-facing tools such
   * as `spawn_agent`.
   */
  readonly extraTools?: ReadonlyArray<Tool>;
}

/**
 * Build the coding-profile tool registry.
 *
 * Registers: filesystem (readFile, writeFile, editFile, appendFile,
 * listDir, stat, mkdir, delete, move, glob, grep), coding helpers,
 * bash, and planning tools.
 *
 * The default visible set stays small. Heavy AgenC-owned git/symbol
 * inventory tools are registered as deferred entries and load through
 * `system.searchTools`.
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

  const filesystemCompatibilityTools = createFilesystemTools({
    allowedPaths: [options.workspaceRoot],
    allowDelete: options.allowBashDelete ?? false,
  });
  const codingTools = createCodingTools({
    allowedPaths: [options.workspaceRoot],
    persistenceRootDir: options.workspaceRoot,
    codeIntelligenceTools: options.codeIntelligenceTools ?? true,
    getToolCatalog: () =>
      buildRouter()
        .getSpecs()
        .map((spec) => catalogEntryForTool(spec.tool, spec)),
    onDiscoverTools: markDiscovered,
  });
  const shellTools = [
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
      allowedPaths: [options.workspaceRoot],
      unifiedExecManager,
    }),
    createBashTool({
      cwd: options.workspaceRoot,
      ...(options.bashExecObserver !== undefined
        ? { execObserver: options.bashExecObserver }
        : {}),
    }),
  ] as const;
  const firstClassFileTools = [
    createFileReadTool({
      allowedPaths: [options.workspaceRoot],
    }),
    createFileEditTool({
      allowedPaths: [options.workspaceRoot],
    }),
    // MultiEdit is the multi-edit batch editor for one-file rewrite sets.
    createFileMultiEditTool({
      allowedPaths: [options.workspaceRoot],
    }),
    createFileWriteTool({
      allowedPaths: [options.workspaceRoot],
    }),
    createGlobTool({
      allowedPaths: [options.workspaceRoot],
    }),
    createGrepTool({
      allowedPaths: [options.workspaceRoot],
    }),
    createApplyPatchTool({
      cwd: options.workspaceRoot,
      allowedPaths: [options.workspaceRoot],
    }),
  ] as const;
  const firstClassFileSurface = {
    "read": FILE_READ_TOOL_NAME,
    "write": FILE_WRITE_TOOL_NAME,
    "edit": FILE_EDIT_TOOL_NAME,
    "multiEdit": FILE_MULTI_EDIT_TOOL_NAME,
    "grep": GREP_TOOL_NAME,
    "glob": GLOB_TOOL_NAME,
  } as const;
  const interactionTools = [
    createAskUserQuestionTool(),
    createSleepTool(),
    createMonitorTool({
      cwd: options.workspaceRoot,
      unifiedExecManager,
    }),
    createEnterWorktreeTool({ cwd: options.workspaceRoot }),
    createExitWorktreeTool({ cwd: options.workspaceRoot }),
  ] as const;
  const planningTools = createPlanningTools({
    ...(options.workflowController !== undefined
      ? { workflowController: options.workflowController }
      : {}),
  });
  const registryModelFacingTools = readToolList(options.modelFacingTools);
  const modelFacingProviderNativeSurface = {
    webSearch: "WebSearch",
    webSearchNativeTool: "web_search",
  } as const;
  const modelFacingTaskSurface = {
    taskCreate: "TaskCreate",
    taskGet: "TaskGet",
    taskUpdate: "TaskUpdate",
    taskList: "TaskList",
    taskOutput: "TaskOutput",
    taskStop: "TaskStop",
  } as const;
  const modelFacingStringArgumentFieldCandidates = {
    [modelFacingProviderNativeSurface.webSearch]: "query",
    NotebookRead: "notebook_path",
    NotebookEdit: "notebook_path",
    [modelFacingTaskSurface.taskGet]: "taskId",
    [modelFacingTaskSurface.taskOutput]: "task_id",
    [modelFacingTaskSurface.taskStop]: "task_id",
  } as const;
  const modelFacingToolNames = new Set(
    registryModelFacingTools.map((tool) => tool.name),
  );
  const modelFacingStringArgumentFields: Readonly<Record<string, string>> =
    Object.fromEntries(
      Object.entries(modelFacingStringArgumentFieldCandidates).filter(
        ([toolName]) => modelFacingToolNames.has(toolName),
      ),
    );
  const baseBuiltinSurfaceGroups: readonly BuiltinToolSurfaceGroup[] = [
    {
      id: "filesystem-compatibility",
      tools: filesystemCompatibilityTools,
      stringArgumentFields: {
        "system.listDir": "path",
        "system.stat": "path",
        "system.mkdir": "path",
        "system.delete": "path",
      },
    },
    {
      id: "coding",
      tools: codingTools,
      visibleByDefault: ["system.searchTools"],
      stringArgumentFields: {
        "system.grep": "pattern",
        "system.glob": "pattern",
      },
    },
    {
      id: "shell",
      tools: shellTools,
      visibleByDefault: ["exec_command", "write_stdin"],
      stringArgumentFields: {
        exec_command: "cmd",
        "system.bash": "command",
      },
    },
    {
      id: "first-class-files",
      tools: firstClassFileTools,
      visibleByDefault: [
        firstClassFileSurface.read,
        firstClassFileSurface.edit,
        firstClassFileSurface.multiEdit,
        firstClassFileSurface.write,
        firstClassFileSurface.glob,
        firstClassFileSurface.grep,
      ],
      stringArgumentFields: {
        [firstClassFileSurface.read]: "file_path",
        [firstClassFileSurface.write]: "file_path",
        [firstClassFileSurface.edit]: "file_path",
        [firstClassFileSurface.multiEdit]: "file_path",
        [firstClassFileSurface.glob]: "pattern",
        [firstClassFileSurface.grep]: "pattern",
        [APPLY_PATCH_TOOL_NAME]: "input",
      },
    },
    {
      id: "interaction",
      tools: interactionTools,
      visibleByDefault: ["AskUserQuestion"],
    },
    {
      id: "planning",
      tools: planningTools,
      visibleByDefault: ["TodoWrite", "EnterPlanMode", "ExitPlanMode"],
    },
    {
      id: "model-facing",
      tools: registryModelFacingTools,
      visibleByDefault: registryModelFacingTools
        .filter((tool) => tool.metadata?.deferred !== true)
        .map((tool) => tool.name),
      stringArgumentFields: modelFacingStringArgumentFields,
    },
  ];
  const rawDefaultBuiltinTools = buildBuiltinToolSurface(
    baseBuiltinSurfaceGroups,
  ).tools;
  const configuredRawDefaultBuiltinTools = configuredTools(
    rawDefaultBuiltinTools,
  );
  const codeModeTools: readonly Tool[] =
    options.codeModeService?.enabled() === true
      ? createCodeModeTools({
          service: options.codeModeService,
          getEnabledTools: () => allSpecs().map((spec) => spec.tool),
          descriptionTools: configuredRawDefaultBuiltinTools,
        })
      : [];
  const builtinSurface = buildBuiltinToolSurface([
    ...baseBuiltinSurfaceGroups,
    {
      id: "code-mode",
      tools: codeModeTools,
      visibleByDefault: ["exec", "wait"],
      stringArgumentFields: {
        exec: "code",
      },
    },
  ]);
  function applyConfiguredTool(tool: Tool): Tool | null {
    if (!toolConfigAllowsTool(options.toolsConfig, tool.name)) return null;
    const config = resolvePerToolConfig(options.toolsConfig, tool.name);
    if (config.defaultPermissionMode === undefined) return tool;
    return { ...tool, defaultPermissionMode: config.defaultPermissionMode };
  }

  function configuredTools(tools: readonly Tool[]): Tool[] {
    return tools
      .map((tool) => applyConfiguredTool(tool))
      .filter((tool): tool is Tool => tool !== null);
  }

  const defaultBuiltinTools: Tool[] = configuredTools(
    builtinSurface.tools.map((tool) =>
      tagTool(applyBuiltinVisibility(tool, builtinSurface.visibleToolNames)),
    ),
  );
  const extraTools: Tool[] = configuredTools(
    (options.extraTools ?? []).map((tool) => tagTool(tool)),
  );
  const staticTools: Tool[] = [...defaultBuiltinTools, ...extraTools];

  // T7: tag each registered tool with its ConcurrencyClass + flags.
  // Tools without explicit metadata get sensible defaults:
  //   - readFile/listDir/stat/glob/grep → SharedRead + isReadOnly
  //   - writeFile/editFile/delete/move    → Exclusive (never parallel)
  //   - WebFetch/WebSearch                → SharedRead (network reads)
  //   - bash                              → BackgroundTerminal (subprocess)
  function currentMcpTools(): readonly Tool[] {
    return configuredTools(
      (options.mcpToolsProvider?.getTools() ?? []).map((tool) => {
        const serverId = inferMcpServerId(tool.name);
        return tagTool(
          withMetadata(tool, {
            source: "mcp",
            family: "mcp",
            deferred: options.deferMcpTools ?? true,
          }),
          serverId ? { serverId } : {},
        );
      }),
    );
  }

  function currentDynamicTools(): readonly Tool[] {
    return configuredTools(
      readToolList(options.dynamicTools).map((tool) =>
        tagTool(withMetadata(tool, { source: tool.metadata?.source ?? "plugin" })),
      ),
    );
  }

  function currentDeferredTools(): readonly Tool[] {
    return configuredTools(
      readToolList(options.deferredTools).map((tool) =>
        tagTool(
          withMetadata(tool, {
            source: tool.metadata?.source ?? "plugin",
            deferred: true,
          }),
        ),
      ),
    );
  }

  function currentDiscoverableTools(): readonly Tool[] {
    return configuredTools(
      readToolList(options.discoverableTools).map((tool) =>
        tagTool(withMetadata(tool, { source: tool.metadata?.source ?? "plugin" })),
      ),
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
        const args = parseToolCallArguments(
          toolCall,
          builtinSurface.stringArgumentFields,
        );
        Object.defineProperty(args, "__callId", {
          value: toolCall.id,
          enumerable: false,
          configurable: true,
        });
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
          codeModeResult: result.codeModeResult,
          contentItems: result.contentItems,
          metadata: result.metadata,
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
