import {
  resolveDocumentedXaiModel,
} from "./grok/xai-strict-filter.js";

export interface ProviderModelCapabilities {
  readonly provider: string;
  readonly model: string;
  readonly supportsPromptCaching: boolean;
  readonly supportsContextEdits: boolean;
  readonly supportsImageInput: boolean;
  readonly supportsAudioInput: boolean;
  readonly supportsAudioOutput: boolean;
  readonly supportsExtendedThinking: boolean;
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
  readonly supportsPromptCaching: boolean | ((model: string) => boolean);
  readonly supportsContextEdits: boolean | ((model: string) => boolean);
  readonly supportsImageInput: boolean | ((model: string) => boolean);
  readonly supportsAudioInput: boolean | ((model: string) => boolean);
  readonly supportsAudioOutput: boolean | ((model: string) => boolean);
  readonly supportsExtendedThinking: boolean | ((model: string) => boolean);
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
    | ProviderCapabilityDefinition["supportsPromptCaching"]
    | ProviderCapabilityDefinition["supportsContextEdits"]
    | ProviderCapabilityDefinition["supportsImageInput"]
    | ProviderCapabilityDefinition["supportsAudioInput"]
    | ProviderCapabilityDefinition["supportsAudioOutput"]
    | ProviderCapabilityDefinition["supportsExtendedThinking"]
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
    supportsPromptCaching: resolveCapabilityFlag(
      definition.supportsPromptCaching,
      trimmedModel,
    ),
    supportsContextEdits: resolveCapabilityFlag(
      definition.supportsContextEdits,
      trimmedModel,
    ),
    supportsImageInput: resolveCapabilityFlag(
      definition.supportsImageInput,
      trimmedModel,
    ),
    supportsAudioInput: resolveCapabilityFlag(
      definition.supportsAudioInput,
      trimmedModel,
    ),
    supportsAudioOutput: resolveCapabilityFlag(
      definition.supportsAudioOutput,
      trimmedModel,
    ),
    supportsExtendedThinking: resolveCapabilityFlag(
      definition.supportsExtendedThinking,
      trimmedModel,
    ),
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

function isOpenAIAudioInputModel(model: string): boolean {
  return matchesModelFamily(
    model,
    /(?:^|[/:])(?:gpt-audio|gpt-4o(?:-mini)?-audio-preview|gpt-4o(?:-mini)?-transcribe(?:-diarize)?)(?:$|[-_.:])/,
  );
}

function isOpenAIAudioOutputModel(model: string): boolean {
  return matchesModelFamily(
    model,
    /(?:^|[/:])(?:gpt-audio|gpt-4o(?:-mini)?-audio-preview)(?:$|[-_.:])/,
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
    supportsPromptCaching: true,
    supportsContextEdits: false,
    supportsImageInput: resolveGrokImageHistory,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: resolveGrokImageHistory,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: resolveGrokReasoningEffort,
  },
  anthropic: {
    supportsPromptCaching: true,
    supportsContextEdits: true,
    supportsImageInput: true,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: true,
    acceptsImageHistory: true,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: true,
    acceptsReasoningEffort: false,
  },
  ollama: {
    // Ollama can preserve image turns only when the selected local model is
    // vision-capable; the runtime does not have a catalog lookup at switch time.
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: isVisionishOllamaModel,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: isVisionishOllamaModel,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  openai: {
    supportsPromptCaching: true,
    supportsContextEdits: false,
    supportsImageInput: true,
    supportsAudioInput: isOpenAIAudioInputModel,
    supportsAudioOutput: isOpenAIAudioOutputModel,
    supportsExtendedThinking: isOpenAIReasoningModel,
    acceptsImageHistory: true,
    // T13 only serializes inline/base64 OpenAI audio parts. Session history
    // currently records audio as opaque URL-bearing blocks, so provider/model
    // switches must fail closed until replay serialization grows a transcoding
    // layer for those history entries.
    acceptsAudioHistory: false,
    acceptsThinkingHistory: isOpenAIReasoningModel,
    acceptsReasoningEffort: isOpenAIReasoningModel,
  },
  openrouter: {
    // Routed upstreams vary by model/provider and the runtime does not have a
    // catalog handshake here, so model-switch checks must fail closed.
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  groq: {
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  deepseek: {
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: isDeepSeekThinkingModel,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: isDeepSeekThinkingModel,
    acceptsReasoningEffort: false,
  },
  gemini: {
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsExtendedThinking: isGeminiThinkingModel,
    acceptsImageHistory: true,
    // Gemini's OpenAI-compatible surface accepts inline `input_audio`
    // payloads, but this runtime slice does not yet replay stored `audio_url`
    // history into that wire format.
    acceptsAudioHistory: false,
    acceptsThinkingHistory: isGeminiThinkingModel,
    acceptsReasoningEffort: false,
  },
  lmstudio: {
    // LM Studio is model-dependent, so use the same local-model heuristic as
    // Ollama instead of claiming universal multimodal support.
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: isVisionishOllamaModel,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: false,
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
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsExtendedThinking: false,
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
