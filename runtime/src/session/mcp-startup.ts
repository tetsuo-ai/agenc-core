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
 * This module also ships `getMcpConfigFromEnv()` as an explicit
 * `AGENC_MCP_SERVERS` override. Normal startup reads the loaded
 * `~/.agenc/config.toml` snapshot (`mcp_servers`) first, then lets the
 * env override replace that list when set.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  SamplingMessageContentBlock,
} from "@modelcontextprotocol/sdk/types.js";

import type { MCPManager, MCPManagerStartOpts } from "../mcp-client/manager.js";
import { MCPManager as LiveMCPManager } from "../mcp-client/manager.js";
import type { MCPToolBridgePermissionOptions } from "../mcp-client/tools.js";
import type { MCPServerConfig } from "../mcp-client/types.js";
import type {
  LLMChatOptions,
  LLMContentPart,
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolChoice,
} from "../llm/types.js";
import type { AgenCConfig, McpServerConfig as AgenCMcpServerConfig } from "../config/schema.js";
import { McpJsonConfigSchema, type McpServerConfig as ServiceMcpServerConfig } from "../services/mcp/types.js";
import {
  createUnavailableSamplingResult,
  type McpSamplingHandlers,
} from "../services/mcp/hostCapabilities.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
} from "../permissions/evaluator.js";
import { EMPTY_MCP_TOOL_APPROVAL_TEMPLATE_FILE } from "../permissions/rpc/mcp-tool-approval-templates.js";
import { RequestPermissionsRpc } from "../permissions/rpc/request-permissions.js";
import type { Session } from "./session.js";
import type { SessionServices } from "./session.js";
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
  readonly env?: NodeJS.ProcessEnv;
}

export interface ResolveSessionMcpConfigSourcesOptions {
  readonly cwd?: string;
  readonly includeProjectMcpServers?: boolean;
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
  options: Pick<
    ResolveSessionMcpConfigSourcesOptions,
    "sandboxExecutionBroker"
  > = {},
): MCPManager {
  const manager = new LiveMCPManager([...configs]);
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
        response = await session.provider.chat(
          samplingRequestToLlmMessages(request),
          mcpSamplingChatOptions(request, signal),
        );
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

function cloneRecord<T>(
  value: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  return value ? { ...value } : undefined;
}

function toRuntimeMcpServerConfig(
  name: string,
  config: AgenCMcpServerConfig,
): MCPServerConfig {
  const raw = config as AgenCMcpServerConfig & Record<string, unknown>;
  return {
    ...raw,
    name,
    ...(config.args !== undefined ? { args: [...config.args] } : {}),
    ...(config.env_vars !== undefined ? { env_vars: [...config.env_vars] } : {}),
    ...(config.env !== undefined ? { env: cloneRecord(config.env) } : {}),
    ...(config.headers !== undefined
      ? { headers: cloneRecord(config.headers) }
      : {}),
  } as MCPServerConfig;
}

function serviceMcpServerToRuntimeConfig(
  name: string,
  config: ServiceMcpServerConfig,
): MCPServerConfig {
  const raw = config as ServiceMcpServerConfig & Record<string, unknown>;
  const type = raw.type;
  if (type === "sse" || type === "http" || type === "ws") {
    return {
      ...raw,
      name,
      transport: type === "ws" ? "websocket" : type,
      endpoint: typeof raw.url === "string" ? raw.url : undefined,
    } as MCPServerConfig;
  }
  return {
    ...raw,
    name,
    transport: "stdio",
    ...(Array.isArray(raw.args) ? { args: [...raw.args] as string[] } : {}),
    ...(raw.env !== undefined ? { env: cloneRecord(raw.env as Record<string, string>) } : {}),
  } as MCPServerConfig;
}

function projectMcpJsonPaths(cwd: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  for (;;) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return dirs.reverse().map((dir) => join(dir, ".mcp.json"));
}

function getProjectMcpConfigFromCwd(cwd: string): MCPServerConfig[] {
  const merged = new Map<string, MCPServerConfig>();
  for (const filePath of projectMcpJsonPaths(cwd)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    const result = McpJsonConfigSchema().safeParse(parsed);
    if (!result.success) continue;
    for (const [name, config] of Object.entries(result.data.mcpServers)) {
      merged.set(name, serviceMcpServerToRuntimeConfig(name, config));
    }
  }
  return [...merged.values()];
}

/**
 * Read `mcp_servers` from the loaded AgenC config snapshot and convert
 * keyed TOML tables (`[mcp_servers.github]`) into the runtime manager's
 * named config array (`{ name: "github", ... }`).
 */
export function getMcpConfigFromConfig(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
): MCPServerConfig[] {
  const servers = config?.mcp_servers;
  if (!servers) return [];
  return Object.entries(servers)
    .filter((entry): entry is [string, AgenCMcpServerConfig] => {
      const [name, value] = entry;
      return (
        typeof name === "string" &&
        name.trim().length > 0 &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      );
    })
    .map(([name, value]) => toRuntimeMcpServerConfig(name, value));
}

function hasMcpEnvOverride(env: NodeJS.ProcessEnv): boolean {
  return (
    typeof env.AGENC_MCP_SERVERS === "string" &&
    env.AGENC_MCP_SERVERS.trim().length > 0
  );
}

/**
 * Resolve the effective MCP server list for session startup. Config is
 * the default source; `AGENC_MCP_SERVERS` remains a complete override
 * so ops/tests can replace the list without editing config.toml.
 */
export function resolveSessionMcpConfig(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MCPServerConfig[] {
  if (hasMcpEnvOverride(env)) {
    return getMcpConfigFromEnv(env);
  }
  return getMcpConfigFromConfig(config);
}

export async function resolveSessionMcpConfigFromSources(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSessionMcpConfigSourcesOptions = {},
): Promise<MCPServerConfig[]> {
  if (hasMcpEnvOverride(env)) {
    return getMcpConfigFromEnv(env);
  }
  const byName = new Map<string, MCPServerConfig>();
  for (const server of getMcpConfigFromConfig(config)) {
    byName.set(server.name, server);
  }
  if (options.includeProjectMcpServers === true && options.cwd !== undefined) {
    for (const server of getProjectMcpConfigFromCwd(options.cwd)) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

/**
 * Config-backed manager construction for the local runtime path. The
 * env parameter is only the explicit `AGENC_MCP_SERVERS` override.
 */
export function createSessionMcpManagerFromConfig(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<
    ResolveSessionMcpConfigSourcesOptions,
    "sandboxExecutionBroker"
  > = {},
): MCPManager {
  return createSessionMcpManager(resolveSessionMcpConfig(config, env), options);
}

export async function createSessionMcpManagerFromSources(
  config: Pick<AgenCConfig, "mcp_servers"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveSessionMcpConfigSourcesOptions = {},
): Promise<MCPManager> {
  return createSessionMcpManager(
    await resolveSessionMcpConfigFromSources(config, env, options),
    options,
  );
}

/**
 * Back-compat env-backed manager construction for callers/tests that
 * have not yet threaded a ConfigStore snapshot. Prefer
 * `createSessionMcpManagerFromConfig` in live bootstrap paths.
 */
export function createSessionMcpManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  config?: Pick<AgenCConfig, "mcp_servers">,
  options: Pick<
    ResolveSessionMcpConfigSourcesOptions,
    "sandboxExecutionBroker"
  > = {},
): MCPManager {
  return createSessionMcpManager(resolveSessionMcpConfig(config, env), options);
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

export async function refreshMcpManagerFromConfig(params: {
  readonly manager: MCPManager;
  readonly config: Pick<AgenCConfig, "mcp_servers"> | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly opts?: MCPManagerStartOpts;
}): Promise<McpRefreshResult> {
  const configs = resolveSessionMcpConfig(params.config, params.env);
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
  options: CreateSessionMcpServiceOptions = {},
): SessionServices["mcpManager"] {
  const runtimeManager = manager as RuntimeMcpManagerWithMetadata;
  return {
    effectiveServers: async () => buildEffectiveServerMap(runtimeManager),
    toolPluginProvenance: async () => null,
    refreshFromConfig: (config) =>
      refreshMcpManagerFromConfig({
        manager,
        config: config as Pick<AgenCConfig, "mcp_servers"> | undefined,
        env: options.env,
      }),
    reconnectServer:
      typeof manager.reconnectServer === "function"
        ? manager.reconnectServer.bind(manager)
        : undefined,
    enableServer:
      typeof manager.enableServer === "function"
        ? manager.enableServer.bind(manager)
        : undefined,
    disableServer:
      typeof manager.disableServer === "function"
        ? manager.disableServer.bind(manager)
        : undefined,
    addServer:
      typeof manager.addServer === "function"
        ? manager.addServer.bind(manager)
        : undefined,
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

/**
 * Read `AGENC_MCP_SERVERS` and parse it as a JSON array of runtime
 * `MCPServerConfig` objects. Returns `[]` when the env var is unset,
 * empty, or malformed — the caller can still construct an
 * `MCPManager` with an empty config so the observer-attach site
 * remains live.
 */
export function getMcpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MCPServerConfig[] {
  const raw = env.AGENC_MCP_SERVERS;
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is MCPServerConfig =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { name?: unknown }).name === "string",
    );
  } catch {
    return [];
  }
}
