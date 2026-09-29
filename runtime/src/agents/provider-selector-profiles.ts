import type { ChildTaskKind } from "./provider-selector-types.js";

/** Change when routing priors change, so incompatible observations are not mixed. */
export const CHILD_ROUTING_PROFILE_REVISION = "child-routing-v1";

export interface ChildModelProfile {
  readonly quality: Readonly<Record<ChildTaskKind, number>>;
  readonly latencyMs: number;
}

// These are conservative cold-start policy priors, not measured performance.
// Transport capabilities and prices always come from the canonical registry.
const COMPACT: ChildModelProfile = Object.freeze({
  quality: Object.freeze({ extraction: 0.92, review: 0.79, coding: 0.76, reasoning: 0.72, research: 0.78, general: 0.83 }),
  latencyMs: 8_000,
});
const BALANCED: ChildModelProfile = Object.freeze({
  quality: Object.freeze({ extraction: 0.96, review: 0.88, coding: 0.86, reasoning: 0.84, research: 0.87, general: 0.89 }),
  latencyMs: 18_000,
});
const STRONG: ChildModelProfile = Object.freeze({
  quality: Object.freeze({ extraction: 0.98, review: 0.95, coding: 0.95, reasoning: 0.96, research: 0.94, general: 0.95 }),
  latencyMs: 40_000,
});
const QWEN = Object.freeze({ "qwen3.8-max": STRONG, "qwen3.8-flash": BALANCED,
  "qwen3.7-max": STRONG, "qwen3.7-plus": BALANCED, "qwen3.7-flash": BALANCED,
  "qwen3-coder-plus": BALANCED, "qwen3-coder-next": BALANCED });
const ZAI = Object.freeze({ "glm-5.3": STRONG, "glm-5.3-flash": BALANCED });

/** Explicitly maintained identities. Unknown and misleading names do not infer strength. */
const PROFILES: Readonly<Record<string, Readonly<Record<string, ChildModelProfile>>>> = Object.freeze({
  deepseek: Object.freeze({
    "deepseek-flash": BALANCED,
    "deepseek-v4-flash": BALANCED,
    "deepseek-v4-flash-vision-exp": BALANCED,
    "deepseek-v4-pro": STRONG,
  }),
  openai: Object.freeze({
    "gpt-6-luna": COMPACT, "gpt-6-sol": BALANCED, "gpt-6-astra": STRONG,
    "gpt-5.6-luna": COMPACT, "gpt-5.6-terra": BALANCED, "gpt-5.6-sol": STRONG,
    "gpt-5.4-nano": COMPACT, "gpt-5.4-mini": BALANCED,
    "gpt-5.4": BALANCED, "gpt-5.4-pro": STRONG,
    "gpt-5.5": STRONG, "gpt-5.5-pro": STRONG,
    "gpt-5.3-codex": STRONG,
  }),
  anthropic: Object.freeze({
    "claude-haiku-4-5": COMPACT, "claude-sonnet-4-6": BALANCED,
    "claude-opus-4-6": STRONG, "claude-opus-4-7": STRONG,
    "claude-opus-4-8": STRONG,
    "claude-sonnet-5": BALANCED, "claude-opus-5": STRONG, "claude-opus-5-5": STRONG,
  }),
  grok: Object.freeze({ "grok-4.6": BALANCED, "grok-4.7": STRONG, "grok-4-1-fast-reasoning": BALANCED }),
  gemini: Object.freeze({
    "gemini-2.5-flash": COMPACT, "gemini-2.5-pro": BALANCED,
    "gemini-3-flash-preview": BALANCED, "gemini-3-pro-preview": STRONG,
    "gemini-3.1-pro-preview": STRONG,
    "gemini-3.8-flash": BALANCED, "gemini-3.7-flash": BALANCED, "gemini-3.6-flash": BALANCED,
    "gemini-3.5-flash": BALANCED, "gemini-3.5-flash-lite": COMPACT, "gemini-3.1-flash-lite": COMPACT,
  }),
  qwen: QWEN,
  "qwen-token-plan": QWEN,
  kimi: Object.freeze({ "kimi-k3": STRONG, "kimi-k2.7-code": BALANCED }),
  zai: ZAI,
  "zai-coding-plan": ZAI,
  minimax: Object.freeze({ "MiniMax-M3": BALANCED }),
  mistral: Object.freeze({ "mistral-medium-latest": BALANCED }),
  groq: Object.freeze({ "llama-3.3-70b-versatile": BALANCED, "llama-3.1-8b-instant": COMPACT }),
  cerebras: Object.freeze({ "gpt-oss-120b": BALANCED, "qwen-3.8-27b": BALANCED, "gemma-4-31b": BALANCED }),
  meta: Object.freeze({ "muse-spark-1.3": STRONG, "muse-spark-1.3-contributor": BALANCED,
    "muse-spark-1.2": BALANCED, "muse-spark-1.2-contributor": BALANCED }),
});

export function childModelProfile(provider: string, model: string): ChildModelProfile | undefined {
  if (!Object.hasOwn(PROFILES, provider)) return undefined;
  const models = PROFILES[provider];
  // Unknown names, prototype properties and unlisted dated snapshots do not
  // acquire a quality prior from a substring or a JavaScript object property.
  return models !== undefined && Object.hasOwn(models, model) ? models[model] : undefined;
}
