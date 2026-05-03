/**
 * Ports donor `mcp-server/src/message_processor.rs` and
 * `mcp-server/src/outgoing_message.rs` JSON-RPC shapes onto AgenC's
 * server-side MCP framework.
 *
 * Shape differences:
 *   - AgenC keeps the framework transport-neutral; stdio and HTTP/SSE
 *     adapters are later MS-* items.
 *   - Tool registration is provider-backed so later transport work can
 *     attach the same registry without changing the JSON-RPC core.
 */

export type McpRequestId = string | number | null;

export interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: McpRequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface McpJsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface McpJsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: McpRequestId;
  readonly result: unknown;
}

export interface McpJsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface McpJsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: McpRequestId;
  readonly error: McpJsonRpcErrorObject;
}

export type McpIncomingMessage =
  | McpJsonRpcRequest
  | McpJsonRpcNotification
  | McpJsonRpcSuccess
  | McpJsonRpcError;

export type McpResponseMessage = McpJsonRpcSuccess | McpJsonRpcError;

export type McpOutgoingMessage =
  | McpJsonRpcRequest
  | McpJsonRpcNotification
  | McpJsonRpcSuccess
  | McpJsonRpcError;

export interface McpServerInfo {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

export interface McpToolsCapability {
  readonly listChanged?: boolean;
}

export interface McpServerCapabilities {
  readonly tools?: McpToolsCapability;
}

export interface McpInitializeParams {
  readonly protocolVersion?: string;
  readonly clientInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpServerCapabilities;
  readonly serverInfo: McpServerInfo;
  readonly instructions?: string | null;
}

export interface McpListToolsResult {
  readonly tools: readonly McpToolDefinition[];
  readonly nextCursor?: string | null;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpCallToolResult {
  readonly content: readonly McpToolTextContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface McpToolCallParams {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface McpToolCallContext {
  readonly requestId: McpRequestId;
}

export interface McpToolProvider {
  listTools(): readonly McpToolDefinition[];
  callTool(
    params: McpToolCallParams,
    context: McpToolCallContext,
  ): Promise<McpCallToolResult>;
}

export const MCP_JSON_RPC_VERSION = "2.0" as const;

export const MCP_ERROR_PARSE = -32700;
export const MCP_ERROR_INVALID_REQUEST = -32600;
export const MCP_ERROR_METHOD_NOT_FOUND = -32601;
export const MCP_ERROR_INVALID_PARAMS = -32602;
export const MCP_ERROR_INTERNAL = -32603;
export const MCP_ERROR_NOT_INITIALIZED = -32002;
