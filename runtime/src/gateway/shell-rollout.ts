import type {
  AutonomyCanaryDecision,
  AutonomyRolloutFeature,
} from "./autonomy-rollout.js";
import { evaluateAutonomyCanaryAdmission } from "./autonomy-rollout.js";
import {
  DEFAULT_SESSION_SHELL_PROFILE,
  coerceSessionShellProfile,
  type SessionShellProfile,
} from "./shell-profile.js";
import type { GatewayAutonomyConfig } from "./types.js";

export interface ShellRolloutFeatureParams {
  readonly autonomy?: GatewayAutonomyConfig;
  readonly tenantId?: string;
  readonly feature: AutonomyRolloutFeature;
  readonly domain: string;
  readonly stableKey: string;
}

export interface ResolvedShellProfileRollout {
  readonly profile: SessionShellProfile;
  readonly requestedProfile: SessionShellProfile;
  readonly decision: AutonomyCanaryDecision;
  readonly coerced: boolean;
}

function disabledDecision(reason: string): AutonomyCanaryDecision {
  return {
    allowed: true,
    cohort: "disabled",
    reason,
  };
}

export function evaluateShellFeatureRollout(
  params: ShellRolloutFeatureParams,
): AutonomyCanaryDecision {
  if (!params.autonomy || params.autonomy.enabled === false) {
    return disabledDecision("Autonomy rollout gating is inactive.");
  }
  return evaluateAutonomyCanaryAdmission(params);
}

export function resolveConfiguredShellProfile(params: {
  readonly requested?: unknown;
  readonly autonomy?: GatewayAutonomyConfig;
  readonly tenantId?: string;
  readonly stableKey: string;
}): ResolvedShellProfileRollout {
  const requestedProfile =
    coerceSessionShellProfile(params.requested) ?? DEFAULT_SESSION_SHELL_PROFILE;
  if (requestedProfile === DEFAULT_SESSION_SHELL_PROFILE) {
    return {
      profile: DEFAULT_SESSION_SHELL_PROFILE,
      requestedProfile,
      decision: disabledDecision("General shell profile is always available."),
      coerced: false,
    };
  }
  const decision = evaluateShellFeatureRollout({
    autonomy: params.autonomy,
    tenantId: params.tenantId,
    feature: "shellProfiles",
    domain: "shell",
    stableKey: params.stableKey,
  });
  return {
    profile: decision.allowed
      ? requestedProfile
      : DEFAULT_SESSION_SHELL_PROFILE,
    requestedProfile,
    decision,
    coerced: decision.allowed === false,
  };
}

export function formatShellRolloutHoldback(params: {
  readonly label: string;
  readonly decision: AutonomyCanaryDecision;
}): string {
  return `${params.label} is unavailable for this session because rollout policy is holding it back. ${params.decision.reason}`;
}
