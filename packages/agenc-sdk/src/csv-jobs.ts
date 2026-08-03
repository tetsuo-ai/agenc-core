/**
 * Standalone public types for the bounded CSV agent-job result contract.
 *
 * CSV jobs are currently exposed through model-facing tools rather than a
 * daemon JSON-RPC method. These types therefore describe the durable result
 * and pagination vocabulary without inventing an unsupported transport.
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
