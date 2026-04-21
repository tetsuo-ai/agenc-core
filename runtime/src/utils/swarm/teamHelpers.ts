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
export type CleanupOutput<_T = any> = any;
export const CleanupOutput: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type Input<_T = any> = any;
export const Input: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type Output<_T = any> = any;
export const Output: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type SpawnTeamOutput<_T = any> = any;
export const SpawnTeamOutput: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TeamAllowedPath<_T = any> = any;
export const TeamAllowedPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type TeamFile<_T = any> = any;
export const TeamFile: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type addHiddenPaneId<_T = any> = any;
export const addHiddenPaneId: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupSessionTeams<_T = any> = any;
export const cleanupSessionTeams: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type cleanupTeamDirectories<_T = any> = any;
export const cleanupTeamDirectories: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getTeamDir<_T = any> = any;
export const getTeamDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getTeamFilePath<_T = any> = any;
export const getTeamFilePath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type inputSchema<_T = any> = any;
export const inputSchema: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type readTeamFile<_T = any> = any;
export const readTeamFile: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type readTeamFileAsync<_T = any> = any;
export const readTeamFileAsync: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type registerTeamForSessionCleanup<_T = any> = any;
export const registerTeamForSessionCleanup: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type removeHiddenPaneId<_T = any> = any;
export const removeHiddenPaneId: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type removeMemberByAgentId<_T = any> = any;
export const removeMemberByAgentId: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type removeMemberFromTeam<_T = any> = any;
export const removeMemberFromTeam: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type removeTeammateFromTeamFile<_T = any> = any;
export const removeTeammateFromTeamFile: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sanitizeAgentName<_T = any> = any;
export const sanitizeAgentName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type sanitizeName<_T = any> = any;
export const sanitizeName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setMemberActive<_T = any> = any;
export const setMemberActive: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setMemberMode<_T = any> = any;
export const setMemberMode: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type setMultipleMemberModes<_T = any> = any;
export const setMultipleMemberModes: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type syncTeammateMode<_T = any> = any;
export const syncTeammateMode: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type unregisterTeamForSessionCleanup<_T = any> = any;
export const unregisterTeamForSessionCleanup: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type writeTeamFileAsync<_T = any> = any;
export const writeTeamFileAsync: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
