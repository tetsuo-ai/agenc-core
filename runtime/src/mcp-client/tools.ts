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
import { nonEmptyString as stringValue } from "../utils/stringUtils.js";
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
import {
  encodeMcpToolNameForWire,
  isProviderToolNameSafe,
} from "../llm/wire/mcp-tool-naming.js";
import { asRecord } from "../utils/record.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import { MAX_TOOL_CALL_ID_UTF8_BYTES } from "../session/tool-result-integrity.js";
import { sleep } from "../utils/sleep.js";
import { snapshotMcpRequestEnvironment } from "./environment.js";
import { normalizeMcpToolOutput } from "./tool-output.js";
import {
  sanitizeMcpOutputText,
  truncateMcpUtf8,
} from "./content-sanitization.js";
import {
  buildModelFacingMcpToolDescription,
  sanitizeMcpInputSchemaForModel,
} from "./model-facing-sanitization.js";

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
  /** Trusted, explicit raw tool names with no model-directed filesystem writes. */
  readonly virtualNoFsWriteTools?: readonly string[];
  readonly tools?: Readonly<Record<string, PerToolConfig>>;
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

function perMcpToolApprovalMode(
  config: MCPToolCatalogPolicyConfig | undefined,
  rawToolName: string,
  namespacedToolName: string,
): PermissionDefaultMode | undefined {
  const toolConfig = config?.tools?.[rawToolName] ?? config?.tools?.[namespacedToolName];
  const explicit = toolConfig?.default_permission_mode;
  if (isValidPermissionDefaultMode(explicit)) return explicit;
  return isValidPermissionDefaultMode(config?.defaultToolsApprovalMode)
    ? config.defaultToolsApprovalMode
    : undefined;
}

function mcpToolHasNoFilesystemWrites(
  config: MCPToolCatalogPolicyConfig | undefined,
  rawToolName: string,
): boolean {
  return config?.virtualNoFsWriteTools?.includes(rawToolName) === true;
}

const DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS = 30_000;
const MAX_MCP_LIST_TOOLS_ATTEMPTS = 3;
const MCP_LIST_TOOLS_RETRY_BASE_DELAY_MS = 250;
// @modelcontextprotocol/sdk always installs a request timer. Use Node's
// largest safe timer window and reset it on progress when no operator timeout
// was configured; AgenC itself imposes no MCP tool-call deadline.
const MCP_SDK_UNBOUNDED_WINDOW_MS = 2_147_483_647;
const MCP_REQUEST_PERMISSIONS_TOOL_NAME = "request_permissions";
const MCP_RAW_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MCP_EXECUTION_ONLY_ARGUMENT_KEYS = new Set([
  "__abortSignal",
  "__callId",
  "__onProgress",
  "__sandboxExecutionBroker",
  "__sandboxExecutionSurface",
  "__toolRuntimeContext",
]);

function filterProviderSafeMcpToolCatalog(
  serverName: string,
  tools: readonly MCPToolDescriptorLike[],
  logger: Logger,
): readonly MCPToolDescriptorLike[] {
  return tools.filter((mcpTool) => {
    if (!MCP_RAW_TOOL_NAME_PATTERN.test(mcpTool.name)) {
      logger.warn?.(
        `MCP server ${JSON.stringify(serverName)} skipped provider-unsafe tool ` +
          `${JSON.stringify(mcpTool.name)}: raw tool name must match ` +
          `/${MCP_RAW_TOOL_NAME_PATTERN.source}/`,
      );
      return false;
    }

    const namespacedName = `mcp.${serverName}.${mcpTool.name}`;
    const wireName = encodeMcpToolNameForWire(namespacedName);
    if (isProviderToolNameSafe(wireName)) return true;

    logger.warn?.(
      `MCP server ${JSON.stringify(serverName)} skipped provider-unsafe tool ` +
        `${JSON.stringify(mcpTool.name)}: encoded function name ` +
        `${JSON.stringify(wireName)} violates provider function-name constraints`,
    );
    return false;
  });
}

function modelFacingMcpInputSchema(
  serverName: string,
  toolName: string,
  inputSchema: unknown,
  logger: Logger,
): JSONSchema {
  const result = sanitizeMcpInputSchemaForModel(inputSchema);
  if (result.issue?.code === "too_large") {
    logger.warn?.(
      `MCP server ${JSON.stringify(serverName)} tool ${JSON.stringify(toolName)} ` +
        `model-facing input schema exceeded ${result.issue.maxBytes} bytes after metadata sanitization; using an open object schema`,
    );
  } else if (result.issue?.code === "unsafe_key") {
    logger.warn?.(
      `MCP server ${JSON.stringify(serverName)} tool ${JSON.stringify(toolName)} ` +
        "model-facing input schema contained an unsafe or colliding key; using an open object schema",
    );
  }
  return result.schema;
}

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
  environment: ProviderEnvironment;
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

export function withoutMcpExecutionOnlyArgs(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const outbound: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      MCP_EXECUTION_ONLY_ARGUMENT_KEYS.has(key) ||
      key.startsWith("__agenc")
    ) {
      continue;
    }
    Object.defineProperty(outbound, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return outbound;
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
  timeoutMs: number | undefined,
  task: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  callerSignal?.throwIfAborted();

  const controller = new AbortController();
  const timeoutError =
    timeoutMs === undefined
      ? undefined
      : new Error(`${operation} timed out after ${timeoutMs}ms`);
  let timedOut = false;
  const forwardCallerAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(callerSignal?.reason);
    }
  };
  callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          if (!controller.signal.aborted) controller.abort(timeoutError);
        }, timeoutMs);

  try {
    // Abort the physical RPC on cancellation/deadline, but do not settle this
    // boundary until the transport promise itself settles. Otherwise the
    // enclosing admission lease could release concurrency while an
    // abort-ignoring MCP request is still live.
    const result = await task(controller.signal);
    callerSignal?.throwIfAborted();
    if (timedOut && timeoutError !== undefined) throw timeoutError;
    return result;
  } catch (error) {
    callerSignal?.throwIfAborted();
    if (timedOut && timeoutError !== undefined) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardCallerAbort);
  }
}

async function listMcpToolsWithRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  serverName: string,
  timeoutMs: number,
  logger: Logger,
): Promise<MCPListToolsResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_MCP_LIST_TOOLS_ATTEMPTS; attempt += 1) {
    try {
      return await withRPCDeadline<MCPListToolsResponse>(
        `MCP server "${serverName}" listTools`,
        timeoutMs,
        (signal) => client.listTools(undefined, { signal, timeout: timeoutMs }),
      );
    } catch (error) {
      lastError = error;
      if (attempt === MAX_MCP_LIST_TOOLS_ATTEMPTS) break;
      logger.warn?.(
        `MCP server ${JSON.stringify(serverName)} listTools attempt ${attempt} failed; retrying`,
      );
      await sleep(MCP_LIST_TOOLS_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function abortSignalFromArgs(
  args: Record<string, unknown>,
): AbortSignal | undefined {
  const signal = args.__abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export type MCPProgressCallback = (event: {
  readonly chunk: string;
  readonly stream?: "stdout" | "stderr" | "status";
  readonly processId?: number;
}) => void;

function progressCallbackFromArgs(
  args: Record<string, unknown>,
): MCPProgressCallback | undefined {
  const callback = args.__onProgress;
  return typeof callback === "function"
    ? callback as MCPProgressCallback
    : undefined;
}

function trustedCallIdFromArgs(
  args: Record<string, unknown>,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(args, "__callId");
  const value = descriptor?.value;
  return descriptor?.enumerable === false &&
      typeof value === "string" &&
      value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= MAX_TOOL_CALL_ID_UTF8_BYTES
    ? value
    : undefined;
}

function renderMcpProgress(raw: unknown): string | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const parts: string[] = [];
  if (typeof record.message === "string") {
    parts.push(
      sanitizeMcpOutputText(truncateMcpUtf8(record.message, 896)),
    );
  }
  if (typeof record.progress === "number" && Number.isFinite(record.progress)) {
    const progress = String(record.progress);
    const total = typeof record.total === "number" && Number.isFinite(record.total)
      ? `/${record.total}`
      : "";
    parts.push(`progress ${progress}${total}`);
  }
  if (parts.length === 0) return undefined;
  return truncateMcpUtf8(parts.join(" — "), 1_024);
}

function forwardMcpProgress(
  raw: unknown,
  callback: MCPProgressCallback | undefined,
  logger: Logger,
  toolName: string,
): void {
  if (callback === undefined) return;
  const chunk = renderMcpProgress(raw);
  if (chunk === undefined || chunk.length === 0) return;
  try {
    callback({ chunk, stream: "status" });
  } catch (error) {
    logger.warn?.(
      `MCP tool ${JSON.stringify(toolName)} progress callback failed`,
      error,
    );
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
  options: ToolBridgeOptions,
): Promise<MCPToolBridge> {
  const environment = snapshotMcpRequestEnvironment(options.environment);
  const listToolsTimeoutMs = normalizeTimeoutMs(
    options.listToolsTimeoutMs,
    DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS,
  );
  const callToolTimeoutMs =
    typeof options.callToolTimeoutMs === "number" &&
    Number.isFinite(options.callToolTimeoutMs) &&
    options.callToolTimeoutMs > 0
      ? Math.max(1, Math.floor(options.callToolTimeoutMs))
      : undefined;

  const response = await listMcpToolsWithRetry(
    client,
    serverName,
    listToolsTimeoutMs,
    logger,
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

  const providerSafeMcpTools = filterProviderSafeMcpToolCatalog(
    serverName,
    mcpTools,
    logger,
  );

  logger.info(
    `MCP server "${serverName}" exposes ${providerSafeMcpTools.length} tools`,
  );

  // Track disposal to prevent use-after-close. Cache an in-flight or
  // successful close so concurrent lifecycle owners cannot race. A rejected
  // close is cleared after settlement: the bridge remains unusable, but its
  // exact client owner stays available for a later verified-cleanup retry.
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const tools: Tool[] = providerSafeMcpTools.map((mcpTool) => {
    const namespacedName = `mcp.${serverName}.${mcpTool.name}`;
    const defaultPermissionMode = perMcpToolApprovalMode(
      options.serverConfig,
      mcpTool.name,
      namespacedName,
    );
    const virtualNoFsWrites = mcpToolHasNoFilesystemWrites(
      options.serverConfig,
      mcpTool.name,
    );

    const bridgeTool: Tool = {
      name: namespacedName,
      description: buildModelFacingMcpToolDescription({
        modelFacingName: encodeMcpToolNameForWire(namespacedName),
        canonicalName: namespacedName,
        rawToolName: mcpTool.name,
        rawDescription: mcpTool.description,
      }),
      inputSchema: modelFacingMcpInputSchema(
        serverName,
        mcpTool.name,
        mcpTool.inputSchema ?? { type: "object", properties: {} },
        logger,
      ),
      serverId: serverName,
      mcpInfo: { serverName, toolName: mcpTool.name },
      ...(virtualNoFsWrites
        ? { metadata: { mutating: true, virtualNoFsWrites: true } }
        : {}),
      ...(defaultPermissionMode !== undefined ? { defaultPermissionMode } : {}),

      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const effectSignal = abortSignalFromArgs(args);
        effectSignal?.throwIfAborted();
        if (disposed) {
          return {
            content: `MCP server "${serverName}" has been disconnected`,
            isError: true,
          };
        }

        // T6 gap #119: notify observer of call start. Prefer the admitted
        // executor call id so persistence, progress, and events share one
        // identity; standalone bridge callers get a local fallback.
        const trustedCallId = trustedCallIdFromArgs(args);
        const callId = trustedCallId ??
          `mcp-${serverName}-${mcpTool.name}-${randomCallId()}`;
        const progressCallback = progressCallbackFromArgs(args);
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
          const executionArgs = withoutMcpExecutionOnlyArgs(
            authorization.args,
          );
          effectSignal?.throwIfAborted();
          const callArgs = safeStringifyArgs(executionArgs);
          const observer = options.callObserver;
          observer?.onBegin?.({
            callId,
            server: serverName,
            toolName: mcpTool.name,
            args: callArgs,
          });
          const rawResult = await withRPCDeadline<unknown>(
            `MCP tool "${mcpTool.name}" callTool`,
            callToolTimeoutMs,
            (signal) =>
              client.callTool(
                {
                  name: mcpTool.name,
                  arguments: executionArgs,
                  ...(trustedCallId !== undefined
                    ? {
                        _meta: {
                          "agenccode/toolUseId": trustedCallId,
                        },
                      }
                    : {}),
                },
                undefined,
                {
                  signal,
                  timeout:
                    callToolTimeoutMs ?? MCP_SDK_UNBOUNDED_WINDOW_MS,
                  ...(callToolTimeoutMs === undefined
                    ? { resetTimeoutOnProgress: true }
                    : {}),
                  ...(progressCallback !== undefined
                    ? {
                        onprogress: (progress: unknown) => {
                          forwardMcpProgress(
                            progress,
                            progressCallback,
                            logger,
                            mcpTool.name,
                          );
                        },
                      }
                    : {}),
                },
              ),
            effectSignal,
          );
          const result = await normalizeMcpToolOutput({
            raw: rawResult,
            serverName,
            toolName: mcpTool.name,
            callId,
            environment,
            logger,
          });

          const content = result.content;
          const isError = result.isError === true;
          const durationMs = Date.now() - startedAtMs;
          observer?.onEnd?.({
            callId,
            server: serverName,
            toolName: mcpTool.name,
            result: content,
            isError,
            durationMs,
          });
          return result;
        } catch (error) {
          const effectiveError = effectSignal?.aborted
            ? effectSignal.reason
            : error;
          const rawErrorMessage =
            `MCP tool "${mcpTool.name}" failed: ${effectiveError instanceof Error ? effectiveError.message : String(effectiveError)}`;
          const errMessage = sanitizeMcpOutputText(
            truncateMcpUtf8(rawErrorMessage, 16 * 1024),
          );
          const durationMs = Date.now() - startedAtMs;
          options.callObserver?.onEnd?.({
            callId,
            server: serverName,
            toolName: mcpTool.name,
            result: errMessage,
            isError: true,
            durationMs,
          });
          effectSignal?.throwIfAborted();
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
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal;
      disposed = true;
      const task = Promise.resolve()
        .then(() => client.close())
        .then(
          () => {
            logger.info(`Disconnected from MCP server "${serverName}"`);
          },
          (error: unknown) => {
            logger.warn?.(
              `Error disconnecting from MCP server "${serverName}":`,
              error,
            );
            throw error;
          },
        );
      disposal = task;
      void task.then(undefined, () => {
        if (disposal === task) disposal = undefined;
      });
      return task;
    },
  };
}
