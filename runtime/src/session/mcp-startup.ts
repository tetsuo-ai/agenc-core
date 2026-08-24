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
import type { MCPServerConfig } from "../mcp-client/types.js";
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
import {
  getAllMcpConfigs,
  type McpSessionServerDisposition,
  type ResolvedMcpServerDefinition,
} from "../services/mcp/config.js";
import type { ScopedMcpServerConfig } from "../services/mcp/types.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
} from "../permissions/evaluator.js";
import { EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE } from "../permissions/rpc/mcp-tool-approval-templates.js";
import { RequestPermissionsRpc } from "../permissions/rpc/request-permissions.js";
import type {
  McpServerMutationResult,
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

export interface McpAuthorityRefreshOptions {
  readonly signal?: AbortSignal;
}

export interface SessionMcpResolutionPlan {
  readonly configs: readonly MCPServerConfig[];
  readonly definitions: ReadonlyMap<string, ResolvedMcpServerDefinition>;
  readonly knownDefinitionIds: ReadonlySet<string>;
  readonly authoritySnapshot: ReturnType<CanonicalSettingsAuthority["current"]>;
  readonly sessionDispositions: Readonly<
    Record<string, McpSessionServerDisposition>
  >;
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
    authoritySource: _authoritySource,
    pluginSource: _pluginSource,
    pluginServer: _pluginServer,
    type,
    url,
    command,
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
  if (
    transport === "stdio" &&
    (typeof command !== "string" || command.trim() === "")
  ) {
    throw new Error(`MCP server "${name}" is missing its stdio command`);
  }
  if (
    transport !== "stdio" &&
    (typeof url !== "string" || url.trim() === "")
  ) {
    throw new Error(`MCP server "${name}" is missing its remote endpoint`);
  }
  const originScope = _authoritySource ??
    (_scope === "enterprise" || _scope === "managed"
      ? "managed"
      : _scope === "dynamic" && _pluginServer !== undefined
        ? "plugin"
        : _scope === "dynamic" || _scope === "agencai"
          ? "session"
          : _scope);
  return {
    ...rest,
    name,
    transport,
    origin: {
      scope: originScope,
      ...(_pluginSource !== undefined ? { pluginSource: _pluginSource } : {}),
      ...(_pluginServer !== undefined ? { pluginServer: _pluginServer } : {}),
    },
    ...(transport === "stdio" ? { command } : { endpoint: url }),
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

/** Resolve one complete policy-checked MCP lifecycle plan for a live session. */
export async function resolveSessionMcpPlan(
  authority: CanonicalSettingsAuthority,
  environment: ProviderEnvironment,
  sessionServers: Readonly<Record<string, MCPServerConfig>> = {},
  enabledOverrides: ReadonlyMap<string, boolean> = new Map(),
): Promise<SessionMcpResolutionPlan> {
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
  const {
    servers,
    definitions,
    knownDefinitionIds,
    authoritySnapshot,
    sessionDispositions,
  } = await getAllMcpConfigs(
    authority,
    environment,
    scopedSessionServers,
    enabledOverrides,
  );
  return {
    configs: Object.entries(servers).map(([name, config]) =>
      toRuntimeMcpServerConfig(name, config),
    ),
    definitions,
    knownDefinitionIds,
    authoritySnapshot,
    sessionDispositions,
  };
}

/** Resolve the one policy-checked outbound MCP set for a live session. */
export async function resolveSessionMcpConfig(
  authority: CanonicalSettingsAuthority,
  environment: ProviderEnvironment,
  sessionServers: Readonly<Record<string, MCPServerConfig>> = {},
): Promise<MCPServerConfig[]> {
  return [
    ...(await resolveSessionMcpPlan(authority, environment, sessionServers))
      .configs,
  ];
}

export function requiredMcpServerNames(
  configs: ReadonlyArray<MCPServerConfig>,
): string[] {
  return configs
    .filter(
      (config): config is ConfiguredServerWithExtras =>
        (config as ConfiguredServerWithExtras).required === true &&
        config.enabled !== false,
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

interface SessionMcpOverlayState {
  readonly servers: ReadonlyMap<string, MCPServerConfig>;
  readonly enabledOverrides: ReadonlyMap<string, boolean>;
}

const MAX_MCP_AUTHORITY_RETRIES = 5;

function mcpMutationFailure(
  serverName: string,
  error: unknown,
): McpServerMutationResult {
  return {
    serverName,
    success: false,
    toolCount: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

function mcpTransactionError(
  message: string,
  errors: readonly unknown[],
): AggregateError {
  const error = new AggregateError(errors, message);
  error.name = "McpMutationTransactionError";
  return error;
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
  let overlay: SessionMcpOverlayState = {
    servers: new Map(),
    enabledOverrides: new Map(),
  };
  let mutationTail: Promise<void> = Promise.resolve();

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.then(operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const sessionServerRecord = (
    state: SessionMcpOverlayState,
  ): Record<string, MCPServerConfig> => Object.fromEntries(state.servers);
  const resolveOverlayPlan = (
    state: SessionMcpOverlayState,
  ): Promise<SessionMcpResolutionPlan> =>
    resolveSessionMcpPlan(
      options.authority,
      options.environment,
      sessionServerRecord(state),
      state.enabledOverrides,
    );
  const pruneOverlay = (
    state: SessionMcpOverlayState,
    plan: SessionMcpResolutionPlan,
  ): SessionMcpOverlayState => ({
    servers: new Map(
      Array.from(state.servers).filter(
        ([name]) => plan.sessionDispositions[name] !== "blocked",
      ),
    ),
    enabledOverrides: new Map(
      Array.from(state.enabledOverrides).filter(([definitionId]) =>
        plan.knownDefinitionIds.has(definitionId),
      ),
    ),
  });
  class McpAuthorityChangedError extends Error {
    constructor() {
      super("Canonical MCP authority changed during transaction");
      this.name = "McpAuthorityChangedError";
    }
  }
  const applyPlan = async (
    plan: SessionMcpResolutionPlan,
    externalSignal?: AbortSignal,
  ): Promise<McpRefreshResult> => {
    const isCurrent = (): boolean =>
      options.authority.current() === plan.authoritySnapshot;
    if (!isCurrent()) throw new McpAuthorityChangedError();

    const controller = new AbortController();
    const forwardExternalAbort = (): void => {
      controller.abort(externalSignal?.reason ?? "mcp_refresh_cancelled");
    };
    if (externalSignal?.aborted === true) {
      forwardExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", forwardExternalAbort, {
        once: true,
      });
    }
    let authorityChanged = false;
    const unsubscribe = options.authority.subscribe((snapshot) => {
      if (snapshot !== plan.authoritySnapshot) {
        authorityChanged = true;
        controller.abort("canonical_mcp_authority_changed");
      }
    });
    const requiredServers = requiredMcpServerNames(plan.configs);
    try {
      if (!isCurrent()) {
        authorityChanged = true;
        controller.abort("canonical_mcp_authority_changed");
      }
      await manager.refreshServers(
        plan.configs,
        withConfiguredRequiredServers(plan.configs, {
          signal: controller.signal,
        }),
      );
      if (authorityChanged || !isCurrent()) {
        throw new McpAuthorityChangedError();
      }
      return {
        configuredServers: plan.configs.map((config) => config.name),
        requiredServers,
      };
    } catch (error) {
      if (authorityChanged || !isCurrent()) {
        throw new McpAuthorityChangedError();
      }
      throw error;
    } finally {
      unsubscribe?.();
      externalSignal?.removeEventListener("abort", forwardExternalAbort);
    }
  };
  const resolveCurrentOverlayPlan = async (
    state: SessionMcpOverlayState,
  ): Promise<SessionMcpResolutionPlan> => {
    const churnErrors: Error[] = [];
    for (let attempt = 0; attempt < MAX_MCP_AUTHORITY_RETRIES; attempt += 1) {
      const plan = await resolveOverlayPlan(state);
      if (options.authority.current() === plan.authoritySnapshot) return plan;
      churnErrors.push(new McpAuthorityChangedError());
    }
    throw mcpTransactionError(
      "Canonical MCP authority changed repeatedly while resolving a transaction.",
      churnErrors,
    );
  };
  const reconcileOverlayState = async (
    state: SessionMcpOverlayState,
    initialPlan?: SessionMcpResolutionPlan,
    externalSignal?: AbortSignal,
  ): Promise<{
    readonly overlay: SessionMcpOverlayState;
    readonly plan: SessionMcpResolutionPlan;
    readonly result: McpRefreshResult;
  }> => {
    let plan = initialPlan;
    const churnErrors: Error[] = [];
    for (let attempt = 0; attempt < MAX_MCP_AUTHORITY_RETRIES; attempt += 1) {
      if (
        plan === undefined ||
        options.authority.current() !== plan.authoritySnapshot
      ) {
        if (plan !== undefined) churnErrors.push(new McpAuthorityChangedError());
        plan = await resolveCurrentOverlayPlan(state);
      }
      try {
        const result = await applyPlan(plan, externalSignal);
        return {
          overlay: pruneOverlay(state, plan),
          plan,
          result,
        };
      } catch (error) {
        if (error instanceof McpAuthorityChangedError) {
          churnErrors.push(error);
          plan = undefined;
          continue;
        }
        throw error;
      }
    }
    throw mcpTransactionError(
      "Canonical MCP authority changed repeatedly while applying a transaction.",
      churnErrors,
    );
  };
  const failClosed = async (
    message: string,
    causes: readonly unknown[],
  ): Promise<AggregateError> => {
    const errors = [...causes];
    try {
      await manager.refreshServers([], {});
    } catch (refreshError) {
      errors.push(refreshError);
      try {
        await manager.stop();
      } catch (stopError) {
        errors.push(stopError);
      }
    }
    return mcpTransactionError(message, errors);
  };
  const rollbackMutation = async (
    baseline: SessionMcpOverlayState,
    primaryError: unknown,
  ): Promise<Error> => {
    try {
      const reconciled = await reconcileOverlayState(baseline);
      overlay = reconciled.overlay;
      return primaryError instanceof Error
        ? primaryError
        : new Error(String(primaryError));
    } catch (rollbackError) {
      return failClosed(
        "MCP mutation failed, rollback failed, and the session was fail-closed.",
        [primaryError, rollbackError],
      );
    }
  };
  const rejectAfterCanonicalReconciliation = async (
    serverName: string,
    baseline: SessionMcpOverlayState,
    rejection: Error,
  ): Promise<McpServerMutationResult> => {
    try {
      const reconciled = await reconcileOverlayState(baseline);
      overlay = reconciled.overlay;
      return mcpMutationFailure(serverName, rejection);
    } catch (applyError) {
      return mcpMutationFailure(
        serverName,
        await failClosed(
          "MCP mutation was rejected, canonical reconciliation failed, and the session was fail-closed.",
          [rejection, applyError],
        ),
      );
    }
  };
  const refreshFromAuthorityUnlocked = async (
    refreshOptions: McpAuthorityRefreshOptions = {},
  ): Promise<McpRefreshResult> => {
    try {
      const reconciled = await reconcileOverlayState(
        overlay,
        undefined,
        refreshOptions.signal,
      );
      overlay = reconciled.overlay;
      return reconciled.result;
    } catch (error) {
      throw await failClosed(
        "Canonical MCP refresh failed and the session was fail-closed.",
        [error],
      );
    }
  };
  const setServerEnabledUnlocked = async (
    name: string,
    enabled: boolean,
  ): Promise<McpServerMutationResult> => {
    const baseline = overlay;
    let baselinePlan: SessionMcpResolutionPlan;
    try {
      baselinePlan = await resolveCurrentOverlayPlan(baseline);
    } catch (error) {
      return mcpMutationFailure(
        name,
        await failClosed(
          "MCP state resolution failed and the session was fail-closed.",
          [error],
        ),
      );
    }
    const definition = baselinePlan.definitions.get(name);
    if (definition === undefined) {
      return rejectAfterCanonicalReconciliation(
        name,
        baseline,
        new Error(`MCP server "${name}" is not configured.`),
      );
    }
    if (definition.origin === "managed") {
      return rejectAfterCanonicalReconciliation(
        name,
        baseline,
        new Error(
          `MCP server "${name}" is controlled by canonical managed policy.`,
        ),
      );
    }
    const candidate: SessionMcpOverlayState = {
      servers: baseline.servers,
      enabledOverrides: new Map(baseline.enabledOverrides).set(
        definition.id,
        enabled,
      ),
    };
    let reconciled: Awaited<ReturnType<typeof reconcileOverlayState>>;
    try {
      reconciled = await reconcileOverlayState(candidate);
    } catch (error) {
      return mcpMutationFailure(
        name,
        await rollbackMutation(baseline, error),
      );
    }
    const { plan } = reconciled;
    if (plan.definitions.get(name)?.id !== definition.id) {
      return mcpMutationFailure(
        name,
        await rollbackMutation(
          baseline,
          new Error(`MCP server "${name}" changed during mutation; retry.`),
        ),
      );
    }
    const state = manager.getConnectionState(name);
    const ready = enabled
      ? state?.type === "connected"
      : state?.type === "disabled";
    if (!ready) {
      const error =
        state?.type === "failed"
          ? state.error ?? `MCP server "${name}" failed to connect.`
          : `MCP server "${name}" did not reach the requested state.`;
      return mcpMutationFailure(
        name,
        await rollbackMutation(baseline, new Error(error)),
      );
    }
    overlay = reconciled.overlay;
    return {
      serverName: name,
      success: true,
      toolCount: enabled ? manager.getToolsByServer(name).length : 0,
    };
  };
  const addSessionServerUnlocked = async (
    config: McpSessionServerConfig,
  ): Promise<McpServerMutationResult> => {
    if (!/^[A-Za-z0-9_-]+$/u.test(config.name)) {
      return {
        serverName: config.name,
        success: false,
        toolCount: 0,
        error: `Invalid MCP server name "${config.name}". Names can only contain letters, numbers, hyphens, and underscores.`,
      };
    }
    const { args: inputArgs, ...inputConfig } = config;
    const candidate: MCPServerConfig = {
      ...inputConfig,
      ...(inputArgs !== undefined ? { args: [...inputArgs] } : {}),
      origin: { scope: "session" },
    };
    try {
      toScopedMcpServerConfig(candidate);
    } catch (error) {
      return mcpMutationFailure(candidate.name, error);
    }
    const baseline = overlay;
    let baselinePlan: SessionMcpResolutionPlan;
    try {
      baselinePlan = await resolveCurrentOverlayPlan(baseline);
    } catch (error) {
      return mcpMutationFailure(
        config.name,
        await failClosed(
          "MCP state resolution failed and the session was fail-closed.",
          [error],
        ),
      );
    }
    if (
      baseline.servers.has(config.name) ||
      baselinePlan.configs.some((server) => server.name === config.name)
    ) {
      return rejectAfterCanonicalReconciliation(
        config.name,
        baseline,
        new Error(`MCP server "${config.name}" is already configured.`),
      );
    }
    const candidateState: SessionMcpOverlayState = {
      servers: new Map(baseline.servers).set(candidate.name, candidate),
      enabledOverrides: baseline.enabledOverrides,
    };
    let reconciled: Awaited<ReturnType<typeof reconcileOverlayState>>;
    try {
      reconciled = await reconcileOverlayState(candidateState);
    } catch (error) {
      return mcpMutationFailure(
        candidate.name,
        await rollbackMutation(baseline, error),
      );
    }
    const { plan } = reconciled;
    if (plan.sessionDispositions[candidate.name] !== "active") {
      return rejectAfterCanonicalReconciliation(
        candidate.name,
        baseline,
        new Error(
          `MCP server "${candidate.name}" is blocked by canonical MCP policy.`,
        ),
      );
    }
    const state = manager.getConnectionState(candidate.name);
    if (
      state?.type === "connected" ||
      (candidate.enabled === false && state?.type === "disabled")
    ) {
      overlay = reconciled.overlay;
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
    return mcpMutationFailure(
      candidate.name,
      await rollbackMutation(baseline, new Error(error)),
    );
  };
  const reconnectServerUnlocked = async (
    name: string,
  ): Promise<McpServerMutationResult> => {
    let reconciled: Awaited<ReturnType<typeof reconcileOverlayState>>;
    try {
      reconciled = await reconcileOverlayState(overlay);
      overlay = reconciled.overlay;
    } catch (error) {
      return mcpMutationFailure(
        name,
        await failClosed(
          "MCP reconnect reconciliation failed and the session was fail-closed.",
          [error],
        ),
      );
    }
    const config = reconciled.plan.configs.find(
      (candidate) => candidate.name === name,
    );
    if (config === undefined) {
      return mcpMutationFailure(
        name,
        new Error(`MCP server "${name}" is not configured.`),
      );
    }
    if (config.enabled === false) {
      return mcpMutationFailure(
        name,
        new Error(`MCP server "${name}" is disabled in config.`),
      );
    }
    const state = manager.getConnectionState(name);
    if (state?.type !== "connected") {
      const error =
        state?.type === "failed"
          ? state.error ?? `MCP server "${name}" failed to connect.`
          : `MCP server "${name}" did not become ready.`;
      return mcpMutationFailure(name, new Error(error));
    }
    return {
      serverName: name,
      success: true,
      toolCount: manager.getToolsByServer(name).length,
    };
  };
  return {
    effectiveServers: async () => buildEffectiveServerMap(runtimeManager),
    toolPluginProvenance: async () => null,
    refreshFromAuthority: (refreshOptions) =>
      enqueueMutation(() => refreshFromAuthorityUnlocked(refreshOptions)),
    reconnectServer: (name) =>
      enqueueMutation(() => reconnectServerUnlocked(name)),
    enableServer: (name) =>
      enqueueMutation(() => setServerEnabledUnlocked(name, true)),
    disableServer: (name) =>
      enqueueMutation(() => setServerEnabledUnlocked(name, false)),
    addServer: (config) =>
      enqueueMutation(() => addSessionServerUnlocked(config)),
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
  const refreshFromAuthority = session.services?.mcpManager?.refreshFromAuthority;
  if (refreshFromAuthority !== undefined) {
    await refreshFromAuthority(
      opts.signal === undefined ? {} : { signal: opts.signal },
    );
    return;
  }
  const metadataManager = manager as MCPManager & {
    getConfiguredServers?(): readonly MCPServerConfig[];
  };
  const configs = metadataManager.getConfiguredServers?.() ?? [];
  await manager.start(withConfiguredRequiredServers(configs, opts));
}
