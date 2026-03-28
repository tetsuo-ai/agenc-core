import type {
  LLMCollectionsSearchConfig,
  LLMMessage,
  LLMProviderNativeServerToolType,
  LLMRemoteMcpServerConfig,
  LLMXSearchConfig,
  LLMXaiCapabilitySurface,
  LLMWebSearchConfig,
} from "./types.js";
import type { GatewayLLMConfig } from "../gateway/types.js";
import { normalizeGrokModel } from "../gateway/context-window.js";

export const PROVIDER_NATIVE_WEB_SEARCH_TOOL = "web_search";
export const PROVIDER_NATIVE_X_SEARCH_TOOL = "x_search";
export const PROVIDER_NATIVE_CODE_INTERPRETER_TOOL = "code_interpreter";
export const PROVIDER_NATIVE_FILE_SEARCH_TOOL = "file_search";
export const PROVIDER_NATIVE_MCP_TOOL_PREFIX = "mcp:";
export const PROVIDER_NATIVE_RESEARCH_TOOL_NAMES = [
  PROVIDER_NATIVE_WEB_SEARCH_TOOL,
  PROVIDER_NATIVE_X_SEARCH_TOOL,
  PROVIDER_NATIVE_FILE_SEARCH_TOOL,
] as const;
export const PROVIDER_NATIVE_GROUNDED_INFORMATION_TOOL_NAMES = [
  ...PROVIDER_NATIVE_RESEARCH_TOOL_NAMES,
  PROVIDER_NATIVE_CODE_INTERPRETER_TOOL,
] as const;

const RESEARCH_LIKE_RE =
  /\b(?:research|compare|comparison|official docs?|primary sources?|reference|references|citation|citations|look up|latest|up[- ]to[- ]date|news)\b/i;
const INTERACTIVE_BROWSER_RE =
  /\b(?:localhost|127\.0\.0\.1|about:blank|screenshot|snapshot|console|network|dom|inspect|click|type|hover|scroll|fill|select|tab|tabs|window|windows|playtest|qa|end-to-end|e2e|navigate to|open the page)\b/i;
const WEB_SEARCH_CUE_RE =
  /\b(?:official docs?|documentation|docs?|website|web search|search the web|latest|news|current status|current state|up[- ]to[- ]date)\b/i;
const X_SEARCH_CUE_RE =
  /(?:\bon x\b|\bfrom x\b|\bx posts?\b|\bx handles?\b|\bx threads?\b|\btwitter\b|\btweets?\b|\bposts?\s+on\s+x\b|\bwhat are people saying\b|\bsentiment\b|\bhandle(?:s)?\b|\bthread(?:s)?\b)/i;
const FILE_SEARCH_CUE_RE =
  /\b(?:collection|collections|knowledge base|knowledgebase|uploaded (?:docs?|documents?|files?)|internal (?:docs?|documents?|policies?|knowledge)|my (?:docs?|documents?|files)|our (?:docs?|documents?|files)|from (?:the )?(?:collection|collections|knowledge base|uploaded|internal) (?:docs?|documents?|files))\b/i;
const CODE_EXECUTION_CUE_RE =
  /\b(?:calculate|calculation|compute|computation|statistical|statistics|correlation|regression|linear regression|matrix|equation|simulate|simulation|forecast|predict|prediction|t-test|anova|sharpe|dataset|csv|plot|chart|graph|visuali[sz]ation|show your working|show the working)\b/i;
const SIGNIFICANT_TOKEN_RE = /[a-z0-9][a-z0-9_-]{2,}/gi;
const GROK_SERVER_SIDE_TOOL_PREFIX = "grok-4";

export type ProviderNativeSearchMode = "auto" | "on" | "off";

export interface ProviderNativeSearchRoutingDecision {
  readonly toolName: string;
  readonly schemaChars: number;
}

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

export function supportsGrokServerSideTools(model: string | undefined): boolean {
  const normalized = normalizeGrokModel(model)?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized.startsWith(GROK_SERVER_SIDE_TOOL_PREFIX);
}

export function resolveProviderNativeSearchMode(
  llmConfig: Pick<
    GatewayLLMConfig,
    "provider" | "model" | "webSearch" | "searchMode"
  > | undefined,
): ProviderNativeSearchMode {
  if (!llmConfig || llmConfig.provider !== "grok") return "off";
  if (llmConfig.webSearch !== true) return "off";
  if (!supportsGrokServerSideTools(llmConfig.model)) return "off";
  return llmConfig.searchMode ?? "auto";
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

export function getProviderNativeAdvertisedToolNames(
  llmConfig: ProviderNativeToolConfig | undefined,
): readonly string[] {
  return getProviderNativeToolDefinitions(llmConfig).map(
    (definition) => definition.name,
  );
}

export function isResearchLikeText(value: string): boolean {
  return RESEARCH_LIKE_RE.test(value);
}

export function isInteractiveBrowserText(value: string): boolean {
  return INTERACTIVE_BROWSER_RE.test(value);
}

export function isXSearchLikeText(value: string): boolean {
  return X_SEARCH_CUE_RE.test(value);
}

export function isCollectionsSearchLikeText(value: string): boolean {
  return FILE_SEARCH_CUE_RE.test(value);
}

export function isCodeExecutionLikeText(value: string): boolean {
  return CODE_EXECUTION_CUE_RE.test(value) ||
    (/\b(?:data|numbers?)\b/i.test(value) && /\[[^\]]+\]/.test(value));
}

export function selectPreferredProviderNativeResearchToolName(params: {
  readonly messageText: string;
  readonly allowedToolNames: readonly string[];
}): string | undefined {
  const normalizedTools = params.allowedToolNames
    .map((toolName) => toolName.trim())
    .filter((toolName) => toolName.length > 0);
  const combined = params.messageText.toLowerCase();
  if (
    isXSearchLikeText(combined) &&
    normalizedTools.includes(PROVIDER_NATIVE_X_SEARCH_TOOL)
  ) {
    return PROVIDER_NATIVE_X_SEARCH_TOOL;
  }
  if (
    isCollectionsSearchLikeText(combined) &&
    normalizedTools.includes(PROVIDER_NATIVE_FILE_SEARCH_TOOL)
  ) {
    return PROVIDER_NATIVE_FILE_SEARCH_TOOL;
  }
  return normalizedTools.find((toolName) =>
    PROVIDER_NATIVE_RESEARCH_TOOL_NAMES.includes(
      toolName as (typeof PROVIDER_NATIVE_RESEARCH_TOOL_NAMES)[number],
    )
  );
}

function collectRoutingText(
  messageText: string,
  history: readonly LLMMessage[],
): string {
  const recentHistory = history
    .slice(-4)
    .map((entry) =>
      Array.isArray(entry.content)
        ? entry.content
            .filter((part): part is { type: "text"; text: string } =>
              part.type === "text" && typeof part.text === "string"
            )
            .map((part) => part.text)
            .join(" ")
        : entry.content
    )
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" ");
  return `${recentHistory}\n${messageText}`.trim();
}

function extractSignificantTokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(SIGNIFICANT_TOKEN_RE) ?? [])
      .filter((token) => token.length >= 3),
  );
}

function matchesRemoteMcpServer(
  server: LLMRemoteMcpServerConfig,
  combinedText: string,
  combinedTokens: Set<string>,
): boolean {
  const label = server.serverLabel.trim().toLowerCase();
  if (label.length > 0 && combinedText.includes(label)) {
    return true;
  }
  const metadataTokens = extractSignificantTokens([
    server.serverLabel,
    server.serverDescription,
    ...(server.allowedTools ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" "));
  const matchingTokens = [...metadataTokens].filter((token) =>
    combinedTokens.has(token)
  );
  return matchingTokens.length >= 2;
}

export function getProviderNativeToolRoutingDecisions(
  params: {
    readonly llmConfig: ProviderNativeToolConfig | undefined;
    readonly messageText: string;
    readonly history: readonly LLMMessage[];
  },
): readonly ProviderNativeSearchRoutingDecision[] {
  const llmConfig = params.llmConfig;
  if (!llmConfig || llmConfig.provider !== "grok") return [];
  if (!supportsGrokServerSideTools(llmConfig.model)) return [];

  const definitions = getProviderNativeToolDefinitions(llmConfig);
  if (definitions.length === 0) return [];

  const byName = new Map(
    definitions.map((definition) => [definition.name, definition] as const),
  );
  const combined = collectRoutingText(params.messageText, params.history).toLowerCase();
  const combinedTokens = extractSignificantTokens(combined);
  const decisions: ProviderNativeSearchRoutingDecision[] = [];
  const pushDecision = (toolName: string) => {
    if (decisions.some((decision) => decision.toolName === toolName)) {
      return;
    }
    const definition = byName.get(toolName);
    if (!definition) return;
    decisions.push({
      toolName,
      schemaChars: definition.schemaChars,
    });
  };

  const wantsXSearch = llmConfig.xSearch === true && X_SEARCH_CUE_RE.test(combined);
  const wantsFileSearch =
    llmConfig.collectionsSearch?.enabled === true &&
    isCollectionsSearchLikeText(combined);
  const wantsCodeExecution =
    llmConfig.codeExecution === true &&
    isCodeExecutionLikeText(combined);
  const wantsWebSearch =
    !isInteractiveBrowserText(combined) &&
    resolveProviderNativeSearchMode(llmConfig) !== "off" &&
    (
      resolveProviderNativeSearchMode(llmConfig) === "on" ||
      WEB_SEARCH_CUE_RE.test(combined) ||
      (isResearchLikeText(combined) && !wantsXSearch && !wantsFileSearch)
    );

  if (wantsXSearch) {
    pushDecision(PROVIDER_NATIVE_X_SEARCH_TOOL);
  }
  if (wantsFileSearch) {
    pushDecision(PROVIDER_NATIVE_FILE_SEARCH_TOOL);
  }
  if (wantsWebSearch) {
    pushDecision(PROVIDER_NATIVE_WEB_SEARCH_TOOL);
  }
  if (wantsCodeExecution) {
    pushDecision(PROVIDER_NATIVE_CODE_INTERPRETER_TOOL);
  }
  if (llmConfig.remoteMcp?.enabled === true) {
    for (const server of llmConfig.remoteMcp.servers ?? []) {
      if (matchesRemoteMcpServer(server, combined, combinedTokens)) {
        pushDecision(`${PROVIDER_NATIVE_MCP_TOOL_PREFIX}${server.serverLabel}`);
      }
    }
  }

  return decisions;
}

export function getProviderNativeWebSearchRoutingDecision(
  params: {
    readonly llmConfig: ProviderNativeToolConfig | undefined;
    readonly messageText: string;
    readonly history: readonly LLMMessage[];
  },
): ProviderNativeSearchRoutingDecision | undefined {
  return getProviderNativeToolRoutingDecisions(params).find(
    (decision) => decision.toolName === PROVIDER_NATIVE_WEB_SEARCH_TOOL,
  );
}

export function isProviderNativeToolName(toolName: string): boolean {
  const normalized = toolName.trim();
  return (
    normalized === PROVIDER_NATIVE_WEB_SEARCH_TOOL ||
    normalized === PROVIDER_NATIVE_X_SEARCH_TOOL ||
    normalized === PROVIDER_NATIVE_CODE_INTERPRETER_TOOL ||
    normalized === PROVIDER_NATIVE_FILE_SEARCH_TOOL ||
    normalized.startsWith(PROVIDER_NATIVE_MCP_TOOL_PREFIX)
  );
}
