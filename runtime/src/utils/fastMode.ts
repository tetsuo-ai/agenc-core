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
export type CooldownReason<_T = any> = any;
export const CooldownReason: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FAST_MODE_MODEL_DISPLAY<_T = any> = any;
export const FAST_MODE_MODEL_DISPLAY: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FastModeDisabledReason<_T = any> = any;
export const FastModeDisabledReason: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FastModeRuntimeState<_T = any> = any;
export const FastModeRuntimeState: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearFastModeCooldown<_T = any> = any;
export const clearFastModeCooldown: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFastModeModel<_T = any> = any;
export const getFastModeModel: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFastModeRuntimeState<_T = any> = any;
export const getFastModeRuntimeState: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFastModeState<_T = any> = any;
export const getFastModeState: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFastModeUnavailableReason<_T = any> = any;
export const getFastModeUnavailableReason: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getInitialFastModeSetting<_T = any> = any;
export const getInitialFastModeSetting: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type handleFastModeOverageRejection<_T = any> = any;
export const handleFastModeOverageRejection: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type handleFastModeRejectedByAPI<_T = any> = any;
export const handleFastModeRejectedByAPI: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isFastModeAvailable<_T = any> = any;
export const isFastModeAvailable: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isFastModeCooldown<_T = any> = any;
export const isFastModeCooldown: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isFastModeEnabled<_T = any> = any;
export const isFastModeEnabled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isFastModeSupportedByModel<_T = any> = any;
export const isFastModeSupportedByModel: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type onCooldownExpired<_T = any> = any;
export const onCooldownExpired: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type onCooldownTriggered<_T = any> = any;
export const onCooldownTriggered: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type onFastModeOverageRejection<_T = any> = any;
export const onFastModeOverageRejection: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type onOrgFastModeChanged<_T = any> = any;
export const onOrgFastModeChanged: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type prefetchFastModeStatus<_T = any> = any;
export const prefetchFastModeStatus: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type resolveFastModeStatusFromCache<_T = any> = any;
export const resolveFastModeStatusFromCache: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type triggerFastModeCooldown<_T = any> = any;
export const triggerFastModeCooldown: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
