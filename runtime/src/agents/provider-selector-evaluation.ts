import { estimateChildCandidateCost, selectChildProvider } from "./provider-selector.js";
import type { ChildProviderCandidate, ChildTaskComplexity, ChildTaskKind } from "./provider-selector-types.js";

export interface ChildSelectorEvaluationFixture {
  readonly provenance: "synthetic-policy-only" | "recorded-measurements";
  readonly split: "held-out";
  readonly candidates: readonly ChildProviderCandidate[];
  readonly baselines: { readonly strongest: string; readonly parent: string };
  readonly tasks: readonly {
    readonly id: string;
    readonly kind: ChildTaskKind;
    readonly complexity: ChildTaskComplexity;
    readonly expectedChoice?: string;
    readonly outcomeCase: string;
  }[];
  readonly outcomes: Readonly<Record<string, Readonly<Record<string, {
    readonly passed: boolean;
    readonly costUsd: number;
    readonly latencyMs: number;
  }>>>>;
}

export interface ChildSelectorEvaluationScore {
  readonly strategy: "selector" | "always_strongest" | "always_cheapest" | "fixed_parent";
  readonly tasks: number;
  readonly covered: number;
  readonly passed: number;
  readonly costUsd: number;
  readonly passedPerDollar: number | null;
  readonly totalLatencyMs: number;
  readonly expectedChoiceMatches: number;
}

/** Replay supplied outcomes. No provider calls and no generated success labels. */
export function evaluateChildProviderSelector(fixture: ChildSelectorEvaluationFixture): {
  readonly provenance: ChildSelectorEvaluationFixture["provenance"];
  readonly split: "held-out";
  readonly scores: readonly ChildSelectorEvaluationScore[];
} {
  const strategies = ["selector", "always_strongest", "always_cheapest", "fixed_parent"] as const;
  const scores = strategies.map(strategy => {
    let covered = 0; let passed = 0; let costUsd = 0; let totalLatencyMs = 0; let expectedChoiceMatches = 0;
    for (const entry of fixture.tasks) {
      const task = { kind: entry.kind, complexity: entry.complexity, requiresTools: true, inputTokens: 2_000, outputTokens: 500 };
      const selected = strategy === "selector"
        ? selectChildProvider({ task, candidates: fixture.candidates, nowMs: 0 }).selected
        : undefined;
      const cheapest = [...fixture.candidates].filter(candidate => candidate.allowed && candidate.connected)
        .sort((left, right) => (estimateChildCandidateCost(left, task) ?? Infinity) - (estimateChildCandidateCost(right, task) ?? Infinity))[0];
      const key = strategy === "selector" ? selected === undefined ? undefined : `${selected.provider}/${selected.model}`
        : strategy === "always_strongest" ? fixture.baselines.strongest
          : strategy === "fixed_parent" ? fixture.baselines.parent : cheapest === undefined ? undefined : `${cheapest.provider}/${cheapest.model}`;
      if (key === entry.expectedChoice) expectedChoiceMatches += 1;
      const outcome = key === undefined ? undefined : fixture.outcomes[entry.outcomeCase]?.[key];
      if (outcome === undefined) continue;
      if (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0 || !Number.isFinite(outcome.latencyMs) || outcome.latencyMs < 0) {
        throw new Error(`Invalid evaluation outcome for ${entry.id}`);
      }
      covered += 1; passed += Number(outcome.passed); costUsd += outcome.costUsd; totalLatencyMs += outcome.latencyMs;
    }
    return { strategy, tasks: fixture.tasks.length, covered, passed, costUsd: Number(costUsd.toFixed(8)),
      passedPerDollar: costUsd > 0 ? Number((passed / costUsd).toFixed(4)) : null,
      totalLatencyMs, expectedChoiceMatches };
  });
  return { provenance: fixture.provenance, split: fixture.split, scores };
}
