/**
 * No-op replacements for openclaude-port subsystems the gut session
 * subsystem does not implement: prompt-cache break-detection notifications
 * and SessionMemory message-id tracking.
 *
 * The openclaude versions live under `services/api/promptCacheBreakDetection`
 * and `services/SessionMemory/sessionMemoryUtils`; both are infrastructure
 * the gut runtime does not own. These no-ops satisfy the call signatures
 * without side effect so existing call sites compile and run.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function notifyCompaction(..._args: any[]): void {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setLastSummarizedMessageId(..._args: any[]): void {}
