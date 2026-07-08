/**
 * Ports donor `mcp-server/src/message_processor.rs` request lifecycle
 * onto AgenC's transport-neutral MCP server framework.
 *
 * The donor server wires this processor directly to stdio. AgenC keeps
 * MS-01 pure: transports feed parsed JSON-RPC messages into this class,
 * MS-02 attaches provider-backed tool registration, MS-03 owns stdio, and
 * MS-04 owns HTTP/SSE. Later MS-* items own permission integration.
 */

import {
  MCP_ERROR_INTERNAL,
  MCP_ERROR_INVALID_PARAMS,
  MCP_ERROR_INVALID_REQUEST,
  MCP_ERROR_METHOD_NOT_FOUND,
  MCP_ERROR_NOT_INITIALIZED,
  MCP_ERROR_PARSE,
  MCP_JSON_RPC_VERSION,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpJsonRpcError,
  type McpJsonRpcErrorObject,
  type McpJsonRpcNotification,
  type McpJsonRpcRequest,
  type McpJsonRpcSuccess,
  type McpListToolsResult,
  type McpOutgoingMessage,
  type McpRequestId,
  type McpResponseMessage,
  type McpListPromptsResult,
  type McpListResourcesResult,
  type McpPromptProvider,
  type McpResourceProvider,
  type McpServerCapabilities,
  type McpServerInfo,
  type McpToolCallParams,
  type McpToolProvider,
} from "./types.js";
import { asRecord } from "../utils/record.js";

export interface McpServerFrameworkOptions {
  readonly serverInfo?: Partial<McpServerInfo>;
  readonly capabilities?: McpServerCapabilities;
  readonly instructions?: string | null;
  readonly defaultProtocolVersion?: string;
  readonly toolProvider?: McpToolProvider;
  readonly promptProvider?: McpPromptProvider;
  readonly resourceProvider?: McpResourceProvider;
}

export interface McpServerFrameworkSnapshot {
  readonly initialized: boolean;
  readonly initializedNotificationReceived: boolean;
  readonly clientInfo: McpInitializeParams["clientInfo"] | null;
  readonly protocolVersion: string | null;
  readonly pendingServerRequests: number;
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

type ServerRequestCallback = (message: McpResponseMessage) => void;

type InitializeParseResult =
  | { readonly ok: true; readonly params: McpInitializeParams }
  | { readonly ok: false; readonly message: string };

type ToolCallParseResult =
  | { readonly ok: true; readonly params: McpToolCallParams }
  | { readonly ok: false; readonly message: string };

function isValidRequestId(value: unknown): value is McpRequestId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value))
  );
}

function hasId(value: Record<string, unknown>): value is Record<string, unknown> & {
  readonly id: McpRequestId;
} {
  return "id" in value && isValidRequestId(value.id);
}

function isRequest(
  value: Record<string, unknown>,
): value is Record<string, unknown> & McpJsonRpcRequest {
  return (
    value.jsonrpc === MCP_JSON_RPC_VERSION &&
    typeof value.method === "string" &&
    hasId(value)
  );
}

function isSuccessResponse(
  value: Record<string, unknown>,
): value is Record<string, unknown> & McpJsonRpcSuccess {
  return (
    value.jsonrpc === MCP_JSON_RPC_VERSION &&
    hasId(value) &&
    "result" in value &&
    !("method" in value)
  );
}

function isErrorMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & McpJsonRpcError {
  return (
    value.jsonrpc === MCP_JSON_RPC_VERSION &&
    hasId(value) &&
    asRecord(value.error) !== null &&
    !("method" in value)
  );
}

function isNotification(
  value: Record<string, unknown>,
): value is Record<string, unknown> & McpJsonRpcNotification {
  return (
    value.jsonrpc === MCP_JSON_RPC_VERSION &&
    typeof value.method === "string" &&
    !("id" in value)
  );
}

function parseInitializeParams(params: unknown): InitializeParseResult {
  if (params === undefined) return { ok: true, params: {} };
  const record = asRecord(params);
  if (record === null) {
    return { ok: false, message: "initialize params must be an object" };
  }
  if (
    "protocolVersion" in record &&
    typeof record.protocolVersion !== "string"
  ) {
    return { ok: false, message: "initialize protocolVersion must be a string" };
  }
  const clientInfoRecord = asRecord(record.clientInfo);
  if ("clientInfo" in record && clientInfoRecord === null) {
    return { ok: false, message: "initialize clientInfo must be an object" };
  }
  if (
    clientInfoRecord !== null &&
    "name" in clientInfoRecord &&
    typeof clientInfoRecord.name !== "string"
  ) {
    return { ok: false, message: "initialize clientInfo.name must be a string" };
  }
  if (
    clientInfoRecord !== null &&
    "version" in clientInfoRecord &&
    typeof clientInfoRecord.version !== "string"
  ) {
    return {
      ok: false,
      message: "initialize clientInfo.version must be a string",
    };
  }
  return {
    ok: true,
    params: {
      ...(typeof record.protocolVersion === "string"
        ? { protocolVersion: record.protocolVersion }
        : {}),
      ...(clientInfoRecord !== null
        ? {
            clientInfo: {
              ...(typeof clientInfoRecord.name === "string"
                ? { name: clientInfoRecord.name }
                : {}),
              ...(typeof clientInfoRecord.version === "string"
                ? { version: clientInfoRecord.version }
                : {}),
            },
          }
        : {}),
    },
  };
}

function requestIdKey(id: McpRequestId): string | null {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number") return `n:${id}`;
  return null;
}

function parseToolCallParams(params: unknown): ToolCallParseResult {
  const record = asRecord(params);
  if (record === null) {
    return { ok: false, message: "tools/call params must be an object" };
  }
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    return { ok: false, message: "tools/call name must be a string" };
  }
  const args = asRecord(record.arguments);
  if ("arguments" in record && args === null) {
    return { ok: false, message: "tools/call arguments must be an object" };
  }
  return {
    ok: true,
    params: {
      name: record.name,
      ...(args !== null ? { arguments: args } : {}),
    },
  };
}

function errorObject(
  code: number,
  message: string,
  data?: unknown,
): McpJsonRpcErrorObject {
  return {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  };
}

function response(
  id: McpRequestId,
  result: unknown,
): McpJsonRpcSuccess {
  return { jsonrpc: MCP_JSON_RPC_VERSION, id, result };
}

function errorResponse(
  id: McpRequestId,
  error: McpJsonRpcErrorObject,
): McpJsonRpcError {
  return { jsonrpc: MCP_JSON_RPC_VERSION, id, error };
}

export class McpServerFramework {
  private readonly serverInfo: McpServerInfo;
  private readonly capabilities: McpServerCapabilities;
  private readonly instructions: string | null;
  private readonly defaultProtocolVersion: string;
  private readonly toolProvider: McpToolProvider | null;
  private readonly promptProvider: McpPromptProvider | null;
  private readonly resourceProvider: McpResourceProvider | null;
  private initialized = false;
  private initializedNotificationReceived = false;
  private clientInfo: McpInitializeParams["clientInfo"] | null = null;
  private protocolVersion: string | null = null;
  private nextServerRequestId = 0;
  private readonly pendingServerRequests = new Map<string, ServerRequestCallback>();

  constructor(options: McpServerFrameworkOptions = {}) {
    this.serverInfo = {
      name: options.serverInfo?.name ?? "agenc-mcp-server",
      title: options.serverInfo?.title ?? "AgenC",
      version: options.serverInfo?.version ?? "0.0.0",
    };
    this.promptProvider = options.promptProvider ?? null;
    this.resourceProvider = options.resourceProvider ?? null;
    this.capabilities = options.capabilities ?? {
      tools: { listChanged: true },
      ...(this.promptProvider !== null
        ? { prompts: { listChanged: false } }
        : {}),
      ...(this.resourceProvider !== null
        ? { resources: { listChanged: false, subscribe: false } }
        : {}),
    };
    this.instructions = options.instructions ?? null;
    this.defaultProtocolVersion =
      options.defaultProtocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.toolProvider = options.toolProvider ?? null;
  }

  snapshot(): McpServerFrameworkSnapshot {
    return {
      initialized: this.initialized,
      initializedNotificationReceived: this.initializedNotificationReceived,
      clientInfo: this.clientInfo,
      protocolVersion: this.protocolVersion,
      pendingServerRequests: this.pendingServerRequests.size,
    };
  }

  createServerRequest(
    method: string,
    params?: unknown,
    onResponse?: ServerRequestCallback,
  ): McpJsonRpcRequest {
    const id = this.nextServerRequestId;
    this.nextServerRequestId += 1;
    if (onResponse !== undefined) {
      this.pendingServerRequests.set(requestIdKey(id)!, onResponse);
    }
    return {
      jsonrpc: MCP_JSON_RPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
  }

  createServerNotification(
    method: string,
    params?: unknown,
  ): McpJsonRpcNotification {
    return {
      jsonrpc: MCP_JSON_RPC_VERSION,
      method,
      ...(params !== undefined ? { params } : {}),
    };
  }

  handleRawMessage(raw: string): readonly McpOutgoingMessage[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [
        errorResponse(
          null,
          errorObject(MCP_ERROR_PARSE, "invalid JSON-RPC message"),
        ),
      ];
    }
    return this.handleMessage(parsed);
  }

  async handleRawMessageAsync(raw: string): Promise<readonly McpOutgoingMessage[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [
        errorResponse(
          null,
          errorObject(MCP_ERROR_PARSE, "invalid JSON-RPC message"),
        ),
      ];
    }
    return this.handleMessageAsync(parsed);
  }

  handleMessage(message: unknown): readonly McpOutgoingMessage[] {
    return this.handleMessageCore(
      message,
      (request) => this.handleRequest(request),
    ) as readonly McpOutgoingMessage[];
  }

  async handleMessageAsync(
    message: unknown,
  ): Promise<readonly McpOutgoingMessage[]> {
    return await this.handleMessageCore(
      message,
      (request) => this.handleRequestAsync(request),
    );
  }

  private async handleRequestAsync(
    request: McpJsonRpcRequest,
  ): Promise<McpOutgoingMessage> {
    const asyncMethods = [
      "tools/call",
      "prompts/list",
      "prompts/get",
      "resources/list",
      "resources/read",
    ];
    if (!asyncMethods.includes(request.method)) {
      return this.handleRequest(request);
    }
    if (!this.initialized) {
      return errorResponse(
        request.id,
        errorObject(
          MCP_ERROR_NOT_INITIALIZED,
          "initialize must be called before other MCP requests",
          { method: request.method },
        ),
      );
    }
    switch (request.method) {
      case "prompts/list":
        return await this.handleListPrompts(request);
      case "prompts/get":
        return await this.handleGetPrompt(request);
      case "resources/list":
        return await this.handleListResources(request);
      case "resources/read":
        return await this.handleReadResource(request);
    }
    const parsedParams = parseToolCallParams(request.params);
    if (!parsedParams.ok) {
      return errorResponse(
        request.id,
        errorObject(MCP_ERROR_INVALID_PARAMS, parsedParams.message),
      );
    }
    if (this.toolProvider === null) {
      return response(request.id, {
        content: [{ type: "text", text: `Unknown tool '${parsedParams.params.name}'` }],
        isError: true,
      });
    }
    return response(
      request.id,
      await this.toolProvider.callTool(parsedParams.params, {
        requestId: request.id,
      }),
    );
  }

  private handleMessageCore(
    message: unknown,
    handleRequest: (
      request: McpJsonRpcRequest,
    ) => McpOutgoingMessage | Promise<McpOutgoingMessage>,
  ): readonly McpOutgoingMessage[] | Promise<readonly McpOutgoingMessage[]> {
    const record = asRecord(message);
    if (record === null) {
      return [
        errorResponse(
          null,
          errorObject(MCP_ERROR_INVALID_REQUEST, "message must be an object"),
        ),
      ];
    }
    if (isNotification(record)) {
      this.handleNotification(record);
      return [];
    }
    if ("id" in record && !isValidRequestId(record.id)) {
      return [
        errorResponse(
          null,
          errorObject(MCP_ERROR_INVALID_REQUEST, "invalid JSON-RPC id"),
        ),
      ];
    }
    if (isSuccessResponse(record) || isErrorMessage(record)) {
      this.handleClientResponse(record);
      return [];
    }
    if (!isRequest(record)) {
      return [
        errorResponse(
          hasId(record) ? record.id : null,
          errorObject(MCP_ERROR_INVALID_REQUEST, "invalid JSON-RPC request"),
        ),
      ];
    }
    const handled = handleRequest(record);
    if (handled instanceof Promise) {
      return handled.then((out) => [out]);
    }
    return [handled];
  }

  private handleRequest(request: McpJsonRpcRequest): McpOutgoingMessage {
    if (request.method === "initialize") {
      return this.handleInitialize(request);
    }
    if (!this.initialized) {
      return errorResponse(
        request.id,
        errorObject(
          MCP_ERROR_NOT_INITIALIZED,
          "initialize must be called before other MCP requests",
          { method: request.method },
        ),
      );
    }
    switch (request.method) {
      case "ping":
        return response(request.id, {});
      case "tools/list":
        return response(request.id, this.handleListTools());
      case "resources/list":
      case "resources/read":
      case "prompts/list":
      case "prompts/get":
        // Served by the async dispatcher when a provider is configured.
        if (
          (request.method.startsWith("prompts/") &&
            this.promptProvider !== null) ||
          (request.method.startsWith("resources/") &&
            this.resourceProvider !== null)
        ) {
          return errorResponse(
            request.id,
            errorObject(
              MCP_ERROR_INVALID_REQUEST,
              `${request.method} requires the async MCP dispatcher`,
            ),
          );
        }
        return errorResponse(
          request.id,
          errorObject(MCP_ERROR_METHOD_NOT_FOUND, `method not found: ${request.method}`, {
            method: request.method,
          }),
        );
      case "resources/templates/list":
      case "resources/subscribe":
      case "resources/unsubscribe":
      case "logging/setLevel":
      case "completion/complete":
        return errorResponse(
          request.id,
          errorObject(MCP_ERROR_METHOD_NOT_FOUND, `method not found: ${request.method}`, {
            method: request.method,
          }),
        );
      case "tools/call":
        return errorResponse(
          request.id,
          errorObject(
            MCP_ERROR_INVALID_REQUEST,
            "tools/call requires the async MCP dispatcher",
          ),
        );
      default:
        return errorResponse(
          request.id,
          errorObject(MCP_ERROR_METHOD_NOT_FOUND, `method not found: ${request.method}`, {
            method: request.method,
          }),
        );
    }
  }

  private handleInitialize(request: McpJsonRpcRequest): McpOutgoingMessage {
    if (this.initialized) {
      return errorResponse(
        request.id,
        errorObject(
          MCP_ERROR_INVALID_REQUEST,
          "initialize called more than once",
        ),
      );
    }
    const parsedParams = parseInitializeParams(request.params);
    if (!parsedParams.ok) {
      return errorResponse(
        request.id,
        errorObject(MCP_ERROR_INVALID_PARAMS, parsedParams.message),
      );
    }
    const params = parsedParams.params;
    const protocolVersion =
      params.protocolVersion ?? this.defaultProtocolVersion;
    this.initialized = true;
    this.clientInfo = params.clientInfo ?? null;
    this.protocolVersion = protocolVersion;

    const result: McpInitializeResult = {
      protocolVersion,
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
      instructions: this.instructions,
    };
    return response(request.id, result);
  }

  private handleListTools(): McpListToolsResult {
    return { tools: this.toolProvider?.listTools() ?? [], nextCursor: null };
  }

  private methodNotFound(request: McpJsonRpcRequest): McpOutgoingMessage {
    return errorResponse(
      request.id,
      errorObject(
        MCP_ERROR_METHOD_NOT_FOUND,
        `method not found: ${request.method}`,
        { method: request.method },
      ),
    );
  }

  private async handleListPrompts(
    request: McpJsonRpcRequest,
  ): Promise<McpOutgoingMessage> {
    if (this.promptProvider === null) {
      return this.methodNotFound(request);
    }
    const result: McpListPromptsResult = {
      prompts: await this.promptProvider.listPrompts(),
      nextCursor: null,
    };
    return response(request.id, result);
  }

  private async handleGetPrompt(
    request: McpJsonRpcRequest,
  ): Promise<McpOutgoingMessage> {
    if (this.promptProvider === null) {
      return this.methodNotFound(request);
    }
    const params = asRecord(request.params);
    const name = params?.name;
    if (typeof name !== "string" || name.length === 0) {
      return errorResponse(
        request.id,
        errorObject(MCP_ERROR_INVALID_PARAMS, "prompts/get name must be a non-empty string"),
      );
    }
    const rawArgs = asRecord(params?.arguments);
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawArgs ?? {})) {
      if (typeof value === "string") args[key] = value;
    }
    const prompt = await this.promptProvider.getPrompt(name, args);
    if (prompt === null) {
      return errorResponse(
        request.id,
        errorObject(MCP_ERROR_INVALID_PARAMS, `unknown prompt: ${name}`),
      );
    }
    return response(request.id, prompt);
  }

  private async handleListResources(
    request: McpJsonRpcRequest,
  ): Promise<McpOutgoingMessage> {
    if (this.resourceProvider === null) {
      return this.methodNotFound(request);
    }
    const result: McpListResourcesResult = {
      resources: await this.resourceProvider.listResources(),
      nextCursor: null,
    };
    return response(request.id, result);
  }

  private async handleReadResource(
    request: McpJsonRpcRequest,
  ): Promise<McpOutgoingMessage> {
    if (this.resourceProvider === null) {
      return this.methodNotFound(request);
    }
    const params = asRecord(request.params);
    const uri = params?.uri;
    if (typeof uri !== "string" || uri.length === 0) {
      return errorResponse(
        request.id,
        errorObject(MCP_ERROR_INVALID_PARAMS, "resources/read uri must be a non-empty string"),
      );
    }
    const contents = await this.resourceProvider.readResource(uri);
    if (contents === null) {
      return errorResponse(
        request.id,
        errorObject(MCP_ERROR_INVALID_PARAMS, `unknown resource: ${uri}`),
      );
    }
    return response(request.id, contents);
  }

  private handleNotification(notification: McpJsonRpcNotification): void {
    if (notification.method === "notifications/initialized") {
      this.initializedNotificationReceived = true;
    }
  }

  private handleClientResponse(message: McpResponseMessage): void {
    const key = requestIdKey(message.id);
    if (key === null) return;
    const callback = this.pendingServerRequests.get(key);
    if (callback === undefined) return;
    this.pendingServerRequests.delete(key);
    callback(message);
  }
}

export function ensureMcpOutgoingSerializable(
  message: McpOutgoingMessage,
): string {
  try {
    return JSON.stringify(message);
  } catch (err) {
    const fallback = errorResponse(
      "id" in message ? message.id : null,
      errorObject(
        MCP_ERROR_INTERNAL,
        err instanceof Error ? err.message : "failed to serialize message",
      ),
    );
    return JSON.stringify(fallback);
  }
}
