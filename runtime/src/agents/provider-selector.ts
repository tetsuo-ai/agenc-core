import { selectCallRates } from "../session/cost.js";
import { childModelProfile, CHILD_ROUTING_PROFILE_REVISION } from "./provider-selector-profiles.js";
import type {
  ChildProviderCandidate, ChildRoutingSnapshot, ChildSelectionResult, ChildSelectionTask,
  ChildTaskComplexity, ChildTaskKind, RankedChildCandidate,
} from "./provider-selector-types.js";

export * from "./provider-selector-types.js";

const QUALITY_FLOOR = { simple: 0.65, standard: 0.80, hard: 0.92 } as const;
const PRIOR_WEIGHT = 12;
const OBSERVATION_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;

/** Local hints only. Callers can provide explicit task requirements instead. */
export function classifyChildTask(text: string, role?: string): { kind: ChildTaskKind; complexity: ChildTaskComplexity } {
  const value = `${role ?? ""}\n${text}`.toLowerCase();
  const kind: ChildTaskKind = /\b(review|audit|inspect|reviewer)\b/u.test(value) ? "review"
    : /\b(implement|debug|refactor|coding|code|bug|patch|test|worker)\b/u.test(value) ? "coding"
    : /\b(prove|proof|reason|reasoning|mathematical|planner|design|plan)\b/u.test(value) ? "reasoning"
    : /\b(research|sources|search|compare|investigate)\b/u.test(value) ? "research"
    : /\b(extract|classify|format|translate|summarize|summary|list|count)\b/u.test(value) ? "extraction"
    : "general";
  const complexity: ChildTaskComplexity = /\b(complex|hard|difficult|architecture|security|concurrency|cryptograph\w*|proof|prove|comprehensive)\b/u.test(value)
    ? "hard" : /\b(simple|short|brief|small|trivial|format|count|extract|classify)\b/u.test(value)
      ? "simple" : "standard";
  return { kind, complexity };
}

function nonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Estimate only. The execution admission kernel still owns the spending boundary. */
export function estimateChildCandidateCost(candidate: ChildProviderCandidate, task: ChildSelectionTask): number | undefined {
  const entry = candidate.cost;
  if (entry === undefined || entry.costEstimated === true) return undefined;
  const pricing = selectCallRates(entry, {
    ...(candidate.serviceTier === "priority" || candidate.serviceTier === "fast" ? { speed: "fast" } : {}),
    singleCallInputTokens: task.inputTokens,
  });
  const rates = pricing.rates;
  if (!pricing.documented || rates.costEstimated === true || !nonNegative(rates.inputUsdPer1K) ||
      !nonNegative(rates.outputUsdPer1K) ||
      (rates.inputUsdPer1K === 0 && rates.outputUsdPer1K === 0 && rates.localZeroCost !== true)) return undefined;
  const estimate = (task.inputTokens * rates.inputUsdPer1K + task.outputTokens * rates.outputUsdPer1K) /
    1_000 * (task.expectedModelCalls ?? 1);
  return nonNegative(estimate) ? estimate : undefined;
}

/** Hard filters first, then the cheapest sufficient quality with a latency tradeoff. */
export function selectChildProvider(input: {
  readonly task: ChildSelectionTask;
  readonly candidates: readonly ChildProviderCandidate[];
  readonly outcomes?: ChildRoutingSnapshot;
  readonly nowMs?: number;
  readonly override?: { readonly provider: string; readonly model: string };
}): ChildSelectionResult {
  const { task } = input;
  const now = input.nowMs ?? Date.now();
  const rejected: { provider: string; model: string; reason: string }[] = [];
  const viable: RankedChildCandidate[] = [];
  const validTask = nonNegative(task.inputTokens) && nonNegative(task.outputTokens) && task.outputTokens > 0 &&
    nonNegative(task.expectedModelCalls ?? 1) && (task.expectedModelCalls ?? 1) >= 1 &&
    (task.maxCostUsd === undefined || nonNegative(task.maxCostUsd)) &&
    Number.isFinite(now) && QUALITY_FLOOR[task.complexity] !== undefined;
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    const key = `${candidate.provider}\u0000${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reject = (reason: string) => { rejected.push({ provider: candidate.provider, model: candidate.model, reason }); };
    if (!validTask) { reject("invalid_task_requirements"); continue; }
    if (input.override !== undefined && (candidate.provider !== input.override.provider || candidate.model !== input.override.model)) {
      reject("explicit_override"); continue;
    }
    if (!candidate.allowed) { reject("provider_not_allowed"); continue; }
    if (!candidate.connected) { reject("provider_not_connected"); continue; }
    const health = input.outcomes?.health.find(item => item.provider === candidate.provider);
    if (health?.blockedReason !== undefined) { reject(health.blockedReason); continue; }
    if (health !== undefined && health.cooldownUntilMs > now) { reject("provider_cooldown"); continue; }
    if (task.requiresTools && !candidate.supportsToolUse) { reject("client_tools_unsupported"); continue; }
    if (task.requiresVision && !candidate.supportsVision) { reject("vision_unsupported"); continue; }
    if (task.requiresReasoning && !candidate.supportsReasoning) { reject("reasoning_unsupported"); continue; }
    if (!nonNegative(candidate.contextWindow) || task.inputTokens + task.outputTokens > candidate.contextWindow * 0.95) {
      reject("context_insufficient"); continue;
    }
    if (!nonNegative(candidate.maxOutputTokens) || candidate.maxOutputTokens < task.outputTokens) {
      reject("output_limit_insufficient"); continue;
    }
    const profile = childModelProfile(candidate.provider, candidate.model);
    if (profile === undefined && input.override === undefined) { reject("model_profile_unknown"); continue; }
    const aggregate = input.outcomes?.aggregates.find(item => item.provider === candidate.provider && item.model === candidate.model &&
      item.taskKind === task.kind && item.complexity === task.complexity && item.profileRevision === CHILD_ROUTING_PROFILE_REVISION);
    // Old observations fade toward the prior, and a small sample cannot dominate it.
    const decay = aggregate === undefined ? 0 : Math.pow(0.5, Math.max(0, now - aggregate.lastObservedAtMs) / OBSERVATION_HALF_LIFE_MS);
    const observed = aggregate === undefined ? 0 : aggregate.qualityObservations * decay;
    const prior = profile?.quality[task.kind] ?? 0.5;
    const quality = (prior * PRIOR_WEIGHT + (aggregate?.qualitySuccesses ?? 0) * decay) / (PRIOR_WEIGHT + observed);
    if (!Number.isFinite(quality) || (quality < QUALITY_FLOOR[task.complexity] && input.override === undefined)) {
      reject("quality_below_task_floor"); continue;
    }
    const executionObservations = aggregate === undefined ? 0 : (aggregate.attempts - aggregate.infrastructureFailures) * decay;
    const completionReliability = (0.95 * PRIOR_WEIGHT + (aggregate?.successes ?? 0) * decay) /
      (PRIOR_WEIGHT + executionObservations);
    if (executionObservations >= 3 && completionReliability < 0.6 && input.override === undefined) {
      reject("completion_reliability_low"); continue;
    }
    let estimatedCostUsd = estimateChildCandidateCost(candidate, task);
    if (aggregate !== undefined && aggregate.costSamples >= 3 && nonNegative(aggregate.costTotalUsd)) {
      // Prior runs can reveal extra calls/tool-result context that a token-only estimate missed.
      const observedCost = aggregate.costTotalUsd / aggregate.costSamples;
      if (estimatedCostUsd !== undefined) estimatedCostUsd = Math.max(estimatedCostUsd, observedCost * decay);
    }
    if (estimatedCostUsd === undefined && (task.maxCostUsd !== undefined || input.override === undefined)) {
      reject("price_unknown"); continue;
    }
    if (task.maxCostUsd !== undefined && estimatedCostUsd! > task.maxCostUsd) { reject("task_budget_insufficient"); continue; }
    const priorLatency = (profile?.latencyMs ?? 60_000) * (task.expectedModelCalls ?? 1);
    const estimatedLatencyMs = aggregate !== undefined && aggregate.latencySamples >= 3 && nonNegative(aggregate.latencyTotalMs)
      ? (priorLatency * PRIOR_WEIGHT + aggregate.latencyTotalMs * decay) / (PRIOR_WEIGHT + aggregate.latencySamples * decay)
      : priorLatency;
    // Latency has a small dollar-equivalent weight, increased for explicit fast preference.
    const latencyCost = estimatedLatencyMs / 1_000 * (task.latencyPreference === "fast" ? 0.001 : 0.00002);
    const score = quality * completionReliability / ((estimatedCostUsd ?? 1) + latencyCost + 0.00001);
    const reason = input.override !== undefined
      ? `${candidate.provider}/${candidate.model} is the requested override.`
      : `${candidate.provider}/${candidate.model} fits this ${task.complexity} ${task.kind} at an estimated $${estimatedCostUsd!.toFixed(4)}.`;
    viable.push({ provider: candidate.provider, model: candidate.model,
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}), estimatedLatencyMs, quality, score, reason });
  }
  viable.sort((left, right) => right.score - left.score ||
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`));
  const selected = viable[0];
  return { ...(selected !== undefined ? { selected } : {}), ranked: viable, rejected,
    reason: selected?.reason ?? (input.override !== undefined ? "The requested model does not meet this task's requirements." :
      "No connected and allowed model meets this task's requirements.") };
}
