import { isLegacyTurnFailureErrorPayload } from "../session/turn-lifecycle-terminal.js";

/**
 * @deprecated Prefer {@link isLegacyTurnFailureErrorPayload} /
 * {@link isTurnLifecycleTerminalEvent}. Kept as a thin alias for TUI call sites
 * that still name the old helper.
 */
export function isTerminalDaemonErrorPayload(payload: unknown): boolean {
  return isLegacyTurnFailureErrorPayload(payload);
}
