import {
  resolveDocumentedXaiModel,
} from "./grok/xai-strict-filter.js";

export interface ProviderModelCapabilities {
  readonly provider: string;
  readonly model: string;
  readonly acceptsImageHistory: boolean;
  readonly acceptsAudioHistory: boolean;
  readonly acceptsThinkingHistory: boolean;
  readonly acceptsReasoningEffort: boolean;
}

export function normalizeProviderSlug(provider: string | undefined): string {
  const normalized = provider?.trim().toLowerCase() ?? "";
  if (normalized === "xai") {
    return "grok";
  }
  return normalized;
}

interface ProviderCapabilityDefinition {
  readonly acceptsImageHistory: boolean | ((model: string) => boolean);
  readonly acceptsAudioHistory: boolean | ((model: string) => boolean);
  readonly acceptsThinkingHistory: boolean | ((model: string) => boolean);
  readonly acceptsReasoningEffort: boolean | ((model: string) => boolean);
}

function isVisionishOllamaModel(model: string): boolean {
  return /(?:llava|bakllava|vision|(?:^|[-_.:])vl(?:$|[-_.:])|qwen(?:2\.?5)?-vl|minicpm-v|moondream|llama3(?:\.2)?-vision|gemma3)/i.test(
    model,
  );
}

function resolveCapabilityFlag(
  value:
    | ProviderCapabilityDefinition["acceptsImageHistory"]
    | ProviderCapabilityDefinition["acceptsAudioHistory"]
    | ProviderCapabilityDefinition["acceptsThinkingHistory"]
    | ProviderCapabilityDefinition["acceptsReasoningEffort"],
  model: string,
): boolean {
  return typeof value === "function" ? value(model) : value;
}

function buildCapabilities(
  provider: string,
  model: string,
  definition: ProviderCapabilityDefinition,
): ProviderModelCapabilities {
  const trimmedModel = model.trim();
  return {
    provider,
    model: trimmedModel,
    acceptsImageHistory: resolveCapabilityFlag(
      definition.acceptsImageHistory,
      trimmedModel,
    ),
    acceptsAudioHistory: resolveCapabilityFlag(
      definition.acceptsAudioHistory,
      trimmedModel,
    ),
    acceptsThinkingHistory: resolveCapabilityFlag(
      definition.acceptsThinkingHistory,
      trimmedModel,
    ),
    acceptsReasoningEffort: resolveCapabilityFlag(
      definition.acceptsReasoningEffort,
      trimmedModel,
    ),
  };
}

function resolveGrokImageHistory(model: string): boolean {
  const canonicalModel = resolveDocumentedXaiModel(model.trim());
  if (canonicalModel === null) {
    return false;
  }
  // AgenC's Grok adapter auto-routes image-bearing turns through the
  // configured vision model when needed, but the imagine-* family is an
  // image/video output surface rather than normal text chat history.
  return !canonicalModel.startsWith("grok-imagine");
}

function resolveGrokReasoningEffort(model: string): boolean {
  void model;
  return false;
}

function matchesModelFamily(model: string, pattern: RegExp): boolean {
  return pattern.test(model.trim().toLowerCase());
}

function isOpenAIReasoningModel(model: string): boolean {
  return matchesModelFamily(
    model,
    /(?:^|[/:])(?:gpt-5|o1|o3|o4|codex|chatgpt-5)(?:$|[-_.:])/,
  );
}

function isDeepSeekThinkingModel(model: string): boolean {
  return matchesModelFamily(
    model,
    /(?:^|[/:])deepseek-reasoner(?:$|[-_.:])/,
  );
}

function isGeminiThinkingModel(model: string): boolean {
  return matchesModelFamily(model, /(?:^|[/:])gemini-2\.5(?:$|[-_.:])/);
}

const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilityDefinition>> = {
  grok: {
    acceptsImageHistory: resolveGrokImageHistory,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: resolveGrokReasoningEffort,
  },
  anthropic: {
    acceptsImageHistory: true,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: true,
    acceptsReasoningEffort: false,
  },
  ollama: {
    // Ollama can preserve image turns only when the selected local model is
    // vision-capable; the runtime does not have a catalog lookup at switch time.
    acceptsImageHistory: isVisionishOllamaModel,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  openai: {
    acceptsImageHistory: true,
    acceptsAudioHistory: true,
    acceptsThinkingHistory: isOpenAIReasoningModel,
    acceptsReasoningEffort: isOpenAIReasoningModel,
  },
  openrouter: {
    // Routed upstreams vary by model/provider and the runtime does not have a
    // catalog handshake here, so model-switch checks must fail closed.
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  groq: {
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  deepseek: {
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: isDeepSeekThinkingModel,
    acceptsReasoningEffort: false,
  },
  gemini: {
    acceptsImageHistory: true,
    acceptsAudioHistory: true,
    acceptsThinkingHistory: isGeminiThinkingModel,
    acceptsReasoningEffort: false,
  },
  lmstudio: {
    // LM Studio is model-dependent, so use the same local-model heuristic as
    // Ollama instead of claiming universal multimodal support.
    acceptsImageHistory: isVisionishOllamaModel,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
};

function buildDefaultCapabilities(
  provider: string,
  model: string,
): ProviderModelCapabilities {
  return {
    provider,
    model,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  };
}

export function resolveProviderModelCapabilities(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
}): ProviderModelCapabilities {
  const provider = normalizeProviderSlug(input.provider);
  const model = input.model?.trim() ?? "";
  const definition = PROVIDER_CAPABILITIES[provider];

  if (definition) {
    return buildCapabilities(provider, model, definition);
  }
  return buildDefaultCapabilities(provider, model);
}
