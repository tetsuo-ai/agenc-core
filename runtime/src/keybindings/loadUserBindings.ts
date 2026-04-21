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
export type KeybindingsLoadResult<_T = any> = any;
export const KeybindingsLoadResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type disposeKeybindingWatcher<_T = any> = any;
export const disposeKeybindingWatcher: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getCachedKeybindingWarnings<_T = any> = any;
export const getCachedKeybindingWarnings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getKeybindingsPath<_T = any> = any;
export const getKeybindingsPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type initializeKeybindingWatcher<_T = any> = any;
export const initializeKeybindingWatcher: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isKeybindingCustomizationEnabled<_T = any> = any;
export const isKeybindingCustomizationEnabled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type loadKeybindings<_T = any> = any;
export const loadKeybindings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type loadKeybindingsSync<_T = any> = any;
export const loadKeybindingsSync: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type loadKeybindingsSyncWithWarnings<_T = any> = any;
export const loadKeybindingsSyncWithWarnings: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type resetKeybindingLoaderForTesting<_T = any> = any;
export const resetKeybindingLoaderForTesting: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type subscribeToKeybindingChanges<_T = any> = any;
export const subscribeToKeybindingChanges: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
