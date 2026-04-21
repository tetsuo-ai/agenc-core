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
export type FieldPath<_T = any> = any;
export const FieldPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SettingsWithErrors<_T = any> = any;
export const SettingsWithErrors: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ValidationError<_T = any> = any;
export const ValidationError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type filterInvalidPermissionRules<_T = any> = any;
export const filterInvalidPermissionRules: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type formatZodError<_T = any> = any;
export const formatZodError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type validateSettingsFileContent<_T = any> = any;
export const validateSettingsFileContent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
