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
export type CCR_BYOC_BETA<_T = any> = any;
export const CCR_BYOC_BETA: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type CodeSession<_T = any> = any;
export const CodeSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type CodeSessionSchema<_T = any> = any;
export const CodeSessionSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type GitRepositoryOutcome<_T = any> = any;
export const GitRepositoryOutcome: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type GitSource<_T = any> = any;
export const GitSource: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type KnowledgeBaseSource<_T = any> = any;
export const KnowledgeBaseSource: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ListSessionsResponse<_T = any> = any;
export const ListSessionsResponse: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type Outcome<_T = any> = any;
export const Outcome: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type OutcomeGitInfo<_T = any> = any;
export const OutcomeGitInfo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type RemoteMessageContent<_T = any> = any;
export const RemoteMessageContent: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SessionContext<_T = any> = any;
export const SessionContext: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SessionContextSource<_T = any> = any;
export const SessionContextSource: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SessionResource<_T = any> = any;
export const SessionResource: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SessionStatus<_T = any> = any;
export const SessionStatus: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type axiosGetWithRetry<_T = any> = any;
export const axiosGetWithRetry: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchCodeSessionsFromSessionsAPI<_T = any> = any;
export const fetchCodeSessionsFromSessionsAPI: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fetchSession<_T = any> = any;
export const fetchSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getBranchFromSession<_T = any> = any;
export const getBranchFromSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getOAuthHeaders<_T = any> = any;
export const getOAuthHeaders: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isTransientNetworkError<_T = any> = any;
export const isTransientNetworkError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type prepareApiRequest<_T = any> = any;
export const prepareApiRequest: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sendEventToRemoteSession<_T = any> = any;
export const sendEventToRemoteSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type updateSessionTitle<_T = any> = any;
export const updateSessionTitle: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
