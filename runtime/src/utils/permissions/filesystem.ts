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
export type DANGEROUS_DIRECTORIES<_T = any> = any;
export const DANGEROUS_DIRECTORIES: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type DANGEROUS_FILES<_T = any> = any;
export const DANGEROUS_FILES: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type allWorkingDirectories<_T = any> = any;
export const allWorkingDirectories: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkEditableInternalPath<_T = any> = any;
export const checkEditableInternalPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkPathSafetyForAutoEdit<_T = any> = any;
export const checkPathSafetyForAutoEdit: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkReadPermissionForTool<_T = any> = any;
export const checkReadPermissionForTool: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkReadableInternalPath<_T = any> = any;
export const checkReadableInternalPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type checkWritePermissionForTool<_T = any> = any;
export const checkWritePermissionForTool: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ensureScratchpadDir<_T = any> = any;
export const ensureScratchpadDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type generateSuggestions<_T = any> = any;
export const generateSuggestions: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getBundledSkillsRoot<_T = any> = any;
export const getBundledSkillsRoot: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getClaudeSkillScope<_T = any> = any;
export const getClaudeSkillScope: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getClaudeTempDir<_T = any> = any;
export const getClaudeTempDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getClaudeTempDirName<_T = any> = any;
export const getClaudeTempDirName: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getFileReadIgnorePatterns<_T = any> = any;
export const getFileReadIgnorePatterns: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getProjectTempDir<_T = any> = any;
export const getProjectTempDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getResolvedWorkingDirPaths<_T = any> = any;
export const getResolvedWorkingDirPaths: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getScratchpadDir<_T = any> = any;
export const getScratchpadDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getSessionMemoryDir<_T = any> = any;
export const getSessionMemoryDir: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getSessionMemoryPath<_T = any> = any;
export const getSessionMemoryPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isClaudeSettingsPath<_T = any> = any;
export const isClaudeSettingsPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isScratchpadEnabled<_T = any> = any;
export const isScratchpadEnabled: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type matchingRuleForInput<_T = any> = any;
export const matchingRuleForInput: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type normalizeCaseForComparison<_T = any> = any;
export const normalizeCaseForComparison: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type normalizePatternsToPath<_T = any> = any;
export const normalizePatternsToPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type pathInAllowedWorkingPath<_T = any> = any;
export const pathInAllowedWorkingPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type pathInWorkingPath<_T = any> = any;
export const pathInWorkingPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type relativePath<_T = any> = any;
export const relativePath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type toPosixPath<_T = any> = any;
export const toPosixPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
