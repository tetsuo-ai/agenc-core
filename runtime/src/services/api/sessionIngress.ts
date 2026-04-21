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
export type appendSessionLog<_T = any> = any;
export const appendSessionLog: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearAllSessions<_T = any> = any;
export const clearAllSessions: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearSession<_T = any> = any;
export const clearSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getSessionLogs<_T = any> = any;
export const getSessionLogs: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getSessionLogsViaOAuth<_T = any> = any;
export const getSessionLogsViaOAuth: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getTeleportEvents<_T = any> = any;
export const getTeleportEvents: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
