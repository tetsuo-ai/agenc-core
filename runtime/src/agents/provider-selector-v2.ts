import { CHILD_QUALITY_FLOOR, childTierQuality, estimateChildCandidateCost } from "./provider-selector.js";
import { childModelProfile } from "./provider-selector-profiles.js";
import { REFERENCE_DIFFICULTY, abilityPrior, predictSuccess, sigmoid, validAbility, validFeatures,
  type ModelAbility, type TaskFeatures } from "./provider-selector-irt.js";
import type { ChildProviderCandidate, ChildRoutingSnapshot, ChildSelectionTask, RankedChildCandidate } from "./provider-selector-types.js";

export interface RoutingPreferences {
  readonly cost?: "quality" | "balanced" | "economy";
  readonly speed?: "balanced" | "fast";
  /** Opt in only. No exploration on cold or unverified histories. */
  readonly explore?: boolean;
  readonly maxExpectedLoss?: number;
}
export interface ConditionalSuccess {
  readonly first: string;
  readonly second: string;
  readonly failures: number;
  readonly recovered: number;
}
export interface RoutingVerification {
  /** An independent host verifier exists; a model's self-report is insufficient. */
  readonly available: true;
  readonly retrySafe: boolean;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly targetQuality?: number;
  readonly conditional?: readonly ConditionalSuccess[];
}
export interface V2Candidate extends RankedChildCandidate {
  readonly ability: ModelAbility;
  /**
   * How well this model fits the task's kind: its maintained tier, or for an
   * unprofiled model its verified local level. Undefined for a parent or
   * override of unknown quality.
   */
  readonly adequacy?: number;
  /** At least MIN_VERIFIED_OBSERVATIONS verified outcomes back the ability, not only the tier prior. */
  readonly verified: boolean;
  readonly lowerQuality: number;
  readonly upperQuality: number;
  readonly handoffCostUsd: number;
  readonly handoffLatencyMs: number;
}
export interface V2Selection {
  readonly selected?: V2Candidate;
  readonly ranked: readonly V2Candidate[];
  readonly rejected: readonly { readonly provider: string; readonly model: string; readonly reason: string }[];
  readonly reason: string;
  readonly mode: "parent" | "utility" | "cascade" | "explore" | "override" | "unavailable";
  readonly lambda: number;
  readonly mu: number;
  readonly cascade?: { readonly candidates: readonly V2Candidate[]; readonly expectedCostUsd: number;
    readonly expectedLatencyMs: number; readonly quality: number; readonly worstCaseCostUsd: number };
}
export const pairKey = (pair: { readonly provider: string; readonly model: string }): string => `${pair.provider}/${pair.model}`;
/** Verified outcomes needed before an ability counts as local evidence rather than its tier prior. */
export const MIN_VERIFIED_OBSERVATIONS = 3;
const finite = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x) && x >= 0;
/**
 * Utility units per dollar and per second. The dollar weight is the share of
 * the cap the user would trade for one unit of success. Without a cap there
 * is no such share, so price weighs nothing: it never moves a child off the
 * parent's model and an uncapped session is never more price averse than a
 * capped one.
 */
export function utilityWeights(preferences: RoutingPreferences = {}, budgetUsd?: number): { lambda: number; mu: number } {
  const willingness = preferences.cost === "quality" ? 0 : preferences.cost === "economy" ? 0.25 : 0.025;
  return { lambda: budgetUsd === undefined ? 0 : willingness / Math.max(0.001, budgetUsd),
    mu: preferences.speed === "fast" ? 0.01 : 0.0002 };
}
/** Bayesian shrinkage of P(second succeeds | first failed), never an independence assumption. */
export function conditionalRecovery(first: string, second: string, evidence: readonly ConditionalSuccess[] = []): number {
  const row = evidence.find(item => item.first === first && item.second === second);
  if (row === undefined) return 0; // No evidence of complementary errors: do not invent a cascade gain.
  if (!Number.isSafeInteger(row.failures) || !Number.isSafeInteger(row.recovered) ||
      row.failures < 1 || row.recovered < 0 || row.recovered > row.failures) return 0;
  return (row.recovered + 0.5) / (row.failures + 1);
}
/** Closed form minimum first-attempt success for c1+(1-p1)c2 <= budget. */
export function cascadeThreshold(firstCost: number, secondCost: number, budget: number): number | undefined {
  if (![firstCost, secondCost, budget].every(finite) || firstCost > budget) return undefined;
  return secondCost === 0 ? 0 : Math.max(0, Math.min(1, 1 - (budget - firstCost) / secondCost));
}
function normal(random: () => number): number {
  const x = random(), y = random();
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= 1 || y < 0 || y >= 1) throw new RangeError("Invalid routing random source");
  return Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, x))) * Math.cos(2 * Math.PI * y);
}

/** Pure task utility, parent gate, verified cascade and safe contextual Thompson sampling. */
export function selectChildProviderV2(input: {
  readonly task: ChildSelectionTask;
  readonly features: TaskFeatures;
  readonly parent: { readonly provider: string; readonly model: string };
  readonly candidates: readonly ChildProviderCandidate[];
  readonly outcomes?: ChildRoutingSnapshot;
  readonly abilities?: readonly ModelAbility[];
  readonly preferences?: RoutingPreferences;
  readonly verification?: RoutingVerification;
  readonly override?: { readonly provider: string; readonly model: string };
  readonly nowMs?: number;
  readonly random?: () => number;
  readonly handoffTokens?: number;
  readonly handoffLatencyMs?: number;
}): V2Selection {
  const { task, features } = input;
  const { lambda, mu } = utilityWeights(input.preferences, task.maxCostUsd);
  const now = input.nowMs ?? Date.now();
  const handoffTokens = input.handoffTokens ?? 512;
  const handoffLatencyMs = input.handoffLatencyMs ?? 750;
  const rejected: { provider: string; model: string; reason: string }[] = [];
  const ranked: V2Candidate[] = [];
  const finish = (selected: V2Candidate | undefined, mode: V2Selection["mode"], reason: string,
    cascade?: V2Selection["cascade"]): V2Selection => ({ ...(selected ? { selected: { ...selected, reason } } : {}),
    ranked: selected ? [{ ...selected, reason }, ...ranked.filter(item => pairKey(item) !== pairKey(selected))] : [],
    rejected, reason, mode, lambda, mu, ...(cascade ? { cascade } : {}) });
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    const key = pairKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const reject = (reason: string) => rejected.push({ provider: candidate.provider, model: candidate.model, reason });
    if (!validFeatures(features) || !finite(task.inputTokens) || !finite(task.outputTokens) || task.outputTokens < 1 ||
        !finite(task.expectedModelCalls ?? 1) || (task.expectedModelCalls ?? 1) < 1 ||
        (task.maxCostUsd !== undefined && !finite(task.maxCostUsd)) || !finite(now) ||
        !finite(handoffTokens) || !finite(handoffLatencyMs)) { reject("invalid_task_requirements"); continue; }
    if (input.override && key !== pairKey(input.override)) { reject("explicit_override"); continue; }
    if (!candidate.allowed) { reject("provider_not_allowed"); continue; }
    if (!candidate.connected) { reject("provider_not_connected"); continue; }
    const health = input.outcomes?.health.find(item => item.provider === candidate.provider);
    if (health?.blockedReason) { reject(health.blockedReason); continue; }
    if (health && health.cooldownUntilMs > now) { reject("provider_cooldown"); continue; }
    if (task.requiresTools && !candidate.supportsToolUse) { reject("client_tools_unsupported"); continue; }
    if (task.requiresVision && !candidate.supportsVision) { reject("vision_unsupported"); continue; }
    if (task.requiresReasoning && !candidate.supportsReasoning) { reject("reasoning_unsupported"); continue; }
    const parent = key === pairKey(input.parent);
    const extraTokens = parent ? 0 : handoffTokens;
    if (!finite(candidate.contextWindow) || task.inputTokens + task.outputTokens + extraTokens > candidate.contextWindow * 0.95) {
      reject("context_insufficient"); continue;
    }
    if (!finite(candidate.maxOutputTokens) || task.outputTokens > candidate.maxOutputTokens) { reject("output_limit_insufficient"); continue; }
    // Unknown destinations need either verified local evidence or an explicit request. The active parent is connected evidence.
    const saved = (input.abilities ?? input.outcomes?.abilities)?.find(item => item.provider === candidate.provider &&
      item.model === candidate.model && item.skill === features.skill && validAbility(item));
    const verified = saved !== undefined && saved.observations >= MIN_VERIFIED_OBSERVATIONS;
    if (!parent && !input.override && !verified && !childModelProfile(candidate.provider, candidate.model)) { reject("model_profile_unknown"); continue; }
    const ability = saved ?? abilityPrior(candidate.provider, candidate.model, features.skill);
    // A handoff needs evidence that the model is adequate for this task: the
    // maintained tier for its kind must meet the complexity floor. The floor
    // binds the parent too; a parent of unknown quality stays eligible.
    const adequacy = childTierQuality(candidate, task, input.outcomes, now) ??
      (verified ? sigmoid(ability.mean - REFERENCE_DIFFICULTY) : undefined);
    if (!input.override && adequacy !== undefined && !(adequacy >= CHILD_QUALITY_FLOOR[task.complexity])) {
      reject("quality_below_task_floor"); continue;
    }
    const predicted = predictSuccess(ability, features);
    // Infrastructure reliability is separate from the ability posterior.
    const availabilityRows = input.outcomes?.aggregates.filter(item => item.provider === candidate.provider && item.model === candidate.model &&
      finite(item.attempts) && finite(item.infrastructureFailures) && item.infrastructureFailures <= item.attempts) ?? [];
    const attempts = availabilityRows.reduce((sum, row) => sum + row.attempts, 0);
    const failures = availabilityRows.reduce((sum, row) => sum + row.infrastructureFailures, 0);
    const availability = (4 + attempts - failures) / (4 + attempts);
    const quality = { mean: predicted.mean * availability, lower: predicted.lower * availability, upper: predicted.upper * availability };
    const cost = estimateChildCandidateCost(candidate, task);
    const withHandoff = estimateChildCandidateCost(candidate, { ...task, inputTokens: task.inputTokens + extraTokens });
    if (cost === undefined && (task.maxCostUsd !== undefined || candidate.billingSource !== "sign_in")) { reject("price_unknown"); continue; }
    const handoffCostUsd = withHandoff === undefined ? 0 : Math.max(0, withHandoff - cost!);
    if (task.maxCostUsd !== undefined && (withHandoff === undefined || withHandoff > task.maxCostUsd)) { reject("task_budget_insufficient"); continue; }
    const rows = input.outcomes?.aggregates.filter(item => item.provider === candidate.provider && item.model === candidate.model &&
      item.taskKind === task.kind && item.latencySamples > 0 && finite(item.latencyTotalMs)) ?? [];
    const samples = rows.reduce((sum, row) => sum + row.latencySamples, 0);
    const latency = rows.reduce((sum, row) => sum + row.latencyTotalMs, 0);
    const estimatedLatencyMs = samples >= 3 ? latency / samples : (childModelProfile(candidate.provider, candidate.model)?.latencyMs ?? 30_000) * (task.expectedModelCalls ?? 1);
    ranked.push({ provider: candidate.provider, model: candidate.model, ability, verified,
      ...(adequacy !== undefined ? { adequacy } : {}), quality: quality.mean,
      lowerQuality: quality.lower, upperQuality: quality.upper, ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
      estimatedLatencyMs, handoffCostUsd, handoffLatencyMs: parent ? 0 : handoffLatencyMs,
      // Unknown subscription dollars cannot be used to claim a cost advantage.
      score: quality.mean - lambda * (cost ?? 0) - mu * estimatedLatencyMs / 1000,
      reason: "" });
  }
  const cheaper = (a: V2Candidate, b: V2Candidate): number =>
    (a.estimatedCostUsd ?? Number.POSITIVE_INFINITY) - (b.estimatedCostUsd ?? Number.POSITIVE_INFINITY);
  // Least expensive first, with or without a cap. When the parent cannot
  // take the task, the least expensive adequate model does, so a cap can
  // only make the choice cheaper. Only verified outcomes, weighed below, can
  // justify a more expensive one.
  ranked.sort((a, b) => cheaper(a, b) || b.score - a.score || pairKey(a).localeCompare(pairKey(b)));
  if (!ranked.length) return finish(undefined, "unavailable", "No connected and allowed model meets this task's requirements.");
  if (input.override) return finish(ranked[0], "override", `${pairKey(ranked[0]!)} is your override; capability and spend checks passed.`);
  const parent = ranked.find(item => pairKey(item) === pairKey(input.parent));
  let selected = parent ?? ranked[0]!;
  let mode: V2Selection["mode"] = parent ? "parent" : "utility";
  const handoffPenalty = (item: V2Candidate) => lambda * item.handoffCostUsd + mu * item.handoffLatencyMs / 1000 + 0.01;
  for (const item of ranked) {
    if (pairKey(item) === pairKey(selected)) continue;
    if (downgradesHardTask(task, item, selected)) continue;
    // Use a modest uncertainty penalty in addition to actual context and latency overhead.
    const risk = 0.1 * ((item.upperQuality - item.lowerQuality) + (selected.upperQuality - selected.lowerQuality));
    // Maintained tiers establish adequacy, not superiority: a higher predicted
    // quality is a reason to move only when verified local outcomes support it.
    const qualityDelta = item.quality - selected.quality;
    const qualityGain = qualityDelta > 0 && !verifiedBetter(item, selected) ? 0 : qualityDelta;
    // Comparing unknown dollars may not move a subscription parent for an imagined saving.
    const priceGain = item.estimatedCostUsd !== undefined && selected.estimatedCostUsd !== undefined
      ? lambda * (selected.estimatedCostUsd - item.estimatedCostUsd) : 0;
    const gain = qualityGain + priceGain + mu * (selected.estimatedLatencyMs - item.estimatedLatencyMs) / 1000;
    if (gain > handoffPenalty(item) + risk) { selected = item; mode = "utility"; }
  }
  const verifier = input.verification;
  if (verifier?.available && verifier.retrySafe && finite(verifier.costUsd) && finite(verifier.latencyMs)) {
    const target = verifier.targetQuality ?? 0.9;
    const plans: NonNullable<V2Selection["cascade"]>[] = [];
    if (Number.isFinite(target) && target > 0 && target <= 1) for (const first of ranked) for (const second of ranked) {
      // The parent is the escalation anchor. Sparse paired outcomes must not
      // send a failed task wandering through unrelated providers.
      if (parent !== undefined && pairKey(second) !== pairKey(parent)) continue;
      if (pairKey(first) === pairKey(second) || first.estimatedCostUsd === undefined || second.estimatedCostUsd === undefined) continue;
      if (downgradesHardTask(task, first, second)) continue;
      const recovered = conditionalRecovery(pairKey(first), pairKey(second), verifier.conditional);
      const quality = first.quality + (1 - first.quality) * recovered;
      // As for a direct handoff, a tier alone supports no plan: paired
      // recovery outcomes, or verified outcomes showing the first model does
      // better than the current choice, must back it.
      if (recovered === 0 && !verifiedBetter(first, selected)) continue;
      const c1 = first.estimatedCostUsd + first.handoffCostUsd + verifier.costUsd;
      const c2 = second.estimatedCostUsd + second.handoffCostUsd + verifier.costUsd;
      const worstCaseCostUsd = c1 + c2;
      // Reserve the entire possible chain. Expected cost is never a hard admission ceiling.
      if (task.maxCostUsd !== undefined && worstCaseCostUsd > task.maxCostUsd) continue;
      if (first.quality < 0.65 || quality < target) continue;
      const expectedCostUsd = c1 + (1 - first.quality) * c2;
      const expectedLatencyMs = first.estimatedLatencyMs + first.handoffLatencyMs + verifier.latencyMs +
        (1 - first.quality) * (second.estimatedLatencyMs + second.handoffLatencyMs + verifier.latencyMs);
      plans.push({ candidates: [first, second], expectedCostUsd, expectedLatencyMs, worstCaseCostUsd, quality });
    }
    plans.sort((a, b) => a.expectedCostUsd - b.expectedCostUsd || a.expectedLatencyMs - b.expectedLatencyMs);
    const plan = plans.find(item => item.quality - lambda * item.expectedCostUsd - mu * item.expectedLatencyMs / 1000 > selected.score + 0.01);
    if (plan) return finish(plan.candidates[0], "cascade", `${pairKey(plan.candidates[0]!)} first; verify locally and try ${pairKey(plan.candidates[1]!)} only on failure (expected $${plan.expectedCostUsd.toFixed(4)}).`, plan);
  }
  // Contextual Thompson sampling within a conservative loss envelope, off unless opted in.
  const maxLoss = input.preferences?.maxExpectedLoss ?? 0.01;
  if (input.preferences?.explore && parent && finite(maxLoss) && maxLoss <= 0.05 && selected.ability.observations >= MIN_VERIFIED_OBSERVATIONS) {
    let bestSample = -Infinity;
    let explored = selected;
    for (const candidate of ranked) {
      if (candidate.ability.observations < MIN_VERIFIED_OBSERVATIONS || candidate.estimatedCostUsd === undefined || selected.estimatedCostUsd === undefined) continue;
      if (pairKey(candidate) !== pairKey(selected) && downgradesHardTask(task, candidate, selected)) continue;
      const conservativeLoss = selected.upperQuality - candidate.lowerQuality +
        lambda * Math.max(0, candidate.estimatedCostUsd + candidate.handoffCostUsd - selected.estimatedCostUsd) +
        mu * Math.max(0, candidate.estimatedLatencyMs + candidate.handoffLatencyMs - selected.estimatedLatencyMs) / 1000;
      if (pairKey(candidate) !== pairKey(selected) && conservativeLoss > maxLoss) continue;
      const theta = candidate.ability.mean + Math.sqrt(candidate.ability.variance) * normal(input.random ?? Math.random);
      const sample = sigmoid(features.discrimination * (theta - features.difficulty)) - lambda * (candidate.estimatedCostUsd + candidate.handoffCostUsd) -
        mu * (candidate.estimatedLatencyMs + candidate.handoffLatencyMs) / 1000;
      if (sample > bestSample) { bestSample = sample; explored = candidate; }
    }
    if (pairKey(explored) !== pairKey(selected)) { selected = explored; mode = "explore"; }
  }
  const estimate = selected.estimatedCostUsd === undefined ? "subscription dollars unknown" : `$${selected.estimatedCostUsd.toFixed(4)}`;
  const parentBelowFloor = rejected.some(item => pairKey(item) === pairKey(input.parent) && item.reason === "quality_below_task_floor");
  const leastExpensive = parent === undefined && pairKey(selected) === pairKey(ranked[0]!);
  const reason = mode === "parent" ? `Keep ${pairKey(selected)}; expected delegation gain does not cover handoff and uncertainty.`
    : mode === "explore" ? `${pairKey(selected)} is a bounded local exploration within your spend cap.`
    : leastExpensive && parentBelowFloor
      ? `${pairKey(selected)} is the least expensive model rated for this ${task.complexity} ${task.kind} task, and your model is not (estimated ${estimate}).`
    : leastExpensive ? `${pairKey(selected)} is the least expensive model that meets this task's requirements (estimated ${estimate}).`
    : `${pairKey(selected)} has the highest supported task utility after handoff cost (estimated ${estimate}).`;
  return finish(selected, mode, reason);
}

/**
 * Enough verified outcomes put the destination's lower 95% bound above the
 * current choice's expected quality. One lucky pass, or a tier prior, never does.
 */
function verifiedBetter(destination: V2Candidate, current: V2Candidate): boolean {
  return destination.ability.observations >= MIN_VERIFIED_OBSERVATIONS && destination.lowerQuality > current.quality;
}

/**
 * A hard task never moves to a model rated below the current choice, nor away
 * from one whose rating is unknown.
 */
function downgradesHardTask(task: ChildSelectionTask, destination: V2Candidate, current: V2Candidate): boolean {
  return task.complexity === "hard" && (destination.adequacy === undefined || current.adequacy === undefined ||
    destination.adequacy < current.adequacy);
}
