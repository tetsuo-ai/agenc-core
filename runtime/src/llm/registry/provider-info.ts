/**
 * Canonical metadata for every built-in AgenC provider.
 *
 * Provider selection is owned by the session configuration layer. This
 * registry owns the metadata for an already-selected provider: display name,
 * defaults, ordered environment ingress names, and onboarding classification.
 */

import { deriveFlatCatalog } from "./model-catalog.js";
import { OPENROUTER_FREE_MODEL_IDS } from "./openrouter-free-models.js";
import { normalizeProviderIdentity } from "../../provider-identity.js";

// Single source of truth: model lists for providers that have entries in
// REGISTERED_MODEL_CATALOG are computed from it. model-catalog.ts does not
// import this module, so this one-directional import introduces no cycle.
const DERIVED_FLAT_CATALOG = deriveFlatCatalog();

/**
 * Merges registry-derived models for a provider with any extra hand-listed
 * models that do not (yet) have a REGISTERED_MODEL_CATALOG entry. Registry
 * models lead (priority order from the registry); extras are appended in the
 * order given, de-duplicated.
 */
function mergeDerivedProviderModels(
  provider: string,
  options: {
    readonly leadingExtras?: readonly string[];
    readonly trailingExtras?: readonly string[];
  } = {},
): readonly string[] {
  const derived = DERIVED_FLAT_CATALOG[provider] ?? [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (
    const model of [
      ...(options.leadingExtras ?? []),
      ...derived,
      ...(options.trailingExtras ?? []),
    ]
  ) {
    if (seen.has(model)) continue;
    seen.add(model);
    merged.push(model);
  }
  return Object.freeze(merged);
}

export type BuiltInProviderOnboardingAccess =
  | "api-key"
  | "environment"
  | "local"
  | "managed";

export interface BuiltInProviderOnboardingInfo {
  /** Stable provider-picker rank. Lower values appear first. */
  readonly order: number;
  /** Mutually exclusive first-run credential/readiness path. */
  readonly access: BuiltInProviderOnboardingAccess;
  /** A signed-in AgenC subscription may supply this provider's key. */
  readonly supportsManagedKeyAccess: boolean;
}

export interface ProviderCredentialFieldDefinition {
  /** Ordered aliases for one credential field. The first non-empty value wins. */
  readonly envVars: readonly string[];
  /** Whether this field must be present for this credential kind to be usable. */
  readonly required: boolean;
}

export interface BuiltInProviderRegionalEndpointDefinition {
  /** Region used when neither explicit nor environment ingress supplies one. */
  readonly defaultRegion: string;
  /** URL template containing exactly one `{region}` placeholder. */
  readonly baseURLTemplate: string;
}

export interface ResolvedBuiltInProviderRegionalEndpoint {
  readonly region: string;
  readonly baseURL: string;
}

export type ProviderCredentialDefinition =
  | { readonly kind: "none" }
  | {
      readonly kind: "api-key";
      readonly apiKey: ProviderCredentialFieldDefinition;
    }
  | {
      readonly kind: "aws-sigv4";
      readonly accessKeyId: ProviderCredentialFieldDefinition;
      readonly secretAccessKey: ProviderCredentialFieldDefinition;
      readonly sessionToken: ProviderCredentialFieldDefinition;
      readonly regionEnvVars: readonly string[];
    };

function credentialField(
  envVars: readonly string[],
  required: boolean,
): ProviderCredentialFieldDefinition {
  return Object.freeze({
    envVars: Object.freeze([...envVars]),
    required,
  });
}

function noCredentials(): ProviderCredentialDefinition {
  return Object.freeze({ kind: "none" });
}

function apiKeyCredentials(
  envVars: readonly string[],
  required = true,
): ProviderCredentialDefinition {
  return Object.freeze({
    kind: "api-key",
    apiKey: credentialField(envVars, required),
  });
}

function awsSigV4Credentials(params: {
  readonly accessKeyIdEnvVars: readonly string[];
  readonly secretAccessKeyEnvVars: readonly string[];
  readonly sessionTokenEnvVars: readonly string[];
  readonly regionEnvVars: readonly string[];
}): ProviderCredentialDefinition {
  return Object.freeze({
    kind: "aws-sigv4",
    accessKeyId: credentialField(params.accessKeyIdEnvVars, true),
    secretAccessKey: credentialField(params.secretAccessKeyEnvVars, true),
    sessionToken: credentialField(params.sessionTokenEnvVars, false),
    regionEnvVars: Object.freeze([...params.regionEnvVars]),
  });
}

function regionalEndpointBaseURL(
  endpoint: BuiltInProviderRegionalEndpointDefinition,
  region: string,
): string {
  return endpoint.baseURLTemplate.replace("{region}", region);
}

const AMAZON_BEDROCK_REGIONAL_ENDPOINT = Object.freeze({
  defaultRegion: "us-east-1",
  baseURLTemplate: "https://bedrock-runtime.{region}.amazonaws.com",
});

function onboardingInfo(
  order: number,
  access: BuiltInProviderOnboardingAccess,
  supportsManagedKeyAccess = false,
): BuiltInProviderOnboardingInfo {
  return Object.freeze({
    order,
    access,
    supportsManagedKeyAccess,
  });
}

export interface BuiltInProviderDefinition {
  readonly name: string;
  readonly defaultModel: string;
  readonly baseURL: string;
  readonly credentials: ProviderCredentialDefinition;
  readonly baseURLEnvVars: readonly string[];
  readonly regionalEndpoint?: BuiltInProviderRegionalEndpointDefinition;
  /** Factory can authenticate without receiving an API-key-shaped value. */
  readonly supportsApiKeylessAuth: boolean;
  readonly onboarding: BuiltInProviderOnboardingInfo;
}

function providerDefinition<const T extends Omit<
  BuiltInProviderDefinition,
  "supportsApiKeylessAuth"
> & { readonly supportsApiKeylessAuth?: boolean }>(
  definition: T,
): T & { readonly supportsApiKeylessAuth: boolean } {
  return Object.freeze({
    ...definition,
    baseURLEnvVars: Object.freeze([...definition.baseURLEnvVars]),
    supportsApiKeylessAuth: definition.supportsApiKeylessAuth ?? false,
  }) as T & { readonly supportsApiKeylessAuth: boolean };
}

/** The only authored provider metadata table. All exported maps are views. */
export const BUILT_IN_PROVIDER_DEFINITIONS = Object.freeze({
  grok: providerDefinition({
    name: "xAI Grok",
    defaultModel: "grok-4.6",
    baseURL: "https://api.x.ai/v1",
    credentials: apiKeyCredentials(["XAI_API_KEY", "GROK_API_KEY"]),
    baseURLEnvVars: ["XAI_BASE_URL", "GROK_BASE_URL"],
    onboarding: onboardingInfo(10, "api-key"),
  }),
  openai: providerDefinition({
    name: "OpenAI", // branding-scan: allow real provider display name
    defaultModel: "gpt-5",
    baseURL: "https://api.openai.com/v1",
    credentials: apiKeyCredentials(["OPENAI_API_KEY"]),
    baseURLEnvVars: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
    supportsApiKeylessAuth: true,
    onboarding: onboardingInfo(20, "api-key"),
  }),
  anthropic: providerDefinition({
    name: "Anthropic", // branding-scan: allow real provider display name
    defaultModel: "claude-opus-4-7",
    baseURL: "https://api.anthropic.com/v1",
    credentials: apiKeyCredentials(["ANTHROPIC_API_KEY"]),
    baseURLEnvVars: ["ANTHROPIC_BASE_URL"],
    onboarding: onboardingInfo(30, "api-key"),
  }),
  ollama: providerDefinition({
    name: "Ollama",
    defaultModel: "llama3.3",
    baseURL: "http://localhost:11434",
    credentials: noCredentials(),
    baseURLEnvVars: ["OLLAMA_BASE_URL"],
    onboarding: onboardingInfo(40, "local"),
  }),
  lmstudio: providerDefinition({
    name: "LM Studio",
    defaultModel: "gpt-4o-mini",
    baseURL: "http://localhost:1234/v1",
    credentials: apiKeyCredentials(["LMSTUDIO_API_KEY"], false),
    baseURLEnvVars: ["LMSTUDIO_BASE_URL"],
    onboarding: onboardingInfo(50, "local"),
  }),
  "openai-compatible": providerDefinition({
    name: "OpenAI-compatible", // branding-scan: allow provider category display name
    defaultModel: "local-model",
    baseURL: "http://localhost:8000/v1",
    credentials: apiKeyCredentials(
      ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
      false,
    ),
    baseURLEnvVars: [
      "OPENAI_COMPATIBLE_BASE_URL",
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE",
    ],
    onboarding: onboardingInfo(60, "local"),
  }),
  openrouter: providerDefinition({
    name: "OpenRouter",
    defaultModel: "x-ai/grok-4.5",
    baseURL: "https://openrouter.ai/api/v1",
    credentials: apiKeyCredentials(["OPENROUTER_API_KEY"]),
    baseURLEnvVars: ["OPENROUTER_BASE_URL"],
    onboarding: onboardingInfo(70, "api-key", true),
  }),
  groq: providerDefinition({
    name: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    baseURL: "https://api.groq.com/openai/v1",
    credentials: apiKeyCredentials(["GROQ_API_KEY"]),
    baseURLEnvVars: ["GROQ_BASE_URL"],
    onboarding: onboardingInfo(80, "api-key"),
  }),
  deepseek: providerDefinition({
    name: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    baseURL: "https://api.deepseek.com/v1",
    credentials: apiKeyCredentials(["DEEPSEEK_API_KEY"]),
    baseURLEnvVars: ["DEEPSEEK_BASE_URL"],
    onboarding: onboardingInfo(90, "api-key"),
  }),
  gemini: providerDefinition({
    name: "Gemini",
    defaultModel: "gemini-2.5-pro",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    credentials: apiKeyCredentials(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
    baseURLEnvVars: ["GEMINI_BASE_URL"],
    supportsApiKeylessAuth: true,
    onboarding: onboardingInfo(100, "api-key"),
  }),
  mistral: providerDefinition({
    name: "Mistral",
    defaultModel: "mistral-medium-latest",
    baseURL: "https://api.mistral.ai/v1",
    credentials: apiKeyCredentials(["MISTRAL_API_KEY"]),
    baseURLEnvVars: ["MISTRAL_BASE_URL"],
    onboarding: onboardingInfo(110, "api-key"),
  }),
  "nvidia-nim": providerDefinition({
    name: "NVIDIA NIM",
    defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct",
    baseURL: "https://integrate.api.nvidia.com/v1",
    credentials: apiKeyCredentials(["NVIDIA_API_KEY"]),
    baseURLEnvVars: ["NVIDIA_BASE_URL"],
    onboarding: onboardingInfo(120, "api-key"),
  }),
  minimax: providerDefinition({
    name: "MiniMax",
    defaultModel: "MiniMax-M2.5",
    baseURL: "https://api.minimax.io/v1",
    credentials: apiKeyCredentials(["MINIMAX_API_KEY"]),
    baseURLEnvVars: ["MINIMAX_BASE_URL"],
    onboarding: onboardingInfo(130, "api-key"),
  }),
  github: providerDefinition({
    name: "GitHub Copilot",
    defaultModel: "gpt-4o",
    baseURL: "https://api.githubcopilot.com",
    credentials: apiKeyCredentials(["GITHUB_TOKEN", "GH_TOKEN"]),
    baseURLEnvVars: ["GITHUB_BASE_URL"],
    onboarding: onboardingInfo(140, "api-key"),
  }),
  "amazon-bedrock": providerDefinition({
    name: "Amazon Bedrock",
    defaultModel: "amazon.nova-pro-v1:0",
    baseURL: regionalEndpointBaseURL(
      AMAZON_BEDROCK_REGIONAL_ENDPOINT,
      AMAZON_BEDROCK_REGIONAL_ENDPOINT.defaultRegion,
    ),
    regionalEndpoint: AMAZON_BEDROCK_REGIONAL_ENDPOINT,
    credentials: awsSigV4Credentials({
      accessKeyIdEnvVars: ["AWS_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
      secretAccessKeyEnvVars: [
        "AWS_BEDROCK_SECRET_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY",
      ],
      sessionTokenEnvVars: [
        "AWS_BEDROCK_SESSION_TOKEN",
        "AWS_SESSION_TOKEN",
      ],
      regionEnvVars: [
        "AWS_BEDROCK_REGION",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
      ],
    }),
    baseURLEnvVars: ["AWS_BEDROCK_BASE_URL"],
    onboarding: onboardingInfo(150, "environment"),
  }),
  agenc: providerDefinition({
    name: "AgenC",
    defaultModel: "agenc",
    baseURL: "https://id.agenc.ag/v1",
    credentials: noCredentials(),
    baseURLEnvVars: ["AGENC_BASE_URL"],
    onboarding: onboardingInfo(160, "managed"),
  }),
} as const);

export type BuiltInProviderSlug = keyof typeof BUILT_IN_PROVIDER_DEFINITIONS;

function projectProviderStrings(
  field: "defaultModel" | "baseURL",
): Readonly<Record<BuiltInProviderSlug, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(BUILT_IN_PROVIDER_DEFINITIONS).map(
        ([provider, definition]) => [provider, definition[field]],
      ),
    ),
  ) as Readonly<Record<BuiltInProviderSlug, string>>;
}

/** Read-only compatibility views, mechanically derived from the registry. */
export const BUILT_IN_PROVIDER_DEFAULT_MODELS =
  projectProviderStrings("defaultModel");
export const BUILT_IN_PROVIDER_BASE_URLS = projectProviderStrings("baseURL");

export const BUILT_IN_PROVIDER_MODEL_CATALOG: Readonly<
  Record<BuiltInProviderSlug, readonly string[]>
> = Object.freeze({
  // grok is fully covered by REGISTERED_MODEL_CATALOG: derived directly.
  grok: mergeDerivedProviderModels("grok"),
  // openai is registry-derived (gpt-5, the provider default, now leads from the
  // registry via its lowest priority) plus o3, which still lives only as a bare
  // string and trails the registry entries, matching the prior literal's tail.
  openai: mergeDerivedProviderModels("openai", {
    trailingExtras: ["o3"],
  }),
  anthropic: Object.freeze([
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
  ]),
  ollama: Object.freeze(["llama3.3"]),
  lmstudio: Object.freeze(["gpt-4o-mini"]),
  "openai-compatible": Object.freeze(["local-model"]),
  openrouter: Object.freeze([
    "x-ai/grok-4.5",
    "x-ai/grok-4.3",
    "x-ai/grok-build-0.1",
    "x-ai/grok-4.20",
    "openai/gpt-5",
    "openai/gpt-4o-mini",
    "openai/gpt-5-nano",
    "openai/gpt-4.1-nano",
    "openai/gpt-oss-120b",
    "anthropic/claude-haiku-4.5",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v3.2",
    "qwen/qwen3-coder-30b-a3b-instruct",
    "qwen/qwen3-235b-a22b-2507",
    "mistralai/mistral-small-3.2-24b-instruct",
    "meta-llama/llama-3.3-70b-instruct",
    "meta-llama/llama-4-scout",
    "minimax/minimax-m2.5",
    "z-ai/glm-4.7-flash",
    ...OPENROUTER_FREE_MODEL_IDS,
  ]),
  // mixtral-8x7b-32768 was shut down by groq on 2025-03-20 (deprecations
  // page); listing it produced guaranteed-dead sessions.
  groq: Object.freeze([
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
  ]),
  deepseek: Object.freeze(["deepseek-v4-flash", "deepseek-v4-pro"]),
  gemini: Object.freeze(["gemini-2.5-pro"]),
  mistral: Object.freeze(["mistral-medium-latest"]),
  "nvidia-nim": Object.freeze([
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "meta/llama-3.1-8b-instruct",
  ]),
  minimax: Object.freeze(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5"]),
  // `gpt-5.4` is registry-owned by openai (REGISTERED_MODEL_CATALOG,
  // visibility: "list") and surfaces under openai via deriveFlatCatalog. Listing
  // the bare alias here too made the slug match two providers and threw
  // AmbiguousModelError on bare-slug selection (startup abort / silent /model
  // provider drop). github copilot proxies it under a github-qualified name.
  github: Object.freeze(["gpt-4o", "github:copilot"]),
  "amazon-bedrock": Object.freeze([
    "amazon.nova-pro-v1:0",
    "amazon.nova-lite-v1:0",
    "amazon.nova-micro-v1:0",
  ]),
  agenc: Object.freeze(["agenc"]),
});

export interface BuiltInProviderInfo {
  readonly id: BuiltInProviderSlug;
  readonly name: string;
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly credentials: ProviderCredentialDefinition;
  readonly baseURLEnvVars: readonly string[];
  readonly supportsApiKeylessAuth: boolean;
  readonly requiresManagedAuth: boolean;
  readonly onboarding: BuiltInProviderOnboardingInfo;
}

const BUILT_IN_PROVIDER_IDS = Object.freeze(
  Object.keys(BUILT_IN_PROVIDER_DEFINITIONS) as BuiltInProviderSlug[],
);

export function builtInProviderIds(): readonly BuiltInProviderSlug[] {
  return BUILT_IN_PROVIDER_IDS;
}

export function resolveBuiltInProviderInfo(
  provider: string | undefined,
): BuiltInProviderInfo | undefined {
  const id = resolveBuiltInProviderSlug(provider);
  if (id === undefined) return undefined;
  const definition = BUILT_IN_PROVIDER_DEFINITIONS[id];
  return {
    id,
    name: definition.name,
    baseURL: definition.baseURL,
    defaultModel: definition.defaultModel,
    credentials: definition.credentials,
    baseURLEnvVars: definition.baseURLEnvVars,
    supportsApiKeylessAuth: definition.supportsApiKeylessAuth,
    requiresManagedAuth: definition.onboarding.access === "managed",
    onboarding: definition.onboarding,
  };
}

/** Resolve a registry-owned regional endpoint and its effective region. */
export function resolveBuiltInProviderRegionalEndpoint(
  provider: string | undefined,
  region?: string,
): ResolvedBuiltInProviderRegionalEndpoint | undefined {
  const id = resolveBuiltInProviderSlug(provider);
  if (id === undefined) return undefined;
  const definition = BUILT_IN_PROVIDER_DEFINITIONS[id];
  if (!("regionalEndpoint" in definition)) return undefined;
  const endpoint = definition.regionalEndpoint;
  const normalizedRegion = region?.trim() || endpoint.defaultRegion;
  return Object.freeze({
    region: normalizedRegion,
    baseURL: regionalEndpointBaseURL(endpoint, normalizedRegion),
  });
}

export function listBuiltInProviderInfo(): readonly BuiltInProviderInfo[] {
  return Object.freeze(
    builtInProviderIds().map((id) => resolveBuiltInProviderInfo(id)!),
  );
}

export function providerApiKeyEnvironmentLabel(
  provider: string,
): string | undefined {
  const credentials = resolveBuiltInProviderInfo(provider)?.credentials;
  return credentials?.kind === "api-key"
    ? providerCredentialFieldEnvironmentLabel(credentials.apiKey)
    : undefined;
}

export function providerCredentialFieldEnvironmentLabel(
  field: ProviderCredentialFieldDefinition,
): string {
  return field.envVars.join(" or ");
}

export function providerCredentialEnvironmentLabel(
  provider: string,
): string | undefined {
  const credentials = resolveBuiltInProviderInfo(provider)?.credentials;
  if (credentials === undefined || credentials.kind === "none") {
    return undefined;
  }
  if (credentials.kind === "api-key") {
    return providerCredentialFieldEnvironmentLabel(credentials.apiKey);
  }
  return [credentials.accessKeyId, credentials.secretAccessKey]
    .filter((field) => field.required)
    .map(providerCredentialFieldEnvironmentLabel)
    .join(" and ");
}

export function resolveBuiltInProviderSlug(
  provider: string | undefined,
): BuiltInProviderSlug | undefined {
  const normalized = normalizeProviderIdentity(provider, "provider registry");
  if (!normalized) return undefined;
  return normalized in BUILT_IN_PROVIDER_DEFINITIONS
    ? (normalized as BuiltInProviderSlug)
    : undefined;
}
