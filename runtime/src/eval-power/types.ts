import type { Sha256Digest } from "../eval-contract/index.js";

export const EVAL_POWER_ANALYSIS_VERSION = "1.0.0" as const;
export const EVAL_POWER_ALPHA = "0.05" as const;
export const EVAL_POWER_TARGET = "0.80" as const;
export const EVAL_POWER_MINIMUM_EFFECT = 0.1 as const;
export const EVAL_POWER_MINIMUM_PILOT_TASKS = 30 as const;
export const EVAL_POWER_MINIMUM_PILOT_REPOSITORIES = 15 as const;
export const EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS = 50 as const;
export const EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES = 20 as const;
export const EVAL_POWER_MINIMUM_REPETITIONS = 3 as const;
export const EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS = 5 as const;

export type BinaryOutcome = 0 | 1;

/** One paired trial from a blinded pilot result set. */
export interface PairedPilotBinaryOutcome {
  readonly comparisonId: string;
  readonly comparatorSystemId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly trialId: string;
  readonly primaryOutcome: BinaryOutcome;
  readonly comparatorOutcome: BinaryOutcome;
}

export interface PowerAnalysisInput {
  readonly analysisId: string;
  readonly pilotId: string;
  readonly createdAt: string;
  readonly primarySystemId: string;
  readonly outcomes: readonly PairedPilotBinaryOutcome[];
  readonly candidateTaskCounts: readonly number[];
  readonly confirmatoryRepositoryCount: number;
  readonly confirmatoryRepetitionsPerSystemTask: number;
  /** Explicit alternative used to choose N; sensitivity cells remain diagnostic. */
  readonly planningEffectSize: number;
  readonly assumedEffectSizes: readonly number[];
  readonly heterogeneityMultipliers: readonly number[];
  readonly simulationReplications: number;
  readonly randomSeed: number;
}

export interface PilotComparisonSummary {
  readonly comparisonId: string;
  readonly comparatorSystemId: string;
  readonly primaryTaskMeanSuccessRate: number;
  readonly comparatorTaskMeanSuccessRate: number;
  readonly pairedDifferenceTaskWeighted: number;
  readonly pairedDifferenceRepositoryWeighted: number;
  readonly repositoryBetweenVariance: number;
  readonly withinRepositoryVariance: number;
  readonly empiricalRepositoryVarianceShare: number;
}

export interface PowerEstimate {
  readonly successes: number;
  readonly replications: number;
  readonly estimate: number;
  readonly monteCarloStandardError: number;
  readonly wilsonLower95: number;
  readonly wilsonUpper95: number;
}

export interface InterceptOnlyCr2Inference {
  readonly estimate: number;
  readonly standardError: number;
  readonly degreesOfFreedom: number;
  readonly lower95: number;
  readonly upper95: number;
}

export interface SensitivityCell {
  readonly assumedPairedDifference: number;
  readonly heterogeneityMultiplier: number;
  readonly taskCount: number;
  readonly repositoryCount: number;
  readonly comparisonPower: readonly {
    readonly comparisonId: string;
    readonly power: PowerEstimate;
  }[];
  /** Intersection probability: every preregistered comparator succeeds. */
  readonly intersectionPower: PowerEstimate;
}

export interface FixedConfirmatoryPlan {
  readonly taskCount: number;
  readonly repositoryCount: number;
  readonly repetitionsPerSystemTask: number;
  readonly stoppingRule: {
    readonly kind: "fixed";
    readonly taskCount: number;
    readonly interimLooks: 0;
    readonly optionalStopping: false;
  };
}

export interface PowerAnalysisDocument {
  readonly kind: "agenc.eval.power-analysis";
  readonly analysisVersion: typeof EVAL_POWER_ANALYSIS_VERSION;
  readonly documentDigest: Sha256Digest;
  readonly analysisId: string;
  readonly pilotId: string;
  readonly createdAt: string;
  readonly primarySystemId: string;
  readonly pilot: {
    readonly inputDigest: Sha256Digest;
    readonly taskCount: number;
    readonly repositoryCount: number;
    readonly comparisonCount: number;
    readonly minimumRepetitionsPerTaskComparison: number;
    readonly maximumRepetitionsPerTaskComparison: number;
    readonly contractMinimumRepetitionsPerTaskComparison: typeof EVAL_POWER_MINIMUM_REPETITIONS;
    readonly recommendedRepetitionsPerTaskComparison: typeof EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS;
    readonly repetitionRecommendation: "met" | "accepted_contract_minimum_below_recommended";
    readonly aggregation: "mean_within_task_then_equal_task_weight";
    readonly repositoryTaskCounts: readonly {
      readonly repositoryId: string;
      readonly taskCount: number;
    }[];
    readonly comparisons: readonly PilotComparisonSummary[];
  };
  readonly design: {
    readonly alpha: typeof EVAL_POWER_ALPHA;
    readonly targetPower: typeof EVAL_POWER_TARGET;
    readonly minimumEffect: typeof EVAL_POWER_MINIMUM_EFFECT;
    readonly primaryMetric: "paired_binary_success_rate_difference";
    readonly inference: "bias_reduced_linearization_cr2";
    readonly degreesOfFreedom: "bell_mccaffrey_satterthwaite_intercept_only";
    readonly inferenceUnit: "task_mean_after_repetition_aggregation";
    readonly clusteringUnit: "repository";
    readonly multipleComparators: "intersection_union";
    readonly successRule: "point_at_least_minimum_effect_and_two_sided_lower_bound_above_zero_for_every_comparator";
    readonly planningEffectSize: number;
    readonly candidateTaskCounts: readonly number[];
    readonly confirmatoryRepositoryCount: number;
    readonly confirmatoryRepetitionsPerSystemTask: number;
    readonly confirmatoryRepositoryCapPercent: 10;
    readonly optionalStopping: false;
  };
  readonly simulation: {
    readonly method: "hierarchical_repository_task_joint_attempt_bootstrap";
    readonly attemptModel: "empirical_joint_multinomial_with_minimal_marginal_transport";
    readonly sensitivityModel: "bounded_location_shift_of_paired_attempt_means";
    readonly outcomeDependence: "shared_primary_and_joint_comparator_attempt_resampling";
    readonly repetitionAggregation: "mean_within_task_before_repository_inference";
    readonly repositorySampling: "uniform_with_replacement";
    readonly taskSamplingWithinRepository: "uniform_with_replacement";
    readonly commonRandomNumbersAcrossSensitivityCells: true;
    readonly simulationReplications: number;
    readonly randomSeed: number;
    readonly randomStream: "sha256_domain_seeded_xorshift32_rejection_sampling_v1";
    readonly confidenceCriticalValue: "student_t_cornish_fisher_satterthwaite_df";
    readonly powerDecisionInterval: "two_sided_wilson_95";
  };
  readonly sensitivityGrid: readonly SensitivityCell[];
  readonly decision: {
    readonly status: "adequately_powered" | "no_candidate_meets_target";
    readonly rule: "smallest_fixed_n_whose_intersection_power_wilson_lower_95_meets_target_at_planning_effect_across_heterogeneity_grid";
    readonly confirmatoryPlan: FixedConfirmatoryPlan | null;
  };
}
