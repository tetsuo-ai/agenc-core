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
export type bytesPerTokenForFileType<_T = any> = any;
export const bytesPerTokenForFileType: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type countMessagesTokensWithAPI<_T = any> = any;
export const countMessagesTokensWithAPI: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type countTokens<_T = any> = any;
export const countTokens: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type countTokensViaHaikuFallback<_T = any> = any;
export const countTokensViaHaikuFallback: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type countTokensWithAPI<_T = any> = any;
export const countTokensWithAPI: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type roughTokenCountEstimation<_T = any> = any;
// Minimal real implementation: upstream openclaude uses the same length/4
// heuristic (see services/SessionMemory/prompts.ts inline note). The original
// proxy stub returned itself, which evaluated to 0 under numeric coercion and
// corrupted every caller that feeds the result into arithmetic. A real rough
// estimator is strictly more correct than a zero-returning proxy.
export const roughTokenCountEstimation: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } =
  function roughTokenCountEstimation(input?: unknown): number {
    if (input == null) return 0;
    const text = typeof input === 'string' ? input : String(input);
    return Math.ceil(text.length / 4);
  } as any;
export type roughTokenCountEstimationForFileType<_T = any> = any;
export const roughTokenCountEstimationForFileType: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type roughTokenCountEstimationForMessage<_T = any> = any;
export const roughTokenCountEstimationForMessage: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type roughTokenCountEstimationForMessages<_T = any> = any;
export const roughTokenCountEstimationForMessages: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
