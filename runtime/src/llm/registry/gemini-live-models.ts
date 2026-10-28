/**
 * Gemini chat models that Google's live model list serves and Core's bundled
 * registry (gemini-thinking-models.ts) does not know yet.
 *
 * `GET /v1beta/models` lists each model's `inputTokenLimit`,
 * `outputTokenLimit`, whether it `thinking`, and its
 * `supportedGenerationMethods` (ai.google.dev/api/models). That is enough to
 * run a new chat model on the day Google ships it: the window and output
 * limit come from the list, and the model thinks at its own default level.
 *
 * What the list does not say stays unknown until Core registers the model:
 * the thinking levels a request may name, the default level, and the price.
 * Such a model therefore takes no effort setting (requests leave
 * thinkingConfig out) and its cost shows as unknown; it never borrows another
 * model's levels or price. Models the bundled registry knows keep their
 * reviewed rows, so the live list never replaces them.
 *
 * @module
 */

import { asRecord } from "../../utils/record.js";
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";
import { resolveGeminiThinkingModel } from "./gemini-thinking-models.js";

export interface GeminiLiveModel {
  readonly model: string;
  readonly displayName: string;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly thinking: boolean;
}

/**
 * Listed models that are not text chat models: speech, image and video
 * generation, live audio, transcription, embeddings and the computer-use
 * preview. Their ids are checked against these words, since the list has no
 * field that says "chat".
 */
const NON_CHAT_ID_PARTS = Object.freeze([
  "-tts",
  "image",
  "-live",
  "transcribe",
  "native-audio",
  "computer-use",
  "embedding",
  "translate",
  "omni",
  "lyria",
  "veo",
]);

const CHAT_MODEL_ID = /^(?:gemini|gemma)-\d[a-z0-9.-]*$/u;
const TEXT_IMAGE = Object.freeze(["text", "image"] as const);
const NO_LEVELS = Object.freeze([] as const);
const NO_SPEED_TIERS = Object.freeze([] as const);
/** Live rows sort after every bundled Gemini row in model lists. */
const LIVE_PRIORITY_BASE = 1_000;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** True for an id with the shape of a Gemini or Gemma chat model id. */
export function looksLikeGeminiChatModelId(model: string): boolean {
  const id = model.trim().toLowerCase();
  return CHAT_MODEL_ID.test(id) && !NON_CHAT_ID_PARTS.some((part) => id.includes(part));
}

/**
 * The chat models in one `GET /v1beta/models` response that the bundled
 * registry does not know. Undefined when the body is not a model list.
 */
export function parseGeminiLiveModels(body: unknown): readonly GeminiLiveModel[] | undefined {
  const models = asRecord(body)?.models;
  if (!Array.isArray(models)) return undefined;
  const rows: GeminiLiveModel[] = [];
  for (const value of models) {
    const item = asRecord(value);
    const name = typeof item?.name === "string" ? item.name.replace(/^models\//u, "") : "";
    const methods = Array.isArray(item?.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
    const inputTokenLimit = positiveInteger(item?.inputTokenLimit);
    const outputTokenLimit = positiveInteger(item?.outputTokenLimit);
    if (
      !looksLikeGeminiChatModelId(name) ||
      !methods.includes("generateContent") ||
      inputTokenLimit === undefined ||
      outputTokenLimit === undefined ||
      resolveGeminiThinkingModel(name) !== undefined
    ) continue;
    rows.push(Object.freeze({
      model: name,
      displayName: typeof item?.displayName === "string" && item.displayName.trim().length > 0
        ? item.displayName.trim()
        : name,
      inputTokenLimit,
      outputTokenLimit,
      thinking: item?.thinking === true,
    }));
  }
  return Object.freeze(rows);
}

export function geminiLiveCatalogEntry(
  entry: GeminiLiveModel,
  index: number,
): RegisteredModelCatalogEntry {
  return Object.freeze({
    provider: "gemini",
    model: entry.model,
    displayName: entry.displayName,
    contextWindow: entry.inputTokenLimit,
    maxContextWindow: entry.inputTokenLimit,
    // outputTokenLimit is also the non-streaming cap on Gemini 4, so it is a
    // limit every call honors.
    maxOutputTokens: entry.outputTokenLimit,
    maxOutputTokensUpperLimit: entry.outputTokenLimit,
    inputModalities: TEXT_IMAGE,
    supportsToolUse: true,
    supportsThinking: entry.thinking,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none",
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "auto",
    // The list does not say which thinkingLevel values the model takes.
    supportedReasoningLevels: NO_LEVELS,
    additionalSpeedTiers: NO_SPEED_TIERS,
    priority: LIVE_PRIORITY_BASE + index,
    visibility: "list",
  });
}
