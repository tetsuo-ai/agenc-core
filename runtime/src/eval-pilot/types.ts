import type {
  AgentTaskDocument,
  ContentArtifact,
  OperatorTaskDocument,
  Sha256Digest,
  SuiteManifestDocument,
} from "../eval-contract/index.js";

export const EVALUATION_PILOT_PROTOCOL_VERSION = "1.0.0" as const;
export const EVALUATION_PILOT_TASK_COUNT = 30 as const;
export const EVALUATION_PILOT_MINIMUM_REPOSITORIES = 15 as const;
export const EVALUATION_PILOT_MAXIMUM_TASKS_PER_REPOSITORY = 2 as const;
export const EVALUATION_PILOT_MAXIMUM_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const EVALUATION_PILOT_MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const EVALUATION_PILOT_MAXIMUM_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024;

export const EVALUATION_PILOT_CATEGORIES = [
  "multi_file_fix",
  "failing_test_diagnosis",
  "regression_repair",
  "compatibility_refactor",
  "missing_tests",
  "long_context_navigation",
  "ambiguous_issue",
] as const;

export const EVALUATION_PILOT_STRESSORS = [
  "tool_timeout",
  "partial_output",
  "repository_prompt_injection",
  "collaboration_beneficial",
] as const;

export type EvaluationPilotProtocolVersion = typeof EVALUATION_PILOT_PROTOCOL_VERSION;
export type EvaluationPilotCategory = (typeof EVALUATION_PILOT_CATEGORIES)[number];
export type EvaluationPilotStressor = (typeof EVALUATION_PILOT_STRESSORS)[number];

export interface EvaluationPilotSourceDataset {
  readonly datasetId: string;
  readonly revision: string;
  readonly revisionDigest: Sha256Digest;
  readonly license: {
    readonly spdxIdentifier: string;
    readonly evidence: ContentArtifact;
  };
  readonly selection: {
    readonly algorithm: "sha256_ranked_stratified_v1";
    readonly algorithmVersion: "1.0.0";
    readonly implementation: ContentArtifact;
    readonly seedDigest: Sha256Digest;
    readonly eligiblePopulationDigest: Sha256Digest;
    readonly selectedRowsDigest: Sha256Digest;
    readonly taskOrdering: "ascending_selection_key_digest";
    readonly outcomeDataUsed: false;
  };
}

export interface EvaluationPilotTaskCuration {
  readonly taskId: string;
  readonly operatorTaskDigest: Sha256Digest;
  readonly repositoryFamily: string;
  readonly eligibility: "development_public_issue_eligible";
  readonly category: EvaluationPilotCategory;
  readonly stressors: readonly EvaluationPilotStressor[];
  readonly selectionKeyDigest: Sha256Digest;
  readonly source: {
    readonly rowId: string;
    readonly rowDigest: Sha256Digest;
    readonly row: ContentArtifact;
  };
  readonly qa: {
    readonly upstreamTriplePreflight: ContentArtifact;
    readonly independentSolveReview: ContentArtifact;
    readonly negativePatchReview: ContentArtifact;
  };
}

export interface EvaluationPilotCurationDocument {
  readonly kind: "agenc.eval.development-pilot-curation";
  readonly pilotProtocolVersion: EvaluationPilotProtocolVersion;
  readonly documentDigest: Sha256Digest;
  readonly createdAt: string;
  readonly suite: {
    readonly suiteId: string;
    readonly suiteVersion: string;
    readonly manifestDigest: Sha256Digest;
    readonly split: "development";
    readonly taskCount: 30;
  };
  readonly cas: {
    readonly layout: "cas/sha256/<hex>";
    readonly digestAlgorithm: "sha256";
    readonly requiredArtifactSetDigest: Sha256Digest;
    readonly maximumArtifactBytes: 16_777_216;
    readonly maximumTotalArtifactBytes: 268_435_456;
  };
  readonly sourceDataset: EvaluationPilotSourceDataset;
  readonly coverage: {
    readonly categories: readonly EvaluationPilotCategory[];
    readonly stressors: readonly EvaluationPilotStressor[];
    readonly minimumRepositoryFamilies: 15;
    readonly maximumTasksPerRepositoryFamily: 2;
  };
  readonly tasks: readonly EvaluationPilotTaskCuration[];
}

export interface EvaluationPilotSourceRowEvidence {
  readonly kind: "agenc.eval.pilot-source-row";
  readonly evidenceVersion: "1.0.0";
  readonly datasetId: string;
  readonly datasetRevisionDigest: Sha256Digest;
  readonly rowId: string;
  readonly taskId: string;
  readonly operatorTaskDigest: Sha256Digest;
  readonly repositoryUri: string;
  readonly repositoryCommit: string;
  readonly issueDigest: Sha256Digest;
  readonly licenseSpdxIdentifier: string;
}

export interface EvaluationPilotLicenseEvidence {
  readonly kind: "agenc.eval.pilot-license-evidence";
  readonly evidenceVersion: "1.0.0";
  readonly datasetId: string;
  readonly datasetRevisionDigest: Sha256Digest;
  readonly spdxIdentifier: string;
  readonly reviewStatus: "confirmed";
}

export interface EvaluationPilotUpstreamPreflightEvidence {
  readonly kind: "agenc.eval.pilot-upstream-triple-preflight";
  readonly evidenceVersion: "1.0.0";
  readonly taskId: string;
  readonly operatorTaskDigest: Sha256Digest;
  readonly status: "complete";
  readonly runs: readonly [
    EvaluationPilotPreflightRun,
    EvaluationPilotPreflightRun,
    EvaluationPilotPreflightRun,
  ];
}

export interface EvaluationPilotPreflightRun {
  readonly runIndex: 1 | 2 | 3;
  readonly coldRebuild: true;
  readonly baseFailsTargetChecks: true;
  readonly basePassesRegressionChecks: true;
  readonly referencePassesAllChecks: true;
  readonly environmentDigest: Sha256Digest;
  readonly evidenceDigest: Sha256Digest;
}

export interface EvaluationPilotIndependentSolveEvidence {
  readonly kind: "agenc.eval.pilot-independent-solve-review";
  readonly evidenceVersion: "1.0.0";
  readonly taskId: string;
  readonly operatorTaskDigest: Sha256Digest;
  readonly status: "complete";
  readonly reviewerIdentityDigest: Sha256Digest;
  readonly reviewerIndependentOfTaskAuthor: true;
  readonly verifierInaccessibleDuringSolve: true;
  readonly startedFromPinnedBase: true;
  readonly solutionPatchDigest: Sha256Digest;
  readonly solutionAccepted: true;
  readonly reviewEvidenceDigest: Sha256Digest;
}

export interface EvaluationPilotNegativePatchEvidence {
  readonly kind: "agenc.eval.pilot-negative-patch-review";
  readonly evidenceVersion: "1.0.0";
  readonly taskId: string;
  readonly operatorTaskDigest: Sha256Digest;
  readonly status: "complete";
  readonly reviewerIdentityDigest: Sha256Digest;
  readonly reviewerIndependentOfTaskAuthor: true;
  readonly implementationIndependenceReviewed: true;
  readonly allNegativePatchesRejected: true;
  readonly negativePatches: readonly [
    EvaluationPilotRejectedNegativePatch,
    EvaluationPilotRejectedNegativePatch,
    ...EvaluationPilotRejectedNegativePatch[],
  ];
}

export interface EvaluationPilotRejectedNegativePatch {
  readonly patchDigest: Sha256Digest;
  readonly rejectionEvidenceDigest: Sha256Digest;
  readonly failureClass: "incomplete_fix" | "overfit_fix" | "regression" | "test_tampering";
}

export interface EvaluationPilotTaskEvidence {
  readonly sourceRow: EvaluationPilotSourceRowEvidence;
  readonly upstreamTriplePreflight: EvaluationPilotUpstreamPreflightEvidence;
  readonly independentSolveReview: EvaluationPilotIndependentSolveEvidence;
  readonly negativePatchReview: EvaluationPilotNegativePatchEvidence;
}

export interface ValidatedEvaluationPilotCatalog {
  readonly document: EvaluationPilotCurationDocument;
  readonly suite: SuiteManifestDocument;
  readonly operatorTasks: ReadonlyMap<string, OperatorTaskDocument>;
  readonly taskEvidence: ReadonlyMap<string, EvaluationPilotTaskEvidence>;
  readonly licenseEvidence: EvaluationPilotLicenseEvidence;
  readonly agentTasks: readonly AgentTaskDocument[];
}
