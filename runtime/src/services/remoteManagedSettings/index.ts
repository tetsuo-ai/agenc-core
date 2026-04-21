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
export type clearRemoteManagedSettingsCache<_T = any> = any;
export const clearRemoteManagedSettingsCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type computeChecksumFromSettings<_T = any> = any;
export const computeChecksumFromSettings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type initializeRemoteManagedSettingsLoadingPromise<_T = any> = any;
export const initializeRemoteManagedSettingsLoadingPromise: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isEligibleForRemoteManagedSettings<_T = any> = any;
export const isEligibleForRemoteManagedSettings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type loadRemoteManagedSettings<_T = any> = any;
export const loadRemoteManagedSettings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type refreshRemoteManagedSettings<_T = any> = any;
export const refreshRemoteManagedSettings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startBackgroundPolling<_T = any> = any;
export const startBackgroundPolling: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type stopBackgroundPolling<_T = any> = any;
export const stopBackgroundPolling: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type waitForRemoteManagedSettingsToLoad<_T = any> = any;
export const waitForRemoteManagedSettingsToLoad: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
