/**
 * Ports upstream runtime provider defaults onto AgenC provider identities.
 *
 * Shape difference from upstream:
 *   - AgenC keeps provider auth in `AuthBackend`/BYOK config, so this registry
 *     stores request/catalog metadata only.
 */

import { deriveFlatCatalog } from "./model-catalog.js";
import { OPENROUTER_FREE_MODEL_IDS } from "./openrouter-free-models.js";

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

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_MAX_RETRIES = 5;
const DEFAULT_REQUEST_MAX_RETRIES = 4;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

export const BUILT_IN_PROVIDER_DEFAULT_MODELS = Object.freeze({
  grok: "grok-4.5",
  openai: "gpt-5",
  anthropic: "claude-opus-4-7",
  ollama: "llama3.3",
  lmstudio: "gpt-4o-mini",
  "openai-compatible": "local-model",
  openrouter: "x-ai/grok-4.5",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-reasoner",
  gemini: "gemini-2.5-pro",
  mistral: "devstral-latest",
  "nvidia-nim": "nvidia/llama-3.1-nemotron-70b-instruct",
  minimax: "MiniMax-M2.5",
  github: "gpt-4o",
  "amazon-bedrock": "amazon.nova-pro-v1:0",
  agenc: "agenc",
} as const);

export type BuiltInProviderSlug = keyof typeof BUILT_IN_PROVIDER_DEFAULT_MODELS;

export const BUILT_IN_PROVIDER_BASE_URLS = Object.freeze({
  grok: "https://api.x.ai/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
  "openai-compatible": "http://localhost:8000/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  mistral: "https://api.mistral.ai/v1",
  "nvidia-nim": "https://integrate.api.nvidia.com/v1",
  minimax: "https://api.minimax.io/v1",
  github: "https://api.githubcopilot.com",
  "amazon-bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
  agenc: "https://id.agenc.ag/v1",
} as const satisfies Readonly<Record<BuiltInProviderSlug, string>>);

export const BUILT_IN_PROVIDER_SCOPE_OMISSIONS = Object.freeze({} as const);

export const BUILT_IN_PROVIDER_API_KEY_ENVS: Readonly<
  Partial<Record<BuiltInProviderSlug, string>>
> = Object.freeze({
  grok: "XAI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  lmstudio: "LMSTUDIO_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  "nvidia-nim": "NVIDIA_API_KEY",
  minimax: "MINIMAX_API_KEY",
  github: "GITHUB_TOKEN",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
});

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
    "deepseek/deepseek-chat",
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
  groq: Object.freeze([
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
  ]),
  deepseek: Object.freeze(["deepseek-reasoner"]),
  gemini: Object.freeze(["gemini-2.5-pro"]),
  mistral: Object.freeze(["devstral-latest", "mistral-medium-latest"]),
  "nvidia-nim": Object.freeze([
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "meta/llama-3.1-8b-instruct",
  ]),
  minimax: Object.freeze(["MiniMax-M2.5", "MiniMax-M2.7"]),
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
  readonly apiKeyEnvVar?: string;
  readonly requestMaxRetries: number;
  readonly streamMaxRetries: number;
  readonly streamIdleTimeoutMs: number;
  readonly websocketConnectTimeoutMs: number;
  readonly supportsWebsockets: boolean;
  readonly requiresManagedAuth: boolean;
}

const PROVIDER_DISPLAY_NAMES: Readonly<Record<BuiltInProviderSlug, string>> =
  Object.freeze({
    grok: "xAI Grok",
    openai: "OpenAI", // branding-scan: allow real provider display name
    anthropic: "Anthropic", // branding-scan: allow real provider display name
    ollama: "Ollama",
    lmstudio: "LM Studio",
    "openai-compatible": "OpenAI-compatible", // branding-scan: allow provider category display name
    openrouter: "OpenRouter",
    groq: "Groq",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    mistral: "Mistral",
    "nvidia-nim": "NVIDIA NIM",
    minimax: "MiniMax",
    github: "GitHub Copilot",
    "amazon-bedrock": "Amazon Bedrock",
    agenc: "AgenC",
  });

export function builtInProviderIds(): readonly BuiltInProviderSlug[] {
  return Object.freeze(
    Object.keys(BUILT_IN_PROVIDER_DEFAULT_MODELS) as BuiltInProviderSlug[],
  );
}

export function resolveBuiltInProviderInfo(
  provider: string | undefined,
): BuiltInProviderInfo | undefined {
  const id = normalizeBuiltInProviderSlug(provider);
  if (id === undefined) return undefined;
  return {
    id,
    name: PROVIDER_DISPLAY_NAMES[id],
    baseURL: BUILT_IN_PROVIDER_BASE_URLS[id],
    defaultModel: BUILT_IN_PROVIDER_DEFAULT_MODELS[id],
    ...(BUILT_IN_PROVIDER_API_KEY_ENVS[id] !== undefined
      ? { apiKeyEnvVar: BUILT_IN_PROVIDER_API_KEY_ENVS[id] }
      : {}),
    requestMaxRetries: DEFAULT_REQUEST_MAX_RETRIES,
    streamMaxRetries: DEFAULT_STREAM_MAX_RETRIES,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    websocketConnectTimeoutMs: DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
    supportsWebsockets: id === "openai",
    requiresManagedAuth: id === "agenc",
  };
}

export function listBuiltInProviderInfo(): readonly BuiltInProviderInfo[] {
  return Object.freeze(
    builtInProviderIds().map((id) => resolveBuiltInProviderInfo(id)!),
  );
}

export function normalizeBuiltInProviderSlug(
  provider: string | undefined,
): BuiltInProviderSlug | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return undefined;
  const slug = normalized === "xai"
    ? "grok"
    : normalized === "custom" || normalized === "openai_compatible"
      ? "openai-compatible"
      : normalized;
  return slug in BUILT_IN_PROVIDER_DEFAULT_MODELS
    ? (slug as BuiltInProviderSlug)
    : undefined;
}
