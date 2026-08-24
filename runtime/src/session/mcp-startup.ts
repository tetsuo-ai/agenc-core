/**
 * MCP manager startup helpers owned by the session boundary.
 *
 * `attachMcpManagerToSession` is the single canonical attach site so
 * every session owner (CLI, daemon, tests) wires the observer the same
 * way. Call this BEFORE `manager.start()`; the bridge factory bakes the
 * observer into every per-tool `execute()` closure at creation time, so
 * attaching after `start()` only covers bridges created afterwards.
 *
 * `startMcpManagerForSession` is the live contract used by bootstrap:
 * the caller may still construct the concrete `MCPManager`, but the
 * session boundary owns the attach/start ordering for the running
 * session.
 *
 * Runtime MCP configuration comes only from the canonical settings authority,
 * including its managed policy, project approvals, and enabled plugin
 * declarations. Per-process JSON payloads are not a configuration authority.
 *
 * @module
 */

import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  SamplingMessageContentBlock,
} from "@modelcontextprotocol/sdk/types.js";

import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import {
  MCPManager as LiveMCPManager,
  toScopedMcpServerConfig,
} from "../mcp-client/manager.js";
import type { MCPToolBridgePermissionOptions } from "../mcp-client/tools.js";
import type {
  MCPServerConfig,
  MCPServerMutationResult,
} from "../mcp-client/types.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import type {
  LLMChatOptions,
  LLMContentPart,
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolChoice,
} from "../llm/types.js";
import {
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
import { runAdmittedModelCall } from "../budget/admitted-model-call.js";
import type { CanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import {
  createUnavailableSamplingResult,
  type McpSamplingHandlers,
} from "../services/mcp/hostCapabilities.js";
import { getAllMcpConfigs } from "../services/mcp/config.js";
import type { ScopedMcpServerConfig } from "../services/mcp/types.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
} from "../permissions/evaluator.js";
import { EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE } from "../permissions/rpc/mcp-tool-approval-templates.js";
import { RequestPermissionsRpc } from "../permissions/rpc/request-permissions.js";
import type {
  McpSessionServerConfig,
  Session,
  SessionServices,
} from "./session.js";
import type { EventMsg, TokenCountEvent } from "./event-log.js";
import { createMCPCallObserverForSession } from "./observer-wiring.js";
import { createSessionMcpElicitationHandlers } from "../elicitation/mcp.js";
import type { McpGranularElicitationPolicy } from "../elicitation/mcp.js";

export interface McpStartupCancellationToken {
  readonly signal: AbortSignal;
  cancel(): void;
  isCancelled(): boolean;
}

export interface McpRefreshResult {
  readonly configuredServers: readonly string[];
  readonly requiredServers: readonly string[];
}

export interface CreateSessionMcpServiceOptions {
  readonly authority: CanonicalSettingsAuthority;
  readonly environment: ProviderEnvironment;
}

export interface CreateSessionMcpManagerOptions {
  /** Immutable parent environment owned by this low-level manager. */
  readonly environment?: ProviderEnvironment;
  readonly sandboxExecutionBroker?: import("../sandbox/execution-broker.js").SandboxExecutionBrokerLike;
}

type ConfiguredServerWithExtras = MCPServerConfig & {
  readonly required?: boolean;
  readonly instructions?: string;
};

type EffectiveServerWithInstructions = Awaited<
  ReturnType<SessionServices["mcpManager"]["effectiveServers"]>
> extends Map<string, infer Info>
  ? Info & { readonly instructions?: string }
  : never;

type RuntimeMcpManagerWithMetadata = MCPManager & {
  getConnectedServers?(): string[];
  getConfiguredServers?(): readonly ConfiguredServerWithExtras[];
  getConnectionState?: MCPManager["getConnectionState"];
  getConnectedConnection?: MCPManager["getConnectedConnection"];
  getServerConfig?(name: string): ConfiguredServerWithExtras | undefined;
  getServerInstructions?(name: string): string | undefined;
  getInstructionsForServer?(name: string): string | undefined;
};

function getServerInstructions(
  manager: RuntimeMcpManagerWithMetadata,
  config: ConfiguredServerWithExtras | undefined,
  name: string,
): string | undefined {
  const fromManager =
    manager.getServerInstructions?.(name) ??
    manager.getInstructionsForServer?.(name);
  if (typeof fromManager === "string" && fromManager.trim().length > 0) {
    return fromManager;
  }
  if (typeof config?.instructions === "string" && config.instructions.trim().length > 0) {
    return config.instructions;
  }
  return undefined;
}

function buildEffectiveServerMap(
  manager: RuntimeMcpManagerWithMetadata,
): Map<string, EffectiveServerWithInstructions> {
  const connectedNames = new Set(manager.getConnectedServers?.() ?? []);
  const configs = manager.getConfiguredServers?.() ?? [];
  const map = new Map<string, EffectiveServerWithInstructions>();

  for (const rawConfig of configs) {
    const config = rawConfig as ConfiguredServerWithExtras;
    const connected = connectedNames.has(config.name);
    const instructions = connected
      ? getServerInstructions(manager, config, config.name)
      : undefined;
    map.set(config.name, {
      enabled: connected,
      required: config.required ?? false,
      ...(config.endpoint !== undefined ? { url: config.endpoint } : {}),
      ...(config.command !== undefined ? { command: config.command } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    } as EffectiveServerWithInstructions);
  }

  for (const name of connectedNames) {
    if (map.has(name)) {
      continue;
    }
    const config = manager.getServerConfig?.(name) as
      | ConfiguredServerWithExtras
      | undefined;
    const instructions = getServerInstructions(manager, config, name);
    map.set(name, {
      enabled: true,
      required: config?.required ?? false,
      ...(config?.endpoint !== undefined ? { url: config.endpoint } : {}),
      ...(config?.command !== undefined ? { command: config.command } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    } as EffectiveServerWithInstructions);
  }

  return map;
}

/**
 * Construct the real runtime `MCPManager` for a session boundary.
 * Bootstrap/CLI own env/config discovery, but the concrete manager
 * type comes from the session MCP startup module so the live lifecycle
 * stays anchored at the runtime boundary instead of compatibility service/UI
 * surfaces.
 */
export function createSessionMcpManager(
  configs: ReadonlyArray<MCPServerConfig>,
  options: CreateSessionMcpManagerOptions = {},
): MCPManager {
  const manager = new LiveMCPManager(
    [...configs],
    undefined,
    options.environment,
  );
  manager.setSandboxExecutionBroker(options.sandboxExecutionBroker);
  return manager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSamplingContentBlocks(
  content: unknown,
): SamplingMessageContentBlock[] {
  if (Array.isArray(content)) {
    return content.filter(isRecord) as SamplingMessageContentBlock[];
  }
  return isRecord(content) ? [content as SamplingMessageContentBlock] : [];
}

function textBlockFromUnknown(value: unknown): LLMContentPart | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return { type: "text", text: value };
}

function fallbackTextForSamplingBlock(
  block: Record<string, unknown>,
): string | undefined {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : undefined;
    case "tool_use":
      return JSON.stringify({
        toolUse: {
          name: block.name,
          input: block.input,
        },
      });
    case "tool_result":
      return JSON.stringify({ toolResult: block });
    case "audio":
      return "[MCP sampling audio content omitted]";
    default:
      return undefined;
  }
}

function samplingContentToLlmContent(
  content: unknown,
): string | LLMContentPart[] {
  const blocks = asSamplingContentBlocks(content);
  const parts: LLMContentPart[] = [];
  for (const block of blocks) {
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.mimeType};base64,${block.data}`,
        },
      });
      continue;
    }
    const textPart = textBlockFromUnknown(fallbackTextForSamplingBlock(block));
    if (textPart !== undefined) {
      parts.push(textPart);
    }
  }

  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("\n");
  }
  return parts;
}

function samplingRequestToLlmMessages(
  request: CreateMessageRequest,
): LLMMessage[] {
  return request.params.messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: samplingContentToLlmContent(message.content),
  }));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mcpSamplingModelHint(request: CreateMessageRequest): string | undefined {
  const hints = request.params.modelPreferences?.hints;
  if (!Array.isArray(hints)) return undefined;
  for (const hint of hints) {
    const name = nonEmptyString(hint.name);
    if (name !== undefined) return name;
  }
  return undefined;
}

function mcpSamplingStopSequences(
  request: CreateMessageRequest,
): readonly string[] | undefined {
  const sequences = request.params.stopSequences
    ?.map((sequence) => sequence.trim())
    .filter((sequence) => sequence.length > 0);
  return sequences !== undefined && sequences.length > 0 ? sequences : undefined;
}

function mcpSamplingTools(
  request: CreateMessageRequest,
): readonly LLMTool[] | undefined {
  const tools = request.params.tools;
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool): LLMTool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      parameters: tool.inputSchema,
    },
  }));
}

function mcpSamplingToolChoice(
  request: CreateMessageRequest,
): LLMToolChoice | undefined {
  const mode = request.params.toolChoice?.mode;
  if (mode === "auto" || mode === "required" || mode === "none") return mode;
  return undefined;
}

function mcpSamplingChatOptions(
  request: CreateMessageRequest,
  signal: AbortSignal | undefined,
): LLMChatOptions {
  const model = mcpSamplingModelHint(request);
  const maxOutputTokens = positiveInteger(request.params.maxTokens);
  const temperature = finiteNumber(request.params.temperature);
  const stopSequences = mcpSamplingStopSequences(request);
  const tools = mcpSamplingTools(request);
  const toolChoice = mcpSamplingToolChoice(request);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(request.params.systemPrompt !== undefined
      ? { systemPrompt: request.params.systemPrompt }
      : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(stopSequences !== undefined ? { stopSequences } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
}

function mcpSamplingStopReason(
  finishReason: Awaited<ReturnType<Session["provider"]["chat"]>>["finishReason"],
): CreateMessageResult["stopReason"] {
  switch (finishReason) {
    case "length":
      return "maxTokens";
    case "tool_calls":
      return "toolUse";
    case "error":
      return "error";
    case "stop":
    case "content_filter":
    default:
      return "endTurn";
  }
}

function parseToolCallInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mcpSamplingResultContent(
  response: LLMResponse,
): CreateMessageResult["content"] | CreateMessageResultWithTools["content"] {
  if (response.toolCalls.length === 0) {
    return {
      type: "text",
      text: response.content,
    };
  }

  const blocks: SamplingMessageContentBlock[] = [];
  if (response.content.trim().length > 0) {
    blocks.push({
      type: "text",
      text: response.content,
    });
  }
  for (const toolCall of response.toolCalls) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: parseToolCallInput(toolCall.arguments),
    });
  }
  return blocks;
}

function mcpSamplingAllowedForSession(session: Session): boolean {
  return session.sessionConfiguration.approvalPolicy.value === "never";
}

function emitSessionEvent(session: Session, msg: EventMsg): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg,
  });
}

function mcpSamplingCallId(
  serverName: string,
  requestId: string | number | undefined,
): string {
  return `mcp-sampling:${serverName}:${requestId ?? "unknown"}`;
}

function mcpSamplingRequestSummary(request: CreateMessageRequest): string {
  const modelPreferences = request.params.modelPreferences;
  const modelHint = mcpSamplingModelHint(request);
  const prioritySummary = modelPreferences
    ? {
      costPriority: finiteNumber(modelPreferences.costPriority),
      speedPriority: finiteNumber(modelPreferences.speedPriority),
      intelligencePriority: finiteNumber(modelPreferences.intelligencePriority),
    }
    : undefined;
  return JSON.stringify({
    messageCount: request.params.messages.length,
    hasSystemPrompt: request.params.systemPrompt !== undefined,
    maxTokens: request.params.maxTokens,
    ...(request.params.temperature !== undefined
      ? { temperature: request.params.temperature }
      : {}),
    ...(request.params.stopSequences !== undefined
      ? { stopSequenceCount: request.params.stopSequences.length }
      : {}),
    ...(request.params.includeContext !== undefined
      ? { includeContext: request.params.includeContext }
      : {}),
    ...(modelHint !== undefined ? { modelHint } : {}),
    ...(prioritySummary !== undefined ? { modelPreferences: prioritySummary } : {}),
    ...(request.params.tools !== undefined
      ? { toolCount: request.params.tools.length }
      : {}),
    ...(request.params.toolChoice?.mode !== undefined
      ? { toolChoice: request.params.toolChoice.mode }
      : {}),
    ...(request.params.metadata !== undefined ? { hasMetadata: true } : {}),
  });
}

function tokenCountEventForSampling(
  usage: Awaited<ReturnType<Session["provider"]["chat"]>>["usage"],
  model: string,
): TokenCountEvent {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: usage.reasoningOutputTokens }
      : {}),
    ...(usage.webSearchRequests !== undefined
      ? { webSearchRequests: usage.webSearchRequests }
      : {}),
    model,
  };
}

export function createSessionMcpSamplingHandlers(
  session: Session,
): McpSamplingHandlers {
  return {
    async createMessage({ serverName, requestId, request, signal }) {
      if (!mcpSamplingAllowedForSession(session)) {
        emitSessionEvent(session, {
          type: "warning",
          payload: {
            cause: "mcp_sampling_denied",
            message:
              `MCP server "${serverName}" requested model sampling, but the current approval policy does not allow unattended provider calls.`,
          },
        });
        return createUnavailableSamplingResult();
      }

      const startedAt = Date.now();
      const callId = mcpSamplingCallId(serverName, requestId);
      emitSessionEvent(session, {
        type: "mcp_tool_call_begin",
        payload: {
          callId,
          server: serverName,
          toolName: "sampling/createMessage",
          args: mcpSamplingRequestSummary(request),
        },
      });

      let response: Awaited<ReturnType<Session["provider"]["chat"]>>;
      try {
        const provider = session.provider;
        const messages = samplingRequestToLlmMessages(request);
        const options = mcpSamplingChatOptions(request, signal);
        response = await runAdmittedModelCall({
          session,
          provider,
          messages,
          options,
          stepId:
            `mcp_sampling:${serverName}:${requestId ?? "unknown"}:` +
            session.nextInternalSubId(),
          sessionId: session.conversationId,
          model:
            options.model ??
            readProviderFactoryOptions(provider).model ??
            session.modelInfo?.slug ??
            "unknown",
          providerName: readProviderIdentity(provider) ?? provider.name,
          ...(signal !== undefined ? { signal } : {}),
          invoke: (admittedOptions) =>
            provider.chat(messages, admittedOptions),
        });
      } catch (err) {
        emitSessionEvent(session, {
          type: "mcp_tool_call_end",
          payload: {
            callId,
            result: err instanceof Error ? err.message : String(err),
            isError: true,
            durationMs: Date.now() - startedAt,
          },
        });
        throw err;
      }

      emitSessionEvent(session, {
        type: "token_count",
        payload: tokenCountEventForSampling(response.usage, response.model),
      });
      emitSessionEvent(session, {
        type: "mcp_tool_call_end",
        payload: {
          callId,
          result: "sampling/createMessage completed",
          isError: false,
          durationMs: Date.now() - startedAt,
        },
      });

      return {
        role: "assistant",
        model: response.model,
        stopReason: mcpSamplingStopReason(response.finishReason),
        content: mcpSamplingResultContent(response),
      };
    },
  };
}

function toRuntimeMcpServerConfig(
  name: string,
  config: ScopedMcpServerConfig,
): MCPServerConfig {
  const raw = config as ScopedMcpServerConfig & Record<string, unknown>;
  const {
    scope: _scope,
    pluginSource: _pluginSource,
    pluginServer: _pluginServer,
    type,
    url,
    args,
    env,
    headers,
    ...rest
  } = raw;
  let transport: NonNullable<MCPServerConfig["transport"]>;
  switch (type) {
    case undefined:
    case "stdio":
      transport = "stdio";
      break;
    case "sse":
    case "http":
      transport = type;
      break;
    case "ws":
      transport = "websocket";
      break;
    case "sse-ide":
    case "ws-ide":
    case "sdk":
    case "agencai-proxy":
      throw new Error(
        `Unsupported MCP server type reached canonical startup: ${type}`,
      );
  }
  if (transport !== "stdio" && typeof url !== "string") {
    throw new Error(`MCP server "${name}" is missing its remote endpoint`);
  }
  const originScope =
    _scope === "enterprise" || _scope === "managed"
      ? "managed"
      : _scope === "dynamic" && _pluginServer !== undefined
        ? "plugin"
        : _scope === "dynamic" || _scope === "agencai"
          ? "session"
          : _scope;
  return {
    ...rest,
    name,
    transport,
    origin: {
      scope: originScope,
      ...(_pluginSource !== undefined ? { pluginSource: _pluginSource } : {}),
      ...(_pluginServer !== undefined ? { pluginServer: _pluginServer } : {}),
    },
    ...(transport === "stdio" ? {} : { endpoint: url }),
    ...(Array.isArray(args)
      ? {
          args: args.map((arg) => {
            if (typeof arg !== "string") {
              throw new Error(`MCP server "${name}" has a non-string argument`);
            }
            return arg;
          }),
        }
      : {}),
    ...(env !== undefined ? { env: { ...env } as Record<string, string> } : {}),
    ...(headers !== undefined
      ? { headers: { ...headers } as Record<string, string> }
      : {}),
  } as MCPServerConfig;
}

/** Resolve the one policy-checked outbound MCP set for a live session. */
export async function resolveSessionMcpConfig(
  authority: CanonicalSettingsAuthority,
  environment: ProviderEnvironment,
  sessionServers: Readonly<Record<string, MCPServerConfig>> = {},
): Promise<MCPServerConfig[]> {
  const scopedSessionServers = Object.fromEntries(
    Object.entries(sessionServers).map(([name, config]) => [
      name,
      toScopedMcpServerConfig({
        ...config,
        name,
        origin: { scope: "session" },
      }),
    ]),
  );
  const { servers } = await getAllMcpConfigs(
    authority,
    environment,
    scopedSessionServers,
  );
  return Object.entries(servers).map(([name, config]) =>
    toRuntimeMcpServerConfig(name, config),
  );
}

export async function createSessionMcpManagerFromAuthority(
  authority: CanonicalSettingsAuthority,
  environment: ProviderEnvironment,
  options: Omit<CreateSessionMcpManagerOptions, "environment"> = {},
): Promise<MCPManager> {
  return createSessionMcpManager(
    await resolveSessionMcpConfig(authority, environment),
    { ...options, environment },
  );
}

export function requiredMcpServerNames(
  configs: ReadonlyArray<MCPServerConfig>,
): string[] {
  return configs
    .filter(
      (config): config is ConfiguredServerWithExtras =>
        (config as ConfiguredServerWithExtras).required === true,
    )
    .map((config) => config.name);
}

function withConfiguredRequiredServers(
  configs: ReadonlyArray<MCPServerConfig>,
  opts: MCPManagerStartOpts = {},
): MCPManagerStartOpts {
  if (opts.requiredServers !== undefined) {
    return opts;
  }
  const requiredServers = requiredMcpServerNames(configs);
  if (requiredServers.length === 0) {
    return opts;
  }
  return {
    ...opts,
    requiredServers,
  };
}

export async function refreshMcpManagerFromAuthority(params: {
  readonly manager: MCPManager;
  readonly authority: CanonicalSettingsAuthority;
  readonly environment: ProviderEnvironment;
  readonly sessionServers?: Readonly<Record<string, MCPServerConfig>>;
  readonly enabledOverrides?: ReadonlyMap<string, boolean>;
  readonly opts?: MCPManagerStartOpts;
}): Promise<McpRefreshResult> {
  const resolved = await resolveSessionMcpConfig(
    params.authority,
    params.environment,
    params.sessionServers,
  );
  const configs = resolved.map((config) => {
    const enabled = params.enabledOverrides?.get(config.name);
    return enabled === undefined ? config : { ...config, enabled };
  });
  const requiredServers = requiredMcpServerNames(configs);
  await params.manager.refreshServers(
    configs,
    withConfiguredRequiredServers(configs, params.opts ?? {}),
  );
  return {
    configuredServers: configs.map((config) => config.name),
    requiredServers,
  };
}

export function createMcpStartupCancellationToken(): McpStartupCancellationToken {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel: () => {
      if (!controller.signal.aborted) {
        controller.abort("mcp_startup_cancelled");
      }
    },
    isCancelled: () => controller.signal.aborted,
  };
}

/**
 * Session-facing MCP service surface. This is intentionally not the
 * old React/service MCP owner; it is a thin facade over the real live
 * manager so routing/provenance callers and subagent readiness checks
 * all observe the same runtime-owned connection state.
 */
export function createSessionMcpService(
  manager: MCPManager,
  options: CreateSessionMcpServiceOptions,
): SessionServices["mcpManager"] {
  const runtimeManager = manager as RuntimeMcpManagerWithMetadata;
  const sessionServers = new Map<string, MCPServerConfig>();
  const enabledOverrides = new Map<string, boolean>();
  const sessionServerRecord = (): Record<string, MCPServerConfig> =>
    Object.fromEntries(sessionServers);
  const refreshFromAuthority = async (): Promise<McpRefreshResult> => {
    const result = await refreshMcpManagerFromAuthority({
      manager,
      authority: options.authority,
      environment: options.environment,
      sessionServers: sessionServerRecord(),
      enabledOverrides,
    });
    const configured = manager.getConfiguredServers();
    const configuredNames = new Set(configured.map((config) => config.name));
    const admittedSessionNames = new Set(
      configured
        .filter((config) => config.origin?.scope === "session")
        .map((config) => config.name),
    );
    for (const name of sessionServers.keys()) {
      if (!admittedSessionNames.has(name)) sessionServers.delete(name);
    }
    for (const name of enabledOverrides.keys()) {
      if (!configuredNames.has(name)) enabledOverrides.delete(name);
    }
    return result;
  };
  const setServerEnabled = async (
    name: string,
    enabled: boolean,
  ): Promise<MCPServerMutationResult> => {
    const result = enabled
      ? await manager.enableServer(name)
      : await manager.disableServer(name);
    if (result.success) enabledOverrides.set(name, enabled);
    return result;
  };
  const addSessionServer = async (
    config: McpSessionServerConfig,
  ): Promise<MCPServerMutationResult> => {
    if (!/^[A-Za-z0-9_-]+$/u.test(config.name)) {
      return {
        serverName: config.name,
        success: false,
        toolCount: 0,
        error: `Invalid MCP server name "${config.name}". Names can only contain letters, numbers, hyphens, and underscores.`,
      };
    }
    if (manager.getConfiguredServers().some((server) => server.name === config.name)) {
      return {
        serverName: config.name,
        success: false,
        toolCount: 0,
        error: `MCP server "${config.name}" is already configured.`,
      };
    }
    const { args: inputArgs, ...inputConfig } = config;
    const candidate: MCPServerConfig = {
      ...inputConfig,
      ...(inputArgs !== undefined ? { args: [...inputArgs] } : {}),
      origin: { scope: "session" },
    };
    const proposed = {
      ...sessionServerRecord(),
      [candidate.name]: candidate,
    };
    const admitted = await resolveSessionMcpConfig(
      options.authority,
      options.environment,
      proposed,
    );
    if (
      !admitted.some(
        (server) =>
          server.name === candidate.name && server.origin?.scope === "session",
      )
    ) {
      return {
        serverName: candidate.name,
        success: false,
        toolCount: 0,
        error: `MCP server "${candidate.name}" is blocked by canonical MCP policy.`,
      };
    }

    sessionServers.set(candidate.name, candidate);
    try {
      await refreshFromAuthority();
    } catch (error) {
      sessionServers.delete(candidate.name);
      await refreshFromAuthority();
      return {
        serverName: candidate.name,
        success: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const state = manager.getConnectionState(candidate.name);
    if (state?.type === "connected" || state?.type === "disabled") {
      return {
        serverName: candidate.name,
        success: true,
        toolCount: manager.getToolsByServer(candidate.name).length,
      };
    }
    const error =
      state?.type === "failed"
        ? state.error ?? `MCP server "${candidate.name}" failed to connect.`
        : `MCP server "${candidate.name}" did not become ready.`;
    sessionServers.delete(candidate.name);
    await refreshFromAuthority();
    return {
      serverName: candidate.name,
      success: false,
      toolCount: 0,
      error,
    };
  };
  return {
    effectiveServers: async () => buildEffectiveServerMap(runtimeManager),
    toolPluginProvenance: async () => null,
    refreshFromAuthority,
    reconnectServer:
      typeof manager.reconnectServer === "function"
        ? manager.reconnectServer.bind(manager)
        : undefined,
    enableServer: (name) => setServerEnabled(name, true),
    disableServer: (name) => setServerEnabled(name, false),
    addServer: addSessionServer,
    getTools:
      typeof manager.getTools === "function"
        ? manager.getTools.bind(manager)
        : undefined,
    getToolsByServer:
      typeof manager.getToolsByServer === "function"
        ? manager.getToolsByServer.bind(manager)
        : undefined,
    getConfiguredServers:
      typeof manager.getConfiguredServers === "function"
        ? manager.getConfiguredServers.bind(manager)
        : undefined,
    getConnectionState:
      typeof manager.getConnectionState === "function"
        ? manager.getConnectionState.bind(manager)
        : undefined,
    getConnectedConnection:
      typeof manager.getConnectedConnection === "function"
        ? manager.getConnectedConnection.bind(manager)
        : undefined,
    isConnected:
      typeof manager.isConnected === "function"
        ? manager.isConnected.bind(manager)
        : undefined,
    resolveMcpToolInfo:
      typeof manager.resolveMcpToolInfo === "function"
        ? manager.resolveMcpToolInfo.bind(manager)
        : undefined,
    getServerForTool:
      typeof manager.getServerForTool === "function"
        ? manager.getServerForTool.bind(manager)
        : undefined,
    getConnectedServers:
      typeof manager.getConnectedServers === "function"
        ? manager.getConnectedServers.bind(manager)
        : undefined,
    getServerInstructions:
      typeof (manager as { getServerInstructions?: unknown })
        .getServerInstructions === "function"
        ? (
            manager as { getServerInstructions: (name: string) => string | undefined }
          ).getServerInstructions.bind(manager)
        : undefined,
  };
}

/**
 * Attach a session's MCP call observer to an `MCPManager`. Must run
 * BEFORE `manager.start()` so `mcp_tool_call_begin` /
 * `mcp_tool_call_end` events are captured from the very first bridge.
 *
 * The helper tolerates `sessionSlot.current === null` (the slot may
 * still be unfilled at wiring time) — the slot-bound observer silently
 * drops events until the slot is populated.
 */
export function attachMcpManagerToSession(
  manager: MCPManager,
  session: Session,
): void {
  const observer = createMCPCallObserverForSession(session);
  try {
    manager.setCallObserver(observer);
    const permissionManager = manager as MCPManager & {
      setPermissionOptions?: (options: MCPToolBridgePermissionOptions) => void;
    };
    const permissionOptions = createMcpPermissionOptionsForSession(session);
    if (permissionOptions !== undefined) {
      permissionManager.setPermissionOptions?.(permissionOptions);
    }
    const elicitationManager = manager as MCPManager & {
      setElicitationHandlers?: MCPManager["setElicitationHandlers"];
    };
    elicitationManager.setElicitationHandlers?.(
      createSessionMcpElicitationHandlers(
        session,
        granularElicitationPolicyForSession(session),
      ),
    );
    const samplingManager = manager as MCPManager & {
      setSamplingHandlers?: MCPManager["setSamplingHandlers"];
    };
    samplingManager.setSamplingHandlers?.(
      createSessionMcpSamplingHandlers(session),
    );
  } catch (err) {
    // Surface the failure through the session's event log rather than
    // silently running MCP with partial session wiring.
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "error",
        payload: {
          cause: "mcp_observer_attach_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      },
    });
    throw err;
  }
}

function createMcpPermissionOptionsForSession(
  session: Session,
): MCPToolBridgePermissionOptions | undefined {
  const registry = (session as {
    readonly permissionModeRegistry?: Session["permissionModeRegistry"];
  }).permissionModeRegistry;
  const sessionConfiguration = (session as {
    readonly sessionConfiguration?: Session["sessionConfiguration"];
  }).sessionConfiguration;
  if (registry === undefined || sessionConfiguration === undefined) {
    return undefined;
  }
  const services = (session as {
    readonly services?: Partial<Session["services"]>;
  }).services ?? {};
  const denialTracking = freshDenialTracking();
  return {
    canUseTool: hasPermissionsToUseTool,
    permissionContext: attachContextDefaults({
      session,
      denialTracking,
      getAppState() {
        const toolPermissionContext = registry.current();
        return {
          toolPermissionContext,
          denialTracking,
          autoModeActive: toolPermissionContext.autoModeActive === true,
        };
      },
    }),
    ...(services.approvalResolver !== undefined
      ? { approvalResolver: services.approvalResolver }
      : {}),
    ...(services.guardianApprovalReviewer !== undefined
      ? { guardianApprovalReviewer: services.guardianApprovalReviewer }
      : {}),
    getActiveTurnId: () =>
      (session as { readonly activeTurn?: Session["activeTurn"] })
        .activeTurn?.unsafePeek()?.turnId ?? null,
    requestPermissionsRpc: new RequestPermissionsRpc(),
    approvalTemplates: EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE,
    session,
    cwd: sessionConfiguration.cwd,
    ...((session as { readonly abortController?: Session["abortController"] })
      .abortController?.signal !== undefined
      ? {
          signal: (session as { readonly abortController?: Session["abortController"] })
            .abortController!.signal,
        }
      : {}),
    approvalPolicy: sessionConfiguration.approvalPolicy.value,
    sandboxPolicy: sessionConfiguration.sandboxPolicy.value,
    ...(sessionConfiguration.approvalsReviewer !== undefined
      ? { approvalsReviewer: sessionConfiguration.approvalsReviewer }
      : {}),
  };
}

function granularElicitationPolicyForSession(
  session: Session,
): McpGranularElicitationPolicy | undefined {
  const granular = (session as {
    services?: {
      granularApprovalConfig?: {
        readonly mcp_elicitations?: unknown;
      };
    };
  }).services?.granularApprovalConfig;
  if (granular === undefined) return undefined;
  return {
    allowsMcpElicitations: () => granular.mcp_elicitations === true,
  };
}

/**
 * Canonical live startup ordering for a session-owned MCP manager.
 * Attaches the observer first, then starts the manager.
 */
export async function startMcpManagerForSession(
  manager: MCPManager,
  session: Session,
  opts: MCPManagerStartOpts = {},
): Promise<void> {
  attachMcpManagerToSession(manager, session);
  const metadataManager = manager as MCPManager & {
    getConfiguredServers?(): readonly MCPServerConfig[];
  };
  const configs = metadataManager.getConfiguredServers?.() ?? [];
  await manager.start(withConfiguredRequiredServers(configs, opts));
}
