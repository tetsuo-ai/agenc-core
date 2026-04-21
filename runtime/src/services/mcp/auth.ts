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
export type AuthenticationCancelledError<_T = any> = any;
export const AuthenticationCancelledError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ClaudeAuthProvider<_T = any> = any;
export const ClaudeAuthProvider: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearMcpClientConfig<_T = any> = any;
export const clearMcpClientConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearServerTokensFromSecureStorage<_T = any> = any;
export const clearServerTokensFromSecureStorage: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getMcpClientConfig<_T = any> = any;
export const getMcpClientConfig: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getServerKey<_T = any> = any;
export const getServerKey: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasMcpDiscoveryButNoToken<_T = any> = any;
export const hasMcpDiscoveryButNoToken: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type normalizeOAuthErrorBody<_T = any> = any;
export const normalizeOAuthErrorBody: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type performMCPOAuthFlow<_T = any> = any;
export const performMCPOAuthFlow: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type readClientSecret<_T = any> = any;
export const readClientSecret: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type revokeServerTokens<_T = any> = any;
export const revokeServerTokens: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type saveMcpClientSecret<_T = any> = any;
export const saveMcpClientSecret: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type wrapFetchWithStepUpDetection<_T = any> = any;
export const wrapFetchWithStepUpDetection: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
