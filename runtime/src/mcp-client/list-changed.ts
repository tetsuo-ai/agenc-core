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

import { VERSION } from "../version.js";
import { configureMcpElicitationClient } from "../elicitation/mcp.js";
import type { MCPElicitationHandlers } from "./types.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpHostElicitationCapabilityMode,
  type McpSamplingHandlers,
} from "../services/mcp/hostCapabilities.js";

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

type McpSdkClientConstructor = new (
  info: { readonly name: string; readonly version: string },
  options: McpRuntimeClientOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => any;

/**
 * Shared SDK Client construction used by every transport so listChanged
 * handlers, host request handlers, and elicitation stay wired the same way.
 */
export async function createConfiguredMcpRuntimeClient(
  Client: McpSdkClientConstructor,
  serverName: string,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  listChangedHandlers?: MCPListChangedHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const client = new Client(
    { name: "agenc-runtime", version: VERSION },
    buildMcpRuntimeClientOptions(
      elicitationHandlers === undefined ? "none" : "form-url",
      listChangedHandlers,
    ),
  );
  configureMcpHostRequestHandlers(
    client,
    serverName,
    samplingHandlers === undefined ? undefined : { samplingHandlers },
  );
  await configureMcpElicitationClient(
    client,
    serverName,
    elicitationHandlers,
  );
  return client;
}

export function assertNeverCatalogKind(kind: never): never {
  throw new Error(`Unhandled MCP catalog kind: ${String(kind)}`);
}
