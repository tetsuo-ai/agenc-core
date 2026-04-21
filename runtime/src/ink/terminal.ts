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
export type Progress<_T = any> = any;
export const Progress: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SYNC_OUTPUT_SUPPORTED<_T = any> = any;
export const SYNC_OUTPUT_SUPPORTED: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type Terminal<_T = any> = any;
export const Terminal: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasCursorUpViewportYankBug<_T = any> = any;
export const hasCursorUpViewportYankBug: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isGhosttyTerminal<_T = any> = any;
export const isGhosttyTerminal: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isProgressReportingAvailable<_T = any> = any;
export const isProgressReportingAvailable: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isSynchronizedOutputSupported<_T = any> = any;
export const isSynchronizedOutputSupported: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isXtermJs<_T = any> = any;
export const isXtermJs: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setXtversionName<_T = any> = any;
export const setXtversionName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type shouldSkipMainScreenSyncMarkers<_T = any> = any;
export const shouldSkipMainScreenSyncMarkers: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type shouldUseMainScreenRewrite<_T = any> = any;
export const shouldUseMainScreenRewrite: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type supportsExtendedKeys<_T = any> = any;
export const supportsExtendedKeys: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type writeDiffToTerminal<_T = any> = any;
export const writeDiffToTerminal: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
