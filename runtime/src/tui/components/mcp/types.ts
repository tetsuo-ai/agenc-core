import type {
  ConfigScope,
  MCPServerConnection,
  McpAgenCAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  McpWebSocketServerConfig,
} from "../../../services/mcp/types.js";
import type { Tool } from "../../../tools/Tool.js";

interface BaseServerInfo {
  readonly name: string;
  readonly client: MCPServerConnection;
  readonly scope: ConfigScope;
}

export interface StdioServerInfo extends BaseServerInfo {
  readonly transport: "stdio";
  readonly config: McpStdioServerConfig;
}

export interface SSEServerInfo extends BaseServerInfo {
  readonly transport: "sse";
  readonly isAuthenticated?: boolean;
  readonly config: McpSSEServerConfig;
}

export interface HTTPServerInfo extends BaseServerInfo {
  readonly transport: "http";
  readonly isAuthenticated?: boolean;
  readonly config: McpHTTPServerConfig;
}

export interface AgenCAIServerInfo extends BaseServerInfo {
  readonly transport: "agencai-proxy";
  readonly isAuthenticated?: boolean;
  readonly config: McpAgenCAIProxyServerConfig;
}

export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | AgenCAIServerInfo;

export interface AgentMcpServerInfo {
  readonly name: string;
  readonly sourceAgents: readonly string[];
  readonly transport: "stdio" | "sse" | "http" | "ws";
  readonly command?: string;
  readonly url?: string;
  readonly needsAuth: boolean;
}

export type MCPViewState =
  | { readonly type: "list"; readonly defaultTab?: string }
  | { readonly type: "server"; readonly server: ServerInfo }
  | { readonly type: "tools"; readonly server: ServerInfo }
  | { readonly type: "tool-detail"; readonly server: ServerInfo; readonly tool: Tool }
  | { readonly type: "agent-server"; readonly agentServer: AgentMcpServerInfo };

export type WebSocketServerInfo = BaseServerInfo & {
  readonly transport: "ws";
  readonly config: McpWebSocketServerConfig;
};
