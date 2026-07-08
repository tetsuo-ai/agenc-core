/**
 * Ports donor `mcp-server/src/message_processor.rs` and
 * `mcp-server/src/outgoing_message.rs` JSON-RPC shapes onto AgenC's
 * server-side MCP framework.
 *
 * Shape differences:
 *   - AgenC keeps the framework transport-neutral; stdio and HTTP/SSE
 *     adapters live alongside this core without changing its JSON-RPC shapes.
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

export interface McpPromptsCapability {
  readonly listChanged?: boolean;
}

export interface McpResourcesCapability {
  readonly listChanged?: boolean;
  readonly subscribe?: boolean;
}

export interface McpServerCapabilities {
  readonly tools?: McpToolsCapability;
  readonly prompts?: McpPromptsCapability;
  readonly resources?: McpResourcesCapability;
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

// --- Prompts (MCP `prompts/*`) ---

export interface McpPromptArgumentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface McpPromptDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly McpPromptArgumentDefinition[];
}

export interface McpListPromptsResult {
  readonly prompts: readonly McpPromptDefinition[];
  readonly nextCursor?: string | null;
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: McpToolTextContent;
}

export interface McpGetPromptResult {
  readonly description?: string;
  readonly messages: readonly McpPromptMessage[];
}

export interface McpPromptProvider {
  listPrompts(): Promise<readonly McpPromptDefinition[]>;
  /** Returns null when no prompt with that name exists. */
  getPrompt(
    name: string,
    args?: Readonly<Record<string, string>>,
  ): Promise<McpGetPromptResult | null>;
}

// --- Resources (MCP `resources/*`) ---

export interface McpResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpListResourcesResult {
  readonly resources: readonly McpResourceDefinition[];
  readonly nextCursor?: string | null;
}

export interface McpResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
}

export interface McpReadResourceResult {
  readonly contents: readonly McpResourceContents[];
}

export interface McpResourceProvider {
  listResources(): Promise<readonly McpResourceDefinition[]>;
  /** Returns null when the uri is unknown (never reads arbitrary paths). */
  readResource(uri: string): Promise<McpReadResourceResult | null>;
}

export const MCP_JSON_RPC_VERSION = "2.0" as const;

export const MCP_ERROR_PARSE = -32700;
export const MCP_ERROR_INVALID_REQUEST = -32600;
export const MCP_ERROR_METHOD_NOT_FOUND = -32601;
export const MCP_ERROR_INVALID_PARAMS = -32602;
export const MCP_ERROR_INTERNAL = -32603;
export const MCP_ERROR_NOT_INITIALIZED = -32002;
