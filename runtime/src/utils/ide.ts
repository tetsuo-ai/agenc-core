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
export type DetectedIDEInfo<_T = any> = any;
export const DetectedIDEInfo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type IDEExtensionInstallationStatus<_T = any> = any;
export const IDEExtensionInstallationStatus: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type IdeType<_T = any> = any;
export const IdeType: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type callIdeRpc<_T = any> = any;
export const callIdeRpc: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupStaleIdeLockfiles<_T = any> = any;
export const cleanupStaleIdeLockfiles: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type closeOpenDiffs<_T = any> = any;
export const closeOpenDiffs: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type detectIDEs<_T = any> = any;
export const detectIDEs: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type detectRunningIDEs<_T = any> = any;
export const detectRunningIDEs: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type detectRunningIDEsCached<_T = any> = any;
export const detectRunningIDEsCached: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type findAvailableIDE<_T = any> = any;
export const findAvailableIDE: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getConnectedIdeClient<_T = any> = any;
export const getConnectedIdeClient: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getConnectedIdeName<_T = any> = any;
export const getConnectedIdeName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getIdeClientName<_T = any> = any;
export const getIdeClientName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getIdeLockfilesPaths<_T = any> = any;
export const getIdeLockfilesPaths: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getSortedIdeLockfiles<_T = any> = any;
export const getSortedIdeLockfiles: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getTerminalIdeType<_T = any> = any;
export const getTerminalIdeType: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasAccessToIDEExtensionDiffFeature<_T = any> = any;
export const hasAccessToIDEExtensionDiffFeature: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type initializeIdeIntegration<_T = any> = any;
export const initializeIdeIntegration: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isCursorInstalled<_T = any> = any;
export const isCursorInstalled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isIDEExtensionInstalled<_T = any> = any;
export const isIDEExtensionInstalled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isJetBrainsIde<_T = any> = any;
export const isJetBrainsIde: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isSupportedJetBrainsTerminal<_T = any> = any;
export const isSupportedJetBrainsTerminal: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isSupportedTerminal<_T = any> = any;
export const isSupportedTerminal: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isSupportedVSCodeTerminal<_T = any> = any;
export const isSupportedVSCodeTerminal: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isVSCodeIde<_T = any> = any;
export const isVSCodeIde: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isVSCodeInstalled<_T = any> = any;
export const isVSCodeInstalled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isWindsurfInstalled<_T = any> = any;
export const isWindsurfInstalled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type maybeInstallIDEExtension<_T = any> = any;
export const maybeInstallIDEExtension: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type maybeNotifyIDEConnected<_T = any> = any;
export const maybeNotifyIDEConnected: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type resetDetectRunningIDEs<_T = any> = any;
export const resetDetectRunningIDEs: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type toIDEDisplayName<_T = any> = any;
export const toIDEDisplayName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
