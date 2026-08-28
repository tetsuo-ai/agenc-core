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
  getGeminiProjectIdHint,
  resolveGeminiCredentialPlan,
  type GeminiCredentialPlan,
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
  resolveProviderBaseURLEnvironment,
  resolveProviderCredentialEnvironment,
  missingProviderCredentialEnvironmentLabel,
  providerCredentialEnvironmentProvenance,
  type ProviderCredentialProvenance,
} from "./registry/provider-ingress.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  providerCredentialEnvironmentLabel,
  resolveBuiltInProviderInfo,
} from "./registry/provider-info.js";
import { resolveGrokProviderCredential } from "./xai-capability-config.js";
import type { ProviderFactoryOptions, ProviderName } from "./provider.js";
import {
  assertNoRetiredGeminiRuntimeFields,
  createGeminiRuntimeOptions,
  readGeminiRuntimeOptions,
} from "./providers/gemini/runtime-options.js";
import { createGeminiEndpointPlan } from "./providers/gemini/endpoint-plan.js";
import { isGrokComposerModel } from "./providers/grok/acp-adapter.js";
import type { AuthBackend, AuthSubscriptionTier } from "../auth/backend.js";

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

/** Lower-precedence credentials discovered at the canonical ingress. */
export interface ProviderCredentialCandidates {
  readonly savedApiKey?: string;
}

export type ProviderCredentialReadyMode =
  | "api-key"
  | "anthropic-bearer-token"
  | "xai-oauth"
  | "openai-oauth"
  | "gemini-access-token"
  | "gemini-adc"
  | "aws-sigv4";

export type ProviderCredentialSource =
  | "explicit"
  | "environment"
  | "saved-byok"
  | "native-sign-in"
  | "application-default";

export type ProviderCredentialState =
  | {
      readonly status: "ready";
      readonly mode: ProviderCredentialReadyMode;
      readonly source: ProviderCredentialSource;
      readonly label: string;
      readonly provenance?: ProviderCredentialProvenance;
    }
  | {
      readonly status: "optional" | "not-required";
      readonly mode: "none";
      readonly label: string;
    }
  | {
      readonly status: "missing";
      readonly mode: "none";
      readonly reason: "absent" | "partial" | "mode-required";
      readonly label: string;
      readonly missingLabel: string;
      readonly provenance?: ProviderCredentialProvenance;
    };

export interface ResolvedProviderCredentialAuthority {
  readonly factoryOptions: ProviderFactoryOptions;
  readonly credential: ProviderCredentialState;
}

export type ReadSavedProviderApiKey = (
  provider: ProviderName,
) => Promise<string | undefined>;

export interface ProviderRuntimeCredentialOptions {
  readonly readSavedApiKey?: ReadSavedProviderApiKey;
  readonly authBackend?: AuthBackend;
  readonly sessionId?: string;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly managedKeysEnabled?: boolean;
  readonly freeManagedCredential?: boolean;
}

export interface ResolvedProviderRuntimeAuthority extends ResolvedProviderCredentialAuthority {
  readonly managedCredential: boolean;
}

export const MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

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
    : (Object.fromEntries(entries) as Readonly<Record<string, string>>);
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
      canonicalSessionEnvironmentKeys(env).flatMap((key) =>
        env[key] === undefined ? [] : [[key, env[key]]],
      ),
    ),
  );
}

function readyCredential(
  mode: ProviderCredentialReadyMode,
  source: ProviderCredentialSource,
  label: string,
  provenance?: ProviderCredentialProvenance,
): ProviderCredentialState {
  return Object.freeze({
    status: "ready",
    mode,
    source,
    label,
    ...(provenance === undefined ? {} : { provenance }),
  });
}

function missingCredential(
  label: string,
  missingLabel = label,
  provenance?: ProviderCredentialProvenance,
  reason: "absent" | "partial" | "mode-required" = "absent",
): ProviderCredentialState {
  return Object.freeze({
    status: "missing",
    mode: "none",
    reason,
    label,
    missingLabel,
    ...(provenance === undefined ? {} : { provenance }),
  });
}

function readExtraString(
  extra: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = extra?.[key];
  return typeof value === "string" ? nonEmpty(value) : undefined;
}

function projectGeminiCredentialState(
  plan: GeminiCredentialPlan,
  environment: ReturnType<typeof resolveProviderCredentialEnvironment>,
): ProviderCredentialState {
  if (plan.kind === "api-key") {
    if (plan.source === "saved-byok") {
      return readyCredential("api-key", "saved-byok", "saved Gemini BYOK");
    }
    if (plan.source === "factory") {
      return readyCredential("api-key", "explicit", "explicit Gemini API key");
    }
    const provenance =
      environment === undefined
        ? Object.freeze({
            kind: "environment" as const,
            fields: Object.freeze([
              Object.freeze({ role: "apiKey" as const, envVar: plan.source }),
            ]),
          })
        : providerCredentialEnvironmentProvenance(environment);
    return readyCredential("api-key", "environment", plan.source, provenance);
  }
  if (plan.kind === "access-token") {
    return readyCredential("gemini-access-token", "environment", plan.source);
  }
  if (plan.kind === "adc") {
    return readyCredential(
      "gemini-adc",
      plan.source === "well-known-adc" ? "application-default" : "environment",
      plan.source === "well-known-adc"
        ? "Google application default credentials"
        : plan.source,
    );
  }
  const missingLabel =
    plan.expected === "access-token"
      ? "GEMINI_ACCESS_TOKEN"
      : plan.expected === "adc"
        ? plan.configuredPath === undefined
          ? "Google application default credentials"
          : `ADC file ${plan.configuredPath}`
        : plan.expected === "api-key"
          ? "GEMINI_API_KEY or GOOGLE_API_KEY or saved BYOK"
          : "Gemini API key, access token, ADC credentials, or saved BYOK";
  return missingCredential(
    `${missingLabel} missing`,
    missingLabel,
    undefined,
    plan.expected === "any" ? "absent" : "mode-required",
  );
}

function projectProviderCredentialState(params: {
  readonly provider: ProviderName;
  readonly requested: ProviderFactoryOptions;
  readonly snapshot: ProviderEnvironment;
  readonly candidates: ProviderCredentialCandidates;
  readonly factoryOptions: ProviderFactoryOptions;
  readonly credentialEnvironment: ReturnType<
    typeof resolveProviderCredentialEnvironment
  >;
  readonly grokCredential?: ReturnType<typeof resolveGrokProviderCredential>;
  readonly openAiNativeAuthMode?: "api-key" | "oauth";
  readonly geminiCredentialPlan?: GeminiCredentialPlan;
}): ProviderCredentialState {
  const info = resolveBuiltInProviderInfo(params.provider);
  if (info === undefined) {
    return missingCredential("provider credentials", "provider credentials");
  }
  if (
    params.provider === "grok" &&
    isGrokComposerModel(params.factoryOptions.model)
  ) {
    return Object.freeze({
      status: "not-required",
      mode: "none",
      label: "Grok CLI authentication",
    });
  }
  if (params.provider === "gemini") {
    return params.geminiCredentialPlan === undefined
      ? missingCredential(
          "Gemini credential authority missing",
          "Gemini credentials",
        )
      : projectGeminiCredentialState(
          params.geminiCredentialPlan,
          params.credentialEnvironment,
        );
  }
  if (params.provider === "openai") {
    if (params.openAiNativeAuthMode === "oauth") {
      return readyCredential(
        "openai-oauth",
        "native-sign-in",
        "OpenAI sign-in",
      );
    }
    if (params.openAiNativeAuthMode === "api-key") {
      return readyCredential(
        "api-key",
        "native-sign-in",
        "stored OpenAI API key",
      );
    }
  }
  if (params.provider === "grok" && params.grokCredential?.isOAuth === true) {
    return readyCredential(
      "xai-oauth",
      "native-sign-in",
      "xAI OAuth",
      Object.freeze({ kind: "oauth", provider: "grok" }),
    );
  }
  if (info.credentials.kind === "aws-sigv4") {
    const accessKeyId = readExtraString(
      params.factoryOptions.extra,
      "accessKeyId",
    );
    const secretAccessKey = readExtraString(
      params.factoryOptions.extra,
      "secretAccessKey",
    );
    if (accessKeyId !== undefined && secretAccessKey !== undefined) {
      const explicit =
        readExtraString(params.requested.extra, "accessKeyId") !== undefined ||
        readExtraString(params.requested.extra, "secretAccessKey") !==
          undefined;
      const provenance =
        explicit || params.credentialEnvironment === undefined
          ? undefined
          : providerCredentialEnvironmentProvenance(
              params.credentialEnvironment,
            );
      return readyCredential(
        "aws-sigv4",
        explicit ? "explicit" : "environment",
        explicit ? "explicit AWS SigV4 credentials" : "AWS SigV4 environment",
        provenance,
      );
    }
    const missingFields: string[] = [];
    if (accessKeyId === undefined) {
      missingFields.push(info.credentials.accessKeyId.envVars.join(" or "));
    }
    if (secretAccessKey === undefined) {
      missingFields.push(info.credentials.secretAccessKey.envVars.join(" or "));
    }
    const missingLabel = missingFields.join(" and ");
    return missingCredential(
      `${missingLabel} missing`,
      missingLabel,
      params.credentialEnvironment === undefined
        ? undefined
        : providerCredentialEnvironmentProvenance(params.credentialEnvironment),
      params.credentialEnvironment?.sources.length ? "partial" : "absent",
    );
  }
  if (info.credentials.kind === "none") {
    return Object.freeze({
      status: "not-required",
      mode: "none",
      label: "no provider credential required",
    });
  }
  const resolvedAuthToken = nonEmpty(params.factoryOptions.authToken);
  if (params.provider === "anthropic" && resolvedAuthToken !== undefined) {
    const requestedAuthToken = nonEmpty(params.requested.authToken);
    return readyCredential(
      "anthropic-bearer-token",
      requestedAuthToken === resolvedAuthToken ? "explicit" : "environment",
      requestedAuthToken === resolvedAuthToken
        ? "explicit Anthropic bearer token"
        : "ANTHROPIC_AUTH_TOKEN",
    );
  }
  const resolvedApiKey = nonEmpty(params.factoryOptions.apiKey);
  if (resolvedApiKey !== undefined) {
    const requestedApiKey = nonEmpty(params.requested.apiKey);
    if (requestedApiKey !== undefined && requestedApiKey === resolvedApiKey) {
      return readyCredential("api-key", "explicit", "explicit API key");
    }
    const environmentApiKey =
      params.credentialEnvironment?.kind === "api-key"
        ? params.credentialEnvironment.apiKey
        : undefined;
    if (
      environmentApiKey !== undefined &&
      environmentApiKey.value === resolvedApiKey
    ) {
      return readyCredential(
        "api-key",
        "environment",
        environmentApiKey.envVar,
        providerCredentialEnvironmentProvenance(params.credentialEnvironment!),
      );
    }
    if (nonEmpty(params.candidates.savedApiKey) === resolvedApiKey) {
      return readyCredential("api-key", "saved-byok", "saved BYOK");
    }
    return readyCredential("api-key", "explicit", "resolved API key");
  }
  if (!info.credentials.apiKey.required) {
    return Object.freeze({
      status: "optional",
      mode: "none",
      label: `${providerCredentialEnvironmentLabel(params.provider) ?? "API key"} optional`,
    });
  }
  const missingLabel =
    params.provider === "anthropic"
      ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
      : missingProviderCredentialEnvironmentLabel(
          params.provider,
          params.snapshot,
        ) ??
        providerCredentialEnvironmentLabel(params.provider) ??
        `${info.name} credentials`;
  return missingCredential(`${missingLabel} missing`, missingLabel);
}

/**
 * Resolve credentials and endpoint metadata for an explicit provider/model.
 * The provider and model are never inferred from credential names or values.
 */
function resolveProviderCredentialAuthorityCore(
  provider: ProviderName,
  requested: ProviderFactoryOptions,
  env: ProviderEnvironment,
  candidates: ProviderCredentialCandidates = {},
): ResolvedProviderCredentialAuthority {
  if (
    provider === "amazon-bedrock" &&
    nonEmpty(requested.apiKey) !== undefined
  ) {
    throw new Error(
      "amazon-bedrock does not accept the generic apiKey factory option; pass accessKeyId in factory options extra",
    );
  }
  if (
    provider !== "anthropic" &&
    nonEmpty(requested.authToken) !== undefined
  ) {
    throw new Error(`${provider} does not accept the authToken factory option`);
  }
  if (
    nonEmpty(requested.apiKey) !== undefined &&
    nonEmpty(requested.authToken) !== undefined
  ) {
    throw new Error(
      "anthropic credential authority requires exactly one explicit credential: apiKey or authToken",
    );
  }
  const snapshot = snapshotProviderEnvironment(env);
  const home = requested.credentialHome;
  const credentialEnvironment =
    provider === "gemini"
      ? undefined
      : resolveProviderCredentialEnvironment(provider, snapshot);
  const environmentApiKey =
    credentialEnvironment?.kind === "api-key"
      ? credentialEnvironment.apiKey?.value
      : undefined;
  const explicitApiKey = nonEmpty(requested.apiKey);
  const explicitAuthToken = nonEmpty(requested.authToken);
  const environmentAuthToken =
    provider === "anthropic" && explicitApiKey === undefined
      ? nonEmpty(snapshot.ANTHROPIC_AUTH_TOKEN)
      : undefined;
  const authToken = explicitAuthToken ?? environmentAuthToken;
  const grokCredential =
    provider === "grok" && home !== undefined
      ? resolveGrokProviderCredential(home, requested.apiKey, snapshot)
      : undefined;
  let apiKey =
    provider === "grok" && home !== undefined
      ? (grokCredential?.value ?? nonEmpty(candidates.savedApiKey))
      : (explicitApiKey ??
        environmentApiKey ??
        nonEmpty(candidates.savedApiKey));
  if (authToken !== undefined) {
    apiKey = undefined;
  }
  const requestedBaseURL = nonEmpty(requested.baseURL);
  let baseURL =
    requestedBaseURL ??
    resolveProviderBaseURLEnvironment(provider, snapshot)?.value;

  const resolvedExtra: Record<string, unknown> = {};
  const forcedExtra: Record<string, unknown> = {};
  let chatGptSubscription = false;
  let openAiNativeAuthMode: "api-key" | "oauth" | undefined;
  if (provider === "openai") {
    const organization = nonEmpty(snapshot.OPENAI_ORGANIZATION);
    const project = nonEmpty(snapshot.OPENAI_PROJECT);
    if (organization !== undefined) resolvedExtra.organization = organization;
    if (project !== undefined) resolvedExtra.project = project;

    if (nonEmpty(requested.apiKey) === undefined) {
      const stored =
        home === undefined ? undefined : readOpenAiOauthCredentials(home);
      if (stored?.apiKey !== undefined) {
        apiKey = stored.apiKey;
        baseURL = assertOpenAiOauthBaseUrl(baseURL);
        openAiNativeAuthMode = "api-key";
        forcedExtra.authMode = "api_key";
      } else {
        const subscription =
          resolveStoredChatGptSubscriptionCredentials(stored);
        if (home !== undefined && subscription !== undefined) {
          const initialAccessToken = subscription.bearerToken;
          apiKey = undefined;
          baseURL = CHATGPT_BACKEND_BASE_URL;
          chatGptSubscription = true;
          openAiNativeAuthMode = "oauth";
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
                  reason:
                    error instanceof Error ? error.message : String(error),
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
  }

  let geminiCredentialPlan: GeminiCredentialPlan | undefined;
  if (provider === "gemini") {
    assertNoRetiredGeminiRuntimeFields(requested.extra);
    const requestedRuntime = readGeminiRuntimeOptions(requested.extra);
    if (
      requestedRuntime !== undefined &&
      nonEmpty(requested.apiKey) !== undefined
    ) {
      throw new Error(
        "Gemini factory options cannot contain both apiKey and extra.gemini credentialPlan",
      );
    }
    const credentialPlan =
      requestedRuntime?.credentialPlan ??
      resolveGeminiCredentialPlan(snapshot, {
        apiKey: requested.apiKey,
        savedApiKey: candidates.savedApiKey,
      });
    geminiCredentialPlan = credentialPlan;
    const usesVertexRouting =
      credentialPlan.kind === "access-token" ||
      credentialPlan.kind === "adc" ||
      (credentialPlan.kind === "none" &&
        (credentialPlan.mode === "access-token" ||
          credentialPlan.mode === "adc"));
    const project =
      getGeminiProjectIdHint(snapshot) ??
      (credentialPlan.kind === "access-token" || credentialPlan.kind === "adc"
        ? credentialPlan.projectId
        : undefined);
    const location =
      nonEmpty(snapshot.GEMINI_VERTEX_LOCATION) ??
      nonEmpty(snapshot.GOOGLE_CLOUD_LOCATION);
    if (requestedRuntime !== undefined && requestedBaseURL !== undefined) {
      throw new Error(
        "Gemini factory options cannot contain both baseURL and extra.gemini endpointPlan",
      );
    }
    if (
      requestedRuntime === undefined &&
      baseURL === undefined &&
      usesVertexRouting &&
      (project === undefined || location === undefined)
    ) {
      throw new Error(
        "Gemini access-token/ADC routing requires both project and location when GEMINI_BASE_URL is not set",
      );
    }
    const endpointPlan =
      requestedRuntime?.endpointPlan ??
      createGeminiEndpointPlan({
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(baseURL === undefined &&
        usesVertexRouting &&
        project !== undefined &&
        location !== undefined
          ? { vertex: { project, location } }
          : {}),
      });
    const cachedContent =
      requestedRuntime === undefined
        ? nonEmpty(snapshot.GEMINI_CACHED_CONTENT)
        : requestedRuntime.cachedContent;
    forcedExtra.gemini = createGeminiRuntimeOptions({
      credentialPlan,
      endpointPlan,
      ...(cachedContent !== undefined ? { cachedContent } : {}),
    });
    // From this boundary onward Gemini has one credential and endpoint
    // representation. Generic factory fields cannot become parallel authority.
    apiKey = undefined;
    baseURL = undefined;
  }

  if (provider === "grok" && isGrokComposerModel(requested.model)) {
    const requestedGrokAcp = requested.extra?.grokAcp;
    const requestedGrokAcpRecord =
      requestedGrokAcp !== null &&
      typeof requestedGrokAcp === "object" &&
      !Array.isArray(requestedGrokAcp)
        ? (requestedGrokAcp as Readonly<Record<string, unknown>>)
        : undefined;
    const binaryPath = nonEmpty(snapshot.AGENC_GROK_CLI);
    const permissions = nonEmpty(snapshot.AGENC_GROK_ACP_PERMISSIONS);
    const path = snapshot.PATH;
    if (
      requestedGrokAcpRecord !== undefined ||
      binaryPath !== undefined ||
      permissions !== undefined ||
      path !== undefined
    ) {
      forcedExtra.grokAcp = {
        ...(binaryPath !== undefined ? { binaryPath } : {}),
        ...(permissions !== undefined
          ? { allowPermissions: permissions.toLowerCase() === "allow" }
          : {}),
        ...(path !== undefined ? { path } : {}),
        ...(requestedGrokAcpRecord ?? {}),
      };
    }
  }

  if (provider === "openrouter") {
    const referer = nonEmpty(snapshot.AGENC_OPENROUTER_HTTP_REFERER);
    const title = nonEmpty(snapshot.AGENC_OPENROUTER_TITLE);
    if (referer !== undefined || title !== undefined) {
      resolvedExtra.defaultHeaders = {
        ...(referer !== undefined ? { "HTTP-Referer": referer } : {}),
        ...(title !== undefined ? { "X-Title": title } : {}),
        ...stringRecord(requested.extra?.defaultHeaders),
      };
    }
  }

  if (provider === "amazon-bedrock") {
    const bedrock =
      credentialEnvironment?.kind === "aws-sigv4"
        ? credentialEnvironment
        : undefined;
    const accessKeyId = bedrock?.accessKeyId?.value;
    const secretAccessKey = bedrock?.secretAccessKey?.value;
    const sessionToken = bedrock?.sessionToken?.value;
    const region = bedrock?.region?.value;
    if (accessKeyId !== undefined) resolvedExtra.accessKeyId = accessKeyId;
    if (secretAccessKey !== undefined) {
      resolvedExtra.secretAccessKey = secretAccessKey;
    }
    if (sessionToken !== undefined) resolvedExtra.sessionToken = sessionToken;
    if (region !== undefined) resolvedExtra.region = region;
  }

  let extra = mergeExtra(requested.extra, resolvedExtra, forcedExtra);
  if (provider === "openrouter" && resolvedExtra.defaultHeaders !== undefined) {
    extra = {
      ...(extra ?? {}),
      defaultHeaders: resolvedExtra.defaultHeaders,
    };
  }
  if (chatGptSubscription && extra !== undefined) {
    delete extra.organization;
    delete extra.project;
  }
  const factoryOptions: ProviderFactoryOptions = {
    ...(home !== undefined ? { credentialHome: home } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(requested.model !== undefined ? { model: requested.model } : {}),
    ...(requested.tools !== undefined ? { tools: [...requested.tools] } : {}),
    ...(requested.timeoutMs !== undefined
      ? { timeoutMs: requested.timeoutMs }
      : {}),
    ...(extra !== undefined ? { extra } : {}),
  };
  return Object.freeze({
    factoryOptions,
    credential: projectProviderCredentialState({
      provider,
      requested,
      snapshot,
      candidates,
      factoryOptions,
      credentialEnvironment,
      grokCredential,
      openAiNativeAuthMode,
      geminiCredentialPlan,
    }),
  });
}

/**
 * Resolve runtime factory options and a redacted view of the same direct
 * credential decision. Menus, command guards, and discovery must consume this
 * projection instead of rebuilding provider-specific credential rules.
 */
export function resolveProviderCredentialAuthority(
  provider: ProviderName,
  requested: ProviderFactoryOptions,
  env: ProviderEnvironment,
  candidates: ProviderCredentialCandidates = {},
): ResolvedProviderCredentialAuthority {
  return resolveProviderCredentialAuthorityCore(
    provider,
    requested,
    env,
    candidates,
  );
}

function isEntitledSubscription(
  tier: AuthSubscriptionTier | undefined,
): boolean {
  return tier === "pro" || tier === "team" || tier === "enterprise";
}

export function assertHostedAgencSubscriptionAuthority(params: {
  readonly provider: ProviderName;
  readonly authBackend: AuthBackend | undefined;
  readonly subscriptionTier: AuthSubscriptionTier | undefined;
}): void {
  if (
    params.provider === "agenc" &&
    params.authBackend?.kind === "remote" &&
    !isEntitledSubscription(params.subscriptionTier)
  ) {
    throw new Error(
      "Hosted AgenC model routing requires an active AgenC subscription",
    );
  }
}

function withRuntimeAuthExtra(
  provider: ProviderName,
  options: ProviderFactoryOptions,
  runtime: ProviderRuntimeCredentialOptions,
  managedCredential: boolean,
): ProviderFactoryOptions {
  const sessionId = nonEmpty(runtime.sessionId);
  if (runtime.authBackend === undefined || sessionId === undefined) {
    return options;
  }
  return {
    ...options,
    extra: {
      ...(options.extra ?? {}),
      authBackend: runtime.authBackend,
      sessionId,
      ...(runtime.subscriptionTier !== undefined
        ? { subscriptionTier: runtime.subscriptionTier }
        : {}),
      ...(managedCredential ? { managedCredential: true } : {}),
      ...(managedCredential &&
      provider === "openrouter" &&
      options.extra?.maxTokens === undefined
        ? { maxTokens: MANAGED_OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS }
        : {}),
    },
  };
}

/**
 * Resolve the complete credential authority for a live provider binding.
 * Saved BYOK is read only when explicit, native, and environment credentials
 * are absent. Subscription credentials remain lazy and are vended only by the
 * provider wrapper when the first model operation starts.
 */
export async function resolveProviderRuntimeAuthority(
  provider: ProviderName,
  requested: ProviderFactoryOptions,
  env: ProviderEnvironment,
  runtime: ProviderRuntimeCredentialOptions = {},
): Promise<ResolvedProviderRuntimeAuthority> {
  let resolved = resolveProviderCredentialAuthority(provider, requested, env);
  const info = resolveBuiltInProviderInfo(provider);
  if (
    resolved.credential.status === "missing" &&
    info?.onboarding.access === "api-key" &&
    runtime.readSavedApiKey !== undefined
  ) {
    const savedApiKey = nonEmpty(await runtime.readSavedApiKey(provider));
    if (savedApiKey !== undefined) {
      resolved = resolveProviderCredentialAuthority(provider, requested, env, {
        savedApiKey,
      });
    }
  }
  const sessionId = nonEmpty(runtime.sessionId);
  const managedCredential =
    resolved.credential.status === "missing" &&
    runtime.managedKeysEnabled === true &&
    info?.onboarding.supportsManagedKeyAccess === true &&
    runtime.authBackend !== undefined &&
    sessionId !== undefined;

  if (
    managedCredential &&
    runtime.authBackend?.kind === "remote" &&
    !isEntitledSubscription(runtime.subscriptionTier) &&
    runtime.freeManagedCredential !== true
  ) {
    throw new Error(
      "Managed provider keys require an active AgenC subscription; configure BYOK provider credentials instead",
    );
  }
  assertHostedAgencSubscriptionAuthority({
    provider,
    authBackend: runtime.authBackend,
    subscriptionTier: runtime.subscriptionTier,
  });

  const needsAuthBackend = managedCredential || provider === "agenc";
  const factoryOptions = needsAuthBackend
    ? withRuntimeAuthExtra(
        provider,
        resolved.factoryOptions,
        runtime,
        managedCredential,
      )
    : resolved.factoryOptions;
  return Object.freeze({
    factoryOptions,
    credential: resolved.credential,
    managedCredential,
  });
}

export function requireProviderRuntimeCredential(
  provider: ProviderName,
  authority: ResolvedProviderRuntimeAuthority,
): void {
  if (
    authority.credential.status !== "missing" ||
    authority.managedCredential ||
    provider === "agenc"
  ) {
    return;
  }
  const managedHint =
    resolveBuiltInProviderInfo(provider)?.onboarding
      .supportsManagedKeyAccess === true
      ? " or sign in and enable auth.managedKeys.enabled"
      : "";
  throw new Error(
    `${provider} provider requires credentials. Set ${authority.credential.missingLabel}${managedHint}.`,
  );
}

/** Resolve the credential-bearing options used to construct one provider. */
export function resolveProviderFactoryOptions(
  provider: ProviderName,
  requested: ProviderFactoryOptions,
  env: ProviderEnvironment,
  candidates: ProviderCredentialCandidates = {},
): ProviderFactoryOptions {
  return resolveProviderCredentialAuthority(
    provider,
    requested,
    env,
    candidates,
  ).factoryOptions;
}
