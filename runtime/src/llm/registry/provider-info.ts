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

export const GEMINI_DEVELOPER_NATIVE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

export const GITHUB_COPILOT_MODEL_PREFIX = "github:copilot:";

const GITHUB_COPILOT_MODEL_IDS = Object.freeze([
  "gpt-5-mini",
  "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-fable-5",
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-opus-5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "mai-code-1-flash-picker",
  "mai-code-1.1-flash",
  "raptor-mini",
  "kimi-k2.7-code",
  "kimi-k3",
  "grok-4.5",
  "grok-4.6",
] as const);

const GITHUB_COPILOT_CATALOG_MODELS = Object.freeze(
  GITHUB_COPILOT_MODEL_IDS.map(
    (model) => `${GITHUB_COPILOT_MODEL_PREFIX}${model}`,
  ),
);

const NVIDIA_PROVIDER_MODEL_IDS = Object.freeze([
  "nvidia/cosmos-reason2-8b",
  "microsoft/phi-4-mini-flash-reasoning",
  "qwen/qwen3-next-80b-a3b-thinking",
  "deepseek-ai/deepseek-r1-distill-qwen-32b",
  "deepseek-ai/deepseek-r1-distill-qwen-14b",
  "deepseek-ai/deepseek-r1-distill-qwen-7b",
  "deepseek-ai/deepseek-r1-distill-llama-8b",
  "qwen/qwq-32b",
  "meta/codellama-70b",
  "bigcode/starcoder2-15b",
  "bigcode/starcoder2-7b",
  "mistralai/codestral-22b-instruct-v0.1",
  "mistralai/mamba-codestral-7b-v0.1",
  "deepseek-ai/deepseek-coder-6.7b-instruct",
  "google/codegemma-7b",
  "google/codegemma-1.1-7b",
  "qwen/qwen2.5-coder-32b-instruct",
  "qwen/qwen2.5-coder-7b-instruct",
  "qwen/qwen3-coder-480b-a35b-instruct",
  "ibm/granite-34b-code-instruct",
  "ibm/granite-8b-code-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.1-nemotron-51b-instruct",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-mini-4b-instruct",
  "nvidia/llama-3.1-nemotron-nano-8b-v1",
  "nvidia/llama-3.1-nemotron-nano-4b-v1.1",
  "nvidia/llama3-chatqa-1.5-70b",
  "nvidia/llama3-chatqa-1.5-8b",
  "meta/llama-3.1-405b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.2-90b-vision-instruct",
  "meta/llama-3.2-11b-vision-instruct",
  "meta/llama-3.2-3b-instruct",
  "meta/llama-3.2-1b-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "meta/llama-4-scout-17b-16e-instruct",
  "google/gemma-4-31b-it",
  "google/gemma-3-27b-it",
  "google/gemma-3-12b-it",
  "google/gemma-3-4b-it",
  "google/gemma-3-1b-it",
  "google/gemma-3n-e4b-it",
  "google/gemma-3n-e2b-it",
  "google/gemma-2-27b-it",
  "google/gemma-2-9b-it",
  "google/gemma-2-2b-it",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "mistralai/mistral-large-2-instruct",
  "mistralai/mistral-large",
  "mistralai/mistral-medium-3-instruct",
  "mistralai/mistral-small-4-119b-2603",
  "mistralai/mistral-small-3.1-24b-instruct-2503",
  "mistralai/mistral-small-24b-instruct",
  "mistralai/mistral-7b-instruct-v0.3",
  "mistralai/mistral-7b-instruct-v0.2",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "mistralai/mixtral-8x7b-instruct-v0.1",
  "mistralai/mistral-nemotron",
  "mistralai/ministral-14b-instruct-2512",
  "mistralai/devstral-2-123b-instruct-2512",
  "mistralai/magistral-small-2506",
  "mistralai/mathstral-7b-v0.1",
  "microsoft/phi-4-multimodal-instruct",
  "microsoft/phi-4-mini-instruct",
  "microsoft/phi-3.5-mini-instruct",
  "microsoft/phi-3-small-128k-instruct",
  "microsoft/phi-3-small-8k-instruct",
  "microsoft/phi-3-medium-128k-instruct",
  "microsoft/phi-3-medium-4k-instruct",
  "microsoft/phi-3-mini-128k-instruct",
  "microsoft/phi-3-mini-4k-instruct",
  "qwen/qwen3.5-397b-a17b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3-next-80b-a3b-instruct",
  "qwen/qwen2.5-7b-instruct",
  "qwen/qwen2-7b-instruct",
  "qwen/qwen3-32b",
  "qwen/qwen3-8b",
  "deepseek-ai/deepseek-r1",
  "deepseek-ai/deepseek-v3",
  "deepseek-ai/deepseek-v3.2",
  "deepseek-ai/deepseek-v3.1-terminus",
  "deepseek-ai/deepseek-v3.1",
  "ibm/granite-3.3-8b-instruct",
  "ibm/granite-3.0-8b-instruct",
  "ibm/granite-3.0-3b-a800m-instruct",
  "databricks/dbrx-instruct",
  "01-ai/yi-large",
  "ai21labs/jamba-1.5-large-instruct",
  "ai21labs/jamba-1.5-mini-instruct",
  "writer/palmyra-creative-122b",
  "writer/palmyra-fin-70b-32k",
  "writer/palmyra-med-70b",
  "writer/palmyra-med-70b-32k",
  "z-ai/glm5",
  "z-ai/glm4.7",
  "minimaxai/minimax-m2.5",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2.5-thinking",
  "moonshotai/kimi-k2-instruct-0905",
] as const);

const MINIMAX_MODEL_IDS = Object.freeze([
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2",
  "MiniMax-M2.1",
  "MiniMax-M2.5",
  "MiniMax-Text-01",
  "MiniMax-Text-01-Preview",
  "MiniMax-Vision-01",
  "MiniMax-Vision-01-Fast",
] as const);

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
    baseURL: GEMINI_DEVELOPER_NATIVE_BASE_URL,
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
    defaultModel: "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
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

const DEFAULT_BUILT_IN_PROVIDER_SLUG = "grok" as const;

/** The one built-in provider/model pair used when no selection was supplied. */
export const DEFAULT_BUILT_IN_PROVIDER_SELECTION = Object.freeze({
  provider: DEFAULT_BUILT_IN_PROVIDER_SLUG,
  model:
    BUILT_IN_PROVIDER_DEFINITIONS[DEFAULT_BUILT_IN_PROVIDER_SLUG].defaultModel,
});

/** Project a globally collision-safe catalog value into its provider-local ID. */
export function providerLocalModelIdFromCatalog(
  provider: BuiltInProviderSlug,
  model: string,
): string {
  const trimmed = model.trim();
  if (provider === "github") {
    const normalized = trimmed.toLowerCase();
    if (normalized === "github:copilot" || normalized === "copilot") {
      return BUILT_IN_PROVIDER_DEFINITIONS.github.defaultModel;
    }
    if (normalized.startsWith(GITHUB_COPILOT_MODEL_PREFIX)) {
      return trimmed.slice(GITHUB_COPILOT_MODEL_PREFIX.length).trim();
    }
    if (normalized.startsWith("copilot:")) {
      return trimmed.slice("copilot:".length).trim();
    }
    if (normalized.startsWith("github:")) {
      return trimmed.slice("github:".length).trim();
    }
    return trimmed;
  }
  return model;
}

/** Project a provider-local model into its collision-safe catalog spelling. */
export function providerCatalogModelId(
  provider: BuiltInProviderSlug,
  model: string,
): string {
  const localModel = providerLocalModelIdFromCatalog(provider, model);
  if (provider !== "github") return localModel;
  return `${GITHUB_COPILOT_MODEL_PREFIX}${localModel}`;
}

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
  "nvidia-nim": NVIDIA_PROVIDER_MODEL_IDS,
  minimax: MINIMAX_MODEL_IDS,
  // Copilot proxies models owned by several providers. Keep those entries
  // qualified here so bare slugs such as gpt-5.4 retain one global owner.
  github: GITHUB_COPILOT_CATALOG_MODELS,
  "amazon-bedrock": Object.freeze([
    "amazon.nova-pro-v1:0",
    "amazon.nova-lite-v1:0",
    "amazon.nova-micro-v1:0",
  ]),
  agenc: Object.freeze(["agenc"]),
});

/**
 * Return every catalog spelling for one provider-local model. The local ID is
 * always first; collision-safe compatibility spellings follow without
 * becoming additional runtime state representations.
 */
export function providerModelCatalogIdentifiers(
  provider: BuiltInProviderSlug,
  model: string,
): readonly string[] {
  const localModel = providerLocalModelIdFromCatalog(provider, model);
  const identifiers = [localModel];
  for (const candidate of BUILT_IN_PROVIDER_MODEL_CATALOG[provider]) {
    if (
      providerLocalModelIdFromCatalog(provider, candidate) === localModel &&
      !identifiers.includes(candidate)
    ) {
      identifiers.push(candidate);
    }
  }
  if (provider === "github") {
    const qualifiedModel = `${GITHUB_COPILOT_MODEL_PREFIX}${localModel}`;
    if (!identifiers.includes(qualifiedModel)) {
      identifiers.push(qualifiedModel);
    }
    if (localModel === BUILT_IN_PROVIDER_DEFINITIONS.github.defaultModel) {
      identifiers.push("github:copilot", "copilot");
    }
  }
  return Object.freeze(identifiers);
}

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
