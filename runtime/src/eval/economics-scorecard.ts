export interface EconomicsScenarioRecord {
  readonly scenarioId: string;
  readonly passed: boolean;
  readonly tokenCeilingRespected: boolean;
  readonly latencyCeilingRespected: boolean;
  readonly spendCeilingRespected: boolean;
  readonly negativeEconomicsApplicable: boolean;
  readonly delegationDeniedOnNegativeEconomics: boolean;
  readonly degradedProviderRerouteApplicable: boolean;
  readonly reroutedUnderDegradedProvider: boolean;
  readonly spendUnits: number;
  readonly latencyMs: number;
}

export interface EconomicsScorecard {
  readonly scenarioCount: number;
  readonly passingScenarios: number;
  readonly passRate: number;
  readonly tokenCeilingComplianceRate: number;
  readonly latencyCeilingComplianceRate: number;
  readonly spendCeilingComplianceRate: number;
  readonly negativeEconomicsApplicableCount: number;
  readonly negativeEconomicsDelegationDenialRate: number;
  readonly degradedProviderRerouteApplicableCount: number;
  readonly degradedProviderRerouteRate: number;
  readonly meanSpendUnits: number;
  readonly meanLatencyMs: number;
  readonly scenarios: readonly EconomicsScenarioRecord[];
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function safeComplianceRate(numerator: number, denominator: number): number {
  // When no records apply to a compliance dimension, the dimension is
  // vacuously compliant. Returning 0 here flagged scenarios that simply did
  // not exercise the dimension as failing, which is wrong: a scorecard for a
  // run that never had to enforce delegation denials cannot fail the
  // delegation-denial rate.
  if (!Number.isFinite(denominator) || denominator <= 0) return 1;
  return numerator / denominator;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeEconomicsScorecard(
  records: readonly EconomicsScenarioRecord[],
): EconomicsScorecard {
  const negativeEconomicsApplicable = records.filter(
    (record) => record.negativeEconomicsApplicable,
  );
  const degradedProviderApplicable = records.filter(
    (record) => record.degradedProviderRerouteApplicable,
  );

  return {
    scenarioCount: records.length,
    passingScenarios: records.filter((record) => record.passed).length,
    passRate: safeRatio(
      records.filter((record) => record.passed).length,
      records.length,
    ),
    tokenCeilingComplianceRate: safeRatio(
      records.filter((record) => record.tokenCeilingRespected).length,
      records.length,
    ),
    latencyCeilingComplianceRate: safeRatio(
      records.filter((record) => record.latencyCeilingRespected).length,
      records.length,
    ),
    spendCeilingComplianceRate: safeRatio(
      records.filter((record) => record.spendCeilingRespected).length,
      records.length,
    ),
    negativeEconomicsApplicableCount: negativeEconomicsApplicable.length,
    negativeEconomicsDelegationDenialRate: safeComplianceRate(
      negativeEconomicsApplicable.filter(
        (record) => record.delegationDeniedOnNegativeEconomics,
      ).length,
      negativeEconomicsApplicable.length,
    ),
    degradedProviderRerouteApplicableCount: degradedProviderApplicable.length,
    degradedProviderRerouteRate: safeComplianceRate(
      degradedProviderApplicable.filter(
        (record) => record.reroutedUnderDegradedProvider,
      ).length,
      degradedProviderApplicable.length,
    ),
    meanSpendUnits: average(records.map((record) => record.spendUnits)),
    meanLatencyMs: average(records.map((record) => record.latencyMs)),
    scenarios: records.slice(),
  };
}
