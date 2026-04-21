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
export type PollRemoteSessionResponse<_T = any> = any;
export const PollRemoteSessionResponse: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type RepoValidationResult<_T = any> = any;
export const RepoValidationResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TeleportProgressCallback<_T = any> = any;
export const TeleportProgressCallback: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TeleportProgressStep<_T = any> = any;
export const TeleportProgressStep: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TeleportResult<_T = any> = any;
export const TeleportResult: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type archiveRemoteSession<_T = any> = any;
export const archiveRemoteSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkOutTeleportedSessionBranch<_T = any> = any;
export const checkOutTeleportedSessionBranch: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type pollRemoteSessionEvents<_T = any> = any;
export const pollRemoteSessionEvents: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type processMessagesForTeleportResume<_T = any> = any;
export const processMessagesForTeleportResume: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type teleportFromSessionsAPI<_T = any> = any;
export const teleportFromSessionsAPI: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type teleportResumeCodeSession<_T = any> = any;
export const teleportResumeCodeSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type teleportToRemote<_T = any> = any;
export const teleportToRemote: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type teleportToRemoteWithErrorHandling<_T = any> = any;
export const teleportToRemoteWithErrorHandling: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type validateGitState<_T = any> = any;
export const validateGitState: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type validateSessionRepository<_T = any> = any;
export const validateSessionRepository: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
