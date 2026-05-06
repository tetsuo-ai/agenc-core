import type { AgenCBridgeSession } from "./session-types.js";

export interface PendingProviderSwitchSpec {
  readonly provider: string;
  readonly model: string;
  readonly profile?: string;
}

export function buildPendingProviderSwitch(
  session: Pick<AgenCBridgeSession, "sessionConfiguration">,
  nextModel: string,
): PendingProviderSwitchSpec | null {
  const provider = session.sessionConfiguration?.provider?.slug;
  if (provider === undefined) return null;
  return { provider, model: nextModel };
}
