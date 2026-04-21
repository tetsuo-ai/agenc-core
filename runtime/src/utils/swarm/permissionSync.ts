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
export type PermissionResolution<_T = any> = any;
export const PermissionResolution: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type PermissionResponse<_T = any> = any;
export const PermissionResponse: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SwarmPermissionRequest<_T = any> = any;
export const SwarmPermissionRequest: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SwarmPermissionRequestSchema<_T = any> = any;
export const SwarmPermissionRequestSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupOldResolutions<_T = any> = any;
export const cleanupOldResolutions: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type createPermissionRequest<_T = any> = any;
export const createPermissionRequest: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type deleteResolvedPermission<_T = any> = any;
export const deleteResolvedPermission: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type generateRequestId<_T = any> = any;
export const generateRequestId: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type generateSandboxRequestId<_T = any> = any;
export const generateSandboxRequestId: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getLeaderName<_T = any> = any;
export const getLeaderName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getPermissionDir<_T = any> = any;
export const getPermissionDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isSwarmWorker<_T = any> = any;
export const isSwarmWorker: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isTeamLeader<_T = any> = any;
export const isTeamLeader: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type pollForResponse<_T = any> = any;
export const pollForResponse: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type readPendingPermissions<_T = any> = any;
export const readPendingPermissions: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type readResolvedPermission<_T = any> = any;
export const readResolvedPermission: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type removeWorkerResponse<_T = any> = any;
export const removeWorkerResponse: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type resolvePermission<_T = any> = any;
export const resolvePermission: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sendPermissionRequestViaMailbox<_T = any> = any;
export const sendPermissionRequestViaMailbox: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sendPermissionResponseViaMailbox<_T = any> = any;
export const sendPermissionResponseViaMailbox: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sendSandboxPermissionRequestViaMailbox<_T = any> = any;
export const sendSandboxPermissionRequestViaMailbox: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sendSandboxPermissionResponseViaMailbox<_T = any> = any;
export const sendSandboxPermissionResponseViaMailbox: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type submitPermissionRequest<_T = any> = any;
export const submitPermissionRequest: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type writePermissionRequest<_T = any> = any;
export const writePermissionRequest: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
