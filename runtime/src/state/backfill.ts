import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseRolloutLine, type RolloutItem } from "../session/rollout-item.js";
import { StateThreadRepository, type RolloutItemRow } from "./threads.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { validateCanonicalJournalText } from "./recovery-journal-contract.js";
import { MAX_RECOVERY_CANONICAL_LINE_BYTES } from "./recovery-contract.js";
import {
  withPinnedCanonicalJournalRun,
  type PinnedCanonicalJournalProof,
  type PinnedCanonicalJournalReplay,
  type RecoveryDescriptorBudget,
  type RecoveryFileLimitOverrides,
} from "./recovery-file.js";

export interface BackfillProjectRolloutsOptions {
  readonly projectDir: string;
  readonly driver: StateSqliteDriver;
}

export interface BackfillResult {
  readonly filesScanned: number;
  readonly filesIndexed: number;
  readonly itemsIndexed: number;
}

interface RolloutFileEntry {
  readonly rolloutPath: string;
  readonly archived: boolean;
}

export function backfillProjectRollouts(
  options: BackfillProjectRolloutsOptions,
): BackfillResult {
  const threads = new StateThreadRepository(options.driver);
  let filesScanned = 0;
  let filesIndexed = 0;
  let itemsIndexed = 0;
  for (const entry of listRolloutFiles(options.projectDir)) {
    filesScanned += 1;
    const result = backfillRolloutFile({
      rolloutPath: entry.rolloutPath,
      archived: entry.archived,
      threads,
    });
    filesIndexed += 1;
    itemsIndexed += result.itemsIndexed;
  }
  return { filesScanned, filesIndexed, itemsIndexed };
}

export function backfillRolloutFile(options: {
  readonly rolloutPath: string;
  readonly archived?: boolean;
  readonly threads: StateThreadRepository;
}): { readonly itemsIndexed: number } {
  const snapshotFd = openSync(options.rolloutPath, "r");
  try {
    const stat = fstatSync(snapshotFd);
    assertRolloutRecordBoundary(snapshotFd, options.rolloutPath, stat.size);
    const existing = options.threads.getBackfillFile(options.rolloutPath);

    // Fast path 1 — file unchanged since last index. The rollout file is an
    // append-only log; identical size and mtime means nothing was appended, so
    // there is no work to do. Avoids re-reading and re-hashing the whole file
    // on every `appendItems` call.
    if (
      existing !== undefined &&
      existing.size === stat.size &&
      existing.mtimeMs === stat.mtimeMs
    ) {
      assertSnapshotStillCanonical(options.rolloutPath, stat);
      return { itemsIndexed: 0 };
    }

    // Fast path 2 — file grew (pure append). Read and parse only the appended
    // tail and INSERT only the new lines, leaving prior rows untouched. This
    // keeps each append O(bytes appended) instead of O(file size), avoiding the
    // O(N^2) re-index that an unconditional DELETE-all + re-INSERT-all causes.
    if (existing !== undefined && stat.size > existing.size) {
      const appended = readAppendedTail(
        snapshotFd,
        options.rolloutPath,
        existing.size,
        stat.size,
      );
      if (appended !== undefined) {
        return indexAppendedTail({
          rolloutPath: options.rolloutPath,
          archived: options.archived,
          threads: options.threads,
          stat,
          priorSize: existing.size,
          existing,
          tail: appended,
        });
      }
      // The tail read was unusable (e.g. a partial line straddling the prior
      // size boundary); fall through to a full reconcile below.
    }

    // Full reconcile path — first index, truncation, rewrite, or any case the
    // incremental fast paths could not safely handle. Preserves crash/resume
    // correctness by rebuilding the file's rows from scratch.
    return reindexWholeRolloutFile({
      snapshotFd,
      rolloutPath: options.rolloutPath,
      archived: options.archived,
      threads: options.threads,
      stat,
    });
  } finally {
    closeSync(snapshotFd);
  }
}

/**
 * Project bytes already read through a descriptor-pinned offline rollout
 * lease. Unlike {@link backfillRolloutFile}, this entry point never reopens
 * the canonical source by pathname. The caller-supplied validation runs at
 * the final boundary of the same SQLite transaction as the projection.
 */
export function backfillPinnedRolloutContent(options: {
  readonly rolloutPath: string;
  readonly raw: string;
  readonly archived?: boolean;
  readonly threads: StateThreadRepository;
  readonly mtimeMs: number;
  readonly validateCanonical: () => void;
}): { readonly itemsIndexed: number } {
  const { rolloutPath, raw, threads } = options;
  const journal = validateCanonicalJournalText(raw, {
    terminalPolicy: "allow_missing",
  });
  const threadId = threadIdFromRolloutPath(rolloutPath);
  const items: RolloutItemRow[] = [];
  let itemIndex = 0;
  let firstMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  let latestMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  for (const record of journal.records) {
    const parsed = record.item;
    if (parsed.type === "session_meta") {
      firstMeta ??= parsed;
      latestMeta = parsed;
    }
    items.push(
      rolloutItemRow(parsed, record.lineNumber, record.byteOffset, itemIndex, {
        lineSha256: record.lineSha256,
      }),
    );
    itemIndex += 1;
  }
  const now = new Date(options.mtimeMs).toISOString();
  threads.commitRolloutProjection(() => {
    mergeThreadFromMeta({
      threads,
      threadId,
      rolloutPath,
      archived: options.archived,
      now,
      createdAt: firstMeta?.payload.timestamp,
      metaForUpdate: latestMeta?.payload,
      metaForCreate: firstMeta?.payload,
    });
    threads.replaceRolloutItems({
      threadId,
      sourcePath: rolloutPath,
      items,
      mtimeMs: options.mtimeMs,
      size: journal.sourceByteLength,
      sha256: journal.sourceSha256,
      lineCount: journal.physicalLineCount + 1,
    });
  }, options.validateCanonical);
  return { itemsIndexed: items.length };
}

export interface BackfillPinnedRolloutFileResult {
  readonly itemsIndexed: number;
  readonly proof: PinnedCanonicalJournalProof;
}

export interface BackfillPinnedRolloutSource {
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly archived?: boolean;
  readonly expectedRunId?: string;
  readonly expectedEpoch?: number;
  readonly terminalPolicy?: "allow_missing" | "require_terminal";
  readonly afterValidationPass?: (proof: PinnedCanonicalJournalProof) => void;
}

export interface PreparedPinnedRolloutRun {
  /** Exact canonical ordering shared by proofs and projectAll results. */
  readonly sources: readonly BackfillPinnedRolloutSource[];
  readonly proofs: readonly PinnedCanonicalJournalProof[];
  projectAll(): readonly BackfillPinnedRolloutFileResult[];
  assertPinned(): void;
}

/**
 * Validate a bounded run before mutation, then retain every lease while the
 * caller executes exactly one outer SQLite transaction.
 */
export function withPreparedPinnedRolloutRun<T>(options: {
  readonly projectDir: string;
  readonly sources: readonly BackfillPinnedRolloutSource[];
  readonly threads: StateThreadRepository;
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
  readonly onSourceFailure?: (
    source: BackfillPinnedRolloutSource,
    error: unknown,
  ) => void;
}, operation: (prepared: PreparedPinnedRolloutRun) => T): T {
  const sources = [...options.sources].sort((left, right) =>
    compareRolloutPaths(left.rolloutPath, right.rolloutPath),
  );
  const metadata = sources.map(() => ({
    first: undefined as
      | Extract<RolloutItem, { type: "session_meta" }>
      | undefined,
    latest: undefined as
      | Extract<RolloutItem, { type: "session_meta" }>
      | undefined,
  }));
  const byPath = new Map(
    sources.map((source) => [source.rolloutPath, source] as const),
  );
  return withPinnedCanonicalJournalRun(
    {
      sources: sources.map((source, index) => ({
        projectDir: options.projectDir,
        sessionId: source.sessionId,
        sourcePath: source.rolloutPath,
        terminalPolicy: source.terminalPolicy ?? "allow_missing",
        ...(source.expectedRunId !== undefined
          ? { expectedRunId: source.expectedRunId }
          : {}),
        ...(source.expectedEpoch !== undefined
          ? { expectedEpoch: source.expectedEpoch }
          : {}),
        ...(source.afterValidationPass !== undefined
          ? { afterValidationPass: source.afterValidationPass }
          : {}),
        observeValidatedRecord: (record) => {
          if (record.item.type !== "session_meta") return;
          const state = metadata[index]!;
          state.first ??= record.item;
          state.latest = record.item;
        },
      })),
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.descriptorBudget !== undefined
        ? { descriptorBudget: options.descriptorBudget }
        : {}),
      ...(options.nowMilliseconds !== undefined
        ? { nowMilliseconds: options.nowMilliseconds }
        : {}),
      ...(options.onSourceFailure !== undefined
        ? {
            onSourceFailure: (source, error) => {
              const input = byPath.get(source.sourcePath);
              if (input !== undefined) options.onSourceFailure!(input, error);
            },
          }
        : {}),
    },
    (journals) => {
      let projected = false;
      const prepared: PreparedPinnedRolloutRun = Object.freeze({
        sources: Object.freeze(sources.slice()),
        proofs: Object.freeze(journals.map(({ proof }) => proof)),
        projectAll: () => {
          if (projected) {
            throw new Error("canonical recovery run may project only once");
          }
          projected = true;
          return Object.freeze(
            journals.map((journal, index) =>
              projectPinnedJournal(
                options.threads,
                sources[index]!,
                journal,
                metadata[index]!,
              ),
            ),
          );
        },
        assertPinned: () => {
          for (const journal of journals) journal.assertPinned();
        },
      });
      return operation(prepared);
    },
  );
}

function compareRolloutPaths(
  leftPath: string,
  rightPath: string,
): number {
  const left = process.platform === "win32" ? leftPath.toLowerCase() : leftPath;
  const right =
    process.platform === "win32" ? rightPath.toLowerCase() : rightPath;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Strictly validate and project one retained rollout without reopening it or
 * retaining its records. Pass one proves the complete source; pass two emits
 * one row at a time inside the projection transaction.
 */
export function backfillPinnedRolloutFile(options: {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly archived?: boolean;
  readonly threads: StateThreadRepository;
  readonly expectedRunId?: string;
  readonly expectedEpoch?: number;
  readonly terminalPolicy?: "allow_missing" | "require_terminal";
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
  readonly afterValidationPass?: (proof: PinnedCanonicalJournalProof) => void;
}): BackfillPinnedRolloutFileResult {
  return withPreparedPinnedRolloutRun(
    {
      projectDir: options.projectDir,
      sources: [{
        sessionId: options.sessionId,
        rolloutPath: options.rolloutPath,
        archived: options.archived,
        terminalPolicy: options.terminalPolicy ?? "allow_missing",
        ...(options.expectedRunId !== undefined
          ? { expectedRunId: options.expectedRunId }
          : {}),
        ...(options.expectedEpoch !== undefined
          ? { expectedEpoch: options.expectedEpoch }
          : {}),
        ...(options.afterValidationPass !== undefined
          ? { afterValidationPass: options.afterValidationPass }
          : {}),
      }],
      threads: options.threads,
      ...(options.limits !== undefined ? { limits: options.limits } : {}),
      ...(options.descriptorBudget !== undefined
        ? { descriptorBudget: options.descriptorBudget }
        : {}),
      ...(options.nowMilliseconds !== undefined
        ? { nowMilliseconds: options.nowMilliseconds }
        : {}),
    },
    (prepared) => {
      return options.threads.commitRolloutProjection(
        () => prepared.projectAll()[0]!,
        prepared.assertPinned,
      );
    },
  );
}

function projectPinnedJournal(
  threads: StateThreadRepository,
  source: BackfillPinnedRolloutSource,
  journal: PinnedCanonicalJournalReplay,
  metadata: {
    readonly first?: Extract<RolloutItem, { type: "session_meta" }>;
    readonly latest?: Extract<RolloutItem, { type: "session_meta" }>;
  },
): BackfillPinnedRolloutFileResult {
  const threadId = threadIdFromRolloutPath(source.rolloutPath);
  const now = new Date(journal.proof.snapshot.mtimeMs).toISOString();
  let replayProof: PinnedCanonicalJournalProof | undefined;
  mergeThreadFromMeta({
    threads,
    threadId,
    rolloutPath: source.rolloutPath,
    archived: source.archived,
    now,
    createdAt: metadata.first?.payload.timestamp,
    metaForUpdate: metadata.latest?.payload,
    metaForCreate: metadata.first?.payload,
  });
  let itemIndex = 0;
  threads.replaceRolloutItemsFromProducer({
    threadId,
    sourcePath: source.rolloutPath,
    expectedItemCount: journal.proof.recordCount,
    mtimeMs: journal.proof.snapshot.mtimeMs,
    size: journal.proof.sourceByteLength,
    sha256: journal.proof.sourceSha256,
    lineCount: journal.proof.physicalLineCount + 1,
    produce: (insert) => {
      replayProof = journal.replay((record) => {
        insert(
          rolloutItemRow(
            record.item,
            record.lineNumber,
            record.byteOffset,
            itemIndex,
            { lineSha256: record.lineSha256 },
          ),
        );
        itemIndex += 1;
      });
    },
  });
  if (replayProof === undefined) {
    throw new Error("canonical journal projection completed without replay proof");
  }
  return Object.freeze({
    itemsIndexed: journal.proof.recordCount,
    proof: replayProof,
  });
}

function reindexWholeRolloutFile(args: {
  readonly snapshotFd: number;
  readonly rolloutPath: string;
  readonly archived?: boolean;
  readonly threads: StateThreadRepository;
  readonly stat: Stats;
}): { readonly itemsIndexed: number } {
  const { rolloutPath, threads, stat } = args;
  const raw = readRolloutSnapshot(args.snapshotFd, rolloutPath, 0, stat.size);
  assertTerminatedJsonl(raw, rolloutPath);
  assertTolerantLineByteCeiling(raw, rolloutPath);
  const threadId = threadIdFromRolloutPath(rolloutPath);
  const items: RolloutItemRow[] = [];
  let byteOffset = 0;
  let itemIndex = 0;
  let firstMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  let latestMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (line.trim().length === 0) {
      byteOffset += lineBytes;
      continue;
    }
    let parsed: RolloutItem | null;
    try {
      parsed = parseRolloutLine(line);
    } catch {
      // Skip a corrupt interior line rather than aborting the whole
      // backfill — one bad row must not strand every later row.
      byteOffset += lineBytes;
      continue;
    }
    if (parsed !== null) {
      if (parsed.type === "session_meta") {
        firstMeta ??= parsed;
        latestMeta = parsed;
      }
      items.push(
        rolloutItemRow(parsed, i + 1, byteOffset, itemIndex, { rawLine: line }),
      );
      itemIndex += 1;
    }
    byteOffset += lineBytes;
  }
  const now = new Date(stat.mtimeMs).toISOString();
  threads.commitRolloutProjection(
    () => {
      mergeThreadFromMeta({
        threads,
        threadId,
        rolloutPath,
        archived: args.archived,
        now,
        createdAt: firstMeta?.payload.timestamp,
        metaForUpdate: latestMeta?.payload,
        metaForCreate: firstMeta?.payload,
      });
      threads.replaceRolloutItems({
        threadId,
        sourcePath: rolloutPath,
        items,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256: createHash("sha256").update(raw).digest("hex"),
        lineCount: lines.length,
      });
    },
    () => assertSnapshotStillCanonical(rolloutPath, stat),
  );
  return { itemsIndexed: items.length };
}

function indexAppendedTail(args: {
  readonly rolloutPath: string;
  readonly archived?: boolean;
  readonly threads: StateThreadRepository;
  readonly stat: Stats;
  readonly priorSize: number;
  readonly existing: {
    readonly lineCount: number;
    readonly itemCount: number;
    readonly sha256: string;
  };
  readonly tail: string;
}): { readonly itemsIndexed: number } {
  const { rolloutPath, threads, stat, existing, tail } = args;
  assertTerminatedJsonl(tail, rolloutPath);
  assertTolerantLineByteCeiling(tail, rolloutPath);
  const threadId = threadIdFromRolloutPath(rolloutPath);
  const items: RolloutItemRow[] = [];
  // Prior content occupied line numbers 1..(lineCount-1) plus a trailing empty
  // split element, so existing.lineCount already counts that empty tail line.
  // New lines therefore start at line number `existing.lineCount`, and the
  // first new line's byte offset is the previous file size.
  let byteOffset = args.priorSize;
  let lineNumber = existing.lineCount;
  let itemIndex = existing.itemCount;
  let firstMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  let latestMeta: Extract<RolloutItem, { type: "session_meta" }> | undefined;
  const lines = tail.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (line.trim().length === 0) {
      byteOffset += lineBytes;
      lineNumber += 1;
      continue;
    }
    let parsed: RolloutItem | null;
    try {
      parsed = parseRolloutLine(line);
    } catch {
      // Skip a corrupt interior line rather than aborting the whole
      // tail backfill — one bad row must not strand every later row.
      byteOffset += lineBytes;
      lineNumber += 1;
      continue;
    }
    if (parsed !== null) {
      if (parsed.type === "session_meta") {
        firstMeta ??= parsed;
        latestMeta = parsed;
      }
      items.push(
        rolloutItemRow(parsed, lineNumber, byteOffset, itemIndex, {
          rawLine: line,
        }),
      );
      itemIndex += 1;
    }
    byteOffset += lineBytes;
    lineNumber += 1;
  }
  const now = new Date(stat.mtimeMs).toISOString();
  assertSnapshotStillCanonical(rolloutPath, stat);
  // mergeThread overwrites createdAt/updatedAt unconditionally with whatever we
  // pass, so carry the already-recorded values forward. The first session_meta
  // (the source of createdAt) lives in the unchanged prefix we did not re-read,
  // and the appended tail almost never contains a session_meta to advance
  // updatedAt — falling back to `now` (file mtime) would make updatedAt jump on
  // an append and then jump back on the next full reconcile. Carry the prior
  // updatedAt forward so it only advances when a newer meta timestamp appears,
  // matching the full-reconcile semantics.
  threads.commitRolloutProjection(
    () => {
      const prior = threads.getThread(threadId);
      mergeThreadFromMeta({
        threads,
        threadId,
        rolloutPath,
        archived: args.archived,
        now,
        createdAt: firstMeta?.payload.timestamp ?? prior?.createdAt,
        updatedAt: prior?.updatedAt,
        metaForUpdate: latestMeta?.payload,
        metaForCreate: firstMeta?.payload,
      });
      threads.appendRolloutItems({
        threadId,
        sourcePath: rolloutPath,
        items,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        // Carry the prior full-file digest forward rather than re-hashing the whole
        // file on every append (which would reintroduce the O(N^2) behaviour). The
        // canonical full-file hash is re-established whenever a full reconcile runs.
        // Change detection here relies on mtime+size, not this digest.
        sha256: existing.sha256,
        lineCount: existing.lineCount + (lines.length - 1),
        totalItemCount: itemIndex,
      });
    },
    () => assertSnapshotStillCanonical(rolloutPath, stat),
  );
  return { itemsIndexed: items.length };
}

/**
 * A newline is the rollout commit boundary. Backfill runs without the session
 * writer lease, so it must never bless a crash-complete-but-unterminated JSON
 * object as canonical evidence. SessionStore owns repair/truncation under the
 * lease; callers retry projection after that recovery succeeds.
 */
function assertRolloutRecordBoundary(
  snapshotFd: number,
  rolloutPath: string,
  size: number,
): void {
  if (size === 0) return;
  const boundary = Buffer.allocUnsafe(1);
  if (
    readSync(snapshotFd, boundary, 0, 1, size - 1) !== 1 ||
    boundary[0] !== 0x0a
  ) {
    throw unterminatedRollout(rolloutPath);
  }
}

function assertTerminatedJsonl(content: string, rolloutPath: string): void {
  if (content.length > 0 && !content.endsWith("\n")) {
    throw unterminatedRollout(rolloutPath);
  }
}

function unterminatedRollout(rolloutPath: string): Error {
  return new Error(
    `refusing to index unterminated canonical rollout without its session lease: ${rolloutPath}`,
  );
}

/** Compatibility code expected by the frozen E1a probe; durable incidents use
 * the schema-backed `line_byte_limit` integrity reason. */
class TolerantRolloutLineLimitError extends Error {
  readonly reasonCode = "line_limit";

  constructor(rolloutPath: string, lineNumber: number) {
    super(
      `canonical rollout line ${lineNumber} exceeds ${MAX_RECOVERY_CANONICAL_LINE_BYTES} bytes: ${rolloutPath}`,
    );
    this.name = "TolerantRolloutLineLimitError";
  }
}

function assertTolerantLineByteCeiling(
  content: string,
  rolloutPath: string,
): void {
  const bytes = Buffer.from(content, "utf8");
  let lineStart = 0;
  let lineNumber = 1;
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    if (bytes[offset] !== 0x0a) continue;
    const carriageReturn = offset > lineStart && bytes[offset - 1] === 0x0d;
    const lineBytes = offset - lineStart - (carriageReturn ? 1 : 0);
    if (lineBytes > MAX_RECOVERY_CANONICAL_LINE_BYTES) {
      throw new TolerantRolloutLineLimitError(rolloutPath, lineNumber);
    }
    lineStart = offset + 1;
    lineNumber += 1;
  }
}

function rolloutItemRow(
  parsed: RolloutItem,
  lineNumber: number,
  byteOffset: number,
  itemIndex: number,
  source: { readonly rawLine: string } | { readonly lineSha256: string },
): RolloutItemRow {
  return {
    lineNumber,
    byteOffset,
    itemIndex,
    itemType: parsed.type,
    eventVersion: parsed.eventVersion,
    eventId:
      parsed.type === "event_msg"
        ? canonicalProjectedEventId(parsed.payload)
        : undefined,
    eventSeq: parsed.type === "event_msg" ? parsed.payload.seq : undefined,
    payloadJson: JSON.stringify(parsed.payload),
    lineHash:
      "lineSha256" in source
        ? source.lineSha256
        : createHash("sha256").update(source.rawLine).digest("hex"),
  };
}

function canonicalProjectedEventId(
  event: Extract<RolloutItem, { readonly type: "event_msg" }>["payload"],
): string {
  if (typeof event.eventId === "string" && event.eventId.length > 0) {
    return event.eventId;
  }
  if (
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
  ) {
    return `legacy-event:${event.seq}:${event.id}`;
  }
  return event.id;
}

function mergeThreadFromMeta(args: {
  readonly threads: StateThreadRepository;
  readonly threadId: string;
  readonly rolloutPath: string;
  readonly archived?: boolean;
  readonly now: string;
  readonly createdAt: string | undefined;
  // Optional override for the stored updatedAt. The incremental-append path
  // passes the carried-forward value so updatedAt does not regress when the
  // appended tail has no session_meta; the full-reconcile path omits it and
  // falls back to the latest meta timestamp (or `now`).
  readonly updatedAt?: string | undefined;
  readonly metaForUpdate:
    Extract<RolloutItem, { type: "session_meta" }>["payload"] | undefined;
  readonly metaForCreate:
    Extract<RolloutItem, { type: "session_meta" }>["payload"] | undefined;
}): void {
  const { metaForUpdate, metaForCreate } = args;
  const archivedAt = args.archived === true ? args.now : undefined;
  args.threads.mergeThread(
    {
      threadId: args.threadId,
      createdAt: args.createdAt ?? args.now,
      updatedAt: metaForUpdate?.timestamp ?? args.updatedAt ?? args.now,
      cwd: metaForUpdate?.cwd ?? metaForCreate?.cwd,
      source: metaForUpdate?.source ?? metaForCreate?.source,
      model: metaForUpdate?.model ?? metaForCreate?.model,
      modelProvider:
        metaForUpdate?.modelProvider ?? metaForCreate?.modelProvider,
      memoryMode: normalizeMemoryMode(metaForUpdate?.memoryMode),
      ...(archivedAt !== undefined
        ? { archivedAt, archivedRolloutPath: args.rolloutPath }
        : { rolloutPath: args.rolloutPath }),
    },
    { replaceArchiveState: true },
  );
}

/**
 * Reads only the bytes appended to a rollout file beyond `priorSize`, decoded
 * as UTF-8. Returns `undefined` when the file is shorter than `priorSize` (a
 * truncation/rewrite that must go through a full reconcile).
 */
function readAppendedTail(
  snapshotFd: number,
  rolloutPath: string,
  priorSize: number,
  snapshotSize: number,
): string | undefined {
  if (snapshotSize < priorSize) return undefined;
  const length = snapshotSize - priorSize;
  if (length === 0) return "";
  // The incremental append path numbers new lines starting at the prior line
  // count, which is only valid when the previously indexed content ended on a
  // line boundary. Verify the byte just before the new region is a newline;
  // otherwise the tail straddles a prior line and must go through a full
  // reconcile to renumber correctly.
  if (priorSize > 0) {
    const boundary = Buffer.allocUnsafe(1);
    if (readSync(snapshotFd, boundary, 0, 1, priorSize - 1) !== 1) {
      return undefined;
    }
    if (boundary[0] !== 0x0a) return undefined;
  }
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(
      snapshotFd,
      buffer,
      read,
      length - read,
      priorSize + read,
    );
    if (n === 0) break;
    read += n;
  }
  if (read !== length) throw changedDuringSnapshot(rolloutPath);
  return buffer.toString("utf8");
}

function readRolloutSnapshot(
  snapshotFd: number,
  rolloutPath: string,
  start: number,
  end: number,
): string {
  const length = end - start;
  if (length < 0) throw changedDuringSnapshot(rolloutPath);
  if (length === 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(
      snapshotFd,
      buffer,
      read,
      length - read,
      start + read,
    );
    if (count === 0) break;
    read += count;
  }
  if (read !== length) throw changedDuringSnapshot(rolloutPath);
  return buffer.toString("utf8");
}

function changedDuringSnapshot(rolloutPath: string): Error {
  return new Error(
    `canonical rollout changed while capturing a bounded projection snapshot: ${rolloutPath}`,
  );
}

function assertSnapshotStillCanonical(
  rolloutPath: string,
  snapshot: Stats,
): void {
  let current: Stats;
  try {
    current = statSync(rolloutPath);
  } catch (error) {
    throw new Error(changedDuringSnapshot(rolloutPath).message, {
      cause: error,
    });
  }
  if (
    current.dev !== snapshot.dev ||
    current.ino !== snapshot.ino ||
    current.size < snapshot.size ||
    (current.size === snapshot.size && current.mtimeMs !== snapshot.mtimeMs)
  ) {
    throw changedDuringSnapshot(rolloutPath);
  }
}

function listRolloutFiles(projectDir: string): RolloutFileEntry[] {
  const roots = [
    { root: join(projectDir, "sessions"), archived: false },
    { root: join(projectDir, "archived_sessions"), archived: true },
  ];
  const result: RolloutFileEntry[] = [];
  for (const { root, archived } of roots) {
    if (!existsSync(root)) continue;
    collectRolloutFiles(root, archived, result);
  }
  return result.sort((a, b) => a.rolloutPath.localeCompare(b.rolloutPath));
}

function collectRolloutFiles(
  dir: string,
  archived: boolean,
  result: RolloutFileEntry[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectRolloutFiles(full, archived, result);
    } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
      result.push({ rolloutPath: full, archived });
    }
  }
}

function threadIdFromRolloutPath(path: string): string {
  const name = basename(path);
  const body = name.slice("rollout-".length, -".jsonl".length);
  const match = body.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/,
  );
  return match?.[2] ?? basename(join(path, ".."));
}

function normalizeMemoryMode(
  value: unknown,
): "enabled" | "disabled" | undefined {
  return value === "enabled" || value === "disabled" ? value : undefined;
}
