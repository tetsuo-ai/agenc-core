import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";
import { canonicalSessionEnvironmentKeys } from "../session/environment.js";

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Copy an environment so later process-global mutation cannot affect a session. */
export function snapshotProviderEnvironment(
  env: ProviderEnvironment,
): ProviderEnvironment {
  assertCanonicalEnvironmentIngress(env);
  return Object.freeze(
    Object.fromEntries(
      canonicalSessionEnvironmentKeys(env).flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]]],
      ),
    ),
  );
}

