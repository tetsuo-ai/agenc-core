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
export type MCPResultType<_T = any> = any;
export const MCPResultType: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpAuthError<_T = any> = any;
export const McpAuthError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS<_T = any> = any;
export const McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TransformedMCPResult<_T = any> = any;
export const TransformedMCPResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type areMcpConfigsEqual<_T = any> = any;
export const areMcpConfigsEqual: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type callIdeRpc<_T = any> = any;
export const callIdeRpc: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type callMCPToolWithUrlElicitationRetry<_T = any> = any;
export const callMCPToolWithUrlElicitationRetry: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupFailedConnection<_T = any> = any;
export const cleanupFailedConnection: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearMcpAuthCache<_T = any> = any;
export const clearMcpAuthCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearServerCache<_T = any> = any;
export const clearServerCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type connectToServer<_T = any> = any;
export const connectToServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type createClaudeAiProxyFetch<_T = any> = any;
export const createClaudeAiProxyFetch: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ensureConnectedClient<_T = any> = any;
export const ensureConnectedClient: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchCommandsForClient<_T = any> = any;
export const fetchCommandsForClient: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchResourcesForClient<_T = any> = any;
export const fetchResourcesForClient: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchToolsForClient<_T = any> = any;
export const fetchToolsForClient: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getMcpServerConnectionBatchSize<_T = any> = any;
export const getMcpServerConnectionBatchSize: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getMcpToolsCommandsAndResources<_T = any> = any;
export const getMcpToolsCommandsAndResources: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getServerCacheKey<_T = any> = any;
export const getServerCacheKey: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type inferCompactSchema<_T = any> = any;
export const inferCompactSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isMcpSessionExpiredError<_T = any> = any;
export const isMcpSessionExpiredError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type mcpToolInputToAutoClassifierInput<_T = any> = any;
export const mcpToolInputToAutoClassifierInput: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type prefetchAllMcpResources<_T = any> = any;
export const prefetchAllMcpResources: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type processMCPResult<_T = any> = any;
export const processMCPResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type reconnectMcpServerImpl<_T = any> = any;
export const reconnectMcpServerImpl: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setupSdkMcpClients<_T = any> = any;
export const setupSdkMcpClients: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type transformMCPResult<_T = any> = any;
export const transformMCPResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type transformResultContent<_T = any> = any;
export const transformResultContent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type wrapFetchWithTimeout<_T = any> = any;
export const wrapFetchWithTimeout: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
