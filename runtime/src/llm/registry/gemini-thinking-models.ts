import { LLMProviderError } from "../errors.js";
import { publishedModelCatalogEntry } from "./published-model-catalog.js";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface GeminiThinkingModel {
  readonly model: string;
  readonly control: "thinkingLevel" | "thinkingBudget";
  readonly levels: readonly GeminiThinkingLevel[];
  readonly defaultLevel?: GeminiThinkingLevel;
  readonly curated: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  /**
   * The most one non-streaming generateContent call may generate, when it is
   * lower than the streaming limit in maxOutputTokens.
   */
  readonly nonStreamingMaxOutputTokens?: number;
  /**
   * A deprecated id that Google now serves with this model. Requests still
   * work, so the row stays resolvable for saved settings, but pickers hide
   * it and it is priced as the model that answers.
   */
  readonly routedTo?: string;
  /**
   * Google has deprecated the id and no longer offers it to new users, but
   * still answers it under its own name. Pickers hide it; saved settings
   * keep resolving.
   */
  readonly deprecated?: boolean;
}

const PRO_LEVELS = Object.freeze(["low", "medium", "high"] as const);
const FLASH_LEVELS = Object.freeze(["minimal", ...PRO_LEVELS] as const);
const HYDROGEN_LEVELS = Object.freeze([...PRO_LEVELS, "xhigh"] as const);
const BUDGET_LEVELS = Object.freeze([] as const);

// Levels per model probed live on generateContent (2026-09-11): 3.8 Flash,
// 3.7 Flash and 3.1 Pro answer "Thinking level MINIMAL is not supported"
// while 3.6 Flash, 3.5 Flash, 3.5 Flash Lite and 3.1 Flash Lite take all
// four. Every 3.x model here thinks by default (thoughtsTokenCount > 0 with
// no thinkingConfig).
//
// Gemini 4 Argon (2026-10-28): the generateContent thinking guide lists low,
// medium (default) and high, and a live MINIMAL request answers HTTP 400
// "Thinking level MINIMAL is not supported for this model". A stream may
// return 65,536 tokens; one non-streaming call returns at most 32,768, which
// is also the outputTokenLimit GET /v1beta/models reports for it
// (ai.google.dev/gemini-api/docs/generate-content/latest-model). The same
// guide lists minimal as the default level of 3.5 and 3.1 Flash-Lite.
//
// Gemini 4 Carbon (2026-11-11) has the same levels and output limits as
// Argon, including HTTP 400 for MINIMAL. It uses more thinking tokens per
// turn (ai.google.dev/gemini-api/docs/generate-content/latest-model).
//
// Gemini 4 Hydrogen (2026-11-12, probed 2026-11-15): the thinking guide lists
// low, medium, high (default) and xhigh. Live: MINIMAL answers HTTP 400, the
// other four answer; XHIGH answers HTTP 400 on Argon, Carbon and 3.8 Flash.
// GET /v1beta/models reports outputTokenLimit 65,536 for it, so it has no
// lower non-streaming cap.
//
// Checked against the docs and the live API on 2026-11-15:
// - gemini-3-pro-preview was shut down on 2026-03-09 and answers HTTP 404, so
//   it has no row any more.
// - gemini-3.1-flash-lite-preview is listed as shut down (2026-05-25) but
//   the API still answers it with modelVersion "gemini-3.1-flash-lite".
// - gemini-2.5-pro and gemini-2.5-flash were deprecated on 2026-11-02 and
//   answer HTTP 404 for a key that never used them. From 2026-12-01 Google
//   routes them to gemini-3.8-flash and gemini-3.5-flash-lite. With no
//   levels here a request names no thinking control, which both the old and
//   the routed model accept.
// - gemini-3.1-flash-lite shuts down on 2027-05-07 (deprecations page). The
//   row carries no retirement date: a dated row is refused from that day
//   on, the live list cannot vouch for a bundled Gemini id, and Google kept
//   answering gemini-3.1-flash-lite-preview long after its own date.
//
// Deprecated 2026-10-08 (changelog): requests for gemini-3.7-flash and
// gemini-3.5-flash are routed to gemini-3.8-flash and gemini-3.6-flash. A
// live request for each returned modelVersion "gemini-3.8-flash" and
// "gemini-3.6-flash" on 2026-10-28.
export const GEMINI_THINKING_MODELS: readonly GeminiThinkingModel[] = Object.freeze(([
  { model: "gemini-4-argon", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true, maxOutputTokens: 65_536, nonStreamingMaxOutputTokens: 32_768 },
  { model: "gemini-4-carbon", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true, maxOutputTokens: 65_536, nonStreamingMaxOutputTokens: 32_768 },
  { model: "gemini-4-hydrogen", control: "thinkingLevel", levels: HYDROGEN_LEVELS, defaultLevel: "high", curated: true, maxOutputTokens: 65_536 },
  { model: "gemini-3.1-pro-preview", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "high", curated: true },
  { model: "gemini-3.8-flash", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.7-flash", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true, routedTo: "gemini-3.8-flash" },
  { model: "gemini-3.6-flash", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.5-flash", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true, routedTo: "gemini-3.6-flash" },
  { model: "gemini-3.5-flash-lite", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "minimal", curated: true },
  { model: "gemini-3.1-flash-lite", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "minimal", curated: true },
  { model: "gemini-3.1-flash-lite-preview", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "minimal", curated: true, routedTo: "gemini-3.1-flash-lite" },
  { model: "gemini-2.5-flash", control: "thinkingBudget", levels: BUDGET_LEVELS, curated: true, deprecated: true },
  { model: "gemini-3-flash-preview", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "high", curated: true },
  { model: "gemini-2.5-pro", control: "thinkingBudget", levels: BUDGET_LEVELS, curated: true, deprecated: true },
  { model: "gemini-2.5-flash-lite", control: "thinkingBudget", levels: BUDGET_LEVELS, curated: true },
  // Official hosted Gemma guide: minimal disables thinking, high enables it.
  { model: "gemini-3.1-pro-preview-customtools", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "high", curated: true },
  { model: "gemma-4-31b-it", control: "thinkingLevel", levels: ["minimal", "high"], curated: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
  { model: "gemma-4-26b-a4b-it", control: "thinkingLevel", levels: ["minimal", "high"], curated: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
  { model: "gemini-robotics-er-2-preview", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "high", curated: true, contextWindow: 131_072 },
] satisfies GeminiThinkingModel[]).map((entry) => Object.freeze(entry)));

function canonicalModelId(model: string): string {
  return model.trim().toLowerCase()
    .replace(/^gemini:/u, "")
    .replace(/^publishers\/google\/models\//u, "")
    .replace(/^models\//u, "")
    .replace(/^google\//u, "");
}

export function resolveGeminiThinkingModel(model: string): GeminiThinkingModel | undefined {
  const normalized = canonicalModelId(model);
  return GEMINI_THINKING_MODELS.find((entry) => entry.model === normalized);
}

/**
 * The output ceiling for one generateContent call: the model's non-streaming
 * cap when the call does not stream and the model has a lower one.
 */
export function geminiOutputTokenCeiling(
  model: string,
  requested: number,
  streaming: boolean,
): number {
  const cap = streaming
    ? undefined
    : resolveGeminiThinkingModel(model)?.nonStreamingMaxOutputTokens;
  return cap === undefined ? requested : Math.min(requested, cap);
}

export function resolveGeminiReasoningEffort(
  model: string,
  effort: string | undefined,
): GeminiThinkingLevel | undefined {
  if (effort === undefined || effort === "none") return undefined;
  const metadata = resolveGeminiThinkingModel(model);
  // A model Google lists but Core has not registered: its levels are unknown,
  // so the request leaves thinkingConfig out and the model thinks at its own
  // default instead of the turn failing (gemini-live-models.ts).
  if (metadata === undefined && publishedModelCatalogEntry("gemini", canonicalModelId(model)) !== undefined) {
    return undefined;
  }
  const supported = metadata?.levels.find((level) => level === effort);
  if (metadata?.control === "thinkingLevel" && supported !== undefined) return supported;
  const detail = metadata?.control === "thinkingBudget"
    ? "This model uses thinkingBudget, not reasoning-effort levels."
    : `Supported reasoning efforts: ${metadata?.levels.join(", ") || "none verified"}.`;
  throw new LLMProviderError("gemini", `Reasoning effort '${effort}' is not supported for model '${model}'. ${detail}`, 400);
}
