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
import {
  canonicalizeEffectReviewResolution,
  StateRunDurabilityRepository,
  type RunJournalBinding,
} from "./run-durability.js";
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

type EffectReviewEvent = Event & {
  readonly msg: Extract<
    Event["msg"],
    { readonly type: "effect_review_resolved" }
  >;
};

export type ResolveDurableEffectReviewResult =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "resolved" | "already_resolved";
      readonly durable: false;
      readonly resolution: EffectReviewResolution;
    }
  | {
      readonly kind: "resolved" | "already_resolved";
      readonly durable: true;
      readonly runId: string;
      readonly stepId: string;
      readonly eventId: string;
      readonly sequence: number;
      readonly resolution: EffectReviewResolution;
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
  const canonicalOptions = {
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    resolution: canonicalizeEffectReviewResolution(options.resolution),
  };
  return driver.transactionImmediate(() =>
    resolveDurableEffectReviewLocked(driver, canonicalOptions),
  );
}

function resolveDurableEffectReviewLocked(
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
      ? {
          kind: "resolved",
          durable: false,
          resolution: options.resolution,
        }
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
  const requestedEventId = reviewEventId(effect, options.resolution);
  let selectedSourcePath: string | undefined;
  let evidence: ReturnType<typeof appendOrReadReviewEvent> | undefined;
  for (const binding of bindings) {
    try {
      evidence = appendOrReadReviewEvent({
        projectDir: driver.projectDir,
        sessionId: binding.sessionId,
        sourcePath: binding.sourcePath,
        binding,
        eventId: requestedEventId,
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
  const reviewWasTerminal =
    effect.reviewStatus === "resolved" || effect.reviewStatus === "abandoned";
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
      eventId: evidence.eventId,
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
    kind: reviewWasTerminal ? "already_resolved" : "resolved",
    durable: true,
    runId: effect.runId,
    stepId: effect.stepId,
    eventId: evidence.eventId,
    sequence: evidence.sequence,
    resolution: evidence.payload.resolution,
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
  const resolution = canonicalizeEffectReviewResolution(options.resolution);
  const canonicalOptions = {
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    resolution,
  };
  const repository = new StateRunDurabilityRepository(driver);
  const effect = repository.getEffectBySessionCall(
    canonicalOptions.sessionId,
    canonicalOptions.toolCallId,
  );
  if (effect === undefined) {
    return resolution.workflowStatus !== "pending" &&
      resolveUnknownOutcomeEffect(driver, canonicalOptions)
      ? {
          kind: "resolved",
          durable: false,
          resolution,
        }
      : { kind: "not_found" };
  }
  if (effect.outcome !== "unknown_outcome") return { kind: "not_found" };
  const reviewWasTerminal =
    effect.reviewStatus === "resolved" || effect.reviewStatus === "abandoned";
  if (
    reviewWasTerminal &&
    effect.review !== undefined &&
    reviewIdentity(effect.review) !== reviewIdentity(resolution)
  ) {
    throw new Error(
      `run ${effect.runId} step ${effect.stepId} already has a different review resolution`,
    );
  }

  const requestedEventId = reviewEventId(effect, resolution);
  const expectedPayload = {
    runId: effect.runId,
    stepId: effect.stepId,
    callId: effect.callId,
    resolution,
  } as const;
  const events = journal
    .readAll()
    .filter(
      (item): item is Extract<RolloutItem, { readonly type: "event_msg" }> =>
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

  const existing = findCanonicalTerminalReview(events, expectedPayload);
  const matchingEventId = events.find(
    (event) => canonicalReviewEventId(event) === requestedEventId,
  );
  let reviewEvent: Event;
  if (existing !== undefined) {
    reviewEvent = existing;
  } else if (matchingEventId === undefined) {
    reviewEvent = journal.append(requestedEventId, expectedPayload);
  } else {
    reviewEvent = matchingEventId;
  }
  if (!Number.isSafeInteger(reviewEvent.seq) || (reviewEvent.seq ?? 0) <= 0) {
    throw new Error(
      `journal event id ${canonicalReviewEventId(reviewEvent)} has no durable sequence`,
    );
  }
  const canonicalReviewResolution = assertMatchingReviewEvent(
    reviewEvent,
    canonicalReviewEventId(reviewEvent),
    expectedPayload,
  );
  const canonicalReviewEvent = canonicalEffectReviewEvent(
    reviewEvent,
    canonicalReviewResolution,
  );
  journal.project(canonicalReviewEvent);
  if (canonicalReviewResolution.workflowStatus !== "pending") {
    resolveUnknownOutcomeEffect(driver, canonicalOptions);
  }
  return {
    kind: reviewWasTerminal ? "already_resolved" : "resolved",
    durable: true,
    runId: effect.runId,
    stepId: effect.stepId,
    eventId: canonicalReviewEventId(reviewEvent),
    sequence: reviewEvent.seq!,
    resolution: canonicalReviewResolution,
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
): EffectReviewResolution {
  if (
    event.msg.type !== "effect_review_resolved" ||
    !Number.isSafeInteger(event.seq) ||
    (event.seq ?? 0) <= 0
  ) {
    throw new Error(`journal event id ${eventId} has conflicting content`);
  }
  const payload = event.msg.payload;
  if (typeof payload.resolution === "string") {
    throw new Error(
      `journal event id ${eventId} contains legacy review evidence`,
    );
  }
  const resolution = canonicalizeEffectReviewResolution(payload.resolution);
  if (
    payload.runId !== expected.runId ||
    payload.stepId !== expected.stepId ||
    payload.callId !== expected.callId ||
    reviewIdentity(resolution) !== reviewIdentity(expected.resolution)
  ) {
    throw new Error(`journal event id ${eventId} has conflicting content`);
  }
  return resolution;
}

function findCanonicalTerminalReview(
  events: readonly Event[],
  expected: {
    readonly runId: string;
    readonly stepId: string;
    readonly callId: string;
    readonly resolution: EffectReviewResolution;
  },
): Event | undefined {
  const matchingEffectIdentity = events.filter(
    (event): event is EffectReviewEvent =>
      event.msg.type === "effect_review_resolved" &&
      event.msg.payload.runId === expected.runId &&
      event.msg.payload.stepId === expected.stepId,
  );
  for (const event of matchingEffectIdentity) {
    if (event.msg.payload.callId !== expected.callId) {
      throw new Error(
        `canonical effect review for ${expected.runId}/${expected.stepId} has conflicting call identity`,
      );
    }
    if (typeof event.msg.payload.resolution === "string") {
      throw new Error(
        `canonical effect review for ${expected.runId}/${expected.stepId} contains legacy evidence`,
      );
    }
  }
  const terminal = matchingEffectIdentity.filter(
    (event) =>
      typeof event.msg.payload.resolution !== "string" &&
      event.msg.payload.resolution.workflowStatus !== "pending",
  );
  if (terminal.length > 1) {
    throw new Error(
      `canonical journal has ${terminal.length} terminal effect reviews for ${expected.runId}/${expected.stepId}`,
    );
  }
  return terminal[0];
}

function canonicalEffectReviewEvent(
  event: Event,
  resolution: EffectReviewResolution,
): Event {
  if (event.msg.type !== "effect_review_resolved") {
    throw new Error(
      `journal event id ${canonicalReviewEventId(event)} has conflicting content`,
    );
  }
  return {
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    id: event.id,
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
    msg: {
      type: "effect_review_resolved",
      payload: {
        runId: event.msg.payload.runId,
        stepId: event.msg.payload.stepId,
        callId: event.msg.payload.callId,
        resolution,
      },
    },
  };
}

function appendOrReadReviewEvent(options: {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly binding: RunJournalBinding;
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
}): {
  readonly sequence: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventId: string;
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
      assertJournalBindingMatchesScan(
        options.binding,
        firstSequence,
        lastSequenceBeforeAppend,
      );
      const terminalReview = findCanonicalTerminalReview(
        events,
        options.payload,
      );
      if (terminalReview !== undefined) {
        const terminalEventId = canonicalReviewEventId(terminalReview);
        const terminalResolution = assertMatchingReviewEvent(
          terminalReview,
          terminalEventId,
          options.payload,
        );
        // A prior attempt may have durably appended its terminal record before
        // SQLite projection failed. Preserve that first exact resolution and
        // timestamp; never append a second terminal event under a new id.
        rollout.sync();
        return {
          sequence: terminalReview.seq!,
          firstSequence,
          lastSequence: lastSequenceBeforeAppend,
          eventId: terminalEventId,
          payload: {
            runId: options.payload.runId,
            stepId: options.payload.stepId,
            callId: options.payload.callId,
            resolution: terminalResolution,
          },
        };
      }
      const existing = events.find(
        (event) => canonicalReviewEventId(event) === options.eventId,
      );
      if (existing !== undefined) {
        const existingResolution = assertMatchingReviewEvent(
          existing,
          options.eventId,
          options.payload,
        );
        // A prior attempt can have written the record before its fsync failed.
        // Re-sync the idempotent match before allowing SQLite to advance.
        rollout.sync();
        return {
          sequence: existing.seq!,
          firstSequence,
          lastSequence: lastSequenceBeforeAppend,
          eventId: options.eventId,
          // A repeated operator command naturally carries a later wall-clock
          // time. Preserve the first durable review timestamp while requiring
          // the reviewer, resolution, and effect identity to match exactly.
          payload: {
            runId: options.payload.runId,
            stepId: options.payload.stepId,
            callId: options.payload.callId,
            resolution: existingResolution,
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
        eventId: options.eventId,
        payload: options.payload,
      };
    },
  );
}

function assertJournalBindingMatchesScan(
  binding: RunJournalBinding,
  firstSequence: number,
  lastSequence: number,
): void {
  if (
    binding.firstAvailableSequence !== undefined &&
    firstSequence > binding.firstAvailableSequence
  ) {
    throw new Error(
      "journal binding would silently advance past retained events",
    );
  }
  if (
    binding.lastSequence !== undefined &&
    lastSequence < binding.lastSequence
  ) {
    throw new Error("journal binding would silently truncate retained events");
  }
  if (
    binding.retiredThroughSequence !== undefined &&
    binding.retiredThroughSequence >= firstSequence
  ) {
    throw new Error("journal binding retirement overlaps retained events");
  }
  if (
    binding.firstAvailableSequence !== undefined &&
    binding.lastSequence !== undefined &&
    binding.lastSequence < binding.firstAvailableSequence
  ) {
    throw new Error("journal binding has invalid retained bounds");
  }
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
        throw new Error(
          `canonical journal event id ${canonicalId} is duplicated`,
        );
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
