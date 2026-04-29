/**
 * Provider-neutral token and budget notices.
 *
 * Upstream-style attachment family, backed by AgenC's session-sidecar
 * snapshot instead of provider/account-specific limits. Context and
 * compaction reminders are thresholded across turns; explicit
 * per-turn output and USD budget notices render whenever the matching
 * operator budget is configured.
 *
 * @module
 */

import type { AttachmentTrackingState } from "../../session/attachment-state.js";
import type { AttachmentProducer, GetAttachmentsOptions } from "./orchestrator.js";
import type { Attachment } from "./types.js";

const CONTEXT_NOTICE_BUCKETS = Object.freeze([70, 80, 90, 95]);
const COMPACTION_NOTICE_BUCKETS = Object.freeze([80, 90, 100]);

function bucketFor(
  percentUsed: number,
  buckets: readonly number[],
): number | undefined {
  if (!Number.isFinite(percentUsed)) return undefined;
  let bucket: number | undefined;
  for (const candidate of buckets) {
    if (percentUsed >= candidate) bucket = candidate;
  }
  return bucket;
}

function maybeTokenUsageAttachment(
  opts: GetAttachmentsOptions,
  state: AttachmentTrackingState,
): Attachment[] {
  const context = opts.usageSnapshot?.context;
  if (context === undefined) return [];

  const bucket = bucketFor(context.percentUsed, CONTEXT_NOTICE_BUCKETS);
  if (bucket === undefined) {
    state.lastTokenUsageNoticeBucket = undefined;
    return [];
  }
  if (
    state.lastTokenUsageNoticeBucket !== undefined &&
    bucket <= state.lastTokenUsageNoticeBucket
  ) {
    return [];
  }

  state.lastTokenUsageNoticeBucket = bucket;
  return [
    {
      kind: "token_usage",
      used: context.usedTokens,
      total: context.totalTokens,
      remaining: context.remainingTokens,
      percentUsed: context.percentUsed,
    },
  ];
}

function maybeCompactionReminderAttachment(
  opts: GetAttachmentsOptions,
  state: AttachmentTrackingState,
): Attachment[] {
  const compaction = opts.usageSnapshot?.compaction;
  if (compaction === undefined) return [];

  const bucket = bucketFor(
    compaction.percentUsed,
    COMPACTION_NOTICE_BUCKETS,
  );
  if (bucket === undefined) {
    state.lastCompactionNoticeBucket = undefined;
    return [];
  }
  if (
    state.lastCompactionNoticeBucket !== undefined &&
    bucket <= state.lastCompactionNoticeBucket
  ) {
    return [];
  }

  state.lastCompactionNoticeBucket = bucket;
  return [
    {
      kind: "compaction_reminder",
      used: compaction.usedTokens,
      threshold: compaction.thresholdTokens,
      remaining: compaction.remainingTokens,
      percentUsed: compaction.percentUsed,
    },
  ];
}

function outputTokenUsageAttachment(
  opts: GetAttachmentsOptions,
): Attachment[] {
  const output = opts.usageSnapshot?.output;
  if (output === undefined) return [];
  if (output.budgetTokens === null || output.budgetTokens <= 0) {
    return [];
  }
  return [
    {
      kind: "output_token_usage",
      turn: output.turnTokens,
      session: output.sessionTokens,
      budget: output.budgetTokens,
    },
  ];
}

function budgetUsdAttachment(opts: GetAttachmentsOptions): Attachment[] {
  const budget = opts.usageSnapshot?.costBudget;
  if (budget === undefined) return [];
  return [
    {
      kind: "budget_usd",
      used: budget.usedUsd,
      total: budget.totalUsd,
      remaining: budget.remainingUsd,
      percentUsed: budget.percentUsed,
    },
  ];
}

export const usageNoticesProducer: AttachmentProducer = async (
  opts,
  state,
) => {
  if (opts.subagentDepth > 0) return [];
  return [
    ...maybeTokenUsageAttachment(opts, state),
    ...budgetUsdAttachment(opts),
    ...outputTokenUsageAttachment(opts),
    ...maybeCompactionReminderAttachment(opts, state),
  ];
};

