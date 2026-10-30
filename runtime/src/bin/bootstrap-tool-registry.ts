import type { MCPManager } from "../mcp-client/manager.js";
import type { Session } from "../session/session.js";
import type { AgentRoleCatalog } from "../agents/role-catalog.js";
import {
  buildToolRegistry,
  type BuildToolRegistryOptions,
  type ToolRegistry,
} from "../tool-registry.js";
import { buildWorkflowToolController } from "./workflow-controller.js";
import { createModelFacingTools } from "./model-facing-tools.js";
import { sparseLineNumbersEnabled } from "../tools/system/_deps/line-numbers.js";
import type { CsvAgentJobsRepositoryProvider } from "../app-server/csv-agent-jobs-authority.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import { resolveWebSearchMode, type WebSearchMode } from "../tools/web-search-mode.js";
import { rareToolDeferralEnabled } from "../tools/rare-tool-deferral.js";

export interface BootstrapToolRegistryOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  /** Session-owned provider/request environment. */
  readonly environment?: ProviderEnvironment;
  readonly mcpManager: MCPManager;
  readonly getSession: () => Session | null;
  readonly roleCatalog?: AgentRoleCatalog;
  readonly csvAgentJobsRepositories: CsvAgentJobsRepositoryProvider;
  readonly emitWarning: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly toolRegistryOptions?: Omit<
    BuildToolRegistryOptions,
    "workspaceRoot" | "modelFacingTools"
  >;
  /** config.toml `defer_rare_tools`; the session environment overrides it. */
  readonly configuredDeferRareTools?: boolean;
  readonly configuredWebSearch?: WebSearchMode;
  /**
   * config.toml `[providers.deepseek] web_search`; the session's
   * `AGENC_DEEPSEEK_WEB_SEARCH` overrides it.
   */
  readonly configuredDeepSeekWebSearch?: boolean;
  /**
   * config.toml `[providers.deepseek] web_fetch`; the session's
   * `AGENC_DEEPSEEK_WEB_FETCH` overrides it.
   */
  readonly configuredDeepSeekWebFetch?: boolean;
}

export function buildBootstrapToolRegistry(
  options: BootstrapToolRegistryOptions,
): ToolRegistry {
  const webSearchEnabled = (): boolean => {
    const store = options.getSession()?.services?.configStore;
    return resolveWebSearchMode(options.environment ?? {},
      store === undefined ? options.configuredWebSearch : store.current().web_search) === "on";
  };
  const modelFacingTools = createModelFacingTools({
    webSearchEnabled,
    workspaceRoot: options.workspaceRoot,
    ...(options.agencHome !== undefined
      ? { agencHome: options.agencHome }
      : {}),
    getSession: options.getSession,
    ...(options.roleCatalog !== undefined
      ? { roleCatalog: options.roleCatalog }
      : {}),
    csvAgentJobsRepositories: options.csvAgentJobsRepositories,
    ...(options.toolRegistryOptions?.unifiedExecManager !== undefined
      ? { unifiedExecManager: options.toolRegistryOptions.unifiedExecManager }
      : {}),
    emitWarning: options.emitWarning,
    env: options.environment ?? process.env,
    ...(options.toolRegistryOptions?.toolsConfig !== undefined
      ? { toolsConfig: options.toolRegistryOptions.toolsConfig }
      : {}),
    ...(options.toolRegistryOptions?.grokCapabilities !== undefined
      ? { grokCapabilities: options.toolRegistryOptions.grokCapabilities }
      : {}),
    ...(options.configuredDeepSeekWebSearch !== undefined
      ? { deepseekWebSearch: options.configuredDeepSeekWebSearch }
      : {}),
    ...(options.configuredDeepSeekWebFetch !== undefined
      ? { deepseekWebFetch: options.configuredDeepSeekWebFetch }
      : {}),
    ...(options.toolRegistryOptions?.sessionProvider !== undefined
      ? { sessionProvider: options.toolRegistryOptions.sessionProvider }
      : {}),
    ...(options.toolRegistryOptions?.sessionBaseURL !== undefined
      ? { sessionBaseURL: options.toolRegistryOptions.sessionBaseURL }
      : {}),
    ...(options.toolRegistryOptions?.outputSchema !== undefined
      ? { outputSchema: options.toolRegistryOptions.outputSchema }
      : {}),
    ...(options.toolRegistryOptions?.toolPolicy !== undefined
      ? { toolPolicy: options.toolRegistryOptions.toolPolicy }
      : {}),
  });
  return buildToolRegistry({
    workspaceRoot: options.workspaceRoot,
    // Read from the session's captured environment, so a client sets it per
    // session. An explicit toolRegistryOptions value below still wins.
    sparseLineNumbers: sparseLineNumbersEnabled(options.environment ?? {}),
    ...(options.agencHome !== undefined
      ? { agencHome: options.agencHome }
      : {}),
    getSession: options.getSession,
    requireAdmission: true,
    webSearchEnabled,
    // Read from the session's captured environment, so a client sets it per
    // session. An explicit toolRegistryOptions value below still wins.
    deferRareTools: rareToolDeferralEnabled(options.environment ?? {}, {
      lightMode: options.toolRegistryOptions?.lightMode === true,
      ...(options.configuredDeferRareTools !== undefined
        ? { configured: options.configuredDeferRareTools }
        : {}),
    }),
    mcpToolsProvider: options.mcpManager,
    workflowController: buildWorkflowToolController({
      getSession: options.getSession,
      ...(options.agencHome !== undefined
        ? { agencHome: options.agencHome }
        : {}),
      emitWarning: options.emitWarning,
    }),
    ...(options.toolRegistryOptions ?? {}),
    modelFacingTools,
    extraTools: options.toolRegistryOptions?.extraTools ?? [],
  });
}
