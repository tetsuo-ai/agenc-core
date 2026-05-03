/**
 * Build the `PendingProviderSwitch` payload the TUI model picker
 * sends to `session.setPendingProviderSwitch` when the user changes
 * model.
 *
 * Pulled out into a pure function so the conditional branch (no
 * provider configured → skip the switch) is unit-testable without a
 * React render harness.
 *
 * @module
 */
import type { AgenCBridgeSession } from "../../tui/session-types.js";

export interface PendingProviderSwitchSpec {
  readonly provider: string;
  readonly model: string;
  readonly profile?: string;
}

/**
 * Derive the pending-switch payload from the active session and the
 * newly picked model. Returns `null` when the session has no
 * configured provider (in which case the caller should leave the
 * runtime alone and only update local UI state).
 */
export function buildPendingProviderSwitch(
  session: Pick<AgenCBridgeSession, "sessionConfiguration">,
  nextModel: string,
): PendingProviderSwitchSpec | null {
  const provider = session.sessionConfiguration?.provider?.slug;
  if (provider === undefined) return null;
  return { provider, model: nextModel };
}
