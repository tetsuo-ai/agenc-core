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

export const GEMINI_THINKING_MODELS: readonly GeminiThinkingModel[] = Object.freeze(([
  { model: "gemini-3.1-pro-preview", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "high", curated: true },
  { model: "gemini-3.7-flash", control: "thinkingLevel", levels: PRO_LEVELS, defaultLevel: "medium", curated: true },
  { model: "gemini-3.5-flash", control: "thinkingLevel", levels: FLASH_LEVELS, defaultLevel: "medium", curated: true },
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
