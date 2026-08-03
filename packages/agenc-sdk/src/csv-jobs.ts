/**
 * Standalone public types for the bounded CSV agent-job result contract.
 *
 * The result vocabulary is shared by model-facing tools and the daemon's
 * connected `csvJob.review.*` operator surface.
 */

export const AGENC_SDK_CSV_JOB_CONTRACT_VERSION = 1 as const;
export const AGENC_SDK_CSV_OUTPUT_CONTRACT_VERSION = 1 as const;

export const AGENC_SDK_CSV_AGENT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "needs_review",
  "finished_with_unknown_outcomes",
] as const;

export const AGENC_SDK_CSV_AGENT_JOB_ITEM_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown_outcome",
] as const;

export const AGENC_SDK_CSV_RESULT_AVAILABILITIES = [
  "not_produced",
  "available",
  "unavailable_after_review",
] as const;

export type CsvAgentJobStatus =
  (typeof AGENC_SDK_CSV_AGENT_JOB_STATUSES)[number];
export type CsvAgentJobItemStatus =
  (typeof AGENC_SDK_CSV_AGENT_JOB_ITEM_STATUSES)[number];
export type CsvResultAvailability =
  (typeof AGENC_SDK_CSV_RESULT_AVAILABILITIES)[number];
export type CsvReviewStatus = "pending" | "resolved" | "abandoned";
export type CsvJobItemCursor = string;

export interface CsvAgentJobProgress {
  readonly totalItems: number;
  readonly pendingItems: number;
  readonly runningItems: number;
  readonly completedItems: number;
  readonly failedItems: number;
  readonly cancelledItems: number;
  readonly unknownOutcomeItems: number;
  readonly reviewPendingItems: number;
}

export interface CsvAgentJobSummary extends CsvAgentJobProgress {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly jobId: string;
  readonly status: CsvAgentJobStatus;
  readonly resultBytes: number;
  readonly availableResults: number;
  readonly unavailableAfterReviewResults: number;
  readonly notProducedResults: number;
}

export interface CsvAgentJobItemSummary {
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly sourceIdTruncated?: boolean;
  readonly sourceIdDigest?: string;
  readonly status: CsvAgentJobItemStatus;
  readonly attemptCount: number;
  readonly resultAvailability: CsvResultAvailability;
  readonly resultSizeBytes: number;
  readonly resultDigest?: string;
  readonly resultPreviewJson?: string;
  readonly resultPreviewTruncated?: boolean;
  readonly lastError?: string;
  readonly lastErrorTruncated?: boolean;
  readonly reviewStatus?: CsvReviewStatus;
  readonly reviewReason?: string;
  readonly reviewReasonTruncated?: boolean;
}

export interface CsvAgentJobItemPage {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly items: ReadonlyArray<CsvAgentJobItemSummary>;
  readonly nextCursor?: CsvJobItemCursor;
}

export interface CsvResultBlobChunk {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly itemId: string;
  readonly availability: CsvResultAvailability;
  readonly totalBytes: number;
  readonly digest?: string;
  readonly byteOffset: number;
  readonly dataBase64: string;
  readonly nextByteOffset?: number;
}

export interface CsvOutputArtifact {
  readonly contractVersion: typeof AGENC_SDK_CSV_OUTPUT_CONTRACT_VERSION;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RunAgentsOnCsvResult {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly jobId: string;
  readonly summary: CsvAgentJobSummary;
  readonly itemPage: ReadonlyArray<CsvAgentJobItemSummary>;
  readonly nextItemCursor?: CsvJobItemCursor;
  readonly stoppedEarly: boolean;
  readonly outputCsvPath?: string;
  readonly outputArtifact?: CsvOutputArtifact;
}

export type CsvReviewDisposition =
  | "confirmed_committed"
  | "confirmed_no_effect"
  | "remains_unknown";

export type CsvReviewDomainAction =
  | "mark_completed"
  | "retry_new_attempt"
  | "abandon_item";

/** Exact A1 operator evidence persisted by a CSV review resolution. */
export interface CsvOperatorEffectReviewResolution {
  readonly version: 1;
  readonly kind: "effect_review_resolution";
  readonly disposition: CsvReviewDisposition;
  readonly actorKind: "operator";
  readonly actorId: string;
  readonly evidenceKind: "operator_evidence";
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
  readonly reviewedAt: string;
  readonly workflowStatus: "resolved" | "abandoned";
  readonly domainAction: CsvReviewDomainAction;
}

export interface CsvJobReviewListParams {
  /** Absolute workspace root. The SDK fills the process cwd when omitted. */
  readonly cwd?: string;
  readonly jobId: string;
  readonly cursor?: CsvJobItemCursor;
  readonly limit?: number;
}

export interface CsvJobReviewShowParams {
  readonly cwd?: string;
  readonly jobId: string;
  readonly itemId: string;
}

export interface CsvJobReviewResolveParams {
  readonly cwd?: string;
  readonly jobId: string;
  readonly itemId: string;
  readonly disposition: CsvReviewDisposition;
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface CsvJobReviewEvidenceProjection {
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly value?: Readonly<Record<string, unknown>>;
}

export interface CsvJobReviewEffectReference {
  readonly runId: string;
  readonly stepId: string;
  readonly epoch: number;
}

export interface CsvJobReviewDetail {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly jobId: string;
  readonly itemId: string;
  readonly rowIndex: number;
  readonly sourceId?: string;
  readonly sourceIdTruncated?: boolean;
  readonly status: CsvAgentJobItemStatus;
  readonly attemptCount: number;
  readonly resultAvailability: CsvResultAvailability;
  readonly resultSizeBytes: number;
  readonly resultDigest?: string;
  readonly reviewStatus: CsvReviewStatus;
  readonly reviewReason?: string;
  readonly reviewReasonTruncated?: boolean;
  readonly disposition?: CsvReviewDisposition;
  readonly domainAction?: CsvReviewDomainAction;
  readonly evidence?: CsvJobReviewEvidenceProjection;
  readonly effect?: CsvJobReviewEffectReference;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface CsvJobReviewListResult {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly job: CsvAgentJobSummary;
  readonly reviews: ReadonlyArray<CsvAgentJobItemSummary>;
  readonly nextCursor?: CsvJobItemCursor;
}

export interface CsvJobReviewShowResult {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly review: CsvJobReviewDetail;
}

export interface CsvJobReviewResolveResult {
  readonly contractVersion: typeof AGENC_SDK_CSV_JOB_CONTRACT_VERSION;
  readonly outcome: "resolved" | "already_resolved";
  readonly review: CsvJobReviewDetail;
  readonly job?: CsvAgentJobSummary;
}
