import { canonicalizeCsvResult } from "../agents/jobs/csv-schema.js";
import type { EffectReviewResolution } from "../contracts/run-contracts.js";
import {
  CsvAgentJobsRepository,
  type CsvAgentJobReviewProjection,
  type CsvAgentJobSummary,
} from "../state/csv-agent-jobs.js";
import { createOperatorEffectReviewResolution } from "../state/effect-review.js";
import { canonicalizeEffectReviewResolution } from "../state/run-durability.js";
import type { CsvAgentJobsRepositoryProvider } from "./csv-agent-jobs-authority.js";
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
  list(
    params: CsvJobReviewListParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CsvJobReviewListResult>;
  show(
    params: CsvJobReviewShowParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CsvJobReviewShowResult>;
  resolve(
    params: CsvJobReviewResolveParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CsvJobReviewResolveResult>;
}

/**
 * Workspace-scoped operator review service. Canonical repository lifetime and
 * concurrent request leases belong to the injected process authority.
 */
export class AgenCCsvJobReviewStateService implements AgenCCsvJobReviewService {
  constructor(private readonly repositories: CsvAgentJobsRepositoryProvider) {}

  async list(
    params: CsvJobReviewListParams,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CsvJobReviewListResult> {
    validateWorkspaceAndIdentifiers(params.cwd, params.jobId);
    return this.repositories.withRepository(
      params.cwd,
      (repository, signal) => {
        signal.throwIfAborted();
        const job = requireJob(repository, params.jobId);
        const page = repository.listReviewProjectionsPage({
          jobId: params.jobId,
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        });
        return {
          contractVersion: CSV_REVIEW_CONTRACT_VERSION,
          job: projectJobSummary(job),
          reviews: page.reviews.map(projectReviewSummary),
          ...(page.nextCursor !== undefined
            ? { nextCursor: page.nextCursor }
            : {}),
        };
      },
      options,
    );
  }

  async show(
    params: CsvJobReviewShowParams,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CsvJobReviewShowResult> {
    validateWorkspaceAndIdentifiers(params.cwd, params.jobId, params.itemId);
    return this.repositories.withRepository(
      params.cwd,
      (repository, signal) => {
        signal.throwIfAborted();
        return {
          contractVersion: CSV_REVIEW_CONTRACT_VERSION,
          review: projectReviewDetail(
            requireReviewProjection(repository, params.jobId, params.itemId),
          ),
        };
      },
      options,
    );
  }

  async resolve(
    params: CsvJobReviewResolveParams,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CsvJobReviewResolveResult> {
    validateResolutionParams(params);
    return this.repositories.withRepository(
      params.cwd,
      async (repository, signal) => {
        signal.throwIfAborted();
        const item = requireReviewProjection(
          repository,
          params.jobId,
          params.itemId,
        );
        const resolution = createCanonicalResolution(params);
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
          signal.throwIfAborted();
          await repository.resolveUnknownOutcome(
            {
              jobId: params.jobId,
              itemId: params.itemId,
              disposition: resolution.disposition,
              domainAction: requireDomainAction(resolution),
              evidence: resolution as unknown as Record<string, unknown>,
              actor: params.reviewer,
              reason: params.reason,
              ...(item.effect !== undefined
                ? { effectReview: resolution }
                : {}),
              ...(requestedResult !== undefined
                ? { result: requestedResult.value }
                : {}),
            },
            { signal },
          );
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const current = repository.getReviewProjection(
            params.jobId,
            params.itemId,
          );
          if (current !== null && current.reviewStatus !== "pending") {
            return replayOrConflict(current, resolution, requestedResult);
          }
          const message =
            error instanceof Error ? error.message : String(error);
          throw new AgenCCsvJobReviewError(
            isCanonicalResolutionConflict(message)
              ? "CSV_REVIEW_CONFLICT"
              : "CSV_REVIEW_INVALID",
            message,
          );
        }

        signal.throwIfAborted();
        return {
          contractVersion: CSV_REVIEW_CONTRACT_VERSION,
          outcome: "resolved",
          review: projectReviewDetail(
            requireReviewProjection(repository, params.jobId, params.itemId),
          ),
          job: projectJobSummary(requireJob(repository, params.jobId)),
        };
      },
      options,
    );
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

function requireReviewProjection(
  repository: CsvAgentJobsRepository,
  jobId: string,
  itemId: string,
): CsvAgentJobReviewProjection {
  requireJob(repository, jobId);
  const item = repository.getReviewProjection(jobId, itemId);
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
  item: CsvAgentJobReviewProjection,
  resolution: EffectReviewResolution,
  requestedResult: ReturnType<typeof canonicalizeCsvResult> | undefined,
): CsvJobReviewResolveResult {
  if (
    sameResolution(item, resolution) &&
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
  item: CsvAgentJobReviewProjection,
  requested: EffectReviewResolution,
): boolean {
  const stored = item.reviewEvidence?.value;
  if (stored === undefined) return false;
  let canonicalStored: EffectReviewResolution;
  try {
    canonicalStored = canonicalizeEffectReviewResolution(
      stored as unknown as EffectReviewResolution,
    );
  } catch {
    return false;
  }
  return sameCanonicalResolutionIdentity(canonicalStored, requested);
}

function sameCanonicalResolutionIdentity(
  stored: EffectReviewResolution,
  requested: EffectReviewResolution,
): boolean {
  const storedRecord = stored as unknown as Record<PropertyKey, unknown>;
  const requestedRecord = requested as unknown as Record<PropertyKey, unknown>;
  const storedKeys = Reflect.ownKeys(storedRecord).filter(
    (key) => key !== "reviewedAt",
  );
  const requestedKeys = Reflect.ownKeys(requestedRecord).filter(
    (key) => key !== "reviewedAt",
  );
  return (
    storedKeys.length === requestedKeys.length &&
    storedKeys.every(
      (key) =>
        requestedKeys.includes(key) &&
        Object.is(storedRecord[key], requestedRecord[key]),
    )
  );
}

function createCanonicalResolution(
  params: CsvJobReviewResolveParams,
): EffectReviewResolution {
  try {
    return canonicalizeEffectReviewResolution(
      createOperatorEffectReviewResolution({
        disposition: params.disposition,
        actorId: params.reviewer,
        evidenceRef: params.evidenceRef,
        evidenceSha256: params.evidenceSha256,
        reviewedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    throw new AgenCCsvJobReviewError(
      "CSV_REVIEW_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function sameResolutionResult(
  item: CsvAgentJobReviewProjection,
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

function projectReviewSummary(
  item: CsvAgentJobReviewProjection,
): CsvJobReviewItemSummary {
  return {
    itemId: item.itemId,
    rowIndex: item.rowIndex,
    ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
    ...(item.sourceIdTruncated === true ? { sourceIdTruncated: true } : {}),
    ...(item.sourceIdDigest !== undefined
      ? { sourceIdDigest: item.sourceIdDigest }
      : {}),
    status: item.status,
    attemptCount: item.attemptCount,
    resultAvailability: item.resultAvailability,
    resultSizeBytes: item.resultSizeBytes,
    ...(item.resultDigest !== undefined
      ? { resultDigest: item.resultDigest }
      : {}),
    ...(item.reviewStatus !== undefined
      ? { reviewStatus: item.reviewStatus }
      : {}),
    ...(item.reviewReason !== undefined
      ? { reviewReason: item.reviewReason }
      : {}),
    ...(item.reviewReasonTruncated === true
      ? { reviewReasonTruncated: true }
      : {}),
  };
}

function projectReviewDetail(
  item: CsvAgentJobReviewProjection,
): CsvJobReviewDetail {
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
    ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
    ...(item.sourceIdTruncated === true ? { sourceIdTruncated: true } : {}),
    ...(item.resultDigest !== undefined
      ? { resultDigest: item.resultDigest }
      : {}),
    ...(item.reviewReason !== undefined
      ? { reviewReason: item.reviewReason }
      : {}),
    ...(item.reviewReasonTruncated === true
      ? { reviewReasonTruncated: true }
      : {}),
    ...(item.reviewDisposition !== undefined
      ? { disposition: item.reviewDisposition }
      : {}),
    ...(item.reviewDomainAction !== undefined
      ? { domainAction: item.reviewDomainAction }
      : {}),
    ...(item.reviewEvidence !== undefined
      ? {
          evidence: {
            bytes: item.reviewEvidence.bytes,
            sha256: item.reviewEvidence.sha256,
            truncated: item.reviewEvidence.truncated,
            ...(item.reviewEvidence.value !== undefined
              ? { value: item.reviewEvidence.value as unknown as JsonObject }
              : {}),
          },
        }
      : {}),
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
    ...(item.completedAt !== undefined
      ? { completedAt: item.completedAt }
      : {}),
  };
}
