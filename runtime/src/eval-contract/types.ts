export const EVAL_CONTRACT_VERSION = "1.0.0" as const;

export type EvalContractVersion = typeof EVAL_CONTRACT_VERSION;
export type Sha256Digest = `sha256:${string}`;
export type GitCommit = string;
export type DecimalString = string;

export type EvalSuiteSplit = "development" | "private_holdout";
export type EvalClaim = "diagnostic" | "pilot" | "superiority";

export interface ContentArtifact {
  readonly digest: Sha256Digest;
  readonly sizeBytes: number;
  readonly mediaType: string;
  /** Portable content-addressed URI. Host paths are forbidden. */
  readonly uri: string;
}

export interface KeyedCommitment {
  readonly algorithm: "hmac-sha256";
  readonly keyId: string;
  readonly digest: Sha256Digest;
}

export interface ToolchainPin {
  readonly name: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export interface ToolGrant {
  readonly name: string;
  readonly version: string;
  readonly manifestDigest: Sha256Digest;
  readonly capabilities: readonly ("read" | "write" | "execute" | "network")[];
}

export interface NetworkPolicy {
  readonly mode: "none" | "loopback" | "allowlist";
  readonly allowlist: readonly string[];
  readonly dns: "disabled" | "pinned";
}

export interface PermissionPolicy {
  readonly mode: "deny_by_default";
  readonly policyDigest: Sha256Digest;
  readonly allowedApprovalKinds: readonly string[];
}

export interface TaskBudget {
  readonly currency: "USD";
  /** Decimal string, never a binary float. */
  readonly usd: DecimalString;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly turns: number;
  readonly wallTimeMs: number;
}

export interface ExpectedArtifact {
  readonly id: string;
  readonly path: string;
  readonly mediaType: string;
  readonly required: true;
  readonly maxBytes: number;
}

export interface TaskRepositoryPin {
  readonly uri: string;
  readonly commit: GitCommit;
  readonly cluster: string;
  readonly solutionHistory: "stripped";
}

export interface TaskIssue {
  readonly text: string;
  readonly digest: Sha256Digest;
}

export interface TaskEnvironmentPin {
  readonly image: string;
  readonly platform: string;
  readonly hardwareClass: string;
  readonly toolchain: readonly ToolchainPin[];
}

export interface ResetRecipe {
  readonly id: string;
  readonly digest: Sha256Digest;
  readonly workspace: "fresh_clone";
  readonly cache: "empty";
  readonly memory: "empty";
  readonly session: "new";
  readonly clock: "real" | "fixed";
}

export interface HiddenVerifierPin {
  readonly id: string;
  readonly version: string;
  readonly bundle: ContentArtifact;
  readonly image: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  readonly network: "none";
  readonly publicCommitment: KeyedCommitment;
  readonly outputPolicy: {
    readonly mode: "result_only";
    readonly maxBytes: number;
    readonly revealAssertions: false;
  };
}

export interface ReferenceSolutionEvidence {
  readonly patch: ContentArtifact;
  readonly validationEvidence: ContentArtifact;
  readonly baseFailsTargetChecks: true;
  readonly basePassesRegressionChecks: true;
  readonly solutionPassesAllChecks: true;
}

export interface TaskProvenance {
  readonly sourceType: "private_authored" | "public_issue" | "synthetic_diagnostic";
  readonly authoredAt: string;
  readonly cutoffAt: string;
  readonly repositoryWasPublic: boolean;
  readonly issueWasPublic: boolean;
  readonly setupPatchWasPublic: boolean;
  readonly verifierWasPublic: boolean;
  readonly goldPatchWasPublic: boolean;
  readonly contaminationAuditDigest: Sha256Digest;
  readonly status: "eligible" | "retired_leak" | "retired_quality";
  readonly retirementReason: string | null;
}

export interface OperatorTaskDocument {
  readonly kind: "agenc.eval.operator-task";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly split: EvalSuiteSplit;
  readonly repository: TaskRepositoryPin;
  readonly setupPatch: ContentArtifact;
  readonly issue: TaskIssue;
  readonly allowedTools: readonly ToolGrant[];
  readonly networkPolicy: NetworkPolicy;
  readonly permissionPolicy: PermissionPolicy;
  readonly budget: TaskBudget;
  readonly expectedArtifacts: readonly ExpectedArtifact[];
  readonly environment: TaskEnvironmentPin;
  readonly resetRecipe: ResetRecipe;
  readonly hiddenVerifier: HiddenVerifierPin;
  readonly referenceSolution: ReferenceSolutionEvidence;
  readonly provenance: TaskProvenance;
}

/** The only task shape that may enter an agent workspace or prompt. */
export interface AgentTaskDocument {
  readonly kind: "agenc.eval.agent-task";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly repository: TaskRepositoryPin;
  readonly setupPatch: ContentArtifact;
  readonly issue: TaskIssue;
  readonly allowedTools: readonly ToolGrant[];
  readonly networkPolicy: NetworkPolicy;
  readonly permissionPolicy: PermissionPolicy;
  readonly budget: TaskBudget;
  readonly expectedArtifacts: readonly ExpectedArtifact[];
  readonly environment: TaskEnvironmentPin;
  readonly verifierCommitment: KeyedCommitment;
}

export interface SuiteManifestDocument {
  readonly kind: "agenc.eval.suite-manifest";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly split: EvalSuiteSplit;
  readonly createdAt: string;
  readonly repositoryFamilies: readonly {
    readonly cluster: string;
    readonly canonicalRepositoryUri: string;
    readonly memberRepositoryUris: readonly string[];
  }[];
  readonly tasks: readonly OperatorTaskDocument[];
}

/** Safe to publish: contains no task identity, prompt, verifier, oracle, or host path. */
export interface HoldoutDescriptorDocument {
  readonly kind: "agenc.eval.holdout-descriptor";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly createdAt: string;
  readonly sealedAt: string;
  readonly taskCount: number;
  readonly repositoryCount: number;
  readonly maximumTasksPerRepository: number;
  readonly taskManifestCommitment: KeyedCommitment;
  readonly verifierRootCommitment: KeyedCommitment;
  readonly repositoryFamilyMapCommitment: KeyedCommitment;
  readonly accessPolicyDigest: Sha256Digest;
  readonly unsealPolicyDigest: Sha256Digest;
  readonly custodianKeyId: string;
  readonly custody: {
    readonly mode: "separate_os_principal_or_remote_service";
    readonly custodianIdentity: string;
    readonly implementerPrincipalSetDigest: Sha256Digest;
    readonly accessControlEvidenceDigest: Sha256Digest;
    readonly custodyVerifierDigest: Sha256Digest;
    readonly accessLogRootCommitment: KeyedCommitment;
    readonly projectionPolicyDigest: Sha256Digest;
  };
  readonly status: "sealed" | "retired";
}

export type JsonScalar = string | number | boolean | null;

export interface NamedModelParameter {
  readonly name: string;
  readonly value: JsonScalar | readonly JsonScalar[];
}

export interface RetryPolicyPin {
  readonly maxAttempts: number;
  readonly retryableReasons: readonly string[];
  readonly backoffDigest: Sha256Digest;
}

export interface ApprovalPolicyPin {
  readonly policyDigest: Sha256Digest;
  readonly allowedKinds: readonly string[];
  readonly undeclaredIntervention: "failure";
}

export interface SystemConfigurationPin {
  readonly systemId: string;
  readonly name: string;
  readonly lane: "matched_model" | "recommended_product";
  readonly release: string;
  readonly repositoryUri: string;
  readonly commit: GitCommit;
  readonly package: ContentArtifact;
  readonly image: string;
  readonly agentConfigDigest: Sha256Digest;
  readonly publicConfigDigest: Sha256Digest;
  readonly redactedConfigFields: readonly string[];
  readonly systemPromptDigest: Sha256Digest;
  readonly toolManifestDigest: Sha256Digest;
  readonly provider: string;
  readonly requestedModelId: string;
  readonly immutableModelId: string;
  readonly generationParameters: readonly NamedModelParameter[];
  readonly retryPolicy: RetryPolicyPin;
  readonly approvalPolicy: ApprovalPolicyPin;
  readonly installCommandDigest: Sha256Digest;
  readonly environmentClassDigest: Sha256Digest;
  readonly hardwareClass: string;
  readonly networkPolicy: NetworkPolicy;
}

export type InfrastructureInvalidReason =
  | "evaluator_host_failure"
  | "shared_provider_outage"
  | "corrupt_task_image"
  | "verifier_infrastructure_failure"
  | "evaluator_coordinator_failure";

export interface ComparisonPairPin {
  readonly comparisonId: string;
  readonly primarySystemId: string;
  readonly comparatorSystemId: string;
}

export interface PreregistrationDocument {
  readonly kind: "agenc.eval.preregistration";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly experimentId: string;
  readonly claim: EvalClaim;
  readonly createdAt: string;
  readonly lane: "matched_model" | "recommended_product";
  readonly suite: {
    readonly suiteId: string;
    readonly suiteVersion: string;
    readonly split: EvalSuiteSplit;
    readonly manifestDigest: Sha256Digest;
    readonly holdoutDescriptorDigest: Sha256Digest | null;
    readonly taskSelectionCommitment: KeyedCommitment;
    readonly repositoryFamilyMapDigest: Sha256Digest;
  };
  readonly evaluator: {
    readonly repositoryUri: string;
    readonly commit: GitCommit;
    readonly image: string;
    readonly harnessConfigDigest: Sha256Digest;
    readonly toolchain: readonly ToolchainPin[];
    readonly analysisImplementation: ContentArtifact;
    readonly trustAssessmentImplementation: ContentArtifact;
  };
  readonly primarySystemId: string;
  readonly systems: readonly SystemConfigurationPin[];
  readonly comparisons: readonly ComparisonPairPin[];
  readonly trialDesign: {
    readonly repetitionsPerSystemTask: number;
    readonly seedSlots: readonly number[];
    readonly order: "randomized_interleave";
    readonly orderAlgorithm: "sha256_fisher_yates_v1";
    readonly orderSeed: number;
    readonly plannedExecutionOrderDigest: Sha256Digest;
  };
  readonly resetPolicy: ResetRecipe;
  readonly scoring: {
    readonly primaryMetric: "trusted_fix_rate";
    readonly taskWeighting: "equal";
    readonly repetitionAggregation: "mean_within_task";
    readonly repositoryCapPercent: 10;
    readonly deterministicOutcomeOnly: true;
  };
  readonly inference: {
    readonly estimand: "paired_tfr_difference";
    readonly targetPopulation: "preregistered_repository_task_population";
    readonly pairKey: "task_id_and_seed_slot";
    readonly trialAggregation: "mean_within_task_before_resampling";
    readonly resamplingUnit: "whole_repository_cluster";
    readonly clusterSampling: "uniform_with_replacement";
    readonly trialResampling: "none";
    readonly taskWeightingWithinResample: "equal";
    readonly interval: "two_sided_percentile";
    readonly lowerQuantile: "0.025";
    readonly upperQuantile: "0.975";
    readonly quantileMethod: "linear_type_7";
    readonly randomStreamDerivation: "sha256_seed_and_comparison_id_first_u32_then_xorshift32_v1";
    readonly multipleComparators: "intersection_union";
    readonly successRule: "point_at_least_0.10_and_lower_above_0_for_every_comparator";
    readonly method: "repository_clustered_paired_percentile_bootstrap";
    readonly confidenceLevel: "0.95";
    readonly alpha: "0.05";
    readonly resamples: number;
    readonly randomSeed: number;
    readonly minimumEffectPercentagePoints: 10;
    readonly targetPower: "0.80";
    readonly powerAnalysisDigest: Sha256Digest;
  };
  readonly samplePlan: {
    readonly minimumTasks: number;
    readonly maximumTasks: number;
    readonly minimumRepositories: number;
    /** v1 is fixed-sample only; sequential inference requires a future contract. */
    readonly stoppingRule: { readonly kind: "fixed"; readonly taskCount: number };
  };
  readonly exclusions: {
    readonly allowedInfrastructureReasons: readonly InfrastructureInvalidReason[];
    readonly classifierImplementation: ContentArtifact;
    readonly classifierVersion: string;
    readonly infrastructureEvidenceRequired: true;
    readonly infrastructurePairing: "comparison_pair_same_task_trial";
    readonly unpairedInfrastructureInvalid: "reject_experiment";
    readonly unsupported: "count_failure";
    readonly timeout: "count_failure";
    readonly crash: "count_failure";
    readonly providerError: "count_failure";
    readonly permissionDenial: "count_failure";
    readonly budgetExhaustion: "count_failure";
  };
  readonly evidencePolicy: {
    readonly ledgerFormat: "jcs-ndjson-v1";
    readonly maximumEventBytes: number;
    readonly maximumPayloadBytes: number;
    readonly maximumLedgerBytes: number;
    readonly maximumEvents: number;
    readonly redactionPolicyDigest: Sha256Digest;
    readonly anchorPolicyDigest: Sha256Digest;
    readonly anchorVerifierDigest: Sha256Digest;
    readonly platformProtectionVerifierDigest: Sha256Digest | null;
  };
  readonly unblinding: {
    readonly state: "sealed";
    readonly policyDigest: Sha256Digest;
    readonly authorizedRole: string;
  };
}

export interface PreregistrationReceiptDocument {
  readonly kind: "agenc.eval.preregistration-receipt";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly preregistrationDigest: Sha256Digest;
  readonly statementDigest: Sha256Digest;
  readonly anchorPolicyDigest: Sha256Digest;
  readonly signatureAlgorithm: "ed25519" | "ecdsa-p256-sha256";
  readonly signatureDigest: Sha256Digest;
  readonly verificationMaterialDigest: Sha256Digest;
  readonly anchorUri: string;
  readonly signerIdentity: string;
  readonly anchoredAt: string;
}

export interface BlindedResultsSealDocument {
  readonly kind: "agenc.eval.blinded-results-seal";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly experimentId: string;
  readonly preregistrationDigest: Sha256Digest;
  readonly preregistrationReceiptDigest: Sha256Digest;
  readonly completeRunMatrixCommitment: KeyedCommitment;
  readonly completeRunMatrixDigest: Sha256Digest;
  readonly evidenceSealSetDigest: Sha256Digest;
  readonly sealedAt: string;
}

export interface HoldoutAccessReceiptDocument {
  readonly kind: "agenc.eval.holdout-access-receipt";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly experimentId: string;
  readonly holdoutDescriptorDigest: Sha256Digest;
  readonly suiteManifestDigest: Sha256Digest;
  readonly preregistrationDigest: Sha256Digest;
  readonly blindedResultsSealDigest: Sha256Digest;
  readonly completeRunMatrixDigest: Sha256Digest;
  readonly accessPolicyDigest: Sha256Digest;
  readonly unsealPolicyDigest: Sha256Digest;
  readonly projectionPolicyDigest: Sha256Digest;
  readonly implementerPrincipalSetDigest: Sha256Digest;
  readonly custodianIdentity: string;
  readonly accessLogHeadDigest: Sha256Digest;
  readonly projectedRunIdsDigest: Sha256Digest;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly authorizedRole: string;
  readonly authorizedPrincipal: string;
  readonly firstAccessAt: string;
  readonly lastAccessAt: string;
  readonly issuedAt: string;
  readonly receiptVerifierDigest: Sha256Digest;
  readonly signatureAlgorithm: "ed25519" | "ecdsa-p256-sha256";
  readonly signatureDigest: Sha256Digest;
  readonly verificationMaterialDigest: Sha256Digest;
  readonly receiptUri: string;
}

export interface UnblindingRecordDocument {
  readonly kind: "agenc.eval.unblinding-record";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly experimentId: string;
  readonly preregistrationDigest: Sha256Digest;
  readonly preregistrationReceiptDigest: Sha256Digest;
  readonly blindedResultsSealDigest: Sha256Digest;
  readonly holdoutDescriptorDigest: Sha256Digest | null;
  readonly holdoutAccessReceiptDigest: Sha256Digest | null;
  readonly policyDigest: Sha256Digest;
  readonly authorizedRole: string;
  readonly authorizationEvidenceDigest: Sha256Digest;
  readonly unblindedBy: string;
  readonly unblindedAt: string;
}

export type FinalOutcome =
  | "pass"
  | "fail"
  | "timeout"
  | "crash"
  | "unsupported"
  | "provider_error"
  | "permission_denied"
  | "budget_exhausted"
  | "unknown_outcome"
  | "infrastructure_invalid";

export interface ActualSystemSnapshot {
  readonly systemId: string;
  readonly release: string;
  readonly commit: GitCommit;
  readonly packageDigest: Sha256Digest;
  readonly image: string;
  readonly agentConfigDigest: Sha256Digest;
  readonly publicConfigDigest: Sha256Digest;
  readonly redactedConfigFields: readonly string[];
  readonly systemPromptDigest: Sha256Digest;
  readonly toolManifestDigest: Sha256Digest;
  readonly installCommandDigest: Sha256Digest;
  readonly environmentClassDigest: Sha256Digest;
  readonly provider: string;
  readonly requestedModelId: string;
  readonly immutableModelId: string;
  readonly providerReportedModelId: string;
  readonly generationParameters: readonly NamedModelParameter[];
  readonly retryPolicy: RetryPolicyPin;
  readonly approvalPolicy: ApprovalPolicyPin;
}

export type TrustCriterionName =
  | "hidden_verifier"
  | "policy_and_budget"
  | "effect_safety"
  | "recovery_integrity"
  | "evidence_bundle"
  | "intervention_free";

export interface TrustCriterionAssessment {
  readonly status: "passed" | "failed";
  readonly evidenceDigests: readonly Sha256Digest[];
}

export interface HiddenVerifierAssessment extends TrustCriterionAssessment {
  readonly inaccessibleDuringRun: boolean;
  readonly deterministicAssertionsPassed: boolean;
}

export interface PolicyAndBudgetAssessment extends TrustCriterionAssessment {
  readonly permissionEscapes: number;
  readonly sandboxEscapes: number;
  readonly concurrencyEscapes: number;
  readonly budgetOverruns: number;
  readonly unresolvedUsageFullyReserved: boolean;
}

export interface EffectSafetyAssessment extends TrustCriterionAssessment {
  readonly duplicatedUncertainMutations: number;
  readonly unsafeAutomaticRetries: number;
  readonly unresolvedUnknownOutcomes: number;
}

export interface RecoveryIntegrityAssessment extends TrustCriterionAssessment {
  readonly scheduledFaults: number;
  readonly successfulRecoveries: number;
  readonly eventGaps: number;
  readonly hiddenEventLoss: number;
}

export interface EvidenceBundleAssessment extends TrustCriterionAssessment {
  readonly schemaValid: boolean;
  readonly hashesValid: boolean;
  readonly unresolvedReviewBlockers: number;
  readonly missingRequiredArtifacts: number;
}

export interface InterventionAssessment extends TrustCriterionAssessment {
  readonly undeclaredInterventions: number;
}

export type TrustAssessment =
  | {
      readonly status: "unassessed";
      readonly trustedFix: false;
      readonly reason: "shared_trust_contract_not_available" | "insufficient_evidence";
      readonly missingCriteria: readonly TrustCriterionName[];
    }
  | {
      readonly status: "assessed";
      readonly trustedFix: boolean;
      readonly assessmentImplementationDigest: Sha256Digest;
      readonly criteria: {
        readonly hiddenVerifier: HiddenVerifierAssessment;
        readonly policyAndBudget: PolicyAndBudgetAssessment;
        readonly effectSafety: EffectSafetyAssessment;
        readonly recoveryIntegrity: RecoveryIntegrityAssessment;
        readonly evidenceBundle: EvidenceBundleAssessment;
        readonly interventionFree: InterventionAssessment;
      };
    };

export interface RecordedRunArtifact extends ContentArtifact {
  readonly artifactId: string;
  readonly expectedArtifactId: string | null;
  readonly path: string | null;
  readonly role:
    | "patch"
    | "changed_files"
    | "test_result"
    | "independent_review"
    | "cost_usage"
    | "approval_log"
    | "effect_log"
    | "risk_register"
    | "diagnostic";
}

export interface RunRecordDocument {
  readonly kind: "agenc.eval.run-record";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly runId: string;
  readonly experimentId: string;
  readonly preregistrationDigest: Sha256Digest;
  readonly preregistrationReceiptDigest: Sha256Digest;
  readonly suiteManifestDigest: Sha256Digest;
  readonly taskId: string;
  readonly operatorTaskDigest: Sha256Digest;
  readonly agentTaskDigest: Sha256Digest;
  readonly repositoryCluster: string;
  readonly systemId: string;
  readonly trialIndex: number;
  readonly seedSlot: number;
  readonly executionIndex: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallTimeMs: number;
  readonly evaluator: {
    readonly commit: GitCommit;
    readonly image: string;
    readonly harnessConfigDigest: Sha256Digest;
    readonly analysisImplementationDigest: Sha256Digest;
    readonly trustAssessmentImplementationDigest: Sha256Digest;
  };
  readonly system: ActualSystemSnapshot;
  readonly environment: {
    readonly operatingSystem: string;
    readonly architecture: string;
    readonly kernel: string;
    readonly platform: string;
    readonly hardwareClass: string;
    readonly image: string;
    readonly toolchain: readonly ToolchainPin[];
    readonly networkPolicy: NetworkPolicy;
    readonly permissionPolicyDigest: Sha256Digest;
  };
  readonly resetReceipt: {
    readonly recipeDigest: Sha256Digest;
    readonly repositoryCommit: GitCommit;
    readonly workspaceFingerprint: Sha256Digest;
    readonly cacheEmpty: true;
    readonly memoryEmpty: true;
    readonly sessionFresh: true;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly totalTokens: number;
    readonly providerCost: {
      readonly status: "reported";
      readonly amount: DecimalString;
      readonly currency: "USD";
      readonly source: "provider_reported";
    } | {
      readonly status: "unavailable";
      readonly reason: string;
      readonly evidenceDigest: Sha256Digest;
      /** Evaluator-enforced upper bound reserved before execution. */
      readonly reservedAmount: DecimalString;
      readonly currency: "USD";
    };
    readonly toolCalls: number;
    readonly turns: number;
    readonly retries: number;
  };
  readonly approvals: readonly {
    readonly id: string;
    readonly kind: string;
    readonly requestedAt: string;
    readonly resolvedAt: string;
    readonly decision: "approved" | "denied";
    readonly declaredByTask: boolean;
  }[];
  readonly interventions: readonly {
    readonly kind: string;
    readonly occurredAt: string;
    readonly declaredByTask: boolean;
  }[];
  readonly artifacts: readonly RecordedRunArtifact[];
  readonly verifier: {
    readonly verifierId: string;
    readonly verifierVersion: string;
    readonly bundleDigest: Sha256Digest;
    readonly result: "passed" | "failed" | "error";
    readonly assertionCount: number;
    readonly passedAssertions: number;
    readonly evidenceDigest: Sha256Digest;
  };
  readonly evidence: {
    readonly contractDigest: Sha256Digest;
    readonly taskId: string;
    readonly systemId: string;
    readonly ledgerDigest: Sha256Digest;
    readonly ledgerByteLength: number;
    readonly genesisEventDigest: Sha256Digest;
    readonly headEventDigest: Sha256Digest;
    readonly eventCount: number;
    readonly platformProtectionVerifierDigest: Sha256Digest | null;
    readonly sealDigest: Sha256Digest;
    readonly statementDigest: Sha256Digest;
    readonly anchorPolicyDigest: Sha256Digest;
    readonly signatureAlgorithm: "ed25519" | "ecdsa-p256-sha256";
    readonly signatureDigest: Sha256Digest;
    readonly verificationMaterialDigest: Sha256Digest;
    readonly anchorUri: string;
    readonly signerIdentity: string;
    readonly sealedAt: string;
  };
  readonly outcome: FinalOutcome;
  readonly verifiedFix: boolean;
  readonly trustAssessment: TrustAssessment;
  readonly infrastructureInvalidPairs: readonly {
    readonly comparisonId: string;
    readonly counterpartRunId: string;
    readonly reason: InfrastructureInvalidReason;
    readonly incidentId: string;
    readonly evidenceDigest: Sha256Digest;
    readonly classifierVersion: string;
    readonly classifierImplementationDigest: Sha256Digest;
  }[];
}

export type EvidenceEventType =
  | "run.started"
  | "reset.completed"
  | "instruction.recorded"
  | "admission.decision"
  | "budget.reserved"
  | "budget.reconciled"
  | "policy.evaluated"
  | "sandbox.evaluated"
  | "model.request"
  | "model.response"
  | "tool.request"
  | "tool.result"
  | "effect.intent"
  | "effect.result"
  | "effect.unknown_outcome"
  | "approval.requested"
  | "approval.resolved"
  | "intervention.recorded"
  | "usage.reported"
  | "artifact.recorded"
  | "verifier.completed"
  | "review.completed"
  | "risk.recorded"
  | "recovery.assessed"
  | "trust.assessed"
  | "daemon.restarted"
  | "client.disconnected"
  | "client.reconnected"
  | "event.gap"
  | "infrastructure.classified"
  | "holdout.accessed"
  | "holdout.unsealed"
  | "holdout.rotated"
  | "run.finished"
  | "diagnostic";

export interface EvidenceEventDocument {
  readonly kind: "agenc.eval.evidence-event";
  readonly contractVersion: EvalContractVersion;
  readonly runId: string;
  readonly eventId: string;
  readonly contractDigest: Sha256Digest;
  readonly taskId: string;
  readonly systemId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly producer: {
    readonly identity: string;
    readonly version: string;
    readonly binaryDigest: Sha256Digest;
  };
  readonly type: EvidenceEventType;
  readonly payload: {
    readonly digest: Sha256Digest;
    readonly sizeBytes: number;
    readonly mediaType: string;
    readonly uri: string;
    readonly sensitivity: "restricted";
    readonly redactionPolicyDigest: Sha256Digest;
  };
  readonly previousEventDigest: Sha256Digest | null;
  readonly eventDigest: Sha256Digest;
}

/** Immutable facts signed by the external evidence-anchor provider. */
export interface EvidenceLedgerSealStatement {
  readonly runId: string;
  readonly contractDigest: Sha256Digest;
  readonly taskId: string;
  readonly systemId: string;
  readonly ledgerDigest: Sha256Digest;
  readonly ledgerByteLength: number;
  readonly genesisEventDigest: Sha256Digest;
  readonly headEventDigest: Sha256Digest;
  readonly eventCount: number;
  readonly platformProtectionVerifierDigest: Sha256Digest | null;
  readonly sealedAt: string;
}

export interface EvidenceAnchorReceipt {
  /** Digest of the exact canonical EvidenceLedgerSealStatement bytes. */
  readonly statementDigest: Sha256Digest;
  readonly anchorPolicyDigest: Sha256Digest;
  readonly signatureAlgorithm: "ed25519" | "ecdsa-p256-sha256";
  readonly signatureDigest: Sha256Digest;
  readonly verificationMaterialDigest: Sha256Digest;
  readonly anchorUri: string;
  readonly signerIdentity: string;
}

/** Canonical stored seal document; `sealDigest` is external to avoid a cycle. */
export interface EvidenceLedgerSealDocument {
  readonly kind: "agenc.eval.evidence-seal";
  readonly contractVersion: EvalContractVersion;
  readonly statement: EvidenceLedgerSealStatement;
  readonly receipt: EvidenceAnchorReceipt;
}

/** Exact externally supplied content address for an EvidenceLedgerSealDocument. */
export interface EvidenceLedgerSeal extends EvidenceLedgerSealDocument {
  readonly sealDigest: Sha256Digest;
}

export interface SystemSummary {
  readonly systemId: string;
  readonly taskCount: number;
  readonly includedTrialCount: number;
  readonly pairwiseInfrastructureExclusionCount: number;
  readonly unassessedTrialCount: number;
  readonly verifiedFixRate: number;
  readonly trustedFixRate: number | null;
  readonly taskScores: readonly {
    readonly taskId: string;
    readonly repositoryCluster: string;
    readonly repetitions: number;
    readonly verifiedFixRate: number;
    readonly trustedFixRate: number | null;
  }[];
}

export interface PairedEffectSummary {
  readonly comparisonId: string;
  readonly comparatorSystemId: string;
  readonly pointEstimate: number;
  readonly confidenceLower: number;
  readonly confidenceUpper: number;
  readonly confidenceLevel: "0.95";
  readonly method: "repository_clustered_paired_percentile_bootstrap";
  readonly resamples: number;
  readonly superiorityCriterionMet: boolean | null;
}

export interface DerivedSummaryDocument {
  readonly kind: "agenc.eval.derived-summary";
  readonly contractVersion: EvalContractVersion;
  readonly documentDigest: Sha256Digest;
  readonly summaryId: string;
  readonly generatedAt: string;
  readonly derived: true;
  readonly claim: EvalClaim;
  readonly experimentId: string;
  readonly preregistrationDigest: Sha256Digest;
  readonly preregistrationReceiptDigest: Sha256Digest;
  readonly blindedResultsSealDigest: Sha256Digest;
  readonly unblindingRecordDigest: Sha256Digest;
  readonly suiteManifestDigest: Sha256Digest;
  readonly analysisImplementationDigest: Sha256Digest;
  readonly evidenceSeals: readonly {
    readonly runId: string;
    readonly contractDigest: Sha256Digest;
    readonly taskId: string;
    readonly systemId: string;
    readonly ledgerDigest: Sha256Digest;
    readonly ledgerByteLength: number;
    readonly headEventDigest: Sha256Digest;
    readonly eventCount: number;
    readonly platformProtectionVerifierDigest: Sha256Digest | null;
    readonly sealDigest: Sha256Digest;
    readonly statementDigest: Sha256Digest;
    readonly anchorPolicyDigest: Sha256Digest;
    readonly signatureAlgorithm: "ed25519" | "ecdsa-p256-sha256";
    readonly signatureDigest: Sha256Digest;
    readonly verificationMaterialDigest: Sha256Digest;
    readonly anchorUri: string;
    readonly signerIdentity: string;
    readonly sealedAt: string;
  }[];
  readonly systems: readonly SystemSummary[];
  readonly pairedEffects: readonly PairedEffectSummary[];
  readonly superiorityEstablished: boolean | null;
  readonly excludedInfrastructurePairs: readonly {
    readonly comparisonId: string;
    readonly taskId: string;
    readonly seedSlot: number;
    readonly primaryRunId: string;
    readonly comparatorRunId: string;
    readonly incidentId: string;
    readonly reason: InfrastructureInvalidReason;
    readonly evidenceDigest: Sha256Digest;
    readonly classifierVersion: string;
    readonly classifierImplementationDigest: Sha256Digest;
  }[];
  readonly rawEvidenceEmbedded: false;
}

export type EvalContractDocument =
  | OperatorTaskDocument
  | AgentTaskDocument
  | SuiteManifestDocument
  | HoldoutDescriptorDocument
  | HoldoutAccessReceiptDocument
  | PreregistrationDocument
  | RunRecordDocument
  | EvidenceEventDocument
  | EvidenceLedgerSealDocument
  | PreregistrationReceiptDocument
  | BlindedResultsSealDocument
  | UnblindingRecordDocument
  | DerivedSummaryDocument;

export interface LegacyReportQualification {
  readonly schemaVersion: 1;
  readonly qualifying: false;
  readonly classification: "legacy_non_confirmatory";
  readonly sourceDigest: Sha256Digest;
  readonly missingPins: readonly string[];
}
