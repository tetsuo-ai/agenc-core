import { isDeepStrictEqual } from "node:util";
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

export interface ResponsesContinuationState {
  conversationId?: string;
  lastRequest?: Record<string, unknown>;
  lastResponseId?: string;
  lastResponseOutput?: readonly Record<string, unknown>[];
}

export interface PreparedResponsesContinuationRequest {
  readonly request: Record<string, unknown>;
  readonly snapshot: Record<string, unknown>;
  readonly previousResponseId?: string;
}

const IMAGE_HISTORY_TYPES = new Set([
  "image",
  "image_url",
  "input_image",
  "view_image",
]);

const AUDIO_HISTORY_TYPES = new Set([
  "audio",
  "input_audio",
  "audio_url",
]);

const THINKING_HISTORY_TYPES = new Set([
  "thinking",
  "redacted_thinking",
  "reasoning",
]);

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

  if (IMAGE_HISTORY_TYPES.has(type)) {
    requirements.hasImageHistory = true;
  }
  if (AUDIO_HISTORY_TYPES.has(type)) {
    requirements.hasAudioHistory = true;
  }
  if (THINKING_HISTORY_TYPES.has(type)) {
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
    missing.push("reasoning effort");
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

function cloneJsonRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function cloneJsonItems(
  items: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return items.map((item) => cloneJsonRecord(item));
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function stripResponsesIncrementalFields(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = cloneJsonRecord(body);
  delete stripped.input;
  delete stripped.previous_response_id;
  return stripped;
}

function baselineIsPrefix(
  baseline: readonly Record<string, unknown>[],
  current: readonly Record<string, unknown>[],
): boolean {
  if (baseline.length > current.length) {
    return false;
  }
  for (let index = 0; index < baseline.length; index += 1) {
    if (!jsonEqual(baseline[index], current[index])) {
      return false;
    }
  }
  return true;
}

function getResponseInputItems(
  body: Record<string, unknown>,
): Record<string, unknown>[] | null {
  if (!Array.isArray(body.input)) {
    return null;
  }
  const items = body.input.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
  return items.length === body.input.length ? cloneJsonItems(items) : null;
}

export function prepareResponsesContinuationRequest(
  body: Record<string, unknown>,
  state: ResponsesContinuationState,
): PreparedResponsesContinuationRequest {
  const snapshot = cloneJsonRecord(body);
  const promptCacheKey =
    typeof snapshot.prompt_cache_key === "string" &&
    snapshot.prompt_cache_key.trim().length > 0
      ? snapshot.prompt_cache_key.trim()
      : state.conversationId?.trim() || undefined;
  if (promptCacheKey) {
    snapshot.prompt_cache_key = promptCacheKey;
  }

  const request = cloneJsonRecord(snapshot);
  const currentInput = getResponseInputItems(snapshot);
  const previousInput =
    state.lastRequest !== undefined ? getResponseInputItems(state.lastRequest) : null;
  const previousOutput = Array.isArray(state.lastResponseOutput)
    ? cloneJsonItems(state.lastResponseOutput)
    : [];

  if (
    !state.lastResponseId ||
    currentInput === null ||
    previousInput === null ||
    !jsonEqual(
      stripResponsesIncrementalFields(state.lastRequest ?? {}),
      stripResponsesIncrementalFields(snapshot),
    )
  ) {
    return {
      request,
      snapshot,
    };
  }

  const baseline = [...previousInput, ...previousOutput];
  if (!baselineIsPrefix(baseline, currentInput)) {
    return {
      request,
      snapshot,
    };
  }

  const delta = currentInput.slice(baseline.length);
  request.input = delta;
  request.previous_response_id = state.lastResponseId;
  return {
    request,
    snapshot,
    previousResponseId: state.lastResponseId,
  };
}

export function recordResponsesContinuationResponse(
  state: ResponsesContinuationState,
  snapshot: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  state.lastRequest = cloneJsonRecord(snapshot);
  state.lastResponseId =
    typeof response.id === "string" && response.id.trim().length > 0
      ? response.id.trim()
      : undefined;
  state.lastResponseOutput = Array.isArray(response.output)
    ? response.output.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : undefined;
}

export function clearResponsesContinuationResponseId(
  state: ResponsesContinuationState,
): void {
  state.lastResponseId = undefined;
  state.lastResponseOutput = undefined;
}

export function resetResponsesContinuationState(
  state: ResponsesContinuationState,
): void {
  state.lastRequest = undefined;
  clearResponsesContinuationResponseId(state);
}
