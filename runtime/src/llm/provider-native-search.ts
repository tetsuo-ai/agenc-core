import type {
  LLMCollectionsSearchConfig,
  LLMProviderNativeServerToolType,
  LLMRemoteMcpServerConfig,
  LLMXSearchConfig,
  LLMXaiCapabilitySurface,
  LLMWebSearchConfig,
} from "./types.js";
import type { GatewayLLMConfig as ContextGatewayLLMConfig } from "./_deps/context-window.js";
import { normalizeGrokModel } from "./_deps/context-window.js";

// Lean-rebuild alias: provider-native-search was written against the
// full gateway/types.ts GatewayLLMConfig. The rebuilt gateway stub
// only exposes the minimal shape via context-window.ts. They're
// interchangeable for the fields this module reads.
type GatewayLLMConfig = ContextGatewayLLMConfig & {
  searchMode?: string;
};

export const PROVIDER_NATIVE_WEB_SEARCH_TOOL = "web_search";
const PROVIDER_NATIVE_X_SEARCH_TOOL = "x_search";
const PROVIDER_NATIVE_CODE_INTERPRETER_TOOL = "code_interpreter";
const PROVIDER_NATIVE_FILE_SEARCH_TOOL = "file_search";
const PROVIDER_NATIVE_MCP_TOOL_PREFIX = "mcp:";
const GROK_SERVER_SIDE_TOOL_PREFIX = "grok-4";

type ProviderNativeSearchMode = "auto" | "on" | "off";

export interface ProviderNativeToolDefinition {
  readonly name: string;
  readonly toolType: LLMProviderNativeServerToolType;
  readonly payload: Record<string, unknown>;
  readonly schemaChars: number;
}

type ProviderNativeToolConfig = Pick<
  GatewayLLMConfig,
  "provider" | "model"
> &
  LLMXaiCapabilitySurface;

/**
 * xAI multi-agent models do not support client-side function calling — only
 * built-in server tools and remote MCP. Detect those model IDs (including
 * aliases and provider-prefixed forms) so adapters can strip LIVE tools.
 *
 * @see https://docs.x.ai/developers/model-capabilities/text/multi-agent
 */
export function isGrokMultiAgentModel(model: string | undefined): boolean {
  if (typeof model !== "string") return false;
  const trimmed = model.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  const normalized =
    normalizeGrokModel(trimmed)?.trim().toLowerCase() ?? trimmed;
  const unqualified = normalized.slice(
    Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":")) + 1,
  );
  return /^grok-4[.-]20-multi-agent(?:$|[-_.])/.test(unqualified);
}

/**
 * Fail-closed: empty/unknown/unnormalizable models never enable xAI server
 * tools. Only explicit Grok 4 family IDs (after alias normalize) qualify.
 */
export function supportsGrokServerSideTools(model: string | undefined): boolean {
  const normalized = normalizeGrokModel(model)?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith(GROK_SERVER_SIDE_TOOL_PREFIX);
}

function resolveProviderNativeSearchMode(
  llmConfig: Pick<
    GatewayLLMConfig,
    "provider" | "model" | "webSearch" | "searchMode"
  > | undefined,
): ProviderNativeSearchMode {
  if (!llmConfig || llmConfig.provider !== "grok") return "off";
  if (llmConfig.webSearch !== true) return "off";
  if (!supportsGrokServerSideTools(llmConfig.model)) return "off";
  const mode = llmConfig.searchMode ?? "auto";
  return mode === "on" || mode === "auto" || mode === "off" ? mode : "auto";
}

export function supportsProviderNativeWebSearch(
  llmConfig: Pick<
    GatewayLLMConfig,
    "provider" | "model" | "webSearch" | "searchMode"
  > | undefined,
): boolean {
  return resolveProviderNativeSearchMode(llmConfig) !== "off";
}

function buildWebSearchPayload(
  options: LLMWebSearchConfig | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: PROVIDER_NATIVE_WEB_SEARCH_TOOL,
  };
  const filters: Record<string, unknown> = {};
  if ((options?.allowedDomains?.length ?? 0) > 0) {
    filters.allowed_domains = [...(options?.allowedDomains ?? [])];
  }
  if ((options?.excludedDomains?.length ?? 0) > 0) {
    filters.excluded_domains = [...(options?.excludedDomains ?? [])];
  }
  if (Object.keys(filters).length > 0) {
    payload.filters = filters;
  }
  if (options?.enableImageUnderstanding === true) {
    payload.enable_image_understanding = true;
  }
  return payload;
}

function buildXSearchPayload(
  options: LLMXSearchConfig | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: PROVIDER_NATIVE_X_SEARCH_TOOL,
  };
  if ((options?.allowedXHandles?.length ?? 0) > 0) {
    payload.allowed_x_handles = [...(options?.allowedXHandles ?? [])];
  }
  if ((options?.excludedXHandles?.length ?? 0) > 0) {
    payload.excluded_x_handles = [...(options?.excludedXHandles ?? [])];
  }
  if (options?.fromDate) {
    payload.from_date = options.fromDate;
  }
  if (options?.toDate) {
    payload.to_date = options.toDate;
  }
  if (options?.enableImageUnderstanding === true) {
    payload.enable_image_understanding = true;
  }
  if (options?.enableVideoUnderstanding === true) {
    payload.enable_video_understanding = true;
  }
  return payload;
}

function buildFileSearchPayload(
  options: LLMCollectionsSearchConfig | undefined,
): Record<string, unknown> | undefined {
  if (options?.enabled !== true || (options.vectorStoreIds?.length ?? 0) === 0) {
    return undefined;
  }
  const payload: Record<string, unknown> = {
    type: PROVIDER_NATIVE_FILE_SEARCH_TOOL,
    vector_store_ids: [...(options.vectorStoreIds ?? [])],
  };
  if (typeof options.maxNumResults === "number" && options.maxNumResults > 0) {
    payload.max_num_results = options.maxNumResults;
  }
  return payload;
}

function buildRemoteMcpPayload(
  server: LLMRemoteMcpServerConfig,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: "mcp",
    server_url: server.serverUrl,
    server_label: server.serverLabel,
  };
  if (server.serverDescription) {
    payload.server_description = server.serverDescription;
  }
  if ((server.allowedTools?.length ?? 0) > 0) {
    payload.allowed_tools = [...(server.allowedTools ?? [])];
  }
  if (server.authorization) {
    payload.authorization = server.authorization;
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    payload.headers = { ...server.headers };
  }
  return payload;
}

function createDefinition(
  name: string,
  toolType: LLMProviderNativeServerToolType,
  payload: Record<string, unknown>,
): ProviderNativeToolDefinition {
  return {
    name,
    toolType,
    payload,
    schemaChars: JSON.stringify(payload).length,
  };
}

export function getProviderNativeToolDefinitions(
  llmConfig: ProviderNativeToolConfig | undefined,
): readonly ProviderNativeToolDefinition[] {
  if (!llmConfig || llmConfig.provider !== "grok") return [];
  if (!supportsGrokServerSideTools(llmConfig.model)) return [];

  const definitions: ProviderNativeToolDefinition[] = [];

  if (llmConfig.webSearch === true) {
    definitions.push(
      createDefinition(
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
        "web_search",
        buildWebSearchPayload(llmConfig.webSearchOptions),
      ),
    );
  }
  if (llmConfig.xSearch === true) {
    definitions.push(
      createDefinition(
        PROVIDER_NATIVE_X_SEARCH_TOOL,
        "x_search",
        buildXSearchPayload(llmConfig.xSearchOptions),
      ),
    );
  }
  if (llmConfig.codeExecution === true) {
    definitions.push(
      createDefinition(
        PROVIDER_NATIVE_CODE_INTERPRETER_TOOL,
        "code_interpreter",
        { type: PROVIDER_NATIVE_CODE_INTERPRETER_TOOL },
      ),
    );
  }

  const fileSearchPayload = buildFileSearchPayload(llmConfig.collectionsSearch);
  if (fileSearchPayload) {
    definitions.push(
      createDefinition(
        PROVIDER_NATIVE_FILE_SEARCH_TOOL,
        "file_search",
        fileSearchPayload,
      ),
    );
  }

  if (llmConfig.remoteMcp?.enabled === true) {
    for (const server of llmConfig.remoteMcp.servers ?? []) {
      definitions.push(
        createDefinition(
          `${PROVIDER_NATIVE_MCP_TOOL_PREFIX}${server.serverLabel}`,
          "mcp",
          buildRemoteMcpPayload(server),
        ),
      );
    }
  }

  return definitions;
}
