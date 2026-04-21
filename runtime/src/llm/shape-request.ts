import type { ProviderModelCapabilities } from "./capabilities.js";

export interface SessionHistoryRequirements {
  readonly hasImageHistory: boolean;
  readonly hasAudioHistory: boolean;
  readonly hasThinkingHistory: boolean;
  readonly reasoningEffortRequested: boolean;
}

export interface HistoryCompatibilityCheck {
  readonly compatible: boolean;
  readonly missingCapabilities: readonly string[];
  readonly reason?: string;
}

function scanValue(
  value: unknown,
  seen: WeakSet<object>,
  requirements: {
    hasImageHistory: boolean;
    hasAudioHistory: boolean;
    hasThinkingHistory: boolean;
  },
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanValue(item, seen, requirements);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";

  if (
    type === "image" ||
    type === "image_url" ||
    type === "input_image" ||
    type === "view_image"
  ) {
    requirements.hasImageHistory = true;
  }
  if (
    type === "audio" ||
    type === "input_audio" ||
    type === "audio_url"
  ) {
    requirements.hasAudioHistory = true;
  }
  if (
    type === "thinking" ||
    type === "redacted_thinking" ||
    type === "reasoning"
  ) {
    requirements.hasThinkingHistory = true;
  }

  for (const nested of Object.values(record)) {
    scanValue(nested, seen, requirements);
  }
}

export function analyzeSessionHistoryRequirements(
  snapshot: unknown,
): SessionHistoryRequirements {
  const state = (snapshot ?? {}) as {
    history?: unknown[];
    sessionConfiguration?: {
      collaborationMode?: { reasoningEffort?: string };
    };
  };
  const requirements = {
    hasImageHistory: false,
    hasAudioHistory: false,
    hasThinkingHistory: false,
  };

  if (Array.isArray(state.history)) {
    scanValue(state.history, new WeakSet<object>(), requirements);
  }

  const reasoningEffort = state.sessionConfiguration?.collaborationMode?.reasoningEffort;
  return {
    ...requirements,
    reasoningEffortRequested:
      typeof reasoningEffort === "string" &&
      reasoningEffort.length > 0 &&
      reasoningEffort !== "none",
  };
}

export function validateHistoryCompatibility(
  caps: ProviderModelCapabilities,
  requirements: SessionHistoryRequirements,
): HistoryCompatibilityCheck {
  const missing: string[] = [];

  if (requirements.hasImageHistory && !caps.acceptsImageHistory) {
    missing.push("image history");
  }
  if (requirements.hasAudioHistory && !caps.acceptsAudioHistory) {
    missing.push("audio history");
  }
  if (requirements.hasThinkingHistory && !caps.acceptsThinkingHistory) {
    missing.push("thinking history");
  }
  if (requirements.reasoningEffortRequested && !caps.acceptsReasoningEffort) {
    missing.push("reasoning_effort");
  }

  if (missing.length === 0) {
    return { compatible: true, missingCapabilities: [] };
  }

  return {
    compatible: false,
    missingCapabilities: missing,
    reason:
      `${caps.provider || "target provider"} / ${caps.model || "target model"} ` +
      `cannot satisfy this session's ${missing.join(", ")} requirements`,
  };
}
