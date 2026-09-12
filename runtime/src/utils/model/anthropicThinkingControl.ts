/**
 * Which thinking control each Claude generation accepts on the Messages
 * API, and which of them take `output_config.effort`. Every row below was
 * probed live on 2026-09-11 and agrees with platform.claude.com (models
 * overview, effort, extended thinking):
 *
 * - `always_on`: the Fable / Mythos 5 family. `thinking` must be omitted
 *   (`disabled`, `enabled` + `budget_tokens` return 400); depth is the
 *   effort parameter's job.
 * - `adaptive`: Opus 5, Sonnet 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6.
 *   `thinking: {type: "adaptive"}` turns thinking on and effort steers it.
 *   Opus 5, Sonnet 5, Opus 4.8 and Opus 4.7 return 400 for `enabled` +
 *   `budget_tokens`; 4.6 still accepts both.
 * - `budget`: Opus 4.5, Sonnet 4.5, Haiku 4.5 and everything older.
 *   `thinking: {type: "enabled", budget_tokens}`; `adaptive` returns 400.
 *
 * Effort is accepted on the always-on and adaptive families and on Opus
 * 4.5; Sonnet 4.5 and Haiku 4.5 answer "This model does not support the
 * effort parameter". Sampling parameters are gone from the always-on
 * family and from Opus 5, Sonnet 5, Opus 4.8 and Opus 4.7 (`temperature`
 * is "deprecated for this model", 400); the 4.6 generation and older still
 * take them. Kept dependency-free like alwaysOnThinking.ts so the wire
 * layer can import it.
 */
import { isAlwaysOnThinkingAnthropicModel } from "./alwaysOnThinking.js";

export type AnthropicThinkingControl = "always_on" | "adaptive" | "budget";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

function familySpelling(model: string): string {
  // Bedrock inference profiles brand the segment "anthropic.agenc-<model>".
  return model.toLowerCase().replaceAll("anthropic.agenc-", "anthropic.claude-");
}

export function anthropicThinkingControl(
  model: string,
): AnthropicThinkingControl {
  if (isAlwaysOnThinkingAnthropicModel(model)) return "always_on";
  const spelled = familySpelling(model);
  if (
    /(?:opus|sonnet)-5(?!\d)/.test(spelled) ||
    /opus-4[.-][678](?!\d)/.test(spelled) ||
    /sonnet-4[.-]6(?!\d)/.test(spelled)
  ) {
    return "adaptive";
  }
  return "budget";
}

export function anthropicAcceptsSamplingParameters(model: string): boolean {
  if (isAlwaysOnThinkingAnthropicModel(model)) return false;
  const spelled = familySpelling(model);
  return !(
    /(?:opus|sonnet)-5(?!\d)/.test(spelled) ||
    /opus-4[.-][78](?!\d)/.test(spelled)
  );
}

export function anthropicAcceptsEffort(model: string): boolean {
  if (anthropicThinkingControl(model) !== "budget") return true;
  return /opus-4[.-]5(?!\d)/.test(familySpelling(model));
}

/** The API's effort ladder; `minimal` rounds up to `low`, `none` sends nothing. */
export function anthropicEffort(
  effort: string | undefined,
): AnthropicEffort | undefined {
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}

const ANTHROPIC_MIN_MANUAL_BUDGET_TOKENS = 1024;

export function anthropicManualBudgetTokens(
  effort: string | undefined,
  maxTokens: number,
): number {
  const requested = effort === "high" || effort === "xhigh" ? 4096 : 2048;
  const budget = Math.min(requested, maxTokens - 1);
  if (budget < ANTHROPIC_MIN_MANUAL_BUDGET_TOKENS) {
    throw new Error(
      `Anthropic manual thinking requires budget_tokens >= ${ANTHROPIC_MIN_MANUAL_BUDGET_TOKENS} and below max_tokens (${maxTokens})`,
    );
  }
  return budget;
}
