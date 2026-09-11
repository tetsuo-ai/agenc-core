import { LLMProviderError } from "../errors.js";

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

interface GeminiThinkingModel {
  readonly model: string;
  readonly control: "thinkingLevel" | "thinkingBudget";
  readonly levels: readonly GeminiThinkingLevel[];
  readonly defaultLevel?: GeminiThinkingLevel;
  readonly curated: boolean;
}

const PRO_LEVELS = Object.freeze(["low", "medium", "high"] as const);
const FLASH_LEVELS = Object.freeze(["minimal", ...PRO_LEVELS] as const);
const ORIGINAL_PRO_LEVELS = Object.freeze(["low", "high"] as const);
const BUDGET_LEVELS = Object.freeze([] as const);

// Levels per model probed live on generateContent (2026-09-11): 3.8 Flash,
// 3.7 Flash and 3.1 Pro answer "Thinking level MINIMAL is not supported"
// while 3.6 Flash, 3.5 Flash, 3.5 Flash Lite and 3.1 Flash Lite take all
// four. Every 3.x model here thinks by default (thoughtsTokenCount > 0 with
// no thinkingConfig).
export const GEMINI_THINKING_MODELS: readonly GeminiThinkingModel[] = Object.freeze(([
  { model: "gemini-3.1-pro-preview", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "high", curated: true },
  { model: "gemini-3.8-flash", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.7-flash", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.6-flash", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.5-flash", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.5-flash-lite", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.1-flash-lite", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-2.5-flash", control: "thinkingBudget", levels: BUDGET_LEVELS, curated: true },
  { model: "gemini-3-flash-preview", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "high", curated: false },
  { model: "gemini-3-pro-preview", control: "thinkingLevel", levels: ORIGINAL_PRO_LEVELS, defaultLevel: "high", curated: false },
  { model: "gemini-2.5-pro", control: "thinkingBudget", levels: BUDGET_LEVELS, curated: false },
  { model: "gemini-2.5-flash-lite", control: "thinkingBudget", levels: BUDGET_LEVELS, curated: false },
] satisfies GeminiThinkingModel[]).map((entry) => Object.freeze(entry)));

export function resolveGeminiThinkingModel(model: string): GeminiThinkingModel | undefined {
  const normalized = model.trim().toLowerCase()
    .replace(/^gemini:/u, "")
    .replace(/^publishers\/google\/models\//u, "")
    .replace(/^models\//u, "")
    .replace(/^google\//u, "");
  return GEMINI_THINKING_MODELS.find((entry) => entry.model === normalized);
}

export function resolveGeminiReasoningEffort(
  model: string,
  effort: string | undefined,
): GeminiThinkingLevel | undefined {
  if (effort === undefined || effort === "none") return undefined;
  const metadata = resolveGeminiThinkingModel(model);
  const supported = metadata?.levels.find((level) => level === effort);
  if (metadata?.control === "thinkingLevel" && supported !== undefined) return supported;
  const detail = metadata?.control === "thinkingBudget"
    ? "This model uses thinkingBudget, not reasoning-effort levels."
    : `Supported reasoning efforts: ${metadata?.levels.join(", ") || "none verified"}.`;
  throw new LLMProviderError("gemini", `Reasoning effort '${effort}' is not supported for model '${model}'. ${detail}`, 400);
}
