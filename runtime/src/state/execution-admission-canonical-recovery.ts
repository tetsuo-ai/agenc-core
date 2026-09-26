import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";

import type { AdmissionJournalEvent } from "../budget/admission-types.js";
import {
  withPinnedOfflineRolloutLease,
  type PinnedOfflineRollout,
} from "../durability/offline-rollout.js";
import type { Event } from "../session/event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type RolloutItem,
} from "../session/rollout-item.js";
import { stableStringify } from "../utils/stableStringify.js";
import {
  backfillPinnedRolloutContent,
  canonicalProjectionCoversFile,
  reuseCanonicalRolloutProjection,
  type CanonicalRolloutSessionMeta,
  type CanonicalRolloutSource,
} from "./backfill.js";
import { normalizeCanonicalRolloutValue } from "./recovery-journal-contract.js";
import type { ExecutionAdmissionRepository } from "./execution-admission.js";
import {
  StateRunDurabilityRepository,
  type RunJournalBinding,
} from "./run-durability.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";
import { recoveryRunIsExecutableSql } from "./recovery-exclusions.js";

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

/** One bound source as read and parsed at the start of convergence. */
interface CanonicalSourceRead {
  readonly raw: string;
  readonly events: readonly CanonicalEventRecord[];
  readonly sessionMeta: CanonicalRolloutSessionMeta;
  /** sha256 of `raw`, computed once a marker matches every cheaper field. */
  sha256?: string;
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
    /**
     * Identity of the running build. When set, every projection leaves a
     * canonical projection marker under this epoch, and a source whose bytes
     * exactly match a marker from the same epoch keeps its projection instead
     * of being validated and projected again. Omitted, every source takes the
     * full path and any earlier marker is cleared.
     */
    readonly canonicalProjectionEpoch?: string;
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
  const epoch = options.canonicalProjectionEpoch;
  if (epoch !== undefined && (typeof epoch !== "string" || epoch.length === 0)) {
    throw new TypeError("canonicalProjectionEpoch must be a non-empty string");
  }
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
       AND ${recoveryRunIsExecutableSql("admission.run_id")}
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
       WHERE ${recoveryRunIsExecutableSql("admission.run_id")}
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
      driver.projectDir,
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
      epoch,
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
  readonly epoch: string | undefined;
}): { readonly appended: number } {
  const bindings = uniqueSourceBindings(params.bindings);
  const { epoch } = params;
  return withPinnedBindings(
    params.driver.projectDir,
    bindings,
    new Map(),
    (leases) => {
      const reads = new Map<string, CanonicalSourceRead>();
      for (const binding of bindings) {
        reads.set(
          binding.sourcePath,
          readCanonicalSource(
            leases.get(binding.sourcePath)!.readUtf8(),
            binding.sourcePath,
          ),
        );
      }
      const canonical = bindings.flatMap(
        (binding) => reads.get(binding.sourcePath)!.events,
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
      const targetRecords = canonical.filter(
        (record) => record.sourcePath === target.sourcePath,
      );
      const targetHasLegacyEvents = targetRecords.some(
        (record) => record.sequence === undefined,
      );
      const targetHasSequencedEvents = targetRecords.some(
        (record) => record.sequence !== undefined,
      );
      if (targetHasLegacyEvents && targetHasSequencedEvents) {
        throw new Error(
          `run ${params.runId} canonical admission recovery found mixed legacy and sequenced event lanes`,
        );
      }
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
        // A legacy source cannot acquire a sequenced suffix. Until E1a can
        // upgrade the whole source under its writer lease, recovery appends a
        // legacy envelope whose payload still carries the durable admission
        // identity. A new/empty or sequenced source uses canonical sequence.
        const event: Event = targetHasLegacyEvents
          ? {
              id: payload.eventId,
              msg: { type: "execution_admission", payload },
            }
          : {
              eventId: payload.eventId,
              id: payload.eventId,
              seq: (lastSequence += 1),
              msg: { type: "execution_admission", payload },
            };
        const sequence = canonicalSequence(event);
        return {
          event,
          eventId: canonicalEventId(event, sequence),
          sequence,
          signature: stableStringify(event),
          sourcePath: target.sourcePath,
        };
      });
      const targetLease = leases.get(target.sourcePath)!;
      const targetRead = reads.get(target.sourcePath)!;
      if (appended.length > 0) {
        targetLease.appendAndSync(
          appended
            .map(({ event }) =>
              serializeRolloutItem({ type: "event_msg", payload: event }),
            )
            .join(""),
        );
      }
      const targetRaw = targetLease.readUtf8();
      // With nothing appended the target still holds the bytes parsed above.
      const targetUnchanged =
        appended.length === 0 && targetRaw === targetRead.raw;
      if (
        appended.length === 0 &&
        !(
          targetUnchanged &&
          epoch !== undefined &&
          canonicalProjectionCoversFile({
            threads: params.threads,
            rolloutPath: target.sourcePath,
            epoch,
            source: describeSource(targetLease, targetRead),
          })
        )
      ) {
        // Existing identical evidence may have survived an ambiguous fsync.
        // Skipped only when a marker proves these exact bytes, in this exact
        // file, were fsynced before that marker committed.
        targetLease.sync();
      }

      const targetEvents = targetUnchanged
        ? targetRead.events
        : readCanonicalSource(targetRaw, target.sourcePath).events;
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
          const archived = binding.sourcePath.includes("/archived_sessions/");
          const read = reads.get(binding.sourcePath)!;
          if (
            epoch !== undefined &&
            raw === read.raw &&
            reuseCanonicalRolloutProjection({
              rolloutPath: binding.sourcePath,
              archived,
              threads: params.threads,
              epoch,
              source: describeSource(lease, read),
              sessionMeta: read.sessionMeta,
              syncSource: () => lease.sync(),
            })
          ) {
            continue;
          }
          backfillPinnedRolloutContent({
            rolloutPath: binding.sourcePath,
            raw,
            archived,
            threads: params.threads,
            mtimeMs: source.mtimeMs,
            validateCanonical: () => lease.sync(),
            ...(epoch !== undefined
              ? { canonicalMarker: { epoch, ...lease.identity() } }
              : {}),
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
  projectDir: string,
): readonly RunJournalBinding[] {
  return bindings.filter(
    (binding) =>
      isBindingInsideProject(binding, projectDir) &&
      !(
        !binding.active &&
        binding.gapReason !== undefined &&
        binding.retiredThroughSequence !== undefined &&
        binding.firstAvailableSequence === undefined
      ),
  );
}

/**
 * A binding may name a rollout in ANOTHER project: resuming one conversation
 * from a second cwd rebinds it there and leaves this project pointing at a
 * foreign path. Pinning it raises OfflineRolloutUnsafePathError, which is the
 * correct containment answer, but it aborts recovery for the whole workspace —
 * observed as every message failing with "unsafe offline canonical rollout …
 * path is outside this project's sessions/archived_sessions roots".
 *
 * The foreign rollout is not ours to read under any circumstance, so there is
 * nothing to recover from it and dropping the binding loses nothing this
 * project owns. The guard in `pinOfflineRollout` stays as the backstop.
 */
function isBindingInsideProject(
  binding: RunJournalBinding,
  projectDir: string,
): boolean {
  const root = resolve(projectDir);
  const source = resolve(binding.sourcePath);
  return (
    source.startsWith(join(root, "sessions") + sep) ||
    source.startsWith(join(root, "archived_sessions") + sep)
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

function readCanonicalSource(
  raw: string,
  sourcePath: string,
): CanonicalSourceRead {
  const events: CanonicalEventRecord[] = [];
  let first: SessionMetaItem | undefined;
  let latest: SessionMetaItem | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const item = parseRolloutLine(line);
    if (item?.type === "session_meta") {
      // A reused projection merges thread metadata from these records, so
      // derive them exactly as the strict validator records them.
      const normalized = normalizeCanonicalRolloutValue(JSON.parse(line));
      if (normalized?.type === "session_meta") {
        first ??= normalized;
        latest = normalized;
      }
      continue;
    }
    if (item?.type !== "event_msg") continue;
    const event = item.payload;
    const sequence = canonicalSequence(event);
    const eventId = canonicalEventId(event, sequence);
    events.push({
      event,
      eventId,
      sequence,
      signature: stableStringify(event),
      sourcePath,
    });
  }
  return { raw, events, sessionMeta: { first, latest } };
}

type SessionMetaItem = Extract<RolloutItem, { type: "session_meta" }>;

/** Current bytes and file of a leased source whose text equals `read.raw`. */
function describeSource(
  lease: PinnedOfflineRollout,
  read: CanonicalSourceRead,
): CanonicalRolloutSource {
  return {
    ...lease.stat(),
    ...lease.identity(),
    sha256: () =>
      (read.sha256 ??= createHash("sha256")
        .update(read.raw, "utf8")
        .digest("hex")),
  };
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
  const envelopeIdentityMatches =
    canonical.eventId === admission.eventId ||
    (canonical.eventId === undefined && canonical.seq === undefined);
  if (
    !envelopeIdentityMatches ||
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
