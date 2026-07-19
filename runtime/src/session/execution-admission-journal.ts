/** Canonical rollout projection for execution-admission transitions. */

import type { ExecutionAdmissionClient } from "../budget/admission-client.js";
import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import type { Event } from "./event-log.js";
import type { RolloutStore } from "./rollout-store.js";
import type { Session } from "./session.js";

const EXECUTION_ADMISSION_CATCHUP_PAGE_SIZE = 1_000;
const MAX_EXECUTION_ADMISSION_CATCHUP_EVENTS = 100_000;

/**
 * Project every live admission decision into one session's rollout. The
 * SQLite admission journal remains authoritative across restart; this durable
 * projection makes queue/reservation/reconcile/cancel/fallback decisions
 * visible through the same canonical event stream as the run they govern.
 */
export function bindExecutionAdmissionJournal(
  session: Session,
  admission: ExecutionAdmissionClient,
): () => void {
  const append = (event: AdmissionJournalEvent): void => {
    appendExecutionAdmissionEvent(session, event);
  };
  const unsubscribe =
    admission.subscribeCritical?.(append) ?? admission.subscribe(append);
  try {
    // Subscribe first, then converge the durable pre-bind history. JavaScript
    // cannot interleave another admission mutation during this synchronous
    // capped scan; detached/rebound sessions simply re-scan and the append
    // helper treats identical canonical evidence as an idempotent no-op.
    const replayJournal = admission.replayJournal?.bind(admission);
    let afterSequence = 0;
    let replayed = 0;
    while (replayJournal !== undefined) {
      const page = replayJournal({
        afterSequence,
        limit: EXECUTION_ADMISSION_CATCHUP_PAGE_SIZE,
      });
      if (page.length > EXECUTION_ADMISSION_CATCHUP_PAGE_SIZE) {
        throw new Error(
          `execution admission catch-up page exceeded ${EXECUTION_ADMISSION_CATCHUP_PAGE_SIZE} events`,
        );
      }
      if (page.length === 0) break;
      for (const event of page) {
        if (
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= afterSequence
        ) {
          throw new Error(
            `execution admission catch-up made no monotonic progress after sequence ${afterSequence}`,
          );
        }
        if (replayed >= MAX_EXECUTION_ADMISSION_CATCHUP_EVENTS) {
          throw new Error(
            `execution admission catch-up exceeded ${MAX_EXECUTION_ADMISSION_CATCHUP_EVENTS} events`,
          );
        }
        append(event);
        afterSequence = event.sequence;
        replayed += 1;
      }
      if (page.length < EXECUTION_ADMISSION_CATCHUP_PAGE_SIZE) break;
    }
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}

/**
 * Idempotently project one SQLite-authoritative admission transition into the
 * canonical rollout. The admission event's existing eventId is carried into
 * the protocol envelope instead of inventing a second identity. A retry after
 * a post-fsync failure accepts only byte-equivalent evidence already present
 * in the rollout.
 */
function appendExecutionAdmissionEvent(
  session: Session,
  payload: AdmissionJournalEvent,
): void {
  // Lightweight structural test adapters predate Session.rolloutStore. Keep
  // their observer contract intact; real Session instances always own this
  // field and must fail closed when no canonical store is attached.
  const structuralSession = session as unknown as {
    readonly rolloutStore?: RolloutStore | null;
    emit: Session["emit"];
  };
  if (structuralSession.rolloutStore === undefined) {
    structuralSession.emit(
      {
        eventId: payload.eventId,
        id: payload.eventId,
        msg: { type: "execution_admission", payload },
      },
      { durable: true },
    );
    return;
  }
  const rolloutStore = structuralSession.rolloutStore;
  if (rolloutStore === null) {
    throw new Error(
      `execution admission event ${payload.eventId} has no canonical rollout store`,
    );
  }

  const existing = findExecutionAdmissionEvent(rolloutStore, payload.eventId);
  if (existing !== undefined) {
    assertMatchingExecutionAdmissionEvent(existing, payload);
    rolloutStore.syncCanonicalTail();
    return;
  }

  try {
    const event = session.emit(
      {
        eventId: payload.eventId,
        id: payload.eventId,
        msg: { type: "execution_admission", payload },
      },
      { durable: true },
    );
    if (
      event.eventId !== payload.eventId ||
      !Number.isSafeInteger(event.seq) ||
      (event.seq ?? 0) <= 0
    ) {
      throw new Error(
        `execution admission event ${payload.eventId} has no canonical coordinates`,
      );
    }
    rememberExecutionAdmissionEvent(rolloutStore, event);
  } catch (error) {
    // Session.emit can fail after append/fsync (for example the M4 publish
    // failpoint). Treat already-committed identical evidence as success; a
    // missing or conflicting append remains a hard boundary failure.
    executionAdmissionEventIndexes.delete(rolloutStore);
    const committed = findExecutionAdmissionEvent(
      rolloutStore,
      payload.eventId,
    );
    if (committed !== undefined) {
      assertMatchingExecutionAdmissionEvent(committed, payload);
      rolloutStore.syncCanonicalTail();
      return;
    }
    throw error;
  }
}

interface ExecutionAdmissionEventIndex {
  readonly byEventId: Map<string, Event[]>;
}

/**
 * A rollout has a single writer under its SessionLock, so an identity index is
 * stable for the life of that RolloutStore. Keeping it here makes live
 * projection O(1) after one bounded scan instead of reparsing the complete
 * journal at every provider/tool boundary. Ambiguous post-append failures
 * explicitly invalidate and rebuild it from canonical bytes.
 */
const executionAdmissionEventIndexes = new WeakMap<
  RolloutStore,
  ExecutionAdmissionEventIndex
>();

function findExecutionAdmissionEvent(
  rolloutStore: RolloutStore,
  eventId: string,
): Event | undefined {
  const matches =
    executionAdmissionEventIndex(rolloutStore).byEventId.get(eventId) ?? [];
  if (matches.length > 1) {
    throw new Error(
      `execution admission event ${eventId} has duplicate canonical evidence`,
    );
  }
  return matches[0];
}

function executionAdmissionEventIndex(
  rolloutStore: RolloutStore,
): ExecutionAdmissionEventIndex {
  const cached = executionAdmissionEventIndexes.get(rolloutStore);
  if (cached !== undefined) return cached;
  const index: ExecutionAdmissionEventIndex = { byEventId: new Map() };
  for (const item of rolloutStore.readAll()) {
    if (item.type === "event_msg") {
      indexExecutionAdmissionEvent(index, item.payload);
    }
  }
  executionAdmissionEventIndexes.set(rolloutStore, index);
  return index;
}

function rememberExecutionAdmissionEvent(
  rolloutStore: RolloutStore,
  event: Event,
): void {
  indexExecutionAdmissionEvent(
    executionAdmissionEventIndex(rolloutStore),
    event,
  );
}

function indexExecutionAdmissionEvent(
  index: ExecutionAdmissionEventIndex,
  event: Event,
): void {
  const identities = new Set<string>();
  if (typeof event.eventId === "string" && event.eventId.length > 0) {
    identities.add(event.eventId);
  }
  if (event.msg.type === "execution_admission") {
    identities.add(event.msg.payload.eventId);
  }
  for (const identity of identities) {
    const matches = index.byEventId.get(identity) ?? [];
    if (!matches.includes(event)) matches.push(event);
    index.byEventId.set(identity, matches);
  }
}

function assertMatchingExecutionAdmissionEvent(
  event: Event,
  payload: AdmissionJournalEvent,
): void {
  if (
    event.eventId !== payload.eventId ||
    !Number.isSafeInteger(event.seq) ||
    (event.seq ?? 0) <= 0 ||
    event.msg.type !== "execution_admission" ||
    JSON.stringify(event.msg.payload) !== JSON.stringify(payload)
  ) {
    throw new Error(
      `execution admission event ${payload.eventId} has conflicting canonical evidence`,
    );
  }
}
