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
export type _resetDownloadPromiseForTesting<_T = any> = any;
export const _resetDownloadPromiseForTesting: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type downloadUserSettings<_T = any> = any;
export const downloadUserSettings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type redownloadUserSettings<_T = any> = any;
export const redownloadUserSettings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type uploadUserSettingsInBackground<_T = any> = any;
export const uploadUserSettingsInBackground: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
