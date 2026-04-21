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
export type ARTIFACTORY_REGISTRY_URL<_T = any> = any;
export const ARTIFACTORY_REGISTRY_URL: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type MAX_DOWNLOAD_RETRIES<_T = any> = any;
export const MAX_DOWNLOAD_RETRIES: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type STALL_TIMEOUT_MS<_T = any> = any;
export const STALL_TIMEOUT_MS: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type StallTimeoutError<_T = any> = any;
export const StallTimeoutError: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type _downloadAndVerifyBinaryForTesting<_T = any> = any;
export const _downloadAndVerifyBinaryForTesting: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type downloadVersion<_T = any> = any;
export const downloadVersion: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type downloadVersionFromArtifactory<_T = any> = any;
export const downloadVersionFromArtifactory: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type downloadVersionFromBinaryRepo<_T = any> = any;
export const downloadVersionFromBinaryRepo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getLatestVersion<_T = any> = any;
export const getLatestVersion: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getLatestVersionFromArtifactory<_T = any> = any;
export const getLatestVersionFromArtifactory: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getLatestVersionFromBinaryRepo<_T = any> = any;
export const getLatestVersionFromBinaryRepo: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
