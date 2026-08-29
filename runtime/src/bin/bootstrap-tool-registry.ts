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
import type { CsvAgentJobsRepositoryProvider } from "../app-server/csv-agent-jobs-authority.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";

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
}

export function buildBootstrapToolRegistry(
  options: BootstrapToolRegistryOptions,
): ToolRegistry {
  const modelFacingTools = createModelFacingTools({
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
    ...(options.toolRegistryOptions?.sessionProvider !== undefined
      ? { sessionProvider: options.toolRegistryOptions.sessionProvider }
      : {}),
    ...(options.toolRegistryOptions?.sessionBaseURL !== undefined
      ? { sessionBaseURL: options.toolRegistryOptions.sessionBaseURL }
      : {}),
    ...(options.toolRegistryOptions?.outputSchema !== undefined
      ? { outputSchema: options.toolRegistryOptions.outputSchema }
      : {}),
  });
  return buildToolRegistry({
    workspaceRoot: options.workspaceRoot,
    ...(options.agencHome !== undefined
      ? { agencHome: options.agencHome }
      : {}),
    getSession: options.getSession,
    requireAdmission: true,
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
