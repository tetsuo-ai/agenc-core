import type { AdditionalPermissionProfile, PermissionProfile } from "../sandbox/engine/index.js";
import { effectivePermissionProfile } from "../sandbox/engine/policy-transforms.js";

/** Called only after selecting an actual sandbox. Preserve cache/offline modes. */
export function withNetworkRetryDefaults(
  env: Readonly<Record<string, string>>,
  profile: PermissionProfile,
  additionalPermissions: AdditionalPermissionProfile | undefined,
  hasManagedNetwork: boolean,
): Record<string, string> {
  const result = { ...env };
  if (hasManagedNetwork ||
    effectivePermissionProfile(profile, additionalPermissions).network !== "disabled") return result;
  // Explicit environment settings win. In a network-denied sandbox these
  // defaults override config-file retry counts, not offline/cache behavior.
  if (!Object.keys(env).some(key => key.toLowerCase() === "npm_config_fetch_retries")) {
    result.npm_config_fetch_retries = "0";
  }
  if (!("PIP_RETRIES" in env)) result.PIP_RETRIES = "0";
  return result;
}
