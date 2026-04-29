/**
 * Shared auth helpers for bearer-key and query-param API key providers.
 *
 * @module
 */

export interface BearerAuthConfig {
  readonly apiKey: string;
  readonly headerName?: string;
  readonly prefix?: string;
}

export interface QueryApiKeyAuthConfig {
  readonly apiKey: string;
  readonly queryParam: string;
}

export function assertNonEmptyApiKey(
  providerName: string,
  apiKey: string | undefined,
  envVarHint: string,
): string {
  const value = apiKey?.trim();
  if (!value) {
    throw new Error(
      `${providerName} provider requires an API key — set ${envVarHint} or pass apiKey in the provider config`,
    );
  }
  return value;
}

export function buildBearerAuthHeaders(
  config: BearerAuthConfig,
): Record<string, string> {
  const headerName = config.headerName ?? "authorization";
  const prefix = config.prefix ?? "Bearer";
  return {
    [headerName]: `${prefix} ${config.apiKey}`,
  };
}

export function applyQueryApiKey(
  url: URL,
  config: QueryApiKeyAuthConfig,
): void {
  url.searchParams.set(config.queryParam, config.apiKey);
}
