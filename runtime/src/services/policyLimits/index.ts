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
export type _resetPolicyLimitsForTesting<_T = any> = any;
export const _resetPolicyLimitsForTesting: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearPolicyLimitsCache<_T = any> = any;
export const clearPolicyLimitsCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type initializePolicyLimitsLoadingPromise<_T = any> = any;
export const initializePolicyLimitsLoadingPromise: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isPolicyAllowed<_T = any> = any;
export const isPolicyAllowed: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isPolicyLimitsEligible<_T = any> = any;
export const isPolicyLimitsEligible: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type loadPolicyLimits<_T = any> = any;
export const loadPolicyLimits: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type refreshPolicyLimits<_T = any> = any;
export const refreshPolicyLimits: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startBackgroundPolling<_T = any> = any;
export const startBackgroundPolling: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type stopBackgroundPolling<_T = any> = any;
export const stopBackgroundPolling: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type waitForPolicyLimitsToLoad<_T = any> = any;
export const waitForPolicyLimitsToLoad: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
