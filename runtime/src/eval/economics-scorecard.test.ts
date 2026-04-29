import { describe, expect, it } from "vitest";

import { computeEconomicsScorecard } from "./economics-scorecard.js";

describe("economics scorecard", () => {
  it("grades negative-economics denial and reroute only on applicable scenarios", () => {
    const scorecard = computeEconomicsScorecard([
      {
        scenarioId: "token_ceiling_enforced",
        passed: true,
        tokenCeilingRespected: true,
        latencyCeilingRespected: true,
        spendCeilingRespected: true,
        negativeEconomicsApplicable: false,
        delegationDeniedOnNegativeEconomics: false,
        degradedProviderRerouteApplicable: false,
        reroutedUnderDegradedProvider: false,
        spendUnits: 0.2,
        latencyMs: 1,
      },
      {
        scenarioId: "negative_economics_delegation_denial",
        passed: true,
        tokenCeilingRespected: true,
        latencyCeilingRespected: true,
        spendCeilingRespected: true,
        negativeEconomicsApplicable: true,
        delegationDeniedOnNegativeEconomics: true,
        degradedProviderRerouteApplicable: false,
        reroutedUnderDegradedProvider: false,
        spendUnits: 0.1,
        latencyMs: 1,
      },
      {
        scenarioId: "degraded_provider_reroute",
        passed: true,
        tokenCeilingRespected: true,
        latencyCeilingRespected: true,
        spendCeilingRespected: true,
        negativeEconomicsApplicable: false,
        delegationDeniedOnNegativeEconomics: false,
        degradedProviderRerouteApplicable: true,
        reroutedUnderDegradedProvider: true,
        spendUnits: 0.4,
        latencyMs: 1,
      },
    ]);

    expect(scorecard.negativeEconomicsApplicableCount).toBe(1);
    expect(scorecard.negativeEconomicsDelegationDenialRate).toBe(1);
    expect(scorecard.degradedProviderRerouteApplicableCount).toBe(1);
    expect(scorecard.degradedProviderRerouteRate).toBe(1);
  });

  it("treats non-applicable economics controls as compliant rather than failing", () => {
    const scorecard = computeEconomicsScorecard([
      {
        scenarioId: "token_ceiling_enforced",
        passed: true,
        tokenCeilingRespected: true,
        latencyCeilingRespected: true,
        spendCeilingRespected: true,
        negativeEconomicsApplicable: false,
        delegationDeniedOnNegativeEconomics: false,
        degradedProviderRerouteApplicable: false,
        reroutedUnderDegradedProvider: false,
        spendUnits: 0.2,
        latencyMs: 1,
      },
    ]);

    expect(scorecard.negativeEconomicsApplicableCount).toBe(0);
    expect(scorecard.negativeEconomicsDelegationDenialRate).toBe(1);
    expect(scorecard.degradedProviderRerouteApplicableCount).toBe(0);
    expect(scorecard.degradedProviderRerouteRate).toBe(1);
  });
});
