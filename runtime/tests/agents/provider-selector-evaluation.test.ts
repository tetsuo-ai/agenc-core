import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateChildProviderSelector } from "../../src/agents/provider-selector-evaluation.js";
import type { ChildSelectorEvaluationFixture } from "../../src/agents/provider-selector-evaluation.js";

const fixture = JSON.parse(readFileSync(new URL("../../eval/provider-selector-policy/fixtures.json", import.meta.url), "utf8")) as ChildSelectorEvaluationFixture;

describe("held-out synthetic child routing policy replay", () => {
  it("reports policy outcomes separately from live provider measurements", () => {
    const report = evaluateChildProviderSelector(fixture);
    expect(report.provenance).toBe("synthetic-policy-only");
    const selector = report.scores[0]!;
    expect(selector).toMatchObject({ strategy: "selector", covered: 12, passed: 12, expectedChoiceMatches: 12, costUsd: 0.06 });
    for (const baseline of report.scores.slice(1)) {
      expect(selector.passedPerDollar).toBeGreaterThan(baseline.passedPerDollar!);
    }
  });

  it("does not count missing outcomes as successes or coverage", () => {
    const report = evaluateChildProviderSelector({ ...fixture, outcomes: {} });
    expect(report.scores.every(score => score.covered === 0 && score.passed === 0 && score.passedPerDollar === null)).toBe(true);
  });
});
