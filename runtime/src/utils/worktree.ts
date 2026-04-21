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
export type WorktreeSession<_T = any> = any;
export const WorktreeSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type _resetGitWorktreeMutationLocksForTesting<_T = any> = any;
export const _resetGitWorktreeMutationLocksForTesting: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupStaleAgentWorktrees<_T = any> = any;
export const cleanupStaleAgentWorktrees: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupWorktree<_T = any> = any;
export const cleanupWorktree: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type copyWorktreeIncludeFiles<_T = any> = any;
export const copyWorktreeIncludeFiles: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type createAgentWorktree<_T = any> = any;
export const createAgentWorktree: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type createTmuxSessionForWorktree<_T = any> = any;
export const createTmuxSessionForWorktree: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type createWorktreeForSession<_T = any> = any;
export const createWorktreeForSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type execIntoTmuxWorktree<_T = any> = any;
export const execIntoTmuxWorktree: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type generateTmuxSessionName<_T = any> = any;
export const generateTmuxSessionName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getCurrentWorktreeSession<_T = any> = any;
export const getCurrentWorktreeSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getTmuxInstallInstructions<_T = any> = any;
export const getTmuxInstallInstructions: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasWorktreeChanges<_T = any> = any;
export const hasWorktreeChanges: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isTmuxAvailable<_T = any> = any;
export const isTmuxAvailable: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type keepWorktree<_T = any> = any;
export const keepWorktree: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type killTmuxSession<_T = any> = any;
export const killTmuxSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type parsePRReference<_T = any> = any;
export const parsePRReference: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type removeAgentWorktree<_T = any> = any;
export const removeAgentWorktree: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type restoreWorktreeSession<_T = any> = any;
export const restoreWorktreeSession: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type validateWorktreeSlug<_T = any> = any;
export const validateWorktreeSlug: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type withGitWorktreeMutationLock<_T = any> = any;
export const withGitWorktreeMutationLock: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type worktreeBranchName<_T = any> = any;
export const worktreeBranchName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
