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
export type LLMRequestNewContext<_T = any> = any;
export const LLMRequestNewContext: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type Span<_T = any> = any;
export const Span: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type addToolContentEvent<_T = any> = any;
export const addToolContentEvent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type endHookSpan<_T = any> = any;
export const endHookSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type endInteractionSpan<_T = any> = any;
export const endInteractionSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type endLLMRequestSpan<_T = any> = any;
export const endLLMRequestSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type endToolBlockedOnUserSpan<_T = any> = any;
export const endToolBlockedOnUserSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type endToolExecutionSpan<_T = any> = any;
export const endToolExecutionSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type endToolSpan<_T = any> = any;
export const endToolSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type executeInSpan<_T = any> = any;
export const executeInSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getCurrentSpan<_T = any> = any;
export const getCurrentSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isBetaTracingEnabled<_T = any> = any;
export const isBetaTracingEnabled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isEnhancedTelemetryEnabled<_T = any> = any;
export const isEnhancedTelemetryEnabled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startHookSpan<_T = any> = any;
export const startHookSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startInteractionSpan<_T = any> = any;
export const startInteractionSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startLLMRequestSpan<_T = any> = any;
export const startLLMRequestSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startToolBlockedOnUserSpan<_T = any> = any;
export const startToolBlockedOnUserSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startToolExecutionSpan<_T = any> = any;
export const startToolExecutionSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type startToolSpan<_T = any> = any;
export const startToolSpan: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
