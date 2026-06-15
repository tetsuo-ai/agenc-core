/**
 * MCP tool bridge for @tetsuo-ai/runtime.
 *
 * Converts MCP server tools into runtime Tool instances,
 * enabling seamless integration with the ToolRegistry and LLM system.
 *
 * @module
 */

import type { Tool, ToolResult, JSONSchema } from "./_deps/tools-types.js";
import type { MCPToolBridge } from "./types.js";
import type { Logger } from "./_deps/logger.js";
import { silentLogger } from "./_deps/logger.js";
import {
  isValidPermissionDefaultMode,
  type PermissionDefaultMode,
  type PerToolConfig,
} from "../config/schema.js";
import { createTurnDiffTracker, type ToolInvocation } from "../tools/context.js";
import {
  arbitratePermissionMode,
  requestApproval,
  type ApprovalResolver,
} from "../permissions/guardian/arbiter.js";
import type { GuardianApprovalReviewer } from "../permissions/guardian/reviewer.js";
import {
  reviewDecisionIsAllow,
  type ReviewDecision,
} from "../permissions/review-decision.js";
import type {
  CanUseToolFn,
  ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import {
  EMPTY_REQUEST_PERMISSION_PROFILE,
  requestPermissionsEventPermissionLabels,
  type RequestPermissionsEvent,
  type RequestPermissionsRpc,
  type RequestPermissionProfile,
  type RequestPermissionsResponse,
} from "../permissions/rpc/request-permissions.js";
import {
  renderMcpToolApprovalTemplate,
  type McpToolApprovalJsonValue,
  type McpToolApprovalTemplateFile,
} from "../permissions/rpc/mcp-tool-approval-templates.js";
import {
  computeMCPToolCatalogSha256,
  catalogDigestMatches,
  type MCPToolDescriptorLike,
} from "./supply-chain.js";
import { encodeMcpToolNameForWire } from "../llm/wire/mcp-tool-naming.js";

/**
 * Policy knobs forwarded from server config to the bridge. `allowedTools`
 * / `deniedTools` are post-list filters; `pinnedCatalogSha256` is the
 * I-74 supply-chain pin.
 */
export interface MCPToolCatalogPolicyConfig {
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly pinnedCatalogSha256?: string;
  readonly defaultToolsApprovalMode?: PermissionDefaultMode;
  readonly tools?: Readonly<Record<string, PerToolConfig>>;
  readonly riskControls?: unknown;
  readonly supplyChain?: {
    readonly catalogSha256?: string;
  };
}

function filterMCPToolCatalog<T extends { name: string }>(
  config: MCPToolCatalogPolicyConfig | undefined,
  tools: readonly T[],
): readonly T[] {
  if (!config) return tools;
  const allow = config.allowedTools
    ? new Set(config.allowedTools)
    : undefined;
  const deny = config.deniedTools ? new Set(config.deniedTools) : undefined;
  return tools.filter((t) => {
    if (deny?.has(t.name)) return false;
    if (allow && !allow.has(t.name)) return false;
    return true;
  });
}

function approvalModeAlias(raw: unknown): PermissionDefaultMode | undefined {
  switch (raw) {
    case "approve":
      return "never";
    case "prompt":
      return "untrusted";
    default:
      return undefined;
  }
}

function perMcpToolApprovalMode(
  config: MCPToolCatalogPolicyConfig | undefined,
  rawToolName: string,
  namespacedToolName: string,
): PermissionDefaultMode | undefined {
  const toolConfig = config?.tools?.[rawToolName] ?? config?.tools?.[namespacedToolName];
  const explicit = toolConfig?.default_permission_mode ??
    toolConfig?.defaultPermissionMode ??
    approvalModeAlias(toolConfig?.approval_mode);
  if (isValidPermissionDefaultMode(explicit)) return explicit;
  return isValidPermissionDefaultMode(config?.defaultToolsApprovalMode)
    ? config.defaultToolsApprovalMode
    : undefined;
}

function modelFacingMcpToolDescription(
  namespacedName: string,
  rawToolName: string,
  rawDescription: string | undefined,
): string {
  const baseDescription =
    rawDescription && rawDescription.trim().length > 0
      ? rawDescription.trim()
      : `MCP tool: ${rawToolName}`;
  const wireName = encodeMcpToolNameForWire(namespacedName);
  const nameHint =
    wireName === namespacedName
      ? `Canonical MCP tool name: ${namespacedName}.`
      : `Model-facing function name: ${wireName}. Canonical MCP tool name: ${namespacedName}.`;
  return `${baseDescription}\n\n${nameHint} Call this only through the tool-call interface; do not use Skill or shell commands as a substitute.`;
}

const DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_CALL_TIMEOUT_MS = 45_000;
const MCP_REQUEST_PERMISSIONS_TOOL_NAME = "request_permissions";

/** I-76: upper bound on a single MCP tool-call result, 5MB. */
const MAX_MCP_CALL_RESULT_BYTES = 5 * 1024 * 1024;

/**
 * T6 gap #119: optional observer hooks for `mcp_tool_call_begin` /
 * `mcp_tool_call_end` EventMsg emissions. The bridge factory does not
 * own a `Session`, so callers pass these hooks in — the manager wires
 * them to `session.emit(...)` with `session.nextInternalSubId()` for
 * the event id. Missing hooks = no emission (test fixtures stay silent).
 */
export interface MCPCallObserver {
  onBegin?: (begin: {
    readonly callId: string;
    readonly server: string;
    readonly toolName: string;
    readonly args: string;
  }) => void;
  onEnd?: (end: {
    readonly callId: string;
    readonly server: string;
    readonly toolName: string;
    readonly result: string;
    readonly isError: boolean;
    readonly durationMs: number;
  }) => void;
}

export interface MCPToolBridgePermissionOptions {
  readonly canUseTool?: CanUseToolFn;
  readonly permissionContext?: ToolEvaluatorContext;
  readonly approvalResolver?: ApprovalResolver;
  readonly guardianApprovalReviewer?: GuardianApprovalReviewer;
  readonly getActiveTurnId?: () => string | null;
  readonly requestPermissionsRpc?: RequestPermissionsRpc;
  readonly approvalTemplates?: McpToolApprovalTemplateFile;
  readonly cwd?: string;
  readonly turnId?: string;
  readonly session?: unknown;
  readonly approvalsReviewer?: string;
  readonly approvalPolicy?: string;
  readonly sandboxPolicy?: string;
  readonly signal?: AbortSignal;
}

interface ToolBridgeOptions {
  listToolsTimeoutMs?: number;
  callToolTimeoutMs?: number;
  serverConfig?: MCPToolCatalogPolicyConfig;
  callObserver?: MCPCallObserver;
  permissions?: MCPToolBridgePermissionOptions;
  serverOrigin?: string;
  transport?: "stdio" | "sse" | "http" | "streamable_http";
}

interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

interface MCPListToolsResponse {
  tools?: unknown;
}

type PermissionResolution =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly result: ToolResult };

const EMPTY_REQUEST_PERMISSIONS_RESPONSE: RequestPermissionsResponse = {
  permissions: EMPTY_REQUEST_PERMISSION_PROFILE,
  scope: "turn",
  strictAutoReview: false,
};

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

/**
 * Truncate a string so its UTF-8 byte length is <= `maxBytes` without
 * splitting multi-byte codepoints mid-sequence.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function randomCallId(): string {
  // Non-crypto — just needs to be unique within a session for tracing.
  return Math.random().toString(36).slice(2, 10);
}

function safeStringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

function safeStringifyMCPPayload(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined) return fallback;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : serialized;
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function normalizeMCPToolDescriptor(raw: unknown): MCPToolDescriptor | null {
  const record = asRecord(raw);
  if (!record) return null;

  const name = stringValue(record.name);
  if (!name) return null;

  const description = typeof record.description === "string"
    ? record.description
    : undefined;
  const inputSchema = asRecord(record.inputSchema) ?? {
    type: "object",
    properties: {},
  };

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    inputSchema,
  };
}

function normalizeMCPToolCatalog(rawTools: unknown): MCPToolDescriptor[] {
  if (!Array.isArray(rawTools)) return [];
  return rawTools
    .map(normalizeMCPToolDescriptor)
    .filter((tool): tool is MCPToolDescriptor => tool !== null);
}

function renderMCPCallContentItem(raw: unknown): string {
  const record = asRecord(raw);
  if (record?.type === "text") {
    return safeStringifyMCPPayload(record.text);
  }
  return safeStringifyMCPPayload(raw);
}

function renderMCPCallContent(rawContent: unknown): string {
  if (Array.isArray(rawContent)) {
    return rawContent.map(renderMCPCallContentItem).join("\n");
  }
  return safeStringifyMCPPayload(rawContent);
}

function normalizeMCPCallToolResponse(raw: unknown): {
  readonly content: string;
  readonly isError: boolean;
} {
  const record = asRecord(raw);
  if (!record) {
    return {
      content: renderMCPCallContent(raw),
      isError: false,
    };
  }

  return {
    content: renderMCPCallContent(record.content),
    isError: record.isError === true,
  };
}

function errorResult(content: string): ToolResult {
  return { content, isError: true };
}

function approvalPathConfigured(
  options: MCPToolBridgePermissionOptions,
): boolean {
  return options.approvalResolver !== undefined ||
    options.guardianApprovalReviewer !== undefined;
}

function requestPermissionsApprovalArgs(
  event: RequestPermissionsEvent,
): Record<string, unknown> {
  return {
    permissions: requestPermissionsEventPermissionLabels(event.permissions),
    requested: event.permissions,
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  };
}

function bridgeApprovalTurnConfig(
  options: MCPToolBridgePermissionOptions,
): { readonly approvalsReviewer?: string } {
  return {
    ...(options.approvalsReviewer !== undefined
      ? { approvalsReviewer: options.approvalsReviewer }
      : options.guardianApprovalReviewer !== undefined
        ? { approvalsReviewer: "auto_review" }
        : {}),
  };
}

function mcpApprovalReason(
  serverName: string,
  descriptor: MCPToolDescriptorLike,
  args: Record<string, unknown>,
  options: MCPToolBridgePermissionOptions,
  fallback?: string,
): string {
  const record = asRecord(descriptor) ?? {};
  const connectorId = stringValue(record.connectorId) ?? serverName;
  const connectorName = stringValue(record.connectorName) ?? serverName;
  const toolTitle =
    stringValue(record.toolTitle) ??
    stringValue(record.title) ??
    descriptor.name;
  const rendered = renderMcpToolApprovalTemplate(
    serverName,
    connectorId,
    connectorName,
    toolTitle,
    args as McpToolApprovalJsonValue,
    options.approvalTemplates,
  );
  return rendered?.question ?? fallback ?? `Permission required to use mcp.${serverName}.${descriptor.name}`;
}

function approvalCtxForMcpClientTool(
  serverName: string,
  descriptor: MCPToolDescriptorLike,
  callId: string,
  args: Record<string, unknown>,
  options: MCPToolBridgePermissionOptions,
  retryReason?: string,
): Parameters<typeof requestApproval>[0]["ctx"] {
  const activeTurnId = options.getActiveTurnId?.();
  const turnId = options.turnId ??
    (activeTurnId && activeTurnId.length > 0 ? activeTurnId : `mcp-${callId}`);
  const toolName = `mcp.${serverName}.${descriptor.name}`;
  const invocation: ToolInvocation = {
    session: (options.session ??
      options.permissionContext?.session ??
      { services: {}, conversationId: "mcp-client" }) as ToolInvocation["session"],
    turn: {
      subId: turnId,
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: { value: options.approvalPolicy ?? "on_request" },
      sandboxPolicy: { value: options.sandboxPolicy ?? "workspace_write" },
      config: bridgeApprovalTurnConfig(options),
    } as ToolInvocation["turn"],
    tracker: createTurnDiffTracker(),
    callId,
    toolName: { name: toolName },
    payload: {
      kind: "mcp",
      server: serverName,
      tool: descriptor.name,
      rawArguments: safeStringifyArgs(args),
    },
    source: "direct",
  };
  return {
    invocation,
    callId,
    toolName,
    turnId,
    ...(retryReason !== undefined ? { retryReason } : {}),
  };
}

function approvalCtxForRequestPermissions(
  event: RequestPermissionsEvent,
  options: MCPToolBridgePermissionOptions,
  retryReason?: string,
): Parameters<typeof requestApproval>[0]["ctx"] {
  const callId = event.callId;
  const activeTurnId = options.getActiveTurnId?.();
  const turnId = event.turnId ||
    options.turnId ||
    (activeTurnId && activeTurnId.length > 0 ? activeTurnId : `mcp-${callId}`);
  const approvalArgs = requestPermissionsApprovalArgs(event);
  const invocation: ToolInvocation = {
    session: (options.session ??
      options.permissionContext?.session ??
      { services: {}, conversationId: "mcp-client" }) as ToolInvocation["session"],
    turn: {
      subId: turnId,
      cwd: event.cwd ?? options.cwd ?? process.cwd(),
      approvalPolicy: { value: options.approvalPolicy ?? "on_request" },
      sandboxPolicy: { value: options.sandboxPolicy ?? "workspace_write" },
      config: bridgeApprovalTurnConfig(options),
    } as ToolInvocation["turn"],
    tracker: createTurnDiffTracker(),
    callId,
    toolName: { name: MCP_REQUEST_PERMISSIONS_TOOL_NAME },
    payload: {
      kind: "function",
      arguments: safeStringifyArgs(approvalArgs),
    },
    source: "direct",
  };
  return {
    invocation,
    callId,
    toolName: MCP_REQUEST_PERMISSIONS_TOOL_NAME,
    turnId,
    ...(retryReason !== undefined ? { retryReason } : {}),
  };
}

async function requestMcpClientApproval(
  serverName: string,
  descriptor: MCPToolDescriptorLike,
  callId: string,
  args: Record<string, unknown>,
  options: MCPToolBridgePermissionOptions,
  reason: string,
): Promise<ReviewDecision | null> {
  if (!approvalPathConfigured(options)) return null;
  const approval = await requestApproval({
    ctx: approvalCtxForMcpClientTool(
      serverName,
      descriptor,
      callId,
      args,
      options,
      reason,
    ),
    args,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.approvalResolver !== undefined
      ? { resolver: options.approvalResolver }
      : {}),
    ...(options.guardianApprovalReviewer !== undefined
      ? { guardianApprovalReviewer: options.guardianApprovalReviewer }
      : {}),
    ...(options.getActiveTurnId !== undefined
      ? { getActiveTurnId: options.getActiveTurnId }
      : {}),
  });
  return approval.decision;
}

async function requestRequestPermissionsApproval(
  event: RequestPermissionsEvent,
  options: MCPToolBridgePermissionOptions,
  reason: string,
): Promise<ReviewDecision | null> {
  if (!approvalPathConfigured(options)) return null;
  const approval = await requestApproval({
    ctx: approvalCtxForRequestPermissions(event, options, reason),
    args: requestPermissionsApprovalArgs(event),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.approvalResolver !== undefined
      ? { resolver: options.approvalResolver }
      : {}),
    ...(options.guardianApprovalReviewer !== undefined
      ? { guardianApprovalReviewer: options.guardianApprovalReviewer }
      : {}),
    ...(options.getActiveTurnId !== undefined
      ? { getActiveTurnId: options.getActiveTurnId }
      : {}),
  });
  return approval.decision;
}

async function authorizeMcpClientToolCall(
  tool: Tool,
  serverName: string,
  descriptor: MCPToolDescriptorLike,
  callId: string,
  args: Record<string, unknown>,
  options: MCPToolBridgePermissionOptions | undefined,
): Promise<PermissionResolution> {
  if (options === undefined) return { ok: true, args };

  let executionArgs = args;
  let promptReason: string | undefined;
  const hasEvaluator =
    options.canUseTool !== undefined && options.permissionContext !== undefined;

  if (hasEvaluator) {
    const permissionDecision = await arbitratePermissionMode({
      tool,
      args,
      canUseTool: options.canUseTool,
      permissionContext: options.permissionContext,
    });
    if (permissionDecision.kind === "deny") {
      return {
        ok: false,
        result: errorResult(permissionDecision.message ?? "Permission denied"),
      };
    }
    if (permissionDecision.kind === "ask") {
      executionArgs = permissionDecision.args;
      promptReason = mcpApprovalReason(
        serverName,
        descriptor,
        executionArgs,
        options,
        permissionDecision.message,
      );
    } else if (permissionDecision.kind === "allow") {
      return { ok: true, args: permissionDecision.args };
    }
  }

  if (promptReason === undefined && !hasEvaluator) {
    promptReason = mcpApprovalReason(serverName, descriptor, executionArgs, options);
  }
  if (promptReason === undefined) return { ok: true, args: executionArgs };

  const decision = await requestMcpClientApproval(
    serverName,
    descriptor,
    callId,
    executionArgs,
    options,
    promptReason,
  );
  if (decision === null) {
    return {
      ok: false,
      result: errorResult("approval requested with no prompt wired"),
    };
  }
  if (!reviewDecisionIsAllow(decision)) {
    return {
      ok: false,
      result: errorResult(`Permission denied: ${decision.kind}`),
    };
  }
  return { ok: true, args: executionArgs };
}

function responseScopeFromDecision(
  decision: ReviewDecision | null,
): RequestPermissionsResponse["scope"] {
  return decision?.kind === "approved_for_session" ? "session" : "turn";
}

function responseForRequestPermissionsDecision(
  requested: RequestPermissionProfile,
  decision: ReviewDecision | null,
): RequestPermissionsResponse {
  if (decision === null || !reviewDecisionIsAllow(decision)) {
    return EMPTY_REQUEST_PERMISSIONS_RESPONSE;
  }
  return {
    permissions: requested,
    scope: responseScopeFromDecision(decision),
    strictAutoReview: false,
  };
}

function requestPermissionsReason(
  reason: string | undefined,
  requested: RequestPermissionProfile,
): string {
  if (reason !== undefined && reason.trim().length > 0) return reason;
  const labels = requestPermissionsEventPermissionLabels(requested);
  return labels.length > 0
    ? `Permission required: ${labels.join(", ")}`
    : "Permission required";
}

async function callRequestPermissionsTool(
  args: Record<string, unknown>,
  callId: string,
  options: MCPToolBridgePermissionOptions,
): Promise<ToolResult> {
  const rpc = options.requestPermissionsRpc;
  if (rpc === undefined) return errorResult("request_permissions RPC is not configured");
  let pending;
  try {
    pending = rpc.request({
      callId,
      turnId: options.turnId,
      args,
      cwd: options.cwd,
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  const reason = requestPermissionsReason(
    pending.event.reason,
    pending.event.permissions,
  );
  try {
    const decision = await requestRequestPermissionsApproval(
      pending.event,
      options,
      reason,
    );
    const response = responseForRequestPermissionsDecision(
      pending.event.permissions,
      decision,
    );
    rpc.respond(pending.event.callId, response);
    return {
      content: JSON.stringify(
        (await pending.response) ?? EMPTY_REQUEST_PERMISSIONS_RESPONSE,
      ),
    };
  } catch (error) {
    rpc.respond(pending.event.callId, EMPTY_REQUEST_PERMISSIONS_RESPONSE);
    await pending.response;
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

async function withRPCDeadline<T>(
  operation: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Create a tool bridge from an MCP client connection.
 *
 * Queries the server for available tools via `client.listTools()`,
 * then wraps each as a runtime `Tool` with namespaced names:
 * `mcp.{serverName}.{toolName}`
 *
 * @param client - Connected MCP Client instance (from createMCPConnection)
 * @param serverName - Server name for tool namespacing
 * @param logger - Optional logger
 * @returns MCPToolBridge with adapted tools
 */
export async function createToolBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  logger: Logger = silentLogger,
  options: ToolBridgeOptions = {},
): Promise<MCPToolBridge> {
  const listToolsTimeoutMs = normalizeTimeoutMs(
    options.listToolsTimeoutMs,
    DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS,
  );
  const callToolTimeoutMs = normalizeTimeoutMs(
    options.callToolTimeoutMs,
    DEFAULT_MCP_CALL_TIMEOUT_MS,
  );

  const response = await withRPCDeadline<MCPListToolsResponse>(
    `MCP server "${serverName}" listTools`,
    listToolsTimeoutMs,
    () => client.listTools(),
  );
  const rawTools = normalizeMCPToolCatalog(response.tools);
  const mcpTools: MCPToolDescriptorLike[] = options.serverConfig
    ? (filterMCPToolCatalog(
        options.serverConfig,
        rawTools,
      ) as MCPToolDescriptorLike[])
    : rawTools;

  // I-74: supply-chain pin. Compute + compare canonical SHA-256.
  const expectedPin =
    options.serverConfig?.supplyChain?.catalogSha256 ??
    options.serverConfig?.pinnedCatalogSha256;
  if (expectedPin) {
    const { sha256: actualSha } = computeMCPToolCatalogSha256(mcpTools);
    if (!catalogDigestMatches(actualSha, expectedPin)) {
      throw new Error(
        `MCP server "${serverName}" tool catalog digest mismatch: expected ${expectedPin}, got ${actualSha}`,
      );
    }
  }

  logger.info(`MCP server "${serverName}" exposes ${mcpTools.length} tools`);

  // Track disposal to prevent use-after-close
  let disposed = false;

  const tools: Tool[] = mcpTools.map((mcpTool) => {
    const namespacedName = `mcp.${serverName}.${mcpTool.name}`;
    const defaultPermissionMode = perMcpToolApprovalMode(
      options.serverConfig,
      mcpTool.name,
      namespacedName,
    );

    const bridgeTool: Tool = {
      name: namespacedName,
      description: modelFacingMcpToolDescription(
        namespacedName,
        mcpTool.name,
        mcpTool.description,
      ),
      inputSchema: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as JSONSchema,
      serverId: serverName,
      mcpInfo: { serverName, toolName: mcpTool.name },
      ...(defaultPermissionMode !== undefined ? { defaultPermissionMode } : {}),

      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        if (disposed) {
          return {
            content: `MCP server "${serverName}" has been disconnected`,
            isError: true,
          };
        }

        // T6 gap #119: notify observer of call start. The observer is
        // responsible for emitting `mcp_tool_call_begin`; bridge stays
        // session-agnostic. `callId` is synthesized here because the
        // MCP bridge is not given one by the executor wrapper.
        const callId = `mcp-${serverName}-${mcpTool.name}-${randomCallId()}`;
        if (
          mcpTool.name === MCP_REQUEST_PERMISSIONS_TOOL_NAME &&
          options.permissions?.requestPermissionsRpc !== undefined
        ) {
          return callRequestPermissionsTool(args, callId, options.permissions);
        }
        const startedAtMs = Date.now();

        try {
          const authorization = await authorizeMcpClientToolCall(
            bridgeTool,
            serverName,
            mcpTool,
            callId,
            args,
            options.permissions,
          );
          if (!authorization.ok) {
            return authorization.result;
          }
          const executionArgs = authorization.args;
          const callArgs = safeStringifyArgs(executionArgs);
          const observer = options.callObserver;
          observer?.onBegin?.({
            callId,
            server: serverName,
            toolName: mcpTool.name,
            args: callArgs,
          });
          const result = normalizeMCPCallToolResponse(
            await withRPCDeadline<unknown>(
              `MCP tool "${mcpTool.name}" callTool`,
              callToolTimeoutMs,
              () =>
                client.callTool({
                  name: mcpTool.name,
                  arguments: executionArgs,
                }),
            ),
          );

          const rawContent = result.content;

          // I-76: cap result payload at 5MB.
          const bytes = Buffer.byteLength(rawContent, "utf8");
          let content = rawContent;
          if (bytes > MAX_MCP_CALL_RESULT_BYTES) {
            content = `${truncateUtf8(rawContent, MAX_MCP_CALL_RESULT_BYTES)}\n\n…[truncated: MCP tool result exceeded ${MAX_MCP_CALL_RESULT_BYTES} bytes]`;
            logger.warn?.(
              `MCP tool "${mcpTool.name}" result exceeded I-76 cap (${bytes}B > ${MAX_MCP_CALL_RESULT_BYTES}B); truncated`,
            );
          }

          const isError = result.isError;
          const durationMs = Date.now() - startedAtMs;
          observer?.onEnd?.({
            callId,
            server: serverName,
            toolName: mcpTool.name,
            result: content,
            isError,
            durationMs,
          });
          return {
            content,
            isError,
          };
        } catch (error) {
          const errMessage = `MCP tool "${mcpTool.name}" failed: ${(error as Error).message}`;
          const durationMs = Date.now() - startedAtMs;
          options.callObserver?.onEnd?.({
            callId,
            server: serverName,
            toolName: mcpTool.name,
            result: errMessage,
            isError: true,
            durationMs,
          });
          return {
            content: errMessage,
            isError: true,
          };
        }
      },
    };
    return bridgeTool;
  });

  return {
    serverName,
    tools,
    async dispose(): Promise<void> {
      disposed = true;
      try {
        await client.close();
        logger.info(`Disconnected from MCP server "${serverName}"`);
      } catch (error) {
        logger.warn?.(
          `Error disconnecting from MCP server "${serverName}":`,
          error,
        );
      }
    },
  };
}
