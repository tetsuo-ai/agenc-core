/**
 * Resolve provider construction inputs at an ingress boundary.
 *
 * `createProvider()` deliberately does not read `process.env`. Callers that
 * accept environment configuration resolve it once, against the session's
 * immutable environment snapshot, and pass the resulting options into the
 * factory. Credentials are inputs for an already-selected provider; they
 * never participate in provider selection here.
 */

import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";
import { canonicalSessionEnvironmentKeys } from "../session/environment.js";
import {
  getGeminiAuthMode,
  getGeminiProjectIdHint,
  resolveGeminiCredential,
} from "../utils/geminiAuth.js";
import {
  readOpenAiOauthCredentials,
  refreshOpenAiSubscriptionIfNeeded,
} from "../utils/openAiOauthCredentials.js";
import {
  CHATGPT_BACKEND_BASE_URL,
  chatGptSubscriptionHeaders,
  resolveStoredChatGptSubscriptionCredentials,
} from "./providers/openai/chatgpt-backend.js";
import {
  resolveProviderApiKeyEnvironment,
  resolveProviderBaseURLEnvironment,
} from "./registry/provider-ingress.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "./registry/provider-info.js";
import { resolveGrokProviderApiKey } from "./xai-capability-config.js";
import type { ProviderFactoryOptions, ProviderName } from "./provider.js";

export type ProviderEnvironment = Readonly<
  Record<string, string | undefined>
>;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function mergeExtra(
  requested: Readonly<Record<string, unknown>> | undefined,
  resolved: Readonly<Record<string, unknown>>,
  forced: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> | undefined {
  const merged = { ...resolved, ...(requested ?? {}), ...forced };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  return entries.some(([, entry]) => typeof entry !== "string")
    ? {}
    : Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function assertOpenAiOauthBaseUrl(baseURL: string | undefined): string {
  const canonical = BUILT_IN_PROVIDER_BASE_URLS.openai;
  if (
    baseURL !== undefined &&
    baseURL.replace(/\/+$/u, "") !== canonical.replace(/\/+$/u, "")
  ) {
    throw new Error(
      "OpenAI sign-in credentials are bound to the first-party OpenAI " +
        "endpoint. Run /openai-logout before using a custom OPENAI_BASE_URL.",
    );
  }
  return canonical;
}

/** Copy an environment so later process-global mutation cannot affect a session. */
export function snapshotProviderEnvironment(
  env: ProviderEnvironment,
): ProviderEnvironment {
  assertCanonicalEnvironmentIngress(env);
  return Object.freeze(
    Object.fromEntries(
      canonicalSessionEnvironmentKeys(env).flatMap(key =>
        env[key] === undefined ? [] : [[key, env[key]]],
      ),
    ),
  );
}

/**
 * Resolve credentials and endpoint metadata for an explicit provider/model.
 * The provider and model are never inferred from credential names or values.
 */
export function resolveProviderFactoryOptions(
  provider: ProviderName,
  requested: ProviderFactoryOptions,
  env: ProviderEnvironment,
): ProviderFactoryOptions {
  const snapshot = snapshotProviderEnvironment(env);
  const home = requested.credentialHome;
  const environmentApiKey = resolveProviderApiKeyEnvironment(
    provider,
    snapshot,
  )?.value;
  let apiKey = provider === "grok" && home !== undefined
    ? resolveGrokProviderApiKey(
        home,
        requested.apiKey ?? environmentApiKey,
        snapshot,
      )
    : nonEmpty(requested.apiKey) ?? environmentApiKey;
  let baseURL =
    nonEmpty(requested.baseURL) ??
    resolveProviderBaseURLEnvironment(provider, snapshot)?.value;

  const resolvedExtra: Record<string, unknown> = {};
  const forcedExtra: Record<string, unknown> = {};
  let chatGptSubscription = false;
  if (provider === "openai") {
    const organization = nonEmpty(snapshot.OPENAI_ORGANIZATION);
    const project = nonEmpty(snapshot.OPENAI_PROJECT);
    if (organization !== undefined) resolvedExtra.organization = organization;
    if (project !== undefined) resolvedExtra.project = project;

    const stored = home === undefined
      ? undefined
      : readOpenAiOauthCredentials(home);
    if (stored?.apiKey !== undefined) {
      apiKey = stored.apiKey;
      baseURL = assertOpenAiOauthBaseUrl(baseURL);
      forcedExtra.authMode = "api_key";
    } else {
      const subscription = resolveStoredChatGptSubscriptionCredentials(stored);
      if (home !== undefined && subscription !== undefined) {
        const initialAccessToken = subscription.bearerToken;
        apiKey = undefined;
        baseURL = CHATGPT_BACKEND_BASE_URL;
        chatGptSubscription = true;
        forcedExtra.authMode = "oauth";
        forcedExtra.oauth = {
          accessToken: initialAccessToken,
          ...(stored?.refreshToken !== undefined
            ? { refreshToken: stored.refreshToken }
            : {}),
          refreshAccessToken: async () => {
            try {
              const refreshed = await refreshOpenAiSubscriptionIfNeeded(
                home,
                snapshot,
                { force: true },
              );
              const credentials = refreshed.credentials;
              if (
                refreshed.refreshed !== true ||
                credentials?.apiKey !== undefined ||
                credentials?.accessToken === undefined
              ) {
                return {
                  kind: "exhausted" as const,
                  reason: "OpenAI subscription token refresh is unavailable",
                };
              }
              return {
                kind: "refreshed" as const,
                accessToken: credentials.accessToken,
                ...(credentials.refreshToken !== undefined
                  ? { refreshToken: credentials.refreshToken }
                  : {}),
              };
            } catch (error) {
              return {
                kind: "exhausted" as const,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
          },
        };
        forcedExtra.store = false;
        forcedExtra.useResponsesApi = true;
        forcedExtra.chatgptBackend = true;
        forcedExtra.defaultHeaders = {
          ...stringRecord(requested.extra?.defaultHeaders),
          ...chatGptSubscriptionHeaders(subscription.accountId),
        };
      }
    }
  }

  if (provider === "gemini") {
    const authMode = getGeminiAuthMode(snapshot);
    const accessToken = nonEmpty(snapshot.GEMINI_ACCESS_TOKEN);
    const project = getGeminiProjectIdHint(snapshot);
    const location =
      nonEmpty(snapshot.GEMINI_VERTEX_LOCATION) ??
      nonEmpty(snapshot.GOOGLE_CLOUD_LOCATION) ??
      nonEmpty(snapshot.GOOGLE_CLOUD_REGION) ??
      nonEmpty(snapshot.CLOUD_ML_REGION);
    const cachedContent = nonEmpty(snapshot.GEMINI_CACHED_CONTENT);
    if (authMode === "access-token" || authMode === "adc") {
      resolvedExtra.authMode = "oauth";
      apiKey = undefined;
    }
    if (accessToken !== undefined) resolvedExtra.accessToken = accessToken;
    if (project !== undefined) resolvedExtra.project = project;
    if (location !== undefined) resolvedExtra.location = location;
    if (cachedContent !== undefined) resolvedExtra.cachedContent = cachedContent;
    resolvedExtra.resolveCredential = () =>
      resolveGeminiCredential(snapshot);
  }

  if (provider === "amazon-bedrock") {
    const secretAccessKey =
      nonEmpty(snapshot.AWS_BEDROCK_SECRET_ACCESS_KEY) ??
      nonEmpty(snapshot.AWS_SECRET_ACCESS_KEY);
    const sessionToken =
      nonEmpty(snapshot.AWS_BEDROCK_SESSION_TOKEN) ??
      nonEmpty(snapshot.AWS_SESSION_TOKEN);
    const region =
      nonEmpty(snapshot.AWS_BEDROCK_REGION) ??
      nonEmpty(snapshot.AWS_REGION) ??
      nonEmpty(snapshot.AWS_DEFAULT_REGION);
    if (secretAccessKey !== undefined) {
      resolvedExtra.secretAccessKey = secretAccessKey;
    }
    if (sessionToken !== undefined) resolvedExtra.sessionToken = sessionToken;
    if (region !== undefined) resolvedExtra.region = region;
    if (apiKey !== undefined) resolvedExtra.accessKeyId = apiKey;
  }

  const extra = mergeExtra(requested.extra, resolvedExtra, forcedExtra);
  if (chatGptSubscription && extra !== undefined) {
    delete extra.organization;
    delete extra.project;
  }
  return {
    ...(home !== undefined ? { credentialHome: home } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(requested.model !== undefined ? { model: requested.model } : {}),
    ...(requested.tools !== undefined ? { tools: [...requested.tools] } : {}),
    ...(requested.timeoutMs !== undefined
      ? { timeoutMs: requested.timeoutMs }
      : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
}
