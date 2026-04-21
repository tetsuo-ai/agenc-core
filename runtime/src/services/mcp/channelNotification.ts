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
export type CHANNEL_PERMISSION_METHOD<_T = any> = any;
export const CHANNEL_PERMISSION_METHOD: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type CHANNEL_PERMISSION_REQUEST_METHOD<_T = any> = any;
export const CHANNEL_PERMISSION_REQUEST_METHOD: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ChannelGateResult<_T = any> = any;
export const ChannelGateResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ChannelMessageNotificationSchema<_T = any> = any;
export const ChannelMessageNotificationSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ChannelPermissionNotificationSchema<_T = any> = any;
export const ChannelPermissionNotificationSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ChannelPermissionRequestParams<_T = any> = any;
export const ChannelPermissionRequestParams: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type findChannelEntry<_T = any> = any;
export const findChannelEntry: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type gateChannelServer<_T = any> = any;
export const gateChannelServer: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getEffectiveChannelAllowlist<_T = any> = any;
export const getEffectiveChannelAllowlist: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type wrapChannelMessage<_T = any> = any;
export const wrapChannelMessage: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
