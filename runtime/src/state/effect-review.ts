import {
  OfflineRolloutSourceMissingError,
  withPinnedOfflineRolloutLease,
} from "../durability/offline-rollout.js";
import type { Event } from "../session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type RolloutItem,
} from "../session/rollout-item.js";
import type {
  EffectReviewDisposition,
  EffectReviewResolution,
} from "../contracts/run-contracts.js";
import { stableStringify } from "../utils/stableStringify.js";
import { StateRunDurabilityRepository } from "./run-durability.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { resolveUnknownOutcomeEffect } from "./unknown-outcome-gate.js";

export interface ResolveDurableEffectReviewOptions {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly resolution: EffectReviewResolution;
}

export interface LiveEffectReviewJournal {
  readAll(): readonly RolloutItem[];
  append(
    eventId: string,
    payload: {
      readonly runId: string;
      readonly stepId: string;
      readonly callId: string;
      readonly resolution: EffectReviewResolution;
    },
  ): Event;
  project(event: Event): void;
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

export function createOperatorEffectReviewResolution(options: {
  readonly disposition: EffectReviewDisposition;
  readonly actorId: string;
  readonly evidenceRef: string;
  readonly evidenceSha256: string;
  readonly reviewedAt: string;
}): EffectReviewResolution {
  const terminal =
    options.disposition === "confirmed_committed"
      ? {
          workflowStatus: "resolved" as const,
          domainAction: "mark_completed" as const,
        }
      : options.disposition === "confirmed_no_effect"
        ? {
            workflowStatus: "resolved" as const,
            domainAction: "retry_new_attempt" as const,
          }
        : {
            workflowStatus: "abandoned" as const,
            domainAction: "abandon_item" as const,
          };
  return {
    version: 1,
    kind: "effect_review_resolution",
    disposition: options.disposition,
    actorKind: "operator",
    actorId: options.actorId,
    evidenceKind: "operator_evidence",
    evidenceRef: options.evidenceRef,
    evidenceSha256: options.evidenceSha256,
    reviewedAt: options.reviewedAt,
    ...terminal,
  };
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
    return options.resolution.workflowStatus !== "pending" &&
      resolveUnknownOutcomeEffect(driver, options)
      ? { kind: "resolved", durable: false }
      : { kind: "not_found" };
  }
  if (effect.outcome !== "unknown_outcome") return { kind: "not_found" };
  if (
    (effect.reviewStatus === "resolved" ||
      effect.reviewStatus === "abandoned") &&
    effect.review !== undefined &&
    reviewIdentity(effect.review) !== reviewIdentity(options.resolution)
  ) {
    throw new Error(
      `run ${effect.runId} step ${effect.stepId} already has a different review resolution`,
    );
  }

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
  const eventId = reviewEventId(effect, options.resolution);
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
      updatedAt: evidence.payload.resolution.reviewedAt,
    });
    repository.resolveEffectReview({
      runId: effect.runId,
      stepId: effect.stepId,
      resolution: evidence.payload.resolution,
      eventId,
      evidence: {
        callId: effect.callId,
        sequence: evidence.sequence,
        source: "canonical_run_journal",
      },
    });
    if (evidence.payload.resolution.workflowStatus !== "pending") {
      resolveUnknownOutcomeEffect(driver, options);
    }
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

/**
 * Append and project an operator review through the Session that currently
 * owns the canonical journal lease. Repeated calls reuse the deterministic
 * journal event, so a projection failure never creates a second terminal
 * review record.
 */
export function resolveLiveDurableEffectReview(
  driver: StateSqliteDriver,
  options: ResolveDurableEffectReviewOptions,
  journal: LiveEffectReviewJournal,
): ResolveDurableEffectReviewResult {
  const repository = new StateRunDurabilityRepository(driver);
  const effect = repository.getEffectBySessionCall(
    options.sessionId,
    options.toolCallId,
  );
  if (effect === undefined) {
    return options.resolution.workflowStatus !== "pending" &&
      resolveUnknownOutcomeEffect(driver, options)
      ? { kind: "resolved", durable: false }
      : { kind: "not_found" };
  }
  if (effect.outcome !== "unknown_outcome") return { kind: "not_found" };
  const reviewWasTerminal =
    effect.reviewStatus === "resolved" || effect.reviewStatus === "abandoned";
  if (
    reviewWasTerminal &&
    effect.review !== undefined &&
    reviewIdentity(effect.review) !== reviewIdentity(options.resolution)
  ) {
    throw new Error(
      `run ${effect.runId} step ${effect.stepId} already has a different review resolution`,
    );
  }

  const eventId = reviewEventId(effect, options.resolution);
  const expectedPayload = {
    runId: effect.runId,
    stepId: effect.stepId,
    callId: effect.callId,
    resolution: options.resolution,
  } as const;
  const events = journal
    .readAll()
    .filter((item): item is Extract<RolloutItem, { readonly type: "event_msg" }> =>
      item.type === "event_msg",
    )
    .map((item) => item.payload);
  const unknownEvidence = events.filter(
    (event) =>
      event.msg.type === "effect_unknown_outcome" &&
      event.msg.payload.runId === effect.runId &&
      event.msg.payload.stepId === effect.stepId &&
      event.msg.payload.callId === effect.callId,
  );
  if (unknownEvidence.length !== 1) {
    throw new Error(
      `canonical journal has ${unknownEvidence.length} matching unknown-outcome records for ${effect.runId}/${effect.stepId}`,
    );
  }
  const unknown = unknownEvidence[0]!;
  if (
    canonicalReviewEventId(unknown) !== effect.resultEventId ||
    unknown.seq !== effect.resultSequence
  ) {
    throw new Error(
      `canonical unknown-outcome evidence disagrees with the durable projection for ${effect.runId}/${effect.stepId}`,
    );
  }

  const existing = events.find(
    (event) => canonicalReviewEventId(event) === eventId,
  );
  let reviewEvent: Event;
  if (existing === undefined) {
    reviewEvent = journal.append(eventId, expectedPayload);
  } else {
    assertMatchingReviewEvent(existing, eventId, expectedPayload);
    reviewEvent = existing;
  }
  if (!Number.isSafeInteger(reviewEvent.seq) || (reviewEvent.seq ?? 0) <= 0) {
    throw new Error(`journal event id ${eventId} has no durable sequence`);
  }
  journal.project(reviewEvent);
  if (options.resolution.workflowStatus !== "pending") {
    resolveUnknownOutcomeEffect(driver, options);
  }
  return {
    kind: reviewWasTerminal ? "already_resolved" : "resolved",
    durable: true,
    runId: effect.runId,
    stepId: effect.stepId,
    eventId,
    sequence: reviewEvent.seq,
  };
}

function reviewEventId(
  effect: { readonly runId: string; readonly stepId: string },
  resolution: EffectReviewResolution,
): string {
  return (
    `effect-review:${effect.runId}:${effect.stepId}:` +
    `${resolution.actorKind}:${resolution.workflowStatus}:` +
    resolution.evidenceSha256.slice(0, 12)
  );
}

function assertMatchingReviewEvent(
  event: Event,
  eventId: string,
  expected: {
    readonly runId: string;
    readonly stepId: string;
    readonly callId: string;
    readonly resolution: EffectReviewResolution;
  },
): void {
  if (
    event.msg.type !== "effect_review_resolved" ||
    !Number.isSafeInteger(event.seq) ||
    (event.seq ?? 0) <= 0
  ) {
    throw new Error(`journal event id ${eventId} has conflicting content`);
  }
  const payload = event.msg.payload;
  if (
    payload.runId !== expected.runId ||
    payload.stepId !== expected.stepId ||
    payload.callId !== expected.callId ||
    typeof payload.resolution === "string" ||
    reviewIdentity(payload.resolution) !== reviewIdentity(expected.resolution)
  ) {
    throw new Error(`journal event id ${eventId} has conflicting content`);
  }
}

function appendOrReadReviewEvent(
  options: {
    readonly projectDir: string;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly eventId: string;
    readonly payload: {
      readonly runId: string;
      readonly stepId: string;
      readonly callId: string;
      readonly resolution: EffectReviewResolution;
    };
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
          typeof existingPayload.resolution === "string" ||
          reviewIdentity(existingPayload.resolution) !==
            reviewIdentity(options.payload.resolution)
        ) {
          throw new Error(
            `journal event id ${options.eventId} has conflicting content`,
          );
        }
        if (typeof existingPayload.resolution === "string") {
          throw new Error(
            `journal event id ${options.eventId} contains legacy review evidence`,
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
          payload: {
            runId: existingPayload.runId,
            stepId: existingPayload.stepId,
            callId: existingPayload.callId,
            resolution: existingPayload.resolution,
          },
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

function reviewIdentity(resolution: EffectReviewResolution): string {
  const { reviewedAt: _reviewedAt, ...identity } = resolution;
  return stableStringify(identity);
}

function readValidatedEvents(raw: string): {
  readonly events: Event[];
  readonly firstSequence: number | undefined;
  readonly lastSequence: number;
} {
  const events: Event[] = [];
  const canonicalIds = new Map<string, string[]>();
  let firstSequence: number | undefined;
  let lastSequence = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const item = parseRolloutLine(line);
    if (item?.type !== "event_msg") continue;
    const event = item.payload;
    const canonicalId = canonicalReviewEventId(event);
    const priors = canonicalIds.get(canonicalId) ?? [];
    const signature = JSON.stringify(event);
    if (priors.length > 0) {
      // Legacy rollouts predate durable event identities — synthetic ids like
      // "system" recur across distinct events, so a repeated legacy id is the
      // old format, not corruption. Identical copies dedupe; distinct events
      // sharing the id are disambiguated. Only non-legacy ids throw (real
      // corruption), matching execution-admission-canonical-recovery.
      if (priors.includes(signature)) continue;
      if (!canonicalId.startsWith("legacy-unsequenced:")) {
        throw new Error(`canonical journal event id ${canonicalId} is duplicated`);
      }
      const disambiguated = `${canonicalId}~conflict-${priors.length}`;
      priors.push(signature);
      canonicalIds.set(canonicalId, priors);
      canonicalIds.set(disambiguated, [signature]);
    } else {
      priors.push(signature);
      canonicalIds.set(canonicalId, priors);
    }
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
