// @ts-nocheck
// Stub — feature-gated path; real implementation lives in openclaude upstream.
const __stubProxy: any = new Proxy(function __stub(..._args: any[]): any { return __stubProxy; }, {
  get(target, prop) {
    if (prop === 'then') return undefined;
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === Symbol.iterator) return function* () {};
    if (prop === Symbol.asyncIterator) return async function* () {};
    if (prop === 'length') return 0;
    if (prop === 'size') return 0;
    if (prop === 'cache') return new Map();
    return __stubProxy;
  },
  apply() { return __stubProxy; },
  construct() { return __stubProxy; },
  has() { return true; },
  set() { return true; },
});
export type ConfigScope<_T = any> = any;
export const ConfigScope: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ConfigScopeSchema<_T = any> = any;
export const ConfigScopeSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ConnectedMCPServer<_T = any> = any;
export const ConnectedMCPServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type DisabledMCPServer<_T = any> = any;
export const DisabledMCPServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FailedMCPServer<_T = any> = any;
export const FailedMCPServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type MCPCliState<_T = any> = any;
export const MCPCliState: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type MCPServerConnection<_T = any> = any;
export const MCPServerConnection: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpClaudeAIProxyServerConfig<_T = any> = any;
export const McpClaudeAIProxyServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpClaudeAIProxyServerConfigSchema<_T = any> = any;
export const McpClaudeAIProxyServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpHTTPServerConfig<_T = any> = any;
export const McpHTTPServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpHTTPServerConfigSchema<_T = any> = any;
export const McpHTTPServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpJsonConfig<_T = any> = any;
export const McpJsonConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpJsonConfigSchema<_T = any> = any;
export const McpJsonConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpSSEIDEServerConfig<_T = any> = any;
export const McpSSEIDEServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpSSEIDEServerConfigSchema<_T = any> = any;
export const McpSSEIDEServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpSSEServerConfig<_T = any> = any;
export const McpSSEServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpSSEServerConfigSchema<_T = any> = any;
export const McpSSEServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpSdkServerConfig<_T = any> = any;
export const McpSdkServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpSdkServerConfigSchema<_T = any> = any;
export const McpSdkServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpServerConfig<_T = any> = any;
export const McpServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpServerConfigSchema<_T = any> = any;
export const McpServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpStdioServerConfig<_T = any> = any;
export const McpStdioServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpStdioServerConfigSchema<_T = any> = any;
export const McpStdioServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpWebSocketIDEServerConfig<_T = any> = any;
export const McpWebSocketIDEServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpWebSocketIDEServerConfigSchema<_T = any> = any;
export const McpWebSocketIDEServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpWebSocketServerConfig<_T = any> = any;
export const McpWebSocketServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpWebSocketServerConfigSchema<_T = any> = any;
export const McpWebSocketServerConfigSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type NeedsAuthMCPServer<_T = any> = any;
export const NeedsAuthMCPServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type PendingMCPServer<_T = any> = any;
export const PendingMCPServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ScopedMcpServerConfig<_T = any> = any;
export const ScopedMcpServerConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SerializedClient<_T = any> = any;
export const SerializedClient: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SerializedTool<_T = any> = any;
export const SerializedTool: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ServerResource<_T = any> = any;
export const ServerResource: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type Transport<_T = any> = any;
export const Transport: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TransportSchema<_T = any> = any;
export const TransportSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
