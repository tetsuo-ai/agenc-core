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
export type IMAGE_EXTENSION_REGEX<_T = any> = any;
export const IMAGE_EXTENSION_REGEX: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type ImageWithDimensions<_T = any> = any;
export const ImageWithDimensions: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type LINUX_CLIPBOARD_IMAGE_MIME_TYPES<_T = any> = any;
export const LINUX_CLIPBOARD_IMAGE_MIME_TYPES: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type PASTE_THRESHOLD<_T = any> = any;
export const PASTE_THRESHOLD: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type asImageFilePath<_T = any> = any;
export const asImageFilePath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type buildLinuxClipboardCheckCommand<_T = any> = any;
export const buildLinuxClipboardCheckCommand: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type buildLinuxClipboardSaveCommand<_T = any> = any;
export const buildLinuxClipboardSaveCommand: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getImageFromClipboard<_T = any> = any;
export const getImageFromClipboard: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type getImagePathFromClipboard<_T = any> = any;
export const getImagePathFromClipboard: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type hasImageInClipboard<_T = any> = any;
export const hasImageInClipboard: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type isImageFilePath<_T = any> = any;
export const isImageFilePath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
export type tryReadImageFromPath<_T = any> = any;
export const tryReadImageFromPath: { <T = any>(..._args: any[]): any; [k: string]: any; new (..._args: any[]): any } = __stubProxy as any;
