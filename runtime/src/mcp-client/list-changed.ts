/**
 * MCP list_changed notification wiring for AgenC clients.
 *
 * The installed SDK Client constructor accepts `listChanged` handlers for
 * tools, prompts, and resources. AgenC uses those callbacks only as a
 * transport-level signal; the manager owns generation-fenced refresh,
 * policy, and publication.
 *
 * @module
 */

import type { McpHostElicitationCapabilityMode } from "../services/mcp/hostCapabilities.js";
import { buildMcpHostClientCapabilities } from "../services/mcp/hostCapabilities.js";

export type MCPCatalogKind = "tools" | "prompts" | "resources";

export interface MCPListChangedHandlers {
  readonly onToolsListChanged: () => void;
  readonly onPromptsListChanged: () => void;
  readonly onResourcesListChanged: () => void;
}

export interface McpSdkListChangedOption {
  readonly tools: { readonly onChanged: (error?: unknown) => void };
  readonly prompts: { readonly onChanged: (error?: unknown) => void };
  readonly resources: { readonly onChanged: (error?: unknown) => void };
}

export interface McpRuntimeClientOptions {
  readonly capabilities: Record<string, unknown>;
  readonly listChanged?: McpSdkListChangedOption;
}

export function toSdkListChangedHandlers(
  handlers: MCPListChangedHandlers,
): McpSdkListChangedOption {
  return {
    tools: {
      onChanged: () => {
        handlers.onToolsListChanged();
      },
    },
    prompts: {
      onChanged: () => {
        handlers.onPromptsListChanged();
      },
    },
    resources: {
      onChanged: () => {
        handlers.onResourcesListChanged();
      },
    },
  };
}

export function buildMcpRuntimeClientOptions(
  elicitationMode: McpHostElicitationCapabilityMode,
  listChangedHandlers?: MCPListChangedHandlers,
): McpRuntimeClientOptions {
  return {
    capabilities: buildMcpHostClientCapabilities(elicitationMode),
    ...(listChangedHandlers === undefined
      ? {}
      : { listChanged: toSdkListChangedHandlers(listChangedHandlers) }),
  };
}

export function assertNeverCatalogKind(kind: never): never {
  throw new Error(`Unhandled MCP catalog kind: ${String(kind)}`);
}
