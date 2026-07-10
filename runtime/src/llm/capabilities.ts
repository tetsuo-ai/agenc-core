import {
  supportsAnthropicStructuredOutputToolUse,
  supportsOpenAIStructuredOutputs,
  supportsXaiReasoningEffortParam,
  supportsXaiStructuredOutputs,
  supportsXaiStructuredOutputsWithTools,
} from "./structured-output.js";
import { resolveModelCapabilityHints } from "./registry/model-catalog.js";
import { supportsGrokServerSideTools } from "./provider-native-search.js";

export interface ProviderModelCapabilities {
  readonly provider: string;
  readonly model: string;
  readonly supportsToolUse: boolean;
  readonly supportsPromptCaching: boolean;
  readonly supportsContextEdits: boolean;
  readonly supportsImageInput: boolean;
  readonly supportsVisionInput: boolean;
  readonly supportsAudioInput: boolean;
  readonly supportsAudioOutput: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsStructuredOutputWithTools: boolean;
  readonly supportsProviderNativeWebSearch: boolean;
  readonly supportsExtendedThinking: boolean;
  readonly acceptsImageHistory: boolean;
  readonly acceptsAudioHistory: boolean;
  readonly acceptsThinkingHistory: boolean;
  readonly acceptsReasoningEffort: boolean;
}

export interface ProviderCapabilityOverrides {
  readonly supportsToolUse?: boolean;
  readonly supportsPromptCaching?: boolean;
  readonly supportsContextEdits?: boolean;
  readonly supportsImageInput?: boolean;
  readonly supportsAudioInput?: boolean;
  readonly supportsAudioOutput?: boolean;
  readonly supportsStructuredOutput?: boolean;
  readonly supportsStructuredOutputWithTools?: boolean;
  readonly supportsProviderNativeWebSearch?: boolean;
  readonly supportsExtendedThinking?: boolean;
  readonly acceptsImageHistory?: boolean;
  readonly acceptsAudioHistory?: boolean;
  readonly acceptsThinkingHistory?: boolean;
  readonly acceptsReasoningEffort?: boolean;
}

export interface ProviderCapabilityRegistryEntry
  extends ProviderModelCapabilities {
  readonly lastVerifiedAt: number;
  readonly stale: boolean;
  readonly warning?: "capability_drift_detected";
}

const CAPABILITY_REGISTRY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_CAPABILITY_VERIFIED_AT = Date.UTC(2026, 3, 22);
const registryState = new Map<
  string,
  { lastVerifiedAt: number; stale: boolean }
>();

export function normalizeProviderSlug(provider: string | undefined): string {
  const normalized = provider?.trim().toLowerCase() ?? "";
  if (normalized === "xai") {
    return "grok";
  }
  return normalized;
}

interface ProviderCapabilityDefinition {
  readonly supportsToolUse: CapabilityFlagValue;
  readonly supportsPromptCaching: CapabilityFlagValue;
  readonly supportsContextEdits: CapabilityFlagValue;
  readonly supportsImageInput: CapabilityFlagValue;
  readonly supportsAudioInput: CapabilityFlagValue;
  readonly supportsAudioOutput: CapabilityFlagValue;
  readonly supportsStructuredOutput: CapabilityFlagValue;
  readonly supportsStructuredOutputWithTools: CapabilityFlagValue;
  readonly supportsProviderNativeWebSearch: CapabilityFlagValue;
  readonly supportsExtendedThinking: CapabilityFlagValue;
  readonly acceptsImageHistory: CapabilityFlagValue;
  readonly acceptsAudioHistory: CapabilityFlagValue;
  readonly acceptsThinkingHistory: CapabilityFlagValue;
  readonly acceptsReasoningEffort: CapabilityFlagValue;
}

type CapabilityFlagValue = boolean | ((model: string) => boolean);
type DirectProviderCapabilityOverrideKey = Exclude<
  keyof ProviderCapabilityOverrides,
  "supportsImageInput"
>;
type MutableProviderModelCapabilities = {
  -readonly [Key in keyof ProviderModelCapabilities]: ProviderModelCapabilities[Key];
};

const DIRECT_PROVIDER_CAPABILITY_OVERRIDE_KEYS = [
  "supportsToolUse",
  "supportsPromptCaching",
  "supportsContextEdits",
  "supportsAudioInput",
  "supportsAudioOutput",
  "supportsStructuredOutput",
  "supportsStructuredOutputWithTools",
  "supportsProviderNativeWebSearch",
  "supportsExtendedThinking",
  "acceptsImageHistory",
  "acceptsAudioHistory",
  "acceptsThinkingHistory",
  "acceptsReasoningEffort",
] as const satisfies readonly DirectProviderCapabilityOverrideKey[];

function isVisionishOllamaModel(model: string): boolean {
  return /(?:llava|bakllava|vision|(?:^|[-_.:])vl(?:$|[-_.:])|qwen(?:2\.?5)?-vl|minicpm-v|moondream|llama3(?:\.2)?-vision|gemma3)/i.test(
    model,
  );
}

function resolveCapabilityFlag(value: CapabilityFlagValue, model: string): boolean {
  return typeof value === "function" ? value(model) : value;
}

function buildCapabilities(
  provider: string,
  model: string,
  definition: ProviderCapabilityDefinition,
): ProviderModelCapabilities {
  const trimmedModel = model.trim();
  const hints = resolveModelCapabilityHints({ provider, model: trimmedModel });
  const supportsImageInput = resolveCapabilityFlag(
    hints?.supportsImageInput ?? definition.supportsImageInput,
    trimmedModel,
  );
  return {
    provider,
    model: trimmedModel,
    supportsToolUse: hints?.supportsToolUse ??
      resolveCapabilityFlag(definition.supportsToolUse, trimmedModel),
    supportsPromptCaching: resolveCapabilityFlag(
      definition.supportsPromptCaching,
      trimmedModel,
    ),
    supportsContextEdits: resolveCapabilityFlag(
      definition.supportsContextEdits,
      trimmedModel,
    ),
    supportsImageInput,
    supportsVisionInput: supportsImageInput,
    supportsAudioInput: resolveCapabilityFlag(
      definition.supportsAudioInput,
      trimmedModel,
    ),
    supportsAudioOutput: resolveCapabilityFlag(
      definition.supportsAudioOutput,
      trimmedModel,
    ),
    supportsStructuredOutput: hints?.supportsStructuredOutput ??
      resolveCapabilityFlag(definition.supportsStructuredOutput, trimmedModel),
    supportsStructuredOutputWithTools:
      hints?.supportsStructuredOutputWithTools ??
        resolveCapabilityFlag(
          definition.supportsStructuredOutputWithTools,
          trimmedModel,
        ),
    supportsProviderNativeWebSearch:
      hints?.supportsProviderNativeWebSearch ??
        resolveCapabilityFlag(
          definition.supportsProviderNativeWebSearch,
          trimmedModel,
        ),
    supportsExtendedThinking: resolveCapabilityFlag(
      definition.supportsExtendedThinking,
      trimmedModel,
    ),
    acceptsImageHistory: hints?.acceptsImageHistory ??
      resolveCapabilityFlag(definition.acceptsImageHistory, trimmedModel),
    acceptsAudioHistory: resolveCapabilityFlag(
      definition.acceptsAudioHistory,
      trimmedModel,
    ),
    acceptsThinkingHistory: resolveCapabilityFlag(
      definition.acceptsThinkingHistory,
      trimmedModel,
    ),
    acceptsReasoningEffort: hints?.acceptsReasoningEffort ??
      resolveCapabilityFlag(definition.acceptsReasoningEffort, trimmedModel),
  };
}

function capabilityRegistryKey(provider: string, model: string): string {
  return `${normalizeProviderSlug(provider)}:${model.trim().toLowerCase()}`;
}

function applyCapabilityOverrides(
  caps: ProviderModelCapabilities,
  overrides: ProviderCapabilityOverrides | undefined,
): ProviderModelCapabilities {
  if (!overrides) return caps;
  const next: MutableProviderModelCapabilities = { ...caps };
  for (const key of DIRECT_PROVIDER_CAPABILITY_OVERRIDE_KEYS) {
    const value = overrides[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  if (overrides.supportsImageInput !== undefined) {
    next.supportsImageInput = overrides.supportsImageInput;
    next.supportsVisionInput = overrides.supportsImageInput;
  }
  return next;
}

function resolveGrokImageHistory(model: string): boolean {
  // AgenC's Grok adapter auto-routes image-bearing turns through the
  // configured vision model when needed, but the imagine-* family is an
  // image/video output surface rather than normal text chat history.
  return !model.trim().toLowerCase().startsWith("grok-imagine");
}

function resolveGrokReasoningEffort(model: string): boolean {
  // Delegate the xAI model allowlist to the single source of truth so
  // supported 4.3/4.5 requests retain their depth control while inherited
  // effort is stripped from unknown or explicitly non-reasoning models.
  return supportsXaiReasoningEffortParam(model);
}

function matchesModelFamily(model: string, pattern: RegExp): boolean {
  return pattern.test(model.trim().toLowerCase());
}

function isOpenAIReasoningModel(model: string): boolean {
  return matchesModelFamily(
    model,
    // branding-scan: allow OpenAI model family identifier
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

const HOSTED_CHAT_COMPATIBLE_CAPABILITIES = {
  supportsToolUse: true,
  supportsPromptCaching: false,
  supportsContextEdits: false,
  supportsImageInput: false,
  supportsAudioInput: false,
  supportsAudioOutput: false,
  supportsStructuredOutput: false,
  supportsStructuredOutputWithTools: false,
  supportsProviderNativeWebSearch: false,
  supportsExtendedThinking: false,
  acceptsImageHistory: false,
  acceptsAudioHistory: false,
  acceptsThinkingHistory: false,
  acceptsReasoningEffort: false,
} satisfies ProviderCapabilityDefinition;

const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilityDefinition>> = {
  grok: {
    supportsToolUse: true,
    supportsPromptCaching: true,
    supportsContextEdits: false,
    supportsImageInput: resolveGrokImageHistory,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: supportsXaiStructuredOutputs,
    supportsStructuredOutputWithTools: supportsXaiStructuredOutputsWithTools,
    supportsProviderNativeWebSearch: supportsGrokServerSideTools,
    supportsExtendedThinking: false,
    acceptsImageHistory: resolveGrokImageHistory,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: resolveGrokReasoningEffort,
  },
  anthropic: {
    supportsToolUse: true,
    supportsPromptCaching: true,
    supportsContextEdits: true,
    supportsImageInput: true,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: supportsAnthropicStructuredOutputToolUse,
    supportsStructuredOutputWithTools: supportsAnthropicStructuredOutputToolUse,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: true,
    acceptsImageHistory: true,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: true,
    acceptsReasoningEffort: false,
  },
  ollama: {
    // Ollama can preserve image turns only when the selected local model is
    // vision-capable; the runtime does not have a catalog lookup at switch time.
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: isVisionishOllamaModel,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: isVisionishOllamaModel,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  openai: {
    supportsToolUse: true,
    supportsPromptCaching: true,
    supportsContextEdits: false,
    supportsImageInput: true,
    supportsAudioInput: isOpenAIAudioInputModel,
    supportsAudioOutput: isOpenAIAudioOutputModel,
    supportsStructuredOutput: supportsOpenAIStructuredOutputs,
    supportsStructuredOutputWithTools: supportsOpenAIStructuredOutputs,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: isOpenAIReasoningModel,
    acceptsImageHistory: true,
    // T13 only serializes inline/base64 audio parts for this provider. Session history
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
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  groq: {
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  deepseek: {
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: isDeepSeekThinkingModel,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: isDeepSeekThinkingModel,
    acceptsReasoningEffort: false,
  },
  gemini: {
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: isGeminiThinkingModel,
    acceptsImageHistory: true,
    // Gemini's chat-compatible surface accepts inline `input_audio`
    // payloads, but this runtime slice does not yet replay stored `audio_url`
    // history into that wire format.
    acceptsAudioHistory: false,
    acceptsThinkingHistory: isGeminiThinkingModel,
    acceptsReasoningEffort: false,
  },
  mistral: HOSTED_CHAT_COMPATIBLE_CAPABILITIES,
  "nvidia-nim": HOSTED_CHAT_COMPATIBLE_CAPABILITIES,
  minimax: HOSTED_CHAT_COMPATIBLE_CAPABILITIES,
  github: HOSTED_CHAT_COMPATIBLE_CAPABILITIES,
  "amazon-bedrock": {
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  lmstudio: {
    // LM Studio is model-dependent, so use the same local-model heuristic as
    // Ollama instead of claiming universal multimodal support.
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: isVisionishOllamaModel,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: isVisionishOllamaModel,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  agenc: {
    // Hosted routing supports normal tool calls, but model-specific
    // multimodal/search details are resolved by the selected downstream route.
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
    acceptsAudioHistory: false,
    acceptsThinkingHistory: false,
    acceptsReasoningEffort: false,
  },
  "openai-compatible": {
    // Generic self-hosted endpoints vary by model and server, so fail closed.
    supportsToolUse: true,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
    supportsExtendedThinking: false,
    acceptsImageHistory: false,
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
    supportsToolUse: false,
    supportsPromptCaching: false,
    supportsContextEdits: false,
    supportsImageInput: false,
    supportsVisionInput: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsProviderNativeWebSearch: false,
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
  readonly overrides?: ProviderCapabilityOverrides;
}): ProviderModelCapabilities {
  const provider = normalizeProviderSlug(input.provider);
  const model = input.model?.trim() ?? "";
  const definition = PROVIDER_CAPABILITIES[provider];

  if (definition) {
    return applyCapabilityOverrides(
      buildCapabilities(provider, model, definition),
      input.overrides,
    );
  }
  return applyCapabilityOverrides(
    buildDefaultCapabilities(provider, model),
    input.overrides,
  );
}

export function resolveProviderCapabilityEntry(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly overrides?: ProviderCapabilityOverrides;
  readonly nowMs?: number;
}): ProviderCapabilityRegistryEntry {
  const caps = resolveProviderModelCapabilities(input);
  const key = capabilityRegistryKey(caps.provider, caps.model);
  const state = registryState.get(key) ?? {
    lastVerifiedAt: DEFAULT_CAPABILITY_VERIFIED_AT,
    stale: false,
  };
  const nowMs = input.nowMs ?? Date.now();
  const stale =
    state.stale || nowMs - state.lastVerifiedAt >= CAPABILITY_REGISTRY_TTL_MS;
  return {
    ...caps,
    lastVerifiedAt: state.lastVerifiedAt,
    stale,
    ...(stale ? { warning: "capability_drift_detected" as const } : {}),
  };
}

export function shouldProbeCapabilityEntry(
  entry: Pick<ProviderCapabilityRegistryEntry, "lastVerifiedAt" | "stale">,
  nowMs = Date.now(),
): boolean {
  return (
    entry.stale || nowMs - entry.lastVerifiedAt >= CAPABILITY_REGISTRY_TTL_MS
  );
}

export function markCapabilityVerified(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly verifiedAt?: number;
}): ProviderCapabilityRegistryEntry {
  const provider = normalizeProviderSlug(input.provider);
  const model = input.model?.trim() ?? "";
  registryState.set(capabilityRegistryKey(provider, model), {
    lastVerifiedAt: input.verifiedAt ?? Date.now(),
    stale: false,
  });
  return resolveProviderCapabilityEntry({
    provider,
    model,
    nowMs: input.verifiedAt,
  });
}

export function markCapabilityDrift(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly detectedAt?: number;
  readonly overrides?: ProviderCapabilityOverrides;
}): ProviderCapabilityRegistryEntry {
  const provider = normalizeProviderSlug(input.provider);
  const model = input.model?.trim() ?? "";
  registryState.set(capabilityRegistryKey(provider, model), {
    lastVerifiedAt: input.detectedAt ?? Date.now(),
    stale: true,
  });
  return resolveProviderCapabilityEntry({
    provider,
    model,
    overrides: input.overrides,
    nowMs: input.detectedAt,
  });
}

export function isProviderCapabilityMismatch(input: {
  readonly status?: number;
  readonly message: string;
}): boolean {
  const status = input.status;
  if (
    status !== undefined &&
    status !== 400 &&
    status !== 404 &&
    status !== 409 &&
    status !== 422
  ) {
    return false;
  }

  const message = input.message.trim().toLowerCase();
  if (message.length === 0) {
    return false;
  }

  return [
    /\bunsupported\b/,
    /\bnot supported\b/,
    /\bdoes not support\b/,
    /\bnot available for\b/,
    /\bunknown parameter\b/,
    /\bunrecognized request argument\b/,
    /\binvalid parameter\b/,
    /\bincompatible with\b/,
    /\brequires .* support\b/,
    /\bimage .* not supported\b/,
    /\baudio .* not supported\b/,
    /\breasoning .* not supported\b/,
    /\bthinking .* not supported\b/,
    /\btool .* not supported\b/,
    /\bstructured output .* not supported\b/,
    /\bcache_control\b/,
    /\bcontext edits?\b/,
  ].some((pattern) => pattern.test(message));
}
