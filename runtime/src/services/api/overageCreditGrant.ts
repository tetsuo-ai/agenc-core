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
export type OverageCreditGrantCacheEntry<_T = any> = any;
export const OverageCreditGrantCacheEntry: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type OverageCreditGrantInfo<_T = any> = any;
export const OverageCreditGrantInfo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type formatGrantAmount<_T = any> = any;
export const formatGrantAmount: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getCachedOverageCreditGrant<_T = any> = any;
export const getCachedOverageCreditGrant: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type invalidateOverageCreditGrantCache<_T = any> = any;
export const invalidateOverageCreditGrantCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type refreshOverageCreditGrantCache<_T = any> = any;
export const refreshOverageCreditGrantCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
