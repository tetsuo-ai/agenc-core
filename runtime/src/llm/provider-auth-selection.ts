/** Non-secret auth intent, captured in the same immutable env as credentials. */
export type SelectableAuthProvider = "openai" | "grok";
export type ProviderAuthPreference = "auto" | "oauth" | "api-key";
export type ProviderAuthEnvironment = Readonly<Record<string, string | undefined>>;

export const PROVIDER_AUTH_ENV = Object.freeze({
  openai: "OPENAI_AUTH_MODE",
  grok: "GROK_AUTH_MODE",
} as const);

export function providerAuthPreference(
  provider: SelectableAuthProvider,
  environment: ProviderAuthEnvironment,
): ProviderAuthPreference {
  const name = PROVIDER_AUTH_ENV[provider];
  const value = environment[name]?.trim();
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "oauth" || value === "api-key") return value;
  throw new Error(`${name} must be auto, oauth, or api-key`);
}

/** Status describes credential presence, never network validity or balance. */
export function providerAuthSelection(
  provider: SelectableAuthProvider,
  environment: ProviderAuthEnvironment,
  available: { readonly oauth: boolean; readonly apiKey: boolean },
  automaticMode?: "oauth" | "api-key",
) {
  const preference = providerAuthPreference(provider, environment);
  const effectiveMode = preference === "oauth"
    ? available.oauth ? "oauth" : null
    : preference === "api-key"
      ? available.apiKey ? "api-key" : null
      : automaticMode ?? (available.oauth ? "oauth" : available.apiKey ? "api-key" : null);
  return Object.freeze({
    version: 1 as const,
    preference,
    effectiveMode,
    available: Object.freeze({ ...available }),
  });
}

/** The `[providers.<openai|grok>] auth` settings a config may carry. */
export type ConfiguredProviderAuth = {
  readonly providers?: Readonly<
    Partial<Record<SelectableAuthProvider, { readonly auth?: ProviderAuthPreference }>>
  >;
};

/**
 * The environment with each provider's configured `auth` filled in where
 * the environment leaves `OPENAI_AUTH_MODE` / `GROK_AUTH_MODE` unset, so an
 * exported variable always wins and every reader of the environment sees
 * the config choice. Returns the same object when nothing changes.
 */
export function withConfiguredProviderAuth<T extends ProviderAuthEnvironment>(
  environment: T,
  config: ConfiguredProviderAuth | undefined,
): T {
  let next: Record<string, string | undefined> | undefined;
  for (const provider of Object.keys(PROVIDER_AUTH_ENV) as SelectableAuthProvider[]) {
    const configured = config?.providers?.[provider]?.auth;
    if (configured === undefined || configured === "auto") continue;
    const name = PROVIDER_AUTH_ENV[provider];
    if ((environment[name]?.trim() ?? "") !== "") continue;
    next ??= { ...environment };
    next[name] = configured;
  }
  return next === undefined ? environment : (Object.freeze(next) as unknown as T);
}
