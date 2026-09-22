import type { ProviderFactoryOptions } from "../../provider.js";

export function claudeSubscriptionOptions(requested: ProviderFactoryOptions, env: Readonly<Record<string, string | undefined>>): ProviderFactoryOptions | undefined {
  if (env.AGENC_EXPERIMENTAL_CLAUDE_SUBSCRIPTION !== "1" && requested.extra?.claudeSubscription !== true) return undefined;
  const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY"].filter(key => env[key]);
  conflicts.push(...["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].filter(key => !["", "0", "false", "no", "off"].includes((env[key] ?? "").toLowerCase())));
  if (requested.apiKey || requested.authToken || conflicts.length ||
      (requested.baseURL && !/^https:\/\/api\.anthropic\.com(?:\/v1)?\/?$/.test(requested.baseURL))) {
    throw new Error(`Claude CLI subscription cannot be combined with API credentials or endpoint overrides${conflicts.length ? ": " + conflicts.join(", ") : ""}`);
  }
  // Snapshot only process/bootstrap configuration; never transfer token values.
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "PATHEXT", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CLAUDE_CONFIG_DIR", "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND"]) {
    if (env[key]) environment[key] = env[key];
  }
  return { ...requested, apiKey: undefined, authToken: undefined, baseURL: undefined,
    extra: { ...requested.extra, claudeSubscription: true, claudeSubscriptionEnvironment: environment } };
}
