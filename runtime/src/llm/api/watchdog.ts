/**
 * Ports the upstream API stream-idle watchdog contract onto AgenC's shared
 * stream watchdog implementation.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC already owns the monotonic timer implementation in
 *     `runtime/src/llm/stream-watchdog.ts`; this module exposes it from
 *     the API-core namespace expected by LP-01 consumers.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Upstream analytics/diagnostic event names and model-specific fallback
 *     signaling.
 */

export {
  installStreamWatchdog,
  isStreamWatchdogEnabled,
  resolveStreamIdleTimeoutMs,
  STREAM_IDLE_ABORT_REASON,
  STREAM_IDLE_TIMEOUT_MS_DEFAULT,
  STREAM_IDLE_WARNING_REASON,
  type InstallStreamWatchdogOptions,
  type StreamWatchdogHandle,
} from "../stream-watchdog.js";

import {
  installStreamWatchdog,
  type InstallStreamWatchdogOptions,
  type StreamWatchdogHandle,
} from "../stream-watchdog.js";

export function installApiStreamWatchdog(
  options: InstallStreamWatchdogOptions,
): StreamWatchdogHandle {
  return installStreamWatchdog(options);
}
