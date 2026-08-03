import { createHash } from "node:crypto";
import { canonicalizeCsvResult } from "../agents/jobs/csv-schema.js";
import type { EffectReviewResolution } from "../contracts/run-contracts.js";
import {
  CsvAgentJobsRepository,
  type CsvAgentJobItem,
  type CsvAgentJobSummary,
} from "../state/csv-agent-jobs.js";
import { createOperatorEffectReviewResolution } from "../state/effect-review.js";
import { openStateDatabases } from "../state/sqlite-driver.js";
import {
  requireAbsoluteWorkspaceCwd,
  WorkspaceCwdError,
} from "./workspace-cwd.js";
import type {
  CsvJobReviewDetail,
  CsvJobReviewItemSummary,
  CsvJobReviewJobSummary,
  CsvJobReviewListParams,
  CsvJobReviewListResult,
  CsvJobReviewResolveParams,
  CsvJobReviewResolveResult,
  CsvJobReviewShowParams,
  CsvJobReviewShowResult,
  JsonObject,
} from "./protocol/index.js";

const CSV_REVIEW_CONTRACT_VERSION = 1 as const;
const CSV_REVIEW_SOURCE_ID_MAX_BYTES = 1_024;
const CSV_REVIEW_REASON_MAX_BYTES = 4_096;
const CSV_REVIEW_EVIDENCE_MAX_BYTES = 4_096;
const CSV_REVIEW_IDENTIFIER_MAX_BYTES = 1_024;
const CSV_REVIEW_EVIDENCE_REF_MAX_BYTES = 4_096;
const CSV_REVIEW_RESOLUTION_REASON_MAX_BYTES = 32_768;
const CSV_REVIEW_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type AgenCCsvJobReviewErrorCode =
  | "CSV_JOB_NOT_FOUND"
  | "CSV_REVIEW_NOT_FOUND"
  | "CSV_REVIEW_NOT_PENDING"
  | "CSV_REVIEW_CONFLICT"
  | "CSV_REVIEW_INVALID";

export class AgenCCsvJobReviewError extends Error {
  constructor(
    readonly code: AgenCCsvJobReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgenCCsvJobReviewError";
  }
}

export interface AgenCCsvJobReviewService {
  list(params: CsvJobReviewListParams): Promise<CsvJobReviewListResult>;
  show(params: CsvJobReviewShowParams): Promise<CsvJobReviewShowResult>;
  resolve(params: CsvJobReviewResolveParams): Promise<CsvJobReviewResolveResult>;
}

/**
 * Workspace-scoped operator review service. Each call opens and closes the
 * durable state database so results never depend on daemon-process memory.
 */
export class AgenCCsvJobReviewStateService
  implements AgenCCsvJobReviewService
{
  async list(params: CsvJobReviewListParams): Promise<CsvJobReviewListResult> {
    validateWorkspaceAndIdentifiers(params.cwd, params.jobId);
    return withRepository(params.cwd, (repository) => {
      const job = requireJob(repository, params.jobId);
      const page = repository.listItemsPage({
        jobId: params.jobId,
        status: "unknown_outcome",
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      return {
        contractVersion: CSV_REVIEW_CONTRACT_VERSION,
        job: projectJobSummary(job),
        reviews: page.items as unknown as readonly CsvJobReviewItemSummary[],
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
      };
    });
  }

  async show(params: CsvJobReviewShowParams): Promise<CsvJobReviewShowResult> {
    validateWorkspaceAndIdentifiers(params.cwd, params.jobId, params.itemId);
    return withRepository(params.cwd, (repository) => ({
      contractVersion: CSV_REVIEW_CONTRACT_VERSION,
      review: projectReviewDetail(
        requireReviewItem(repository, params.jobId, params.itemId),
      ),
    }));
  }

  async resolve(
    params: CsvJobReviewResolveParams,
  ): Promise<CsvJobReviewResolveResult> {
    validateResolutionParams(params);
    return withRepository(params.cwd, (repository) => {
      const item = requireReviewItem(repository, params.jobId, params.itemId);
      const resolution = createOperatorEffectReviewResolution({
        disposition: params.disposition,
        actorId: params.reviewer,
        evidenceRef: params.evidenceRef,
        evidenceSha256: params.evidenceSha256,
        reviewedAt: new Date().toISOString(),
      });
      const requestedResult =
        params.result === undefined
          ? undefined
          : canonicalizeCsvResult(params.result);

      if (params.disposition !== "confirmed_committed" && requestedResult) {
        throw new AgenCCsvJobReviewError(
          "CSV_REVIEW_INVALID",
          "a CSV review result is valid only for confirmed_committed",
        );
      }
      if (item.reviewStatus !== "pending") {
        return replayOrConflict(item, resolution, requestedResult);
      }

      try {
        repository.resolveUnknownOutcome({
          jobId: params.jobId,
          itemId: params.itemId,
          disposition: resolution.disposition,
          domainAction: requireDomainAction(resolution),
          evidence: resolution as unknown as Record<string, unknown>,
          actor: params.reviewer,
          reason: params.reason,
          ...(item.effect !== undefined ? { effectReview: resolution } : {}),
          ...(requestedResult !== undefined
            ? { result: requestedResult.value }
            : {}),
        });
      } catch (error) {
        const current = repository.getItem(params.jobId, params.itemId);
        if (current !== null && current.reviewStatus !== "pending") {
          return replayOrConflict(current, resolution, requestedResult);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new AgenCCsvJobReviewError(
          isCanonicalResolutionConflict(message)
            ? "CSV_REVIEW_CONFLICT"
            : "CSV_REVIEW_INVALID",
          message,
        );
      }

      return {
        contractVersion: CSV_REVIEW_CONTRACT_VERSION,
        outcome: "resolved",
        review: projectReviewDetail(
          requireReviewItem(repository, params.jobId, params.itemId),
        ),
        job: projectJobSummary(requireJob(repository, params.jobId)),
      };
    });
  }
}

function validateWorkspaceAndIdentifiers(
  cwd: string,
  jobId: string,
  itemId?: string,
): void {
  try {
    requireAbsoluteWorkspaceCwd(cwd, "CSV job review");
  } catch (error) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_INVALID",
      error instanceof WorkspaceCwdError ? error.message : String(error),
    );
  }
  validateBoundedText(jobId, "CSV job id", CSV_REVIEW_IDENTIFIER_MAX_BYTES);
  if (itemId !== undefined) {
    validateBoundedText(
      itemId,
      "CSV job item id",
      CSV_REVIEW_IDENTIFIER_MAX_BYTES,
    );
  }
}

function validateResolutionParams(params: CsvJobReviewResolveParams): void {
  validateWorkspaceAndIdentifiers(params.cwd, params.jobId, params.itemId);
  validateBoundedText(
    params.reviewer,
    "CSV review operator",
    CSV_REVIEW_IDENTIFIER_MAX_BYTES,
  );
  validateBoundedText(
    params.evidenceRef,
    "CSV review evidence reference",
    CSV_REVIEW_EVIDENCE_REF_MAX_BYTES,
  );
  validateBoundedText(
    params.reason,
    "CSV review reason",
    CSV_REVIEW_RESOLUTION_REASON_MAX_BYTES,
  );
  if (!CSV_REVIEW_SHA256_PATTERN.test(params.evidenceSha256)) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_INVALID",
      "CSV review evidence digest must be a lowercase SHA-256 digest",
    );
  }
}

function validateBoundedText(
  value: string,
  label: string,
  maximumBytes: number,
): void {
  if (value.trim().length === 0) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_INVALID",
      `${label} must be non-empty`,
    );
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_INVALID",
      `${label} exceeds ${maximumBytes} UTF-8 bytes`,
    );
  }
}

function isCanonicalResolutionConflict(message: string): boolean {
  return (
    message.includes("different review resolution") ||
    message.includes("disagrees with canonical A1") ||
    message.includes("canonical effect identity is missing or stale")
  );
}

function withRepository<Result>(
  cwd: string,
  operation: (repository: CsvAgentJobsRepository) => Result,
): Result {
  const driver = openStateDatabases({ cwd });
  try {
    return operation(new CsvAgentJobsRepository(driver));
  } finally {
    driver.close();
  }
}

function requireJob(
  repository: CsvAgentJobsRepository,
  jobId: string,
): CsvAgentJobSummary {
  const job = repository.getSummary(jobId);
  if (job === null) {
    throw new AgenCCsvJobReviewError(
      "CSV_JOB_NOT_FOUND",
      `CSV job ${jobId} was not found`,
    );
  }
  return job;
}

function requireReviewItem(
  repository: CsvAgentJobsRepository,
  jobId: string,
  itemId: string,
): CsvAgentJobItem {
  requireJob(repository, jobId);
  const item = repository.getItem(jobId, itemId);
  if (item === null) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_NOT_FOUND",
      `CSV job item ${jobId}/${itemId} was not found`,
    );
  }
  if (item.reviewStatus === undefined) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_NOT_PENDING",
      `CSV job item ${jobId}/${itemId} has no operator review`,
    );
  }
  return item;
}

function replayOrConflict(
  item: CsvAgentJobItem,
  resolution: EffectReviewResolution,
  requestedResult: ReturnType<typeof canonicalizeCsvResult> | undefined,
): CsvJobReviewResolveResult {
  if (
    sameResolution(item.reviewEvidence, resolution) &&
    sameResolutionResult(item, resolution, requestedResult)
  ) {
    return {
      contractVersion: CSV_REVIEW_CONTRACT_VERSION,
      outcome: "already_resolved",
      review: projectReviewDetail(item),
    };
  }
  throw new AgenCCsvJobReviewError(
    "CSV_REVIEW_CONFLICT",
    `CSV job item ${item.jobId}/${item.itemId} already has a different review resolution`,
  );
}

function sameResolution(
  stored: Record<string, unknown> | undefined,
  requested: EffectReviewResolution,
): boolean {
  if (stored === undefined) return false;
  const identityKeys = [
    "version",
    "kind",
    "disposition",
    "actorKind",
    "actorId",
    "evidenceKind",
    "evidenceRef",
    "evidenceSha256",
    "workflowStatus",
    "domainAction",
  ] as const;
  return identityKeys.every((key) => stored[key] === requested[key]);
}

function sameResolutionResult(
  item: CsvAgentJobItem,
  resolution: EffectReviewResolution,
  requestedResult: ReturnType<typeof canonicalizeCsvResult> | undefined,
): boolean {
  if (resolution.disposition !== "confirmed_committed") return true;
  if (requestedResult !== undefined) {
    return (
      item.resultAvailability === "available" &&
      item.resultDigest === requestedResult.digest
    );
  }
  return item.resultAvailability === "unavailable_after_review";
}

function requireDomainAction(
  resolution: EffectReviewResolution,
): "mark_completed" | "retry_new_attempt" | "abandon_item" {
  if (resolution.domainAction === undefined) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_INVALID",
      "canonical CSV review resolution has no domain action",
    );
  }
  return resolution.domainAction;
}

function projectJobSummary(job: CsvAgentJobSummary): CsvJobReviewJobSummary {
  return job as unknown as CsvJobReviewJobSummary;
}

function projectReviewDetail(item: CsvAgentJobItem): CsvJobReviewDetail {
  const sourceId = projectText(item.sourceId, CSV_REVIEW_SOURCE_ID_MAX_BYTES);
  const reason = projectText(item.reviewReason, CSV_REVIEW_REASON_MAX_BYTES);
  const evidence = projectEvidence(item.reviewEvidence);
  return {
    contractVersion: CSV_REVIEW_CONTRACT_VERSION,
    jobId: item.jobId,
    itemId: item.itemId,
    rowIndex: item.rowIndex,
    status: item.status,
    attemptCount: item.attemptCount,
    resultAvailability: item.resultAvailability,
    resultSizeBytes: item.resultSizeBytes,
    reviewStatus: item.reviewStatus ?? "pending",
    ...(sourceId.value !== undefined ? { sourceId: sourceId.value } : {}),
    ...(sourceId.truncated ? { sourceIdTruncated: true } : {}),
    ...(item.resultDigest !== undefined
      ? { resultDigest: item.resultDigest }
      : {}),
    ...(reason.value !== undefined ? { reviewReason: reason.value } : {}),
    ...(reason.truncated ? { reviewReasonTruncated: true } : {}),
    ...(item.reviewDisposition !== undefined
      ? { disposition: item.reviewDisposition }
      : {}),
    ...(item.reviewDomainAction !== undefined
      ? { domainAction: item.reviewDomainAction }
      : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(item.effect !== undefined
      ? {
          effect: {
            runId: item.effect.runId,
            stepId: item.effect.stepId,
            epoch: item.effect.epoch,
          },
        }
      : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
  };
}

function projectEvidence(
  evidence: Record<string, unknown> | undefined,
): CsvJobReviewDetail["evidence"] | undefined {
  if (evidence === undefined) return undefined;
  const json = JSON.stringify(evidence);
  const bytes = Buffer.byteLength(json, "utf8");
  const sha256 = createHash("sha256").update(json).digest("hex");
  return bytes <= CSV_REVIEW_EVIDENCE_MAX_BYTES
    ? {
        bytes,
        sha256,
        truncated: false,
        value: evidence as JsonObject,
      }
    : { bytes, sha256, truncated: true };
}

function projectText(
  value: string | undefined,
  maxBytes: number,
): { readonly value?: string; readonly truncated: boolean } {
  if (value === undefined) return { truncated: false };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
