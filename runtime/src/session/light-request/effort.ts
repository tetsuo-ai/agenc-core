import type { ReasoningEffort } from "../turn-context.js";
import { resolveLightRequest, type LightRequestSession } from "./settings.js";

export function leanDefaultReasoningEffort(
  session: LightRequestSession,
  provider: string | undefined,
): ReasoningEffort | undefined {
  if (resolveLightRequest(session, provider)?.low_effort !== true) return undefined;
  const store = session.services?.configStore;
  const configured = store?.current().reasoning_effort;
  return configured === undefined || store?.provenance?.("reasoning_effort")?.scope === "default"
    ? "low" : undefined;
}

/** The product default fills an absent choice; it never overrides one. */
export function leanLightEffort(input: {
  readonly enabled: boolean;
  readonly turnEffort?: ReasoningEffort;
  readonly configuredEffort?: ReasoningEffort;
  readonly followsModelDefault: boolean;
}): ReasoningEffort | undefined {
  if (input.turnEffort !== undefined) return input.turnEffort;
  if (input.followsModelDefault) return undefined;
  return input.configuredEffort ?? (input.enabled ? "low" : undefined);
}
