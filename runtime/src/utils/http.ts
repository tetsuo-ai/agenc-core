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
export type AuthHeaders<_T = any> = any;
export const AuthHeaders: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getAuthHeaders<_T = any> = any;
export const getAuthHeaders: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getMCPUserAgent<_T = any> = any;
export const getMCPUserAgent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getUserAgent<_T = any> = any;
export const getUserAgent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getWebFetchUserAgent<_T = any> = any;
export const getWebFetchUserAgent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type withOAuth401Retry<_T = any> = any;
export const withOAuth401Retry: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
