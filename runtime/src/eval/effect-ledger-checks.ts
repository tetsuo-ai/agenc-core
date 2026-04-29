import type { EffectRecord, EffectStatus } from "../workflow/effects.js";

export interface EffectLedgerCompletenessArtifact {
  readonly totalEffects: number;
  readonly completeEffects: number;
  readonly completenessRate: number;
  readonly missingApprovalLinks: number;
  readonly missingPreExecutionSnapshots: number;
  readonly missingPostExecutionSnapshots: number;
  readonly missingResultSummaries: number;
  readonly duplicateIdempotencyKeys: number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return numerator / denominator;
}

function requiresApprovalLink(record: EffectRecord): boolean {
  return (
    record.status === "pending_approval" ||
    record.status === "approved" ||
    record.status === "denied" ||
    record.approval !== undefined
  );
}

function requiresFilesystemSnapshots(record: EffectRecord): boolean {
  return (
    record.kind === "filesystem_write" ||
    record.kind === "filesystem_append" ||
    record.kind === "filesystem_delete" ||
    record.kind === "filesystem_move" ||
    record.kind === "filesystem_mkdir"
  );
}

function requiresPostExecutionSnapshots(record: EffectRecord): boolean {
  return (
    requiresFilesystemSnapshots(record) &&
    (record.status === "succeeded" ||
      record.status === "failed" ||
      record.status === "compensated" ||
      record.status === "compensation_failed")
  );
}

function requiresResultSummary(status: EffectStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "compensated" ||
    status === "compensation_failed"
  );
}

export function evaluateEffectLedgerCompleteness(
  records: readonly EffectRecord[],
): EffectLedgerCompletenessArtifact {
  const seenIdempotencyKeys = new Set<string>();
  let duplicateIdempotencyKeys = 0;
  let missingApprovalLinks = 0;
  let missingPreExecutionSnapshots = 0;
  let missingPostExecutionSnapshots = 0;
  let missingResultSummaries = 0;
  let completeEffects = 0;

  for (const record of records) {
    if (seenIdempotencyKeys.has(record.idempotencyKey)) {
      duplicateIdempotencyKeys += 1;
    } else {
      seenIdempotencyKeys.add(record.idempotencyKey);
    }

    let complete = true;

    if (
      requiresApprovalLink(record) &&
      record.approval?.requestId === undefined &&
      record.approval?.disposition === undefined
    ) {
      missingApprovalLinks += 1;
      complete = false;
    }

    if (
      requiresFilesystemSnapshots(record) &&
      (!record.preExecutionSnapshots || record.preExecutionSnapshots.length === 0)
    ) {
      missingPreExecutionSnapshots += 1;
      complete = false;
    }

    if (
      requiresPostExecutionSnapshots(record) &&
      (!record.postExecutionSnapshots || record.postExecutionSnapshots.length === 0)
    ) {
      missingPostExecutionSnapshots += 1;
      complete = false;
    }

    if (requiresResultSummary(record.status) && !record.result) {
      missingResultSummaries += 1;
      complete = false;
    }

    if (complete) {
      completeEffects += 1;
    }
  }

  return {
    totalEffects: records.length,
    completeEffects,
    completenessRate: ratio(completeEffects, records.length),
    missingApprovalLinks,
    missingPreExecutionSnapshots,
    missingPostExecutionSnapshots,
    missingResultSummaries,
    duplicateIdempotencyKeys,
  };
}
