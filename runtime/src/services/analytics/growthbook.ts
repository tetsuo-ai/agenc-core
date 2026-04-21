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
export type GrowthBookUserAttributes<_T = any> = any;
export const GrowthBookUserAttributes: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkGate_CACHED_OR_BLOCKING<_T = any> = any;
export const checkGate_CACHED_OR_BLOCKING: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkSecurityRestrictionGate<_T = any> = any;
export const checkSecurityRestrictionGate: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkStatsigFeatureGate_CACHED_MAY_BE_STALE<_T = any> = any;
export const checkStatsigFeatureGate_CACHED_MAY_BE_STALE: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type clearGrowthBookConfigOverrides<_T = any> = any;
export const clearGrowthBookConfigOverrides: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getAllGrowthBookFeatures<_T = any> = any;
export const getAllGrowthBookFeatures: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getApiBaseUrlHost<_T = any> = any;
export const getApiBaseUrlHost: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getDynamicConfig_BLOCKS_ON_INIT<_T = any> = any;
export const getDynamicConfig_BLOCKS_ON_INIT: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getDynamicConfig_CACHED_MAY_BE_STALE<_T = any> = any;
export const getDynamicConfig_CACHED_MAY_BE_STALE: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFeatureValue_CACHED_MAY_BE_STALE<_T = any> = any;
export const getFeatureValue_CACHED_MAY_BE_STALE: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFeatureValue_CACHED_WITH_REFRESH<_T = any> = any;
export const getFeatureValue_CACHED_WITH_REFRESH: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFeatureValue_DEPRECATED<_T = any> = any;
export const getFeatureValue_DEPRECATED: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getGrowthBookConfigOverrides<_T = any> = any;
export const getGrowthBookConfigOverrides: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasGrowthBookEnvOverride<_T = any> = any;
export const hasGrowthBookEnvOverride: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type initializeGrowthBook<_T = any> = any;
export const initializeGrowthBook: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type onGrowthBookRefresh<_T = any> = any;
export const onGrowthBookRefresh: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type refreshGrowthBookAfterAuthChange<_T = any> = any;
export const refreshGrowthBookAfterAuthChange: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type refreshGrowthBookFeatures<_T = any> = any;
export const refreshGrowthBookFeatures: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type resetGrowthBook<_T = any> = any;
export const resetGrowthBook: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setGrowthBookConfigOverride<_T = any> = any;
export const setGrowthBookConfigOverride: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setupPeriodicGrowthBookRefresh<_T = any> = any;
export const setupPeriodicGrowthBookRefresh: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type stopPeriodicGrowthBookRefresh<_T = any> = any;
export const stopPeriodicGrowthBookRefresh: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
