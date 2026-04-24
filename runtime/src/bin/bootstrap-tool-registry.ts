import type { MCPManager } from "../mcp-client/manager.js";
import type { Session } from "../session/session.js";
import {
  buildToolRegistry,
  type BuildToolRegistryOptions,
  type ToolRegistry,
} from "../tool-registry.js";
import { buildWorkflowToolController } from "./workflow-controller.js";

export interface BootstrapToolRegistryOptions {
  readonly workspaceRoot: string;
  readonly mcpManager: MCPManager;
  readonly getSession: () => Session | null;
  readonly emitWarning: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly toolRegistryOptions?: Omit<BuildToolRegistryOptions, "workspaceRoot">;
}

export function buildBootstrapToolRegistry(
  options: BootstrapToolRegistryOptions,
): ToolRegistry {
  return buildToolRegistry({
    workspaceRoot: options.workspaceRoot,
    mcpToolsProvider: options.mcpManager,
    workflowController: buildWorkflowToolController({
      getSession: options.getSession,
      emitWarning: options.emitWarning,
    }),
    ...(options.toolRegistryOptions ?? {}),
  });
}
