import type { MCPManager } from "../mcp-client/manager.js";
import type { Session } from "../session/session.js";
import {
  buildToolRegistry,
  type BuildToolRegistryOptions,
  type ToolRegistry,
} from "../tool-registry.js";
import { buildWorkflowToolController } from "./workflow-controller.js";
import { createModelFacingTools } from "./model-facing-tools.js";

export interface BootstrapToolRegistryOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  readonly mcpManager: MCPManager;
  readonly getSession: () => Session | null;
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
    ...(options.agencHome !== undefined ? { agencHome: options.agencHome } : {}),
    getSession: options.getSession,
    ...(options.toolRegistryOptions?.unifiedExecManager !== undefined
      ? { unifiedExecManager: options.toolRegistryOptions.unifiedExecManager }
      : {}),
    emitWarning: options.emitWarning,
    env: process.env,
    ...(options.toolRegistryOptions?.toolsConfig !== undefined
      ? { toolsConfig: options.toolRegistryOptions.toolsConfig }
      : {}),
    ...(options.toolRegistryOptions?.outputSchema !== undefined
      ? { outputSchema: options.toolRegistryOptions.outputSchema }
      : {}),
  });
  return buildToolRegistry({
    workspaceRoot: options.workspaceRoot,
    mcpToolsProvider: options.mcpManager,
    workflowController: buildWorkflowToolController({
      getSession: options.getSession,
      ...(options.agencHome !== undefined ? { agencHome: options.agencHome } : {}),
      emitWarning: options.emitWarning,
    }),
    ...(options.toolRegistryOptions ?? {}),
    modelFacingTools,
    extraTools: options.toolRegistryOptions?.extraTools ?? [],
  });
}
