/**
 * Memory-extraction cadence slot of the persisted session state.
 *
 * The extraction service (services/extractMemories) paces its child by
 * eligible turns and remembers how far into the model-visible history it has
 * read. Both counters used to live only in the service's in-process lane map,
 * so a daemon restart began the wait again while the conversation it paced
 * stayed on disk, and a lane the map pruned lost its place the same way.
 * This module gives the counters a durable home next to the agent-task slot
 * in agent-task-lifecycle.ts: the service persists them per memory root as a
 * `session_state` rollout item, the resume path restores the newest item per
 * root into session state, and the service seeds a new lane from there.
 *
 * Writers persist one slot per `session_state` item. The walker here reads
 * only items that address the memory-extraction slot, and the agent-task
 * walker skips these items (sessionStateUpdateAddressesSlot), so neither
 * writer can clear the other's slot.
 *
 * @module
 */

import type { Session } from "./session.js";
import {
  sessionStateUpdateAddressesSlot,
  type RolloutItem,
  type SessionMemoryExtractionState,
} from "./rollout-item.js";

export type { SessionMemoryExtractionState } from "./rollout-item.js";

/**
 * Augment SessionState with the extraction slot, keyed by normalized memory
 * root. This module owns the slot the way agent-task-lifecycle.ts owns
 * `agentTask`.
 */
interface SessionStateWithMemoryExtraction {
  memoryExtraction?: Readonly<Record<string, SessionMemoryExtractionState>>;
}

/** Test doubles for the extraction service may carry no state lock. */
function stateLock(session: Session): Session["state"] | undefined {
  const lock = (session as Partial<Pick<Session, "state">>).state;
  return lock !== undefined && typeof lock.with === "function"
    ? lock
    : undefined;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Shape check for a slot read back from disk; malformed slots are skipped. */
export function isSessionMemoryExtractionState(
  value: unknown,
): value is SessionMemoryExtractionState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.memoryRoot === "string" &&
    record.memoryRoot.length > 0 &&
    isCount(record.processedVisibleCount) &&
    isCount(record.turnsSinceLastExtraction)
  );
}

/**
 * Newest persisted cadence per memory root. Walks the rollout backwards and
 * keeps the first item met for each root, the same "latest wins" reading the
 * agent-task walker applies to its slot.
 */
export function latestPersistedMemoryExtractionState(
  rolloutItems: ReadonlyArray<RolloutItem>,
): ReadonlyMap<string, SessionMemoryExtractionState> {
  const latest = new Map<string, SessionMemoryExtractionState>();
  for (let i = rolloutItems.length - 1; i >= 0; i -= 1) {
    const item = rolloutItems[i];
    if (!item || item.type !== "session_state") continue;
    if (!sessionStateUpdateAddressesSlot(item.payload, "memoryExtraction")) {
      continue;
    }
    const slot = item.payload.memoryExtraction;
    if (!isSessionMemoryExtractionState(slot) || latest.has(slot.memoryRoot)) {
      continue;
    }
    latest.set(slot.memoryRoot, {
      memoryRoot: slot.memoryRoot,
      processedVisibleCount: slot.processedVisibleCount,
      turnsSinceLastExtraction: slot.turnsSinceLastExtraction,
    });
  }
  return latest;
}

/**
 * Resume step: seed session state with the newest persisted cadence per
 * memory root so the extraction service continues the count. A rollout
 * without the slot leaves the state untouched and the service starts at zero
 * as it always did.
 */
export async function restorePersistedMemoryExtractionState(
  session: Session,
  rolloutItems: ReadonlyArray<RolloutItem>,
): Promise<void> {
  const latest = latestPersistedMemoryExtractionState(rolloutItems);
  if (latest.size === 0) return;
  const lock = stateLock(session);
  if (lock === undefined) return;
  await lock.with((s) => {
    const state = s as unknown as SessionStateWithMemoryExtraction;
    state.memoryExtraction = {
      ...(state.memoryExtraction ?? {}),
      ...Object.fromEntries(latest),
    };
  });
}

/** The cadence a lane for `memoryRoot` continues from, if one is known. */
export async function readMemoryExtractionState(
  session: Session,
  memoryRoot: string,
): Promise<SessionMemoryExtractionState | undefined> {
  const lock = stateLock(session);
  if (lock === undefined) return undefined;
  return lock.with(
    (s) =>
      (s as unknown as SessionStateWithMemoryExtraction).memoryExtraction?.[
        memoryRoot
      ],
  );
}

/**
 * Record a cadence change: the session state mirror first, so a lane
 * re-created in this process continues from it, then the rollout, so the
 * next process does. Sessions without a rollout recorder keep the mirror
 * only.
 */
export async function persistMemoryExtractionState(
  session: Session,
  state: SessionMemoryExtractionState,
): Promise<void> {
  const lock = stateLock(session);
  if (lock !== undefined) {
    await lock.with((s) => {
      const current = s as unknown as SessionStateWithMemoryExtraction;
      current.memoryExtraction = {
        ...(current.memoryExtraction ?? {}),
        [state.memoryRoot]: state,
      };
    });
  }
  const rollout = (session as Partial<Pick<Session, "services">>).services
    ?.rollout;
  if (rollout === undefined) return;
  const item: RolloutItem = {
    type: "session_state",
    payload: { memoryExtraction: state },
  };
  await rollout.record(item);
}
