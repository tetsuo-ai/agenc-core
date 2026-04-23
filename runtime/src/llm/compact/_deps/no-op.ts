/**
 * No-op replacements for openclaude-port subsystems the gut runtime
 * does not implement: analytics, telemetry, prompt-cache notification,
 * classifier-approval cache, speculative-check cache, beta tracing,
 * memory-file cache.
 *
 * Compact called these for cross-cutting cache invalidation in the
 * openclaude runtime. The gut runtime does not own these caches, so
 * these are no-ops that satisfy the call signature without side
 * effect.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = any;

export function logEvent(..._args: unknown[]): void {}

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  _flag: string,
  fallback: T,
): T {
  return fallback;
}

export function getDynamicConfig_BLOCKS_ON_INIT<T>(
  _name: string,
  fallback: T,
): T {
  return fallback;
}

export function notifyCompaction(..._args: unknown[]): void {}

export function notifyCacheDeletion(..._args: unknown[]): void {}

export function getRetryDelay(..._args: unknown[]): number {
  return 1000;
}

export function clearClassifierApprovals(): void {}

export function clearSpeculativeChecks(): void {}

export function clearBetaTracingState(): void {}

export function resetGetMemoryFilesCache(_reason?: string): void {}

interface UserContextFn {
  (): Promise<Record<string, string>>;
  cache: { clear: () => void };
}

const _userContextFn = (() => Promise.resolve({})) as unknown as UserContextFn;
_userContextFn.cache = { clear: () => {} };

export const getUserContext: UserContextFn = _userContextFn;

export function isSessionActivityTrackingActive(): boolean {
  return false;
}

export function sendSessionActivitySignal(..._args: unknown[]): void {}
