import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import {
  withPinnedOfflineRolloutLease,
  type PinnedOfflineRollout,
} from "../durability/offline-rollout.js";
import type { Event } from "../session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
} from "../session/rollout-item.js";
import { stableStringify } from "../utils/stableStringify.js";
import { backfillPinnedRolloutContent } from "./backfill.js";
import type { ExecutionAdmissionRepository } from "./execution-admission.js";
import {
  StateRunDurabilityRepository,
  type RunJournalBinding,
} from "./run-durability.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

const DEFAULT_MAX_RUNS = 4_096;
const DEFAULT_MAX_EVENTS_PER_RUN = 100_000;
const DEFAULT_MAX_SOURCES_PER_RUN = 32;
const JOURNAL_PAGE_SIZE = 1_000;

interface AdmissionRunRow {
  readonly run_id: string;
}

interface CanonicalEventRecord {
  readonly event: Event;
  readonly eventId: string;
  readonly sequence: number | undefined;
  readonly signature: string;
  readonly sourcePath: string;
}

export interface ExecutionAdmissionCanonicalRecoveryResult {
  readonly runsScanned: number;
  readonly sourcesScanned: number;
  readonly admissionEventsScanned: number;
  readonly admissionEventsAppended: number;
}

/**
 * Converge SQLite-committed admission decisions into the canonical rollout.
 *
 * SQLite remains the admission/budget authority. This is a bounded recovery
 * projection of those exact rows, carrying their existing event IDs and
 * payloads into the run's per-run sequence namespace. Every retained source
 * is leased with the same SessionLock used by live writers. Conflicts, a live
 * writer, missing source bytes, an exhausted bound, or a sealed terminal tail
 * all refuse startup instead of exposing silently incomplete replay.
 */
export function recoverExecutionAdmissionCanonicalJournals(
  driver: StateSqliteDriver,
  admissions: ExecutionAdmissionRepository,
  options: {
    readonly maxRuns?: number;
    readonly maxEventsPerRun?: number;
    readonly maxSourcesPerRun?: number;
  } = {},
): ExecutionAdmissionCanonicalRecoveryResult {
  const maxRuns = positiveBound(options.maxRuns ?? DEFAULT_MAX_RUNS, "maxRuns");
  const maxEvents = positiveBound(
    options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN,
    "maxEventsPerRun",
  );
  const maxSources = positiveBound(
    options.maxSourcesPerRun ?? DEFAULT_MAX_SOURCES_PER_RUN,
    "maxSourcesPerRun",
  );
  const unboundCanonicalRun = driver
    .prepareState<[], AdmissionRunRow>(
      `SELECT DISTINCT admission.run_id
       FROM execution_admission_journal AS admission
       JOIN run_lifecycle_epochs AS lifecycle
         ON lifecycle.run_id = admission.run_id
       WHERE NOT EXISTS (
         SELECT 1 FROM run_journal_bindings AS binding
         WHERE binding.run_id = admission.run_id
       )
       ORDER BY admission.run_id ASC
       LIMIT 1`,
    )
    .get();
  if (unboundCanonicalRun !== undefined) {
    throw new Error(
      `run ${unboundCanonicalRun.run_id} has committed admission evidence and a canonical lifecycle but no journal binding`,
    );
  }
  const runs = driver
    .prepareState<[number], AdmissionRunRow>(
      `SELECT DISTINCT admission.run_id
       FROM execution_admission_journal AS admission
       JOIN run_journal_bindings AS binding
         ON binding.run_id = admission.run_id
       ORDER BY admission.run_id ASC
       LIMIT ?`,
    )
    .all(maxRuns + 1);
  if (runs.length > maxRuns) {
    throw new Error(
      `canonical admission recovery exceeds the bounded run limit (${maxRuns})`,
    );
  }

  const durability = new StateRunDurabilityRepository(driver);
  const threads = new StateThreadRepository(driver);
  let sourcesScanned = 0;
  let admissionEventsScanned = 0;
  let admissionEventsAppended = 0;
  for (const row of runs) {
    const bindings = retainedBindings(
      durability.listJournalBindings(row.run_id),
    );
    if (bindings.length === 0) continue;
    if (bindings.length > maxSources) {
      throw new Error(
        `run ${row.run_id} canonical admission recovery exceeds the bounded source limit (${maxSources})`,
      );
    }
    const journal = readAdmissionJournal(admissions, row.run_id, maxEvents);
    admissionEventsScanned += journal.length;
    const result = convergeRun({
      runId: row.run_id,
      driver,
      bindings,
      journal,
      durability,
      threads,
    });
    sourcesScanned += bindings.length;
    admissionEventsAppended += result.appended;
  }
  return {
    runsScanned: runs.length,
    sourcesScanned,
    admissionEventsScanned,
    admissionEventsAppended,
  };
}

function convergeRun(params: {
  readonly runId: string;
  readonly driver: StateSqliteDriver;
  readonly bindings: readonly RunJournalBinding[];
  readonly journal: readonly AdmissionJournalEvent[];
  readonly durability: StateRunDurabilityRepository;
  readonly threads: StateThreadRepository;
}): { readonly appended: number } {
  const bindings = uniqueSourceBindings(params.bindings);
  return withPinnedBindings(
    params.driver.projectDir,
    bindings,
    new Map(),
    (leases) => {
      const canonical = bindings.flatMap((binding) =>
        readCanonicalEvents(
          leases.get(binding.sourcePath)!.readUtf8(),
          binding.sourcePath,
        ),
      );
      const index = validateCanonicalEvents(canonical, params.runId);
      const missing: AdmissionJournalEvent[] = [];
      for (const event of params.journal) {
        const envelopeMatches = index.byEventId.get(event.eventId) ?? [];
        const payloadMatches =
          index.byAdmissionEventId.get(event.eventId) ?? [];
        const matches = [...new Set([...envelopeMatches, ...payloadMatches])];
        if (matches.length === 0) {
          missing.push(event);
          continue;
        }
        for (const match of matches) assertAdmissionMatch(match.event, event);
      }

      const target = selectTargetBinding(params.bindings);
      if (
        missing.length > 0 &&
        canonicalTailIsTerminal(index.ordered, params.runId)
      ) {
        throw new Error(
          `run ${params.runId} canonical admission recovery refused: terminal tail precedes ${missing.length} committed admission event(s)`,
        );
      }
      let lastSequence = index.lastSequence;
      const appended = missing.map((payload): CanonicalEventRecord => {
        lastSequence += 1;
        const event: Event = {
          eventId: payload.eventId,
          id: payload.eventId,
          seq: lastSequence,
          msg: { type: "execution_admission", payload },
        };
        return {
          event,
          eventId: payload.eventId,
          sequence: lastSequence,
          signature: stableStringify(event),
          sourcePath: target.sourcePath,
        };
      });
      if (appended.length > 0) {
        leases
          .get(target.sourcePath)!
          .appendAndSync(
            appended
              .map(({ event }) =>
                serializeRolloutItem({ type: "event_msg", payload: event }),
              )
              .join(""),
          );
      } else {
        // Existing identical evidence may have survived an ambiguous fsync.
        leases.get(target.sourcePath)!.sync();
      }

      const targetEvents = readCanonicalEvents(
        leases.get(target.sourcePath)!.readUtf8(),
        target.sourcePath,
      );
      const targetSequences = targetEvents.flatMap((record) =>
        record.sequence === undefined ? [] : [record.sequence],
      );
      params.driver.transactionImmediate(() => {
        for (const binding of bindings) {
          const lease = leases.get(binding.sourcePath)!;
          const raw = lease.readUtf8();
          const source = lease.stat();
          if (source.size !== Buffer.byteLength(raw)) {
            throw new Error(
              `canonical admission source ${binding.sourcePath} changed while preparing its projection`,
            );
          }
          backfillPinnedRolloutContent({
            rolloutPath: binding.sourcePath,
            raw,
            archived: binding.sourcePath.includes("/archived_sessions/"),
            threads: params.threads,
            mtimeMs: source.mtimeMs,
            validateCanonical: () => lease.sync(),
          });
        }
        if (targetSequences.length > 0) {
          params.durability.updateJournalBounds({
            sourcePath: target.sourcePath,
            firstAvailableSequence: Math.min(...targetSequences),
            lastSequence: Math.max(...targetSequences),
            updatedAt: new Date().toISOString(),
          });
        }
      });
      return { appended: appended.length };
    },
  );
}

function uniqueSourceBindings(
  bindings: readonly RunJournalBinding[],
): readonly RunJournalBinding[] {
  const byPath = new Map<string, RunJournalBinding>();
  for (const binding of bindings) {
    const existing = byPath.get(binding.sourcePath);
    if (existing !== undefined && existing.sessionId !== binding.sessionId) {
      throw new Error(
        `canonical admission source ${binding.sourcePath} has conflicting session bindings`,
      );
    }
    byPath.set(binding.sourcePath, binding);
  }
  return [...byPath.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
}

function withPinnedBindings<T>(
  projectDir: string,
  bindings: readonly RunJournalBinding[],
  leases: Map<string, PinnedOfflineRollout>,
  operation: (leases: ReadonlyMap<string, PinnedOfflineRollout>) => T,
  index = 0,
): T {
  const binding = bindings[index];
  if (binding === undefined) return operation(leases);
  return withPinnedOfflineRolloutLease(
    {
      projectDir,
      sessionId: binding.sessionId,
      sourcePath: binding.sourcePath,
    },
    (lease) => {
      leases.set(binding.sourcePath, lease);
      try {
        return withPinnedBindings(
          projectDir,
          bindings,
          leases,
          operation,
          index + 1,
        );
      } finally {
        leases.delete(binding.sourcePath);
      }
    },
  );
}

function retainedBindings(
  bindings: readonly RunJournalBinding[],
): readonly RunJournalBinding[] {
  return bindings.filter(
    (binding) =>
      !(
        !binding.active &&
        binding.gapReason !== undefined &&
        binding.retiredThroughSequence !== undefined &&
        binding.firstAvailableSequence === undefined
      ),
  );
}

function selectTargetBinding(
  bindings: readonly RunJournalBinding[],
): RunJournalBinding {
  const sorted = [...bindings].sort(
    (left, right) =>
      Number(right.active) - Number(left.active) ||
      right.epoch - left.epoch ||
      right.boundAt.localeCompare(left.boundAt) ||
      right.sourcePath.localeCompare(left.sourcePath),
  );
  return sorted[0]!;
}

function readAdmissionJournal(
  admissions: ExecutionAdmissionRepository,
  runId: string,
  maxEvents: number,
): readonly AdmissionJournalEvent[] {
  const result: AdmissionJournalEvent[] = [];
  let afterSequence = 0;
  while (true) {
    const page = admissions.listJournal({
      runId,
      afterSequence,
      limit: JOURNAL_PAGE_SIZE,
    });
    if (page.length === 0) return result;
    for (const event of page) {
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= afterSequence
      ) {
        throw new Error(
          `run ${runId} admission recovery made no monotonic progress after sequence ${afterSequence}`,
        );
      }
      if (result.length >= maxEvents) {
        throw new Error(
          `run ${runId} canonical admission recovery exceeds the bounded event limit (${maxEvents})`,
        );
      }
      result.push(event);
      afterSequence = event.sequence;
    }
    if (page.length < JOURNAL_PAGE_SIZE) return result;
  }
}

function readCanonicalEvents(
  raw: string,
  sourcePath: string,
): CanonicalEventRecord[] {
  const result: CanonicalEventRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const item = parseRolloutLine(line);
    if (item?.type !== "event_msg") continue;
    const event = item.payload;
    const sequence = canonicalSequence(event);
    const eventId = canonicalEventId(event, sequence);
    result.push({
      event,
      eventId,
      sequence,
      signature: stableStringify(event),
      sourcePath,
    });
  }
  return result;
}

function validateCanonicalEvents(
  records: readonly CanonicalEventRecord[],
  runId: string,
): {
  readonly byEventId: ReadonlyMap<string, readonly CanonicalEventRecord[]>;
  readonly byAdmissionEventId: ReadonlyMap<
    string,
    readonly CanonicalEventRecord[]
  >;
  readonly ordered: readonly CanonicalEventRecord[];
  readonly lastSequence: number;
} {
  const byEventId = new Map<string, CanonicalEventRecord[]>();
  const byAdmissionEventId = new Map<string, CanonicalEventRecord[]>();
  const bySequence = new Map<number, CanonicalEventRecord>();
  let lastSequence = 0;
  for (const record of records) {
    let effective = record;
    const identities = byEventId.get(record.eventId) ?? [];
    if (
      identities.some(
        (prior) =>
          prior.sequence !== record.sequence ||
          prior.signature !== record.signature,
      )
    ) {
      if (!record.eventId.startsWith("legacy-unsequenced:")) {
        throw new Error(
          `run ${runId} canonical admission recovery found conflicting event ID ${record.eventId}`,
        );
      }
      // Legacy rollouts predate durable event identities — their `id` field
      // was never unique (synthetic ids like "system" recur across distinct
      // events). Two DIFFERENT events sharing such an id is the legacy
      // format, not corruption, so disambiguate instead of aborting the
      // entire daemon startup. Identical copies (same id + same signature)
      // still dedupe through the normal path above.
      effective = {
        ...record,
        eventId: `${record.eventId}~conflict-${identities.length}`,
      };
    }
    const effectiveIdentities = byEventId.get(effective.eventId) ?? [];
    effectiveIdentities.push(effective);
    byEventId.set(effective.eventId, effectiveIdentities);
    if (effective.sequence !== undefined) {
      const prior = bySequence.get(effective.sequence);
      if (
        prior !== undefined &&
        (prior.eventId !== effective.eventId ||
          prior.signature !== effective.signature)
      ) {
        throw new Error(
          `run ${runId} canonical admission recovery found sequence ${effective.sequence} claimed by both ${prior.eventId} and ${effective.eventId}`,
        );
      }
      bySequence.set(effective.sequence, effective);
      lastSequence = Math.max(lastSequence, effective.sequence);
    }
    if (effective.event.msg.type === "execution_admission") {
      const admissionId = effective.event.msg.payload.eventId;
      const admissionMatches = byAdmissionEventId.get(admissionId) ?? [];
      admissionMatches.push(effective);
      byAdmissionEventId.set(admissionId, admissionMatches);
    }
  }
  return {
    byEventId,
    byAdmissionEventId,
    ordered: [...bySequence.values()].sort(
      (left, right) => left.sequence! - right.sequence!,
    ),
    lastSequence,
  };
}

function assertAdmissionMatch(
  canonical: Event,
  admission: AdmissionJournalEvent,
): void {
  if (
    canonical.eventId !== admission.eventId ||
    canonical.id !== admission.eventId ||
    canonical.msg.type !== "execution_admission" ||
    stableStringify(canonical.msg.payload) !== stableStringify(admission)
  ) {
    throw new Error(
      `execution admission event ${admission.eventId} has conflicting canonical evidence`,
    );
  }
}

function canonicalTailIsTerminal(
  ordered: readonly CanonicalEventRecord[],
  runId: string,
): boolean {
  let sealed = false;
  for (const record of ordered) {
    if (
      record.event.msg.type === "run_terminal" &&
      record.event.msg.payload.runId === runId
    ) {
      sealed = true;
    } else if (
      record.event.msg.type === "run_reopened" &&
      record.event.msg.payload.runId === runId
    ) {
      sealed = false;
    }
  }
  return sealed;
}

function canonicalSequence(event: Event): number | undefined {
  if (event.seq === undefined) return undefined;
  if (!Number.isSafeInteger(event.seq) || event.seq <= 0) {
    throw new Error(
      `canonical admission recovery found invalid sequence ${String(event.seq)}`,
    );
  }
  return event.seq;
}

function canonicalEventId(event: Event, sequence: number | undefined): string {
  if (event.eventId !== undefined) {
    if (typeof event.eventId !== "string" || event.eventId.length === 0) {
      throw new Error("canonical admission recovery found invalid eventId");
    }
    return event.eventId;
  }
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new Error(
      "canonical admission recovery found event without identity",
    );
  }
  return sequence === undefined
    ? `legacy-unsequenced:${event.id}`
    : `legacy-event:${sequence}:${event.id}`;
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
