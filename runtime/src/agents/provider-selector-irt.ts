/** Local, bounded Gaussian (online Laplace) item-response posterior. No I/O. */
export const IRT_REVISION = "child-irt-v2-2026-09-29";
export const ROUTING_SKILLS = ["coding", "reasoning", "tool_use", "long_context", "extraction"] as const;
export type RoutingSkill = (typeof ROUTING_SKILLS)[number];
export interface TaskFeatures {
  readonly skill: RoutingSkill;
  readonly difficulty: number;
  readonly discrimination: number;
}
export interface ModelAbility {
  readonly provider: string;
  readonly model: string;
  readonly skill: RoutingSkill;
  readonly revision: string;
  readonly mean: number;
  readonly variance: number;
  readonly observations: number;
}
export interface PublicAbilitySource {
  readonly url: string;
  readonly published: string;
  readonly retrieved: string;
  readonly metric: string;
  readonly score: number;
}
const deepseekSource = (score: number, metric: string, published: string): PublicAbilitySource => ({
  url: "https://api-docs.deepseek.com/updates/", published, retrieved: "2026-09-29", metric, score,
});
/** Vendor results at different effort/harness settings are weak priors, not comparable task probabilities. */
export function abilitySource(provider: string, model: string, skill: RoutingSkill): PublicAbilitySource | undefined {
  if (provider === "deepseek" && ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model)) {
    if (skill === "coding") return deepseekSource(0.742, "DeepSWE v1.1", "2026-09-10");
    if (skill === "reasoning") return deepseekSource(0.909, "GPQA Diamond", "2026-09-10");
    if (skill === "tool_use") return deepseekSource(0.548, "Automation-Bench", "2026-09-10");
  }
  if (provider === "deepseek" && model === "deepseek-v4-pro") {
    if (skill === "coding") return deepseekSource(0.627, "DeepSWE", "2026-08-13");
    if (skill === "reasoning") return deepseekSource(0.427, "HLE without tools", "2026-08-13");
    if (skill === "tool_use") return deepseekSource(0.741, "Toolathlon-Verified", "2026-08-13");
  }
  if (provider === "meta" && ["muse-spark-1.3", "muse-spark-1.3-contributor"].includes(model) && skill === "coding") {
    return { url: "https://dev.meta.ai/models/muse-spark", published: "undated; retrieved 2026-09-29",
      retrieved: "2026-09-29", metric: "DeepSWE v1.1 (max); contributor shares version, not separately measured", score: 0.754 };
  }
  // No invented scores, version substring matching, or transfer from older Kimi/OpenAI models.
  return undefined;
}
export const sigmoid = (x: number): number => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
export function validFeatures(value: TaskFeatures): boolean {
  return ROUTING_SKILLS.includes(value.skill) && Number.isFinite(value.difficulty) && Math.abs(value.difficulty) <= 6 &&
    Number.isFinite(value.discrimination) && value.discrimination >= 0.25 && value.discrimination <= 2;
}
export function validAbility(value: ModelAbility): boolean {
  return value.revision === IRT_REVISION && ROUTING_SKILLS.includes(value.skill) &&
    Number.isFinite(value.mean) && Math.abs(value.mean) <= 8 && Number.isFinite(value.variance) &&
    value.variance >= 0.01 && value.variance <= 4 && Number.isSafeInteger(value.observations) && value.observations >= 0;
}
export function abilityPrior(provider: string, model: string, skill: RoutingSkill): ModelAbility {
  const source = abilitySource(provider, model, skill);
  // Shrink heterogeneous vendor benchmarks halfway toward neutral log-odds.
  const mean = source === undefined ? 0 : 0.5 * Math.log(source.score / (1 - source.score));
  return { provider, model, skill, revision: IRT_REVISION, mean, variance: 1.5, observations: 0 };
}
/** Task content only. No labels, IDs, expected answers, remote embeddings or secret reads. */
export function extractTaskFeatures(text: string, requiresTools = false): TaskFeatures {
  const length = text.length;
  const coding = /\b(function|python|typescript|javascript|implement|refactor|debug|code|patch)\b/iu.test(text);
  const reasoning = /\b(probability|posterior|bayes|integer|divisible|optimal|minimum|maximum|graph|paths|game|logic|reason|proof|prove)\b/iu.test(text);
  const skill: RoutingSkill = requiresTools && /\b(file|files|workspace|directory|terminal|tool)\b/iu.test(text) ? "tool_use" : length > 24_000 ? "long_context"
    : coding ? "coding" : reasoning ? "reasoning" : "extraction";
  const structure = (text.match(/\b(?:if|unless|except|before|after|precedence|constraint|depend|overlap|cycle|shortest)\b/giu) ?? []).length;
  // Length is weak evidence. Cap it so repeated instructions do not force a premium model.
  const difficulty = Math.min(1.5, -2 + Math.min(1.2, Math.log2(1 + length / 512) * 0.2) +
    Math.min(0.8, structure * 0.08) + (coding || reasoning ? 0.25 : 0) + (requiresTools ? 0.25 : 0));
  return { skill, difficulty, discrimination: 1 };
}
export function predictSuccess(ability: ModelAbility, task: TaskFeatures): {
  readonly mean: number; readonly lower: number; readonly upper: number;
} {
  if (!validAbility(ability) || !validFeatures(task)) throw new RangeError("Invalid local IRT state");
  const a = task.discrimination;
  const radius = 1.96 * Math.sqrt(ability.variance);
  return { mean: sigmoid(a * (ability.mean - task.difficulty) / Math.sqrt(1 + Math.PI * a * a * ability.variance / 8)),
    lower: sigmoid(a * (ability.mean - radius - task.difficulty)),
    upper: sigmoid(a * (ability.mean + radius - task.difficulty)) };
}
/** Only independent correctness verdicts belong here; provider failures and completion labels do not. */
export function updateAbility(prior: ModelAbility, task: TaskFeatures, passed: boolean): ModelAbility {
  if (!validAbility(prior) || !validFeatures(task) || prior.skill !== task.skill || typeof passed !== "boolean") {
    throw new RangeError("Invalid verified IRT observation");
  }
  const a = task.discrimination;
  const p = sigmoid(a * (prior.mean - task.difficulty));
  const variance = Math.max(0.01, 1 / (1 / prior.variance + a * a * p * (1 - p)));
  return { ...prior, mean: Math.max(-8, Math.min(8, prior.mean + variance * a * (Number(passed) - p))),
    variance, observations: Math.min(Number.MAX_SAFE_INTEGER, prior.observations + 1) };
}
