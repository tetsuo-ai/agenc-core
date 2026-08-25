import {
  resolveBuiltInProviderInfo,
  type BuiltInProviderInfo,
} from "./provider-info.js";

export type ProviderIngressEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ProviderEnvironmentMatch {
  readonly envVar: string;
  readonly value: string;
}

function firstEnvironmentMatch(
  env: ProviderIngressEnvironment,
  names: readonly string[],
): ProviderEnvironmentMatch | undefined {
  for (const envVar of names) {
    const value = env[envVar]?.trim();
    if (value) return Object.freeze({ envVar, value });
  }
  return undefined;
}

function resolveProviderInfo(
  provider: string,
): BuiltInProviderInfo | undefined {
  return resolveBuiltInProviderInfo(provider);
}

/** Resolve the first non-empty API-key alias in canonical provider order. */
export function resolveProviderApiKeyEnvironment(
  provider: string,
  env: ProviderIngressEnvironment,
): ProviderEnvironmentMatch | undefined {
  const info = resolveProviderInfo(provider);
  return info === undefined
    ? undefined
    : firstEnvironmentMatch(env, info.apiKeyEnvVars);
}

/** Resolve the first non-empty endpoint alias in canonical provider order. */
export function resolveProviderBaseURLEnvironment(
  provider: string,
  env: ProviderIngressEnvironment,
): ProviderEnvironmentMatch | undefined {
  const info = resolveProviderInfo(provider);
  return info === undefined
    ? undefined
    : firstEnvironmentMatch(env, info.baseURLEnvVars);
}
