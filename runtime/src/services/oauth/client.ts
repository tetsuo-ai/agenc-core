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
export type buildAuthUrl<_T = any> = any;
export const buildAuthUrl: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type createAndStoreApiKey<_T = any> = any;
export const createAndStoreApiKey: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type exchangeCodeForTokens<_T = any> = any;
export const exchangeCodeForTokens: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchAndStoreUserRoles<_T = any> = any;
export const fetchAndStoreUserRoles: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchProfileInfo<_T = any> = any;
export const fetchProfileInfo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getOrganizationUUID<_T = any> = any;
export const getOrganizationUUID: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isOAuthTokenExpired<_T = any> = any;
export const isOAuthTokenExpired: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type parseScopes<_T = any> = any;
export const parseScopes: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type populateOAuthAccountInfoIfNeeded<_T = any> = any;
export const populateOAuthAccountInfoIfNeeded: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type refreshOAuthToken<_T = any> = any;
export const refreshOAuthToken: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type shouldUseClaudeAIAuth<_T = any> = any;
export const shouldUseClaudeAIAuth: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type storeOAuthAccountInfo<_T = any> = any;
export const storeOAuthAccountInfo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
