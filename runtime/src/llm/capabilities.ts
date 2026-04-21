import { supportsXaiReasoningEffortParam } from "./structured-output.js";

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

function isXaiImageOutputModel(model: string): boolean {
  return /^grok-imagine-(?:image(?:-pro)?|video)/i.test(model);
}

function isVisionishOllamaModel(model: string): boolean {
  return /(?:llava|bakllava|vision|(?:^|[-_.:])vl(?:$|[-_.:])|qwen(?:2\.?5)?-vl|minicpm-v|moondream|llama3(?:\.2)?-vision|gemma3)/i.test(
    model,
  );
}

function buildGrokCapabilities(model: string): ProviderModelCapabilities {
  const trimmedModel = model.trim();
  const imageOutputModel = isXaiImageOutputModel(trimmedModel);
  return {
    provider: "grok",
    model: trimmedModel,
    // AgenC's Grok adapter auto-routes image-bearing turns through the
    // configured vision model when needed, so image-bearing history stays
    // compatible for normal Grok text models.
    acceptsImageHistory: !imageOutputModel,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: supportsXaiReasoningEffortParam(trimmedModel),
  };
}

function buildOllamaCapabilities(model: string): ProviderModelCapabilities {
  const trimmedModel = model.trim();
  return {
    provider: "ollama",
    model: trimmedModel,
    acceptsImageHistory: isVisionishOllamaModel(trimmedModel),
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  };
}

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

  switch (provider) {
    case "grok":
      return buildGrokCapabilities(model);
    case "ollama":
      return buildOllamaCapabilities(model);
    default:
      return buildDefaultCapabilities(provider, model);
  }
}
