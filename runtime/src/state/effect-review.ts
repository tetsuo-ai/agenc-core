import {
  OfflineRolloutSourceMissingError,
  withPinnedOfflineRolloutLease,
} from "../durability/offline-rollout.js";
import type { Event } from "../session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
} from "../session/rollout-item.js";
import { StateRunDurabilityRepository } from "./run-durability.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { resolveUnknownOutcomeEffect } from "./unknown-outcome-gate.js";

export interface ResolveDurableEffectReviewOptions {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly reviewedAt: string;
  readonly reviewedBy: string;
  readonly resolution: string;
}

export type ResolveDurableEffectReviewResult =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "resolved" | "already_resolved";
      readonly durable: boolean;
      readonly runId?: string;
      readonly stepId?: string;
      readonly eventId?: string;
      readonly sequence?: number;
    };

class CanonicalReviewEvidenceNotFoundError extends Error {
  constructor(runId: string, stepId: string) {
    super(
      `canonical journal has no matching unknown-outcome record for ${runId}/${stepId}`,
    );
    this.name = "CanonicalReviewEvidenceNotFoundError";
  }
}

/**
 * Resolve the legacy recovery gate and, when present, the v15 effect review in
 * one fail-closed workflow. Durable reviews append evidence to the canonical
 * rollout under its single-writer lease before either SQLite projection moves.
 */
export function resolveDurableEffectReview(
  driver: StateSqliteDriver,
  options: ResolveDurableEffectReviewOptions,
): ResolveDurableEffectReviewResult {
  const repository = new StateRunDurabilityRepository(driver);
  const effect = repository.getEffectBySessionCall(
    options.sessionId,
    options.toolCallId,
  );
  if (effect === undefined) {
    return resolveUnknownOutcomeEffect(driver, options)
      ? { kind: "resolved", durable: false }
      : { kind: "not_found" };
  }
  if (effect.outcome !== "unknown_outcome") return { kind: "not_found" };

  const bindings = repository
    .listJournalBindings(effect.runId)
    .filter(
      (candidate) =>
        candidate.sessionId === effect.sessionId &&
        candidate.epoch === effect.epoch &&
        !(
          !candidate.active &&
          candidate.gapReason !== undefined &&
          candidate.retiredThroughSequence !== undefined &&
          candidate.firstAvailableSequence === undefined
        ),
    )
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        right.boundAt.localeCompare(left.boundAt) ||
        right.sourcePath.localeCompare(left.sourcePath),
    );
  const eventId = `effect-review:${effect.runId}:${effect.stepId}`;
  let selectedSourcePath: string | undefined;
  let evidence:
    | ReturnType<typeof appendOrReadReviewEvent>
    | undefined;
  for (const binding of bindings) {
    try {
      evidence = appendOrReadReviewEvent({
        projectDir: driver.projectDir,
        sessionId: binding.sessionId,
        sourcePath: binding.sourcePath,
        eventId,
        payload: {
          runId: effect.runId,
          stepId: effect.stepId,
          callId: effect.callId,
          resolution: options.resolution,
          reviewedBy: options.reviewedBy,
          reviewedAt: options.reviewedAt,
        },
        expectedUnknownEvidence: {
          eventId: effect.resultEventId,
          sequence: effect.resultSequence,
        },
      });
      selectedSourcePath = binding.sourcePath;
      break;
    } catch (error) {
      if (
        error instanceof CanonicalReviewEvidenceNotFoundError ||
        error instanceof OfflineRolloutSourceMissingError
      ) {
        continue;
      }
      throw error;
    }
  }
  if (evidence === undefined || selectedSourcePath === undefined) {
    throw new Error(
      `run ${effect.runId} has no retained canonical journal evidence for effect review`,
    );
  }
  const priorResolved = effect.reviewStatus === "resolved";
  driver.transactionImmediate(() => {
    repository.updateJournalBounds({
      sourcePath: selectedSourcePath,
      firstAvailableSequence: evidence.firstSequence,
      lastSequence: evidence.lastSequence,
      updatedAt: evidence.payload.reviewedAt,
    });
    repository.resolveEffectReview({
      runId: effect.runId,
      stepId: effect.stepId,
      reviewedAt: evidence.payload.reviewedAt,
      reviewedBy: evidence.payload.reviewedBy,
      resolution: evidence.payload.resolution,
      eventId,
      evidence: {
        callId: effect.callId,
        sequence: evidence.sequence,
        source: "canonical_run_journal",
      },
    });
    resolveUnknownOutcomeEffect(driver, options);
  });
  return {
    kind: priorResolved ? "already_resolved" : "resolved",
    durable: true,
    runId: effect.runId,
    stepId: effect.stepId,
    eventId,
    sequence: evidence.sequence,
  };
}

function appendOrReadReviewEvent(
  options: {
    readonly projectDir: string;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly eventId: string;
    readonly payload: Extract<
      Event["msg"],
      { readonly type: "effect_review_resolved" }
    >["payload"];
    readonly expectedUnknownEvidence: {
      readonly eventId?: string;
      readonly sequence?: number;
    };
  },
): {
  readonly sequence: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly payload: typeof options.payload;
} {
  return withPinnedOfflineRolloutLease(
    {
      projectDir: options.projectDir,
      sessionId: options.sessionId,
      sourcePath: options.sourcePath,
    },
    (rollout) => {
      const raw = rollout.readUtf8();
      const journal = readValidatedEvents(raw);
      const {
        events,
        firstSequence,
        lastSequence: lastSequenceBeforeAppend,
      } = journal;
      const unknownEvidence = events.filter(
        (event) =>
          event.msg.type === "effect_unknown_outcome" &&
          event.msg.payload.runId === options.payload.runId &&
          event.msg.payload.stepId === options.payload.stepId &&
          event.msg.payload.callId === options.payload.callId,
      );
      if (unknownEvidence.length !== 1) {
        if (unknownEvidence.length === 0) {
          throw new CanonicalReviewEvidenceNotFoundError(
            options.payload.runId,
            options.payload.stepId,
          );
        }
        throw new Error(
          `canonical journal has ${unknownEvidence.length} matching unknown-outcome records for ${options.payload.runId}/${options.payload.stepId}`,
        );
      }
      const unknown = unknownEvidence[0]!;
      if (
        canonicalReviewEventId(unknown) !==
          options.expectedUnknownEvidence.eventId ||
        unknown.seq !== options.expectedUnknownEvidence.sequence
      ) {
        throw new Error(
          `canonical unknown-outcome evidence disagrees with the durable projection for ${options.payload.runId}/${options.payload.stepId}`,
        );
      }
      if (firstSequence === undefined) {
        throw new Error(
          `canonical unknown-outcome evidence has no sequenced journal boundary for ${options.payload.runId}/${options.payload.stepId}`,
        );
      }
      const existing = events.find(
        (event) => canonicalReviewEventId(event) === options.eventId,
      );
      if (existing !== undefined) {
        if (
          existing.msg.type !== "effect_review_resolved" ||
          !Number.isSafeInteger(existing.seq) ||
          (existing.seq ?? 0) <= 0
        ) {
          throw new Error(
            `journal event id ${options.eventId} has conflicting content`,
          );
        }
        const existingPayload = existing.msg.payload;
        if (
          existingPayload.runId !== options.payload.runId ||
          existingPayload.stepId !== options.payload.stepId ||
          existingPayload.callId !== options.payload.callId ||
          existingPayload.reviewedBy !== options.payload.reviewedBy ||
          existingPayload.resolution !== options.payload.resolution
        ) {
          throw new Error(
            `journal event id ${options.eventId} has conflicting content`,
          );
        }
        // A prior attempt can have written the record before its fsync failed.
        // Re-sync the idempotent match before allowing SQLite to advance.
        rollout.sync();
        return {
          sequence: existing.seq!,
          firstSequence,
          lastSequence: lastSequenceBeforeAppend,
          // A repeated operator command naturally carries a later wall-clock
          // time. Preserve the first durable review timestamp while requiring
          // the reviewer, resolution, and effect identity to match exactly.
          payload: existingPayload,
        };
      }
      const sequence = lastSequenceBeforeAppend + 1;
      const event: Event = {
        eventId: options.eventId,
        id: options.eventId,
        seq: sequence,
        msg: { type: "effect_review_resolved", payload: options.payload },
      };
      rollout.appendAndSync(
        serializeRolloutItem({ type: "event_msg", payload: event }),
      );
      return {
        sequence,
        firstSequence: Number.isFinite(firstSequence)
          ? firstSequence
          : sequence,
        lastSequence: sequence,
        payload: options.payload,
      };
    },
  );
}

function readValidatedEvents(raw: string): {
  readonly events: Event[];
  readonly firstSequence: number | undefined;
  readonly lastSequence: number;
} {
  const events: Event[] = [];
  const canonicalIds = new Set<string>();
  let firstSequence: number | undefined;
  let lastSequence = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const item = parseRolloutLine(line);
    if (item?.type !== "event_msg") continue;
    const event = item.payload;
    const canonicalId = canonicalReviewEventId(event);
    if (canonicalIds.has(canonicalId)) {
      throw new Error(`canonical journal event id ${canonicalId} is duplicated`);
    }
    canonicalIds.add(canonicalId);
    if (event.seq !== undefined) {
      if (
        !Number.isSafeInteger(event.seq) ||
        event.seq <= 0 ||
        event.seq <= lastSequence
      ) {
        throw new Error(
          `canonical journal contains invalid or non-monotonic sequence ${String(event.seq)}`,
        );
      }
      firstSequence ??= event.seq;
      lastSequence = event.seq;
    }
    events.push(event);
  }
  return { events, firstSequence, lastSequence };
}

function canonicalReviewEventId(event: Event): string {
  if (event.eventId !== undefined) {
    if (typeof event.eventId !== "string" || event.eventId.length === 0) {
      throw new Error("canonical journal contains an invalid eventId");
    }
    return event.eventId;
  }
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new Error("canonical journal event is missing identity");
  }
  if (
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
  ) {
    return `legacy-event:${event.seq}:${event.id}`;
  }
  return `legacy-unsequenced:${event.id}`;
}
