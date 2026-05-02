/**
 * Ports upstream runtime provider defaults onto AgenC provider identities.
 *
 * Shape difference from upstream:
 *   - AgenC keeps provider auth in `AuthBackend`/BYOK config, so this registry
 *     stores request/catalog metadata only.
 */

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_STREAM_MAX_RETRIES = 5;
export const DEFAULT_REQUEST_MAX_RETRIES = 4;
export const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

export const BUILT_IN_PROVIDER_DEFAULT_MODELS = Object.freeze({
  grok: "grok-4-fast",
  openai: "gpt-5",
  anthropic: "claude-opus-4-7",
  ollama: "llama3.3",
  lmstudio: "gpt-4o-mini",
  "openai-compatible": "local-model",
  openrouter: "openai/gpt-5",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-reasoner",
  gemini: "gemini-2.5-pro",
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
  agenc: "https://api.agenc.tech/v1",
} as const satisfies Readonly<Record<BuiltInProviderSlug, string>>);

export const BUILT_IN_PROVIDER_SCOPE_OMISSIONS = Object.freeze({
  "amazon-bedrock":
    "AgenC does not expose an AWS SigV4 Amazon Bedrock runtime provider yet.",
} as const);

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
});

export const BUILT_IN_PROVIDER_MODEL_CATALOG: Readonly<
  Record<BuiltInProviderSlug, readonly string[]>
> = Object.freeze({
  grok: Object.freeze([
    "grok-4-fast",
    "grok-4",
    "grok-3",
    "grok-2",
    "grok-2-mini",
    "grok-beta",
    "grok-code-fast-1",
  ]),
  openai: Object.freeze([
    "gpt-5",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
    "gpt-5.2",
    "codex-auto-review", // branding-scan: allow OpenAI model identifier
    "o3",
  ]),
  anthropic: Object.freeze(["claude-opus-4-7"]),
  ollama: Object.freeze(["llama3.3"]),
  lmstudio: Object.freeze(["gpt-4o-mini"]),
  "openai-compatible": Object.freeze(["local-model"]),
  openrouter: Object.freeze([
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "x-ai/grok-code-fast-1",
  ]),
  groq: Object.freeze([
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
  ]),
  deepseek: Object.freeze(["deepseek-reasoner"]),
  gemini: Object.freeze(["gemini-2.5-pro"]),
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
    openai: "OpenAI",
    anthropic: "Anthropic",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    "openai-compatible": "OpenAI-compatible",
    openrouter: "OpenRouter",
    groq: "Groq",
    deepseek: "DeepSeek",
    gemini: "Gemini",
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
