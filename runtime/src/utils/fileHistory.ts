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
export type DiffStats<_T = any> = any;
export const DiffStats: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FileHistoryBackup<_T = any> = any;
export const FileHistoryBackup: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FileHistorySnapshot<_T = any> = any;
export const FileHistorySnapshot: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type FileHistoryState<_T = any> = any;
export const FileHistoryState: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkOriginFileChanged<_T = any> = any;
export const checkOriginFileChanged: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type copyFileHistoryForResume<_T = any> = any;
export const copyFileHistoryForResume: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryCanRestore<_T = any> = any;
export const fileHistoryCanRestore: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryEnabled<_T = any> = any;
export const fileHistoryEnabled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryGetDiffStats<_T = any> = any;
export const fileHistoryGetDiffStats: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryHasAnyChanges<_T = any> = any;
export const fileHistoryHasAnyChanges: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryMakeSnapshot<_T = any> = any;
export const fileHistoryMakeSnapshot: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryRestoreStateFromLog<_T = any> = any;
export const fileHistoryRestoreStateFromLog: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryRewind<_T = any> = any;
export const fileHistoryRewind: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type fileHistoryTrackEdit<_T = any> = any;
export const fileHistoryTrackEdit: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
