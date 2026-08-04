/**
 * Rollout-store — the publicly-consumed handle on the session rollout.
 *
 * SessionStore owns the on-disk state (flock, file handle, index);
 * RolloutStore is the event-log-facing facade that phases, sidecars,
 * and session.ts call into. Keeping them separate lets us swap
 * backends (file → S3-for-remote-agents) without touching callers.
 *
 * Also owns the 100ms batch flush scheduler. I-25 (snapshot is
 * best-effort, rollout is source of truth) is honored by treating
 * every snapshot write as advisory: if it fails, the rollout itself
 * still contains the truth.
 *
 * @module
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import {
  AtomicArtifactOperationUnsupportedError,
  type AtomicArtifactObservation,
  withAtomicArtifactObservationSync,
} from "../durability/atomic-artifact.js";
import { withPinnedOfflineRolloutLease } from "../durability/offline-rollout.js";
import {
  AgentIdExistsError,
  InvalidAgentMetadataError,
  normalizeAgentMetadata,
  type AgentMetadata,
  type AgentPath,
  type ThreadId,
} from "../agents/registry.js";
import type { Event, EventMsg } from "./event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type ResponseItem,
  type RolloutItem,
} from "./rollout-item.js";
import {
  getProjectDir,
  SessionStore,
  SessionStoreFlushScheduler,
  type AppendOptions,
  type CompactionIndexSnapshot,
  type SessionStoreOpts,
} from "./session-store.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import {
  checkUnknownOutcomeMutationGate,
  UnknownOutcomeMutationBlockedError,
} from "../state/unknown-outcome-gate.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { ThreadSpawnEdgeRepository } from "../state/spawn-edges.js";
import { StateRunDurabilityRepository } from "../state/run-durability.js";
import { recordInFlightToolCallUnknownOutcome } from "../state/tool-output-rotation.js";
import { resolveUnknownOutcomeEffect } from "../state/unknown-outcome-gate.js";
import { getAgenCConfigHomeDir } from "../utils/envUtils.js";
import { sanitizePath } from "../utils/path.js";
import { isRecord } from "../utils/record.js";
import {
  EFFECT_EVIDENCE_FORMAT_VERSION,
  EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
  type EffectNoEffectProof,
} from "../contracts/run-contracts.js";
import {
  planLegacyDurableCheckpointUpgrade,
  type DurableCheckpointUpgradeDeferral,
  type DurableCheckpointUpgradeFailure,
} from "./durable-checkpoint-upgrade.js";
import { StateToolPairProjection } from "../state/tool-pair-projection.js";
import { DURABLE_ROLLOUT_SCHEMA_V2 } from "./durable-checkpoint-reader.js";
import {
  StreamingToolPairValidator,
  validateToolPairSequence,
  type ToolPairMessage,
  type ToolPairIntegrityFailure,
  type ToolPairOperationalDeferral,
  type ToolPairProjection,
  type ToolPairValidationOutcome,
} from "./tool-pair-validator.js";
import { formatIdentityForLog } from "./tool-result-integrity.js";
import {
  CompactionPinQuotaError,
  CompactionRetentionRepository,
  type CompactionPinRecord,
  type CompactionReferenceKind,
} from "../state/compaction-retention.js";
import {
  COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
  COMPACTION_EVENT_FORMAT_VERSION,
  COMPACTION_MINIMUM_READER_RUNTIME,
  COMPACTION_RECONCILIATION_PAGE_SIZE,
  COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN,
  COMPACTION_PRUNE_RECORDS_PER_PAGE,
  COMPACTION_ROLLBACK_RETENTION_MS,
  COMPACTION_SOURCE_DIGEST_DOMAIN,
  MAX_COMPACTION_RECONCILIATION_MS_PER_START,
  MAX_COMPACTION_RECONCILIATION_PAGES_PER_START,
  MAX_COMPACTION_SOURCE_BYTES,
  MAX_COMPACTION_SOURCE_MESSAGES,
  type CompactionCleanupPendingV1,
  type CompactionCommitInputV1,
  type CompactionCommittedV1,
  type CompactionFailedV1,
  type CompactionIntentV1,
  type CompactionPreparedSourceV1,
  type CompactionPayloadBundleV1,
  type CompactionPersistedCommittedV1,
  type CompactionPersistedIntentV1,
  type CompactionPersistedRollbackCommittedV1,
  type CompactionPersistedSourceAuthorityV1,
  type CompactionProjectionMessageV1,
  type CompactionRollbackCommittedV1,
  type CompactionRetentionExtendedV1,
  type CompactionSourceReleaseV1,
  type CompactionSourceAuthorityV1,
  type CompactionSourcePayloadBundlesV1,
  CompactionReconstructionRequiredError,
  CompactionTransactionError,
} from "../services/compact/transaction-types.js";
import {
  canonicalizeJson,
  digestWithDomain,
  sha256Hex,
  verifyCompactionSummaryDigest,
} from "../services/compact/summary-v1.js";
import { canonicalCompactionSourceMessages } from "../services/compact/plan.js";
import type { RuntimeMessage } from "../services/compact/types.js";
import { HARD_MAX_RECOVERY_LINE_BYTES } from "../state/recovery-contract.js";
import { responseItemToLlmMessage } from "./message-history-conversion.js";
import { ROLLOUT_SCHEMA_VERSION } from "./event-log.js";
import {
  readCompactionPersistedCommittedV1,
  readCompactionPersistedIntentV1,
  readCompactionPersistedRollbackCommittedV1,
  readCompactionRolloutPayload,
} from "./compaction-event-reader.js";
import {
  compactActiveHistoryEntries,
  reconstructCompactionPayloadV1,
} from "../services/compact/payload-manifest.js";
import {
  scanCanonicalRollout,
  type CanonicalCompactionAttemptScan,
  type CanonicalRolloutScan,
} from "./canonical-rollout-scanner.js";

export interface RolloutStoreOpts extends SessionStoreOpts {
  /** Flush interval in ms. Default 100. */
  readonly flushIntervalMs?: number;
  /** Whether to auto-start the background flush scheduler. Default true. */
  readonly autoStartScheduler?: boolean;
  /** Test-only crash seam immediately before the atomic v2 inode swap. */
  readonly beforeCheckpointUpgradePublishForTestingOnly?: () => void;
  /** Test-only crash seam after the compaction commit fsync, before projection. */
  readonly afterCompactionCommitAppendForTestingOnly?: () => void;
  /** Test-only crash seam after atomic source pruning, before SQLite finalize. */
  readonly afterCompactionSourcePruneRewriteForTestingOnly?: () => void;
  /** Test-only crash seam after source rollback fsync, before target projection. */
  readonly afterCompactionRollbackAppendForTestingOnly?: () => void;
  /** Injectable store-owned wall clock. Production always uses Date.now. */
  readonly nowMilliseconds?: () => number;
}

export interface CompactionTransactionLease {
  release(): void;
}

interface ReviewedRollbackTargetReservation {
  readonly target: SessionStore;
  opened: boolean;
}

type PersistedCompactionRolloutItem =
  | { readonly type: "compaction_intent"; readonly payload: CompactionPersistedIntentV1 }
  | { readonly type: "compaction_committed"; readonly payload: CompactionPersistedCommittedV1 }
  | {
      readonly type: "compaction_rollback_committed";
      readonly payload: CompactionPersistedRollbackCommittedV1;
    };

export class DurableCheckpointUpgradeBlockedError extends Error {
  constructor(
    readonly runId: string,
    readonly outcome:
      | DurableCheckpointUpgradeFailure
      | DurableCheckpointUpgradeDeferral
      | ToolPairIntegrityFailure
      | ToolPairOperationalDeferral,
  ) {
    super(
      `durable checkpoint upgrade blocked for run ${formatIdentityForLog(runId)}: ${outcome.reason}. Resume remains disabled; preserve the rollout, then restore intact source bytes from backup or start a new session`,
    );
    this.name = "DurableCheckpointUpgradeBlockedError";
  }
}

export interface DurableCheckpointProjectionContext {
  readonly projection: ToolPairProjection;
  readonly projectionId: string;
  readonly sourceKey: string;
  readonly expectedRunId: string;
}

export class ToolPairHistoryBlockedError extends Error {
  constructor(
    readonly purpose: string,
    readonly outcome: Exclude<
      ToolPairValidationOutcome,
      { readonly status: "valid" }
    >,
  ) {
    super(
      `tool-pair history rejected during ${purpose}: ${
        outcome.status === "dangling"
          ? "tool calls remain unresolved"
          : outcome.failure.reason
      }`,
    );
    this.name = "ToolPairHistoryBlockedError";
  }
}

export class TerminalRunEpochOpenError extends Error {
  constructor(
    readonly runId: string,
    readonly epoch: number,
  ) {
    super(
      `refusing to open terminal run ${runId} epoch ${epoch}; explicit reopen is required`,
    );
    this.name = "TerminalRunEpochOpenError";
  }
}

export type ThreadSpawnEdgeStatus = "open" | "closed";

export interface ThreadSpawnEdgeRecord {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly parentPath: AgentPath;
  readonly metadata: AgentMetadata;
  readonly status: ThreadSpawnEdgeStatus;
}

const THREAD_SPAWN_EDGE_SNAPSHOT_VERSION = 1;
const activeCompactionLeases = new Map<string, symbol>();

function rolloutItemsContainTerminal(
  items: readonly RolloutItem[],
  runId: string,
  epoch: number,
): boolean {
  return items.some(
    (item) =>
      item.type === "event_msg" &&
      item.payload.msg.type === "run_terminal" &&
      item.payload.msg.payload.runId === runId &&
      item.payload.msg.payload.epoch === epoch,
  );
}

function rolloutContentContainsTerminal(
  content: string,
  runId: string,
  epoch: number,
): boolean {
  const items: RolloutItem[] = [];
  for (const line of content.split("\n")) {
    const item = parseRolloutLine(line);
    if (item !== null) items.push(item);
  }
  return rolloutItemsContainTerminal(items, runId, epoch);
}

function checkpointProjectionIdentity(
  rolloutPath: string,
  purpose: string,
): string {
  const hash = createHash("sha256");
  hash.update("agenc.checkpoint-projection.v1");
  hash.update("\0");
  hash.update(rolloutPath);
  hash.update("\0");
  hash.update(purpose);
  return hash.digest("hex");
}

function requireCompactionPayloadBundle(
  bundle: CompactionPayloadBundleV1 | undefined,
  params: {
    readonly attemptId: string;
    readonly payloadKind: CompactionPayloadBundleV1["manifest"]["payload_kind"];
    readonly recordedAtMs: number;
    readonly expectedValue?: unknown;
    readonly failureStage: "intent_failed" | "commit_failed";
  },
): unknown {
  if (
    bundle === undefined ||
    bundle.manifest.attempt_id !== params.attemptId ||
    bundle.manifest.payload_kind !== params.payloadKind ||
    bundle.chunks.length !== bundle.manifest.chunk_count ||
    bundle.chunks.some(
      (chunk) =>
        chunk.attempt_id !== params.attemptId ||
        chunk.payload_kind !== params.payloadKind ||
        chunk.recorded_at_ms !== params.recordedAtMs,
    )
  ) {
    throw new CompactionTransactionError(
      params.failureStage,
      `compaction ${params.payloadKind} payload bundle is missing or misbound`,
    );
  }
  let value: unknown;
  try {
    value = reconstructCompactionPayloadV1(bundle.manifest, bundle.chunks);
  } catch (error) {
    throw new CompactionTransactionError(
      params.failureStage,
      `compaction ${params.payloadKind} payload bundle is invalid`,
      { cause: error },
    );
  }
  if (
    params.expectedValue !== undefined &&
    canonicalizeJson(value) !== canonicalizeJson(params.expectedValue)
  ) {
    throw new CompactionTransactionError(
      params.failureStage,
      `compaction ${params.payloadKind} payload bundle conflicts with its runtime value`,
    );
  }
  return value;
}

function persistedCompactionSource(
  source: CompactionSourceAuthorityV1,
  activeHistoryRefsBundle: CompactionPayloadBundleV1,
): CompactionPersistedSourceAuthorityV1 {
  const { active_history_refs: _activeHistoryRefs, ...authority } = source;
  return {
    ...authority,
    active_history_refs_manifest: activeHistoryRefsBundle.manifest,
  };
}

function persistedCompactionIntent(
  intent: CompactionIntentV1,
  bundles: CompactionSourcePayloadBundlesV1,
): CompactionPersistedIntentV1 {
  const persisted = {
    format_version: intent.format_version,
    minimum_reader_runtime: intent.minimum_reader_runtime,
    attempt_id: intent.attempt_id,
    recorded_at_ms: intent.recorded_at_ms,
    source: persistedCompactionSource(intent.source, bundles.active_history_refs),
    source_history_manifest: bundles.source_history.manifest,
    policy_digest: intent.policy_digest,
    configuration_digest: intent.configuration_digest,
    accounting_ref: intent.accounting_ref,
    automatic: intent.automatic,
    selected_history_indexes: intent.selected_history_indexes,
    admission_required: true as const,
    planned_provider_calls: intent.planned_provider_calls,
  };
  return readCompactionPersistedIntentV1(persisted);
}

function persistedCompactionCommit(
  committed: CompactionCommittedV1,
  bundles: NonNullable<CompactionCommitInputV1["payload_bundles"]>,
  activeHistoryRefsManifest: CompactionPayloadBundleV1["manifest"],
): CompactionPersistedCommittedV1 {
  const { active_history_refs: _activeHistoryRefs, ...authority } = committed.source;
  return readCompactionPersistedCommittedV1({
    format_version: committed.format_version,
    minimum_reader_runtime: committed.minimum_reader_runtime,
    attempt_id: committed.attempt_id,
    recorded_at_ms: committed.recorded_at_ms,
    committed_at_ms: committed.committed_at_ms,
    rollback_retention_deadline_ms: committed.rollback_retention_deadline_ms,
    source: {
      ...authority,
      active_history_refs_manifest: activeHistoryRefsManifest,
    },
    selected_history_indexes: committed.selected_history_indexes,
    policy_digest: committed.policy_digest,
    configuration_digest: committed.configuration_digest,
    final_summary_manifest: bundles.final_summary.manifest,
    summary_dag_manifest: bundles.summary_dag.manifest,
    accounting: committed.accounting,
    replacement_history_manifest: bundles.replacement_history.manifest,
    cleanup_state: committed.cleanup_state,
  });
}

function persistedCompactionRollback(
  rollback: CompactionRollbackCommittedV1,
  sourceHistoryManifest: CompactionPayloadBundleV1["manifest"],
): CompactionPersistedRollbackCommittedV1 {
  return readCompactionPersistedRollbackCommittedV1({
    format_version: rollback.format_version,
    minimum_reader_runtime: rollback.minimum_reader_runtime,
    attempt_id: rollback.attempt_id,
    recorded_at_ms: rollback.recorded_at_ms,
    commit_sha256: rollback.commit_sha256,
    source_sha256: rollback.source_sha256,
    history_digest: rollback.history_digest,
    source_session_id: rollback.source_session_id,
    source_epoch: rollback.source_epoch,
    rollback_mode: rollback.rollback_mode,
    target_session_id: rollback.target_session_id,
    source_history_manifest: sourceHistoryManifest,
  });
}

function compactionIntentMatchesPin(
  intent: CompactionIntentV1,
  pin: CompactionPinRecord,
): boolean {
  return (
    intent.attempt_id === pin.attemptId &&
    intent.source.session_id === pin.sessionId &&
    intent.source.epoch === pin.epoch &&
    intent.source.source_binding === pin.sourceBinding &&
    intent.source.first_sequence === pin.firstSequence &&
    intent.source.last_sequence === pin.lastSequence &&
    intent.source.source_sha256 === pin.sourceSha256 &&
    intent.source.source_bytes === pin.sourceBytes &&
    intent.source.history_digest === pin.historyDigest &&
    canonicalizeJson(intent.source.active_history_refs) ===
      canonicalizeJson(pin.activeHistoryRefs) &&
    canonicalizeJson(intent.selected_history_indexes) ===
      canonicalizeJson(pin.selectedHistoryIndexes) &&
    intent.policy_digest === pin.policyDigest &&
    intent.configuration_digest === pin.configurationDigest &&
    intent.accounting_ref === pin.accountingRef &&
    intent.automatic === pin.automatic &&
    intent.admission_required === pin.admissionRequired &&
    intent.planned_provider_calls === pin.plannedProviderCalls
  );
}

function compactionCommitMatchesIntentAndPin(
  commit: CompactionCommittedV1,
  intent: CompactionIntentV1,
  pin: CompactionPinRecord,
): boolean {
  return (
    compactionIntentMatchesPin(intent, pin) &&
    commit.attempt_id === intent.attempt_id &&
    canonicalizeJson(commit.source) === canonicalizeJson(intent.source) &&
    canonicalizeJson(commit.selected_history_indexes) ===
      canonicalizeJson(intent.selected_history_indexes) &&
    commit.policy_digest === intent.policy_digest &&
    commit.configuration_digest === intent.configuration_digest &&
    commit.accounting.accounting_ref === intent.accounting_ref &&
    commit.summary_dag.planned_provider_calls === intent.planned_provider_calls
  );
}

function compactionSourceAuthorityMatchesScan(
  source: CompactionSourceAuthorityV1,
  scan: CanonicalRolloutScan,
): boolean {
  const seenRecords = new Set<number>();
  let sourceBytes = 0;
  for (const ref of source.active_history_refs) {
    const record = scan.sourceRecords.get(ref.first_sequence);
    if (
      ref.first_sequence !== ref.last_sequence ||
      record === undefined ||
      record.encodedByteLength !== ref.encoded_bytes ||
      record.compactionSourceSha256 !== ref.sha256
    ) return false;
    if (!seenRecords.has(record.lineNumber)) {
      seenRecords.add(record.lineNumber);
      sourceBytes += record.encodedByteLength;
    }
  }
  return sourceBytes === source.source_bytes &&
    digestWithDomain(
      COMPACTION_SOURCE_DIGEST_DOMAIN,
      source.active_history_refs,
    ) === source.source_sha256;
}

function compactionPinSourceMatchesScan(
  pin: CompactionPinRecord,
  scan: CanonicalRolloutScan,
): boolean {
  return compactionSourceAuthorityMatchesScan({
    format_version: COMPACTION_EVENT_FORMAT_VERSION,
    attempt_id: pin.attemptId,
    session_id: pin.sessionId,
    epoch: pin.epoch,
    source_binding: pin.sourceBinding,
    first_sequence: pin.firstSequence,
    last_sequence: pin.lastSequence,
    source_sha256: pin.sourceSha256,
    source_bytes: pin.sourceBytes,
    history_digest: pin.historyDigest,
    active_history_refs: pin.activeHistoryRefs,
  }, scan);
}

function compactionSourceRowsPrunedInScan(
  pin: CompactionPinRecord,
  scan: CanonicalRolloutScan,
): boolean {
  return pin.activeHistoryRefs.every((ref) => {
    const retained = scan.sourceRecords.get(ref.first_sequence);
    return retained === undefined ||
      retained.compactionSourceSha256 !== ref.sha256 ||
      (retained.itemType !== "response_item" &&
        retained.itemType !== "compacted");
  });
}

function compactionPhysicalPruneCompleteInScan(
  pin: CompactionPinRecord,
  scan: CanonicalRolloutScan,
): boolean {
  if (!compactionSourceRowsPrunedInScan(pin, scan)) return false;
  const attempt = scan.attempts.get(pin.attemptId);
  if (attempt?.sourceHistoryManifest === undefined) return true;
  return !attempt.sourceHistoryRetained;
}

function cloneProjectionMessage(
  message: ResponseItem,
): CompactionProjectionMessageV1 {
  return {
    ...message,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ({ ...part })),
    ...(message.toolCalls !== undefined
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
    ...(message.toolResultIntegrity !== undefined
      ? { toolResultIntegrity: { ...message.toolResultIntegrity } }
      : {}),
    ...(message.agentInvocation !== undefined
      ? { agentInvocation: { ...message.agentInvocation } }
      : {}),
  };
}

function reviewedRollbackTargetOriginator(
  rollback: CompactionRollbackCommittedV1,
): string {
  return `c2-reviewed-rollback:${digestWithDomain(
    COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
    {
      kind: "reviewed_rollback_target_lineage_v1",
      source_session_id: rollback.source_session_id,
      source_epoch: rollback.source_epoch,
      target_session_id: rollback.target_session_id,
      attempt_id: rollback.attempt_id,
      commit_sha256: rollback.commit_sha256,
    },
  )}`;
}

function assertCompactionItemFitsCanonicalLine(item: RolloutItem): void {
  const encodedBytes = Buffer.byteLength(serializeRolloutItem(item), "utf8") - 1;
  if (encodedBytes > HARD_MAX_RECOVERY_LINE_BYTES) {
    throw new CompactionTransactionError(
      "source_limit_exceeded",
      `compaction ${item.type} event requires ${encodedBytes} bytes; canonical line limit is ${HARD_MAX_RECOVERY_LINE_BYTES}`,
    );
  }
}

function* responseItemsForToolPairValidation(
  items: Iterable<RolloutItem>,
): Iterable<ToolPairMessage> {
  for (const item of items) {
    if (item.type === "response_item") yield item.payload;
  }
}

export class RolloutStore {
  readonly store: SessionStore;
  private readonly scheduler: SessionStoreFlushScheduler;
  private readonly startScheduler: boolean;
  private readonly resumed: boolean;
  readonly projectRootMarkers?: readonly string[];
  private readonly threadSpawnEdgePath: string;
  private readonly stateDriver: StateSqliteDriver;
  private readonly threadSpawnEdgeRepo: ThreadSpawnEdgeRepository;
  private readonly runDurabilityRepo: StateRunDurabilityRepository;
  private readonly compactionRetentionRepo: CompactionRetentionRepository;
  private readonly retrySafeDeferredEffectSteps = new Set<string>();
  private readonly beforeCheckpointUpgradePublishForTestingOnly?: () => void;
  private readonly afterCompactionCommitAppendForTestingOnly?: () => void;
  private readonly afterCompactionSourcePruneRewriteForTestingOnly?: () => void;
  private readonly afterCompactionRollbackAppendForTestingOnly?: () => void;
  private readonly nowMilliseconds: () => number;
  private readonly durablyCommittedCompactionsAwaitingReconstruction =
    new Set<string>();
  private readonly compactionSourcePayloadBundles =
    new Map<string, CompactionSourcePayloadBundlesV1>();
  private liveToolPairProjection: ToolPairProjection | undefined;
  private liveToolPairValidator: StreamingToolPairValidator | undefined;
  private openedAt: string | undefined;
  private openedEpoch: number | undefined;

  constructor(opts: RolloutStoreOpts) {
    this.store = new SessionStore(opts);
    this.scheduler = new SessionStoreFlushScheduler(
      this.store,
      opts.flushIntervalMs ?? 100,
    );
    this.startScheduler = opts.autoStartScheduler !== false;
    this.resumed = opts.resume === true;
    this.projectRootMarkers = opts.projectRootMarkers;
    this.threadSpawnEdgePath = join(
      this.store.sessionDir,
      "thread-spawn-edges.json",
    );
    this.stateDriver = openStateDatabases({
      cwd: opts.cwd,
      projectRootMarkers: opts.projectRootMarkers,
    });
    this.threadSpawnEdgeRepo = new ThreadSpawnEdgeRepository(this.stateDriver);
    this.runDurabilityRepo = new StateRunDurabilityRepository(this.stateDriver);
    this.compactionRetentionRepo = new CompactionRetentionRepository(
      this.stateDriver,
    );
    this.beforeCheckpointUpgradePublishForTestingOnly =
      opts.beforeCheckpointUpgradePublishForTestingOnly;
    this.afterCompactionCommitAppendForTestingOnly =
      opts.afterCompactionCommitAppendForTestingOnly;
    this.afterCompactionSourcePruneRewriteForTestingOnly =
      opts.afterCompactionSourcePruneRewriteForTestingOnly;
    this.afterCompactionRollbackAppendForTestingOnly =
      opts.afterCompactionRollbackAppendForTestingOnly;
    this.nowMilliseconds = opts.nowMilliseconds ?? Date.now;
    this.loadThreadSpawnEdges();
  }

  open(meta: Parameters<SessionStore["open"]>[0]): void {
    try {
      this.assertJournalSourceWritable();
      const existingEpoch = this.runDurabilityRepo.currentEpoch(meta.sessionId);
      if (
        existingEpoch !== undefined &&
        this.currentEpochIsTerminal(meta.sessionId, existingEpoch.epoch)
      ) {
        throw new TerminalRunEpochOpenError(
          meta.sessionId,
          existingEpoch.epoch,
        );
      }

      this.store.open(meta);
      this.promoteDurableCheckpointSchema(meta);
      this.rebuildLiveToolPairProjection();
      // Re-check under the canonical rollout lease. Retention can retire the
      // binding between the optimistic check above and lock acquisition; a
      // source carrying an inactive binding is historical and must never be
      // revived as a writer merely because its directory rename failed.
      this.assertJournalSourceWritable();
      const current = this.runDurabilityRepo.currentEpoch(meta.sessionId);
      const epoch =
        current ??
        this.runDurabilityRepo.ensureInitialEpoch({
          runId: meta.sessionId,
          openedAt: meta.timestamp,
        }).value;
      this.openedAt = epoch.openedAt;
      this.openedEpoch = epoch.epoch;
      if (this.currentEpochIsTerminal(meta.sessionId, epoch.epoch)) {
        throw new TerminalRunEpochOpenError(meta.sessionId, epoch.epoch);
      }
      if (
        this.runDurabilityRepo.getJournalBinding(this.rolloutPath) === undefined
      ) {
        this.runDurabilityRepo.bindJournalSource({
          runId: meta.sessionId,
          epoch: epoch.epoch,
          childRunId: meta.sessionId,
          sessionId: meta.sessionId,
          sourcePath: this.rolloutPath,
          boundAt: epoch.openedAt,
        });
      }
      // C2 reconciliation precedes every other executable recovery family and
      // all pruning. Unresolved pins therefore fail closed before a resumed
      // turn can run or retention can remove source bytes.
      this.reconcileCompactionsOnOpen();
      this.runCompactionRetentionMaintenance(Date.now());
      if (this.resumed) this.recoverEffectProjectionOnOpen();
      if (this.startScheduler) this.scheduler.start();
    } catch (error) {
      this.scheduler.stop();
      this.store.close();
      this.stateDriver.close();
      throw error;
    }
  }

  append(event: Event, opts: AppendOptions = {}): boolean {
    return this.store.append(event, opts);
  }

  /** Lifecycle epoch owned by this canonical rollout writer. */
  get runEpoch(): number {
    if (this.openedEpoch === undefined) {
      throw new Error(`rollout store for ${this.sessionId} is not open`);
    }
    return this.openedEpoch;
  }

  /** CompactionTransactionAdapter epoch alias. */
  get epoch(): number {
    return this.runEpoch;
  }

  /**
   * Fail-fast, durable-session-scoped compaction exclusion. SessionStore's
   * writer lock prevents another process/store from owning the same rollout;
   * this lease serializes independent in-process contexts on that writer.
   */
  acquireCompactionLease(attemptId: string): CompactionTransactionLease {
    if (attemptId.trim().length === 0) {
      throw new CompactionTransactionError(
        "pin_failed",
        "compaction lease requires a nonempty attempt id",
      );
    }
    const key = `${resolve(this.rolloutPath)}#epoch:${this.runEpoch}`;
    if (activeCompactionLeases.has(key)) {
      throw new CompactionTransactionError(
        "intent_failed",
        "compaction already in progress",
      );
    }
    const owner = Symbol(attemptId);
    activeCompactionLeases.set(key, owner);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (activeCompactionLeases.get(key) === owner) {
          activeCompactionLeases.delete(key);
        }
      },
    };
  }
  /** Bind the exact canonical records that currently project active history. */
  prepareSource(
    attemptId: string,
    _messages: readonly RuntimeMessage[],
  ): CompactionPreparedSourceV1 {
    this.store.upgradeCanonicalSchemaHeader(ROLLOUT_SCHEMA_VERSION);
    this.store.syncCanonicalTail();
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: this.sessionId,
      expectedEpoch: this.runEpoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      captureActiveHistory: true,
    });
    if (scan.proof.recordCount === 0) {
      throw new CompactionTransactionError(
        "pin_failed",
        "canonical rollout is empty and cannot authorize compaction",
      );
    }
    const activeHistory = scan.activeHistory;
    if (activeHistory === undefined ||
        activeHistory.positions.length !== activeHistory.messages.length) {
      throw new CompactionTransactionError(
        "pin_failed",
        "active history cannot be mapped exactly to canonical rollout records",
      );
    }
    if (
      activeHistory.messages.length === 0 ||
      activeHistory.messages.length > MAX_COMPACTION_SOURCE_MESSAGES
    ) {
      throw new CompactionTransactionError(
        "source_limit_exceeded",
        "active canonical history is empty or exceeds the compaction message limit",
      );
    }
    const authoritativeMessages = activeHistory.messages.map(
      runtimeMessageFromResponseItem,
    );
    const historyDigest = digestWithDomain(
      COMPACTION_SOURCE_DIGEST_DOMAIN,
      canonicalCompactionSourceMessages(authoritativeMessages),
    );
    const sourceBinding = `rollout:${this.rolloutPath}#epoch:${this.runEpoch}`;
    const activeHistoryRefs = activeHistory.positions.map(
      ({ lineNumber, recordMessageIndex }, historyIndex) => {
        const record = scan.sourceRecords.get(lineNumber);
        if (record === undefined) {
          throw new CompactionTransactionError(
            "pin_failed",
            "active history physical source record was not retained by its scan",
          );
        }
        return {
          kind: "rollout_span" as const,
          ref_id: `${attemptId}:message:${String(historyIndex + 1).padStart(6, "0")}`,
          source_binding: sourceBinding,
          first_sequence: lineNumber,
          last_sequence: lineNumber,
          sha256: record.compactionSourceSha256,
          history_index: historyIndex,
          record_message_index: recordMessageIndex,
          encoded_bytes: record.encodedByteLength,
        };
      },
    );
    const uniqueRecords = new Map<number, number>();
    for (const ref of activeHistoryRefs) {
      uniqueRecords.set(ref.first_sequence, ref.encoded_bytes);
    }
    const sourceBytes = [...uniqueRecords.values()].reduce(
      (total, size) => total + size,
      0,
    );
    if (sourceBytes > MAX_COMPACTION_SOURCE_BYTES) {
      throw new CompactionTransactionError(
        "source_limit_exceeded",
        "active canonical history exceeds the compaction source-byte limit",
      );
    }
    const firstSequence = Math.min(
      ...activeHistoryRefs.map((ref) => ref.first_sequence),
    );
    const lastSequence = Math.max(
      ...activeHistoryRefs.map((ref) => ref.last_sequence),
    );
    const sourceSha256 = digestWithDomain(
      COMPACTION_SOURCE_DIGEST_DOMAIN,
      activeHistoryRefs,
    );
    return {
      source: {
        format_version: COMPACTION_EVENT_FORMAT_VERSION,
        attempt_id: attemptId,
        session_id: this.sessionId,
        epoch: this.runEpoch,
        source_binding: sourceBinding,
        first_sequence: firstSequence,
        last_sequence: lastSequence,
        source_sha256: sourceSha256,
        source_bytes: sourceBytes,
        history_digest: historyDigest,
        active_history_refs: activeHistoryRefs,
      },
      messages: authoritativeMessages,
      message_source_refs: activeHistoryRefs.map((ref) => ({
        kind: ref.kind,
        ref_id: ref.ref_id,
        source_binding: ref.source_binding,
        first_sequence: ref.first_sequence,
        last_sequence: ref.last_sequence,
        sha256: ref.sha256,
        first_history_index: ref.history_index,
        last_history_index: ref.history_index,
        contributing_ref_ids: [ref.ref_id],
      })),
    };
  }

  failureCount(historyDigest: string, configurationDigest: string): number {
    return this.compactionRetentionRepo.failureCount(
      this.sessionId,
      historyDigest,
      configurationDigest,
    );
  }

  pinAndRecordIntent(
    intent: CompactionIntentV1,
    payloadBundles: CompactionSourcePayloadBundlesV1,
  ): void {
    readCompactionRolloutPayload("compaction_intent", intent);
    if (payloadBundles === undefined) {
      throw new CompactionTransactionError(
        "intent_failed",
        "compaction source payload bundles are required",
      );
    }
    const activeHistoryRefs = requireCompactionPayloadBundle(
      payloadBundles.active_history_refs,
      {
        attemptId: intent.attempt_id,
        payloadKind: "active_history_refs",
        recordedAtMs: intent.recorded_at_ms,
        expectedValue: compactActiveHistoryEntries(
          intent.source.active_history_refs,
        ),
        failureStage: "intent_failed",
      },
    );
    void activeHistoryRefs;
    const sourceHistory = requireCompactionPayloadBundle(
      payloadBundles.source_history,
      {
        attemptId: intent.attempt_id,
        payloadKind: "source_history",
        recordedAtMs: intent.recorded_at_ms,
        failureStage: "intent_failed",
      },
    );
    // Reuse the strict inline rollback reader to validate every projection
    // message and bind the manifest source history to the intent digest.
    readCompactionRolloutPayload("compaction_rollback_committed", {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: intent.attempt_id,
      recorded_at_ms: intent.recorded_at_ms,
      commit_sha256: "0".repeat(64),
      source_sha256: intent.source.source_sha256,
      history_digest: intent.source.history_digest,
      source_session_id: intent.source.session_id,
      source_epoch: intent.source.epoch,
      rollback_mode: "same_session",
      target_session_id: intent.source.session_id,
      source_history: sourceHistory,
    });
    const persistedIntent = persistedCompactionIntent(intent, payloadBundles);
    assertCompactionItemFitsCanonicalLine(
      { type: "compaction_intent", payload: persistedIntent } as unknown as RolloutItem,
    );
    try {
      this.compactionRetentionRepo.createPreparingPin(
        intent,
        this.compactionSourceProvenanceAttemptIds(intent.source),
      );
    } catch (error) {
      if (error instanceof CompactionPinQuotaError) {
        this.compactionRetentionRepo.createDeferral({
          sessionId: this.sessionId,
          attemptId: intent.attempt_id,
          reason: error.reason,
          detail: error.message,
          createdAtMs: intent.recorded_at_ms,
        });
      }
      throw error;
    }
    // The pin is durable before this append. A failed append intentionally
    // leaves `preparing` for startup orphan reconciliation.
    this.appendPersistedCompactionRollout(
      { type: "compaction_intent", payload: persistedIntent },
      { durable: true },
    );
    this.appendCompactionPayloadBundles([
      payloadBundles.active_history_refs,
      payloadBundles.source_history,
    ], true);
    this.compactionRetentionRepo.bindIntent(
      intent.attempt_id,
      intent.recorded_at_ms,
    );
    this.compactionSourcePayloadBundles.set(intent.attempt_id, payloadBundles);
  }

  private compactionSourceProvenanceAttemptIds(
    source: CompactionSourceAuthorityV1,
  ): readonly string[] {
    this.store.syncCanonicalTail();
    const candidates = this.compactionRetentionRepo
      .listActiveForSourceBinding(source.source_binding);
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: source.session_id,
      expectedEpoch: source.epoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      additionalSourceLines: [
        ...source.active_history_refs.map((ref) => ref.first_sequence),
        ...candidates.flatMap((pin) =>
          pin.activeHistoryRefs.map((ref) => ref.first_sequence)
        ),
      ],
    });
    if (!compactionSourceAuthorityMatchesScan(source, scan)) {
      throw new CompactionTransactionError(
        "pin_failed",
        "compaction source changed before provenance references were acquired",
      );
    }
    const attempts = new Set<string>();
    for (const ref of source.active_history_refs) {
      const committedAttemptId = scan.sourceRecords.get(ref.first_sequence)
        ?.committedAttemptId;
      if (committedAttemptId !== undefined) attempts.add(committedAttemptId);
    }
    for (const candidate of candidates) {
      const earliestDeletableLine = candidate.activeHistoryRefs
        .filter((ref) => {
          const record = scan.sourceRecords.get(ref.first_sequence);
          return record !== undefined &&
            (record.itemType === "response_item" ||
              record.itemType === "compacted") &&
            record.compactionSourceSha256 === ref.sha256;
        })
        .reduce<number | undefined>(
          (earliest, ref) => earliest === undefined
            ? ref.first_sequence
            : Math.min(earliest, ref.first_sequence),
          undefined,
        );
      if (earliestDeletableLine !== undefined &&
          source.active_history_refs.some(
            (ref) => ref.last_sequence >= earliestDeletableLine,
          )) {
        attempts.add(candidate.attemptId);
      }
    }
    return [...attempts].sort();
  }

  recordFailure(failure: CompactionFailedV1): void {
    readCompactionRolloutPayload("compaction_failed", failure);
    // Terminal evidence must reach the canonical rollout before pin release or
    // failure-guard state can advance.
    this.appendRollout(
      { type: "compaction_failed", payload: failure },
      { durable: true },
    );
    const pin = this.compactionRetentionRepo.get(failure.attempt_id);
    this.compactionRetentionRepo.recordFailure({
      attemptId: failure.attempt_id,
      sessionId: pin?.sessionId ?? this.sessionId,
      historyDigest: failure.history_digest,
      configurationDigest: pin?.configurationDigest ?? "0".repeat(64),
      recordedAtMs: failure.recorded_at_ms,
      sourceStillAuthoritative:
        pin !== undefined && this.compactionSourcePrefixMatches(pin),
      automatic: pin?.automatic ?? false,
    });
  }

  commit(input: CompactionCommitInputV1): CompactionCommittedV1 {
    const commitBundles = input.payload_bundles;
    if (commitBundles === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction commit payload bundles are required",
      );
    }
    verifyCompactionSummaryDigest(input.summary);
    if (
      input.summary.attempt_id !== input.intent.attempt_id ||
      input.summary.policy_digest !== input.intent.policy_digest ||
      input.summary.accounting_ref !== input.intent.accounting_ref
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "summary trusted wrapper does not match the durable compaction intent",
      );
    }
    if (
      input.summary_dag.planned_provider_calls !==
      input.intent.planned_provider_calls
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "summary DAG provider-call count does not match the durable compaction intent",
      );
    }
    this.assertCompactionCommitFresh(input.intent);
    const committed: CompactionCommittedV1 = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: input.intent.attempt_id,
      recorded_at_ms: input.committed_at_ms,
      committed_at_ms: input.committed_at_ms,
      rollback_retention_deadline_ms:
        input.committed_at_ms + COMPACTION_ROLLBACK_RETENTION_MS,
      source: input.intent.source,
      selected_history_indexes: input.intent.selected_history_indexes,
      policy_digest: input.intent.policy_digest,
      configuration_digest: input.intent.configuration_digest,
      summary: input.summary,
      summary_dag: input.summary_dag,
      accounting: input.accounting,
      replacement_history: input.replacement_history,
      cleanup_state: "pending",
    };
    const commitSha256 = digestWithDomain(
      COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
      committed,
    );
    readCompactionRolloutPayload("compaction_committed", committed);
    requireCompactionPayloadBundle(commitBundles.final_summary, {
      attemptId: committed.attempt_id,
      payloadKind: "final_summary",
      recordedAtMs: committed.recorded_at_ms,
      expectedValue: committed.summary,
      failureStage: "commit_failed",
    });
    requireCompactionPayloadBundle(commitBundles.summary_dag, {
      attemptId: committed.attempt_id,
      payloadKind: "summary_dag",
      recordedAtMs: committed.recorded_at_ms,
      expectedValue: committed.summary_dag,
      failureStage: "commit_failed",
    });
    requireCompactionPayloadBundle(commitBundles.replacement_history, {
      attemptId: committed.attempt_id,
      payloadKind: "replacement_history",
      recordedAtMs: committed.recorded_at_ms,
      expectedValue: committed.replacement_history,
      failureStage: "commit_failed",
    });
    const sourceBundles = this.compactionSourcePayloadBundles.get(
      committed.attempt_id,
    );
    if (sourceBundles === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction source payload authority is unavailable",
      );
    }
    const persistedCommit = persistedCompactionCommit(
      committed,
      commitBundles,
      sourceBundles.active_history_refs.manifest,
    );
    // This fsync is the sole commit point. SQLite projection follows and is
    // rebuildable from this event if the process dies between the two writes.
    const commitItem = { type: "compaction_committed", payload: committed } as const;
    const persistedCommitItem = {
      type: "compaction_committed",
      payload: persistedCommit,
    } as const;
    assertCompactionItemFitsCanonicalLine(
      persistedCommitItem as unknown as RolloutItem,
    );
    this.assertLiveToolPairBoundary("transactional compaction commit");
    this.assertValidToolPairHistory(
      committed.replacement_history as readonly ToolPairMessage[],
      "transactional compaction commit",
    );
    try {
      this.appendCompactionPayloadBundles([
        commitBundles.final_summary,
        commitBundles.summary_dag,
        commitBundles.replacement_history,
      ], false);
      this.appendPersistedCompactionRollout(
        persistedCommitItem,
        { durable: true },
      );
    } catch (appendError) {
      this.resolveAmbiguousCompactionCommitAppend(commitItem, appendError);
      throw appendError;
    }
    try {
      this.afterCompactionCommitAppendForTestingOnly?.();
      this.compactionRetentionRepo.markCommitted(committed, commitSha256);
    } catch (error) {
      this.durablyCommittedCompactionsAwaitingReconstruction.add(
        committed.attempt_id,
      );
      try {
        this.compactionRetentionRepo.createDeferral({
          sessionId: this.sessionId,
          attemptId: committed.attempt_id,
          reason: "projection_reconstruction",
          detail: error,
          createdAtMs: Date.now(),
        });
      } catch {
        // The canonical commit is authoritative even if both rebuildable
        // SQLite writes fail. The in-memory poison below still blocks turns.
      }
      throw new CompactionReconstructionRequiredError(committed.attempt_id, {
        cause: error,
      });
    }
    return committed;
  }

  /**
   * A durable append can report failure after every commit byte was written.
   * Resolve that ambiguity before the transaction layer is allowed to append
   * a failure terminal. Once the exact commit is present and a fresh fsync of
   * the canonical tail succeeds, the attempt is committed and must remain
   * poisoned until its rebuildable projection is reconstructed.
   */
  private resolveAmbiguousCompactionCommitAppend(
    expected: Extract<RolloutItem, { readonly type: "compaction_committed" }>,
    appendError: unknown,
  ): void {
    try {
      this.store.syncCanonicalTail();
    } catch (syncError) {
      this.poisonCompactionProjection(expected.payload.attempt_id, [
        appendError,
        syncError,
      ]);
    }
    const terminalItems = this.store.readAll().filter(
      (item) =>
        (item.type === "compaction_committed" ||
          item.type === "compaction_failed") &&
        item.payload.attempt_id === expected.payload.attempt_id,
    );
    if (terminalItems.length === 0) {
      // The canonical tail was repaired and fsynced without this commit. The
      // transaction layer may now append the single failure terminal.
      return;
    }
    const exactCommit =
      terminalItems.length === 1 &&
      terminalItems[0]?.type === "compaction_committed" &&
      canonicalizeJson(terminalItems[0].payload) ===
        canonicalizeJson(expected.payload);
    if (!exactCommit) {
      this.poisonCompactionProjection(expected.payload.attempt_id, [
        appendError,
        new Error("ambiguous compaction append produced conflicting terminal evidence"),
      ]);
    }
    this.poisonCompactionProjection(expected.payload.attempt_id, [appendError]);
  }

  private poisonCompactionProjection(
    attemptId: string,
    causes: readonly unknown[],
  ): never {
    this.durablyCommittedCompactionsAwaitingReconstruction.add(attemptId);
    const cause = causes.length === 1 ? causes[0] : new AggregateError(causes);
    try {
      this.compactionRetentionRepo.createDeferral({
        sessionId: this.sessionId,
        attemptId,
        reason: "projection_reconstruction",
        detail: cause,
        createdAtMs: Date.now(),
      });
    } catch {
      // Canonical evidence and the in-memory poison remain authoritative.
    }
    throw new CompactionReconstructionRequiredError(attemptId, { cause });
  }

  private assertCompactionCommitFresh(intent: CompactionIntentV1): void {
    this.store.syncCanonicalTail();
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: intent.source.session_id,
      expectedEpoch: intent.source.epoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      additionalSourceLines: intent.source.active_history_refs.map(
        (ref) => ref.first_sequence,
      ),
    });
    if (!compactionSourceAuthorityMatchesScan(intent.source, scan)) {
      throw new CompactionTransactionError(
        "commit_failed",
        "canonical active-history source records changed before compaction commit",
      );
    }
    const attempt = scan.attempts.get(intent.attempt_id);
    const persistedIntents = attempt?.records.filter(
      (record) => record.item.type === "compaction_intent",
    ) ?? [];
    const hasTerminal = attempt?.records.some(
      (record) => record.item.type === "compaction_committed" ||
        record.item.type === "compaction_failed",
    ) ?? false;
    if (
      attempt === undefined ||
      persistedIntents.length !== 1 ||
      persistedIntents[0]!.item.type !== "compaction_intent" ||
      canonicalizeJson(persistedIntents[0]!.item.payload) !==
        canonicalizeJson(intent) ||
      hasTerminal ||
      !attempt.admissionValid
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "active rollout advanced outside the compaction admission journal before commit",
      );
    }
  }

  markProjectionComplete(attemptId: string): void {
    this.compactionRetentionRepo.markProjectionComplete(attemptId, Date.now());
    this.durablyCommittedCompactionsAwaitingReconstruction.delete(attemptId);
  }

  markProjectionFailed(attemptId: string, reason: unknown): never {
    try {
      this.recordProjectionFailure(attemptId, reason);
    } catch (recordError) {
      throw new CompactionReconstructionRequiredError(attemptId, {
        cause: new AggregateError([reason, recordError]),
      });
    }
    throw new CompactionReconstructionRequiredError(attemptId, {
      cause: reason,
    });
  }

  recordProjectionFailure(attemptId: string, reason: unknown): void {
    this.compactionRetentionRepo.markProjectionReconstructionRequired(
      attemptId,
      Date.now(),
      reason,
    );
  }

  markCleanupComplete(attemptId: string): void {
    this.compactionRetentionRepo.markCleanupComplete(attemptId);
  }

  markCleanupPending(attemptId: string, reason: unknown): void {
    const pin = this.compactionRetentionRepo.require(attemptId);
    const event: CompactionCleanupPendingV1 = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: attemptId,
      recorded_at_ms: Date.now(),
      commit_sha256: pin.commitSha256 ?? "0".repeat(64),
      reason_digest: sha256Hex(compactionErrorDetail(reason)),
    };
    this.appendRollout(
      { type: "compaction_cleanup_pending", payload: event },
      { durable: true },
    );
    this.compactionRetentionRepo.markCleanupPending(
      attemptId,
      event.recorded_at_ms,
      reason,
    );
  }

  /** Explicit operator extension; the durable minimum can never shrink. */
  extendCompactionRollbackRetention(
    attemptId: string,
    extendedUntilMs: number,
  ): void {
    const pin = this.compactionRetentionRepo.require(attemptId);
    if (pin.state !== "committed_reference" || pin.commitSha256 === undefined ||
        pin.retentionDeadlineMs === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "rollback retention can only extend a committed source",
      );
    }
    const previousDeadlineMs = Math.max(
      pin.retentionDeadlineMs,
      pin.rollbackExtendedUntilMs ?? 0,
    );
    if (!Number.isSafeInteger(extendedUntilMs) ||
        extendedUntilMs <= previousDeadlineMs ||
        extendedUntilMs <= this.nowMilliseconds()) {
      throw new CompactionTransactionError(
        "commit_failed",
        "rollback retention extension must strictly increase the effective future deadline",
      );
    }
    const withoutDigest = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: attemptId,
      recorded_at_ms: this.nowMilliseconds(),
      commit_sha256: pin.commitSha256,
      source_sha256: pin.sourceSha256,
      source_session_id: pin.sessionId,
      source_epoch: pin.epoch,
      previous_retention_deadline_ms: previousDeadlineMs,
      effective_retention_deadline_ms: extendedUntilMs,
    } as const;
    const event: CompactionRetentionExtendedV1 = {
      ...withoutDigest,
      extension_sha256: digestWithDomain(
        COMPACTION_RETENTION_EXTENSION_DIGEST_DOMAIN,
        withoutDigest,
      ),
    };
    readCompactionRolloutPayload("compaction_retention_extended", event);
    this.appendRollout(
      { type: "compaction_retention_extended", payload: event },
      { durable: true },
    );
    try {
      this.compactionRetentionRepo.extendRollbackRetention(
        attemptId,
        extendedUntilMs,
      );
    } catch (error) {
      throw new CompactionReconstructionRequiredError(attemptId, {
        cause: error,
      });
    }
  }

  /**
   * Durably authorize restoration before any caller changes its projection.
   * Newer canonical work forces an explicit reviewed-branch target.
   */
  rollbackCompaction(params: {
    readonly attemptId: string;
    readonly nowMs: number;
    readonly reviewedBranchTargetSessionId?: string;
  }): CompactionRollbackCommittedV1 {
    const nowMs = this.nowMilliseconds();
    const pin = this.compactionRetentionRepo.require(params.attemptId);
    if (pin.state !== "committed_reference" || pin.commitSha256 === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "only a durably committed compaction can be rolled back",
      );
    }
    const rollbackDeadline = Math.max(
      pin.retentionDeadlineMs ?? 0,
      pin.rollbackExtendedUntilMs ?? 0,
    );
    if (nowMs > rollbackDeadline) {
      throw new CompactionTransactionError(
        "commit_failed",
        "the durable compaction rollback window has closed",
      );
    }
    this.store.syncCanonicalTail();
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: pin.sessionId,
      expectedEpoch: pin.epoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      additionalSourceLines: pin.activeHistoryRefs.map(
        (ref) => ref.first_sequence,
      ),
      captureHistoryAtAttemptIds: [pin.attemptId],
    });
    if (!compactionPinSourceMatchesScan(pin, scan)) {
      throw new CompactionTransactionError(
        "commit_failed",
        "rollback source records no longer match their durable authority",
      );
    }
    const attempt = scan.attempts.get(pin.attemptId);
    const intentRecord = attempt?.records.find(
      (record) => record.item.type === "compaction_intent",
    );
    const commitRecord = attempt?.records.find(
      (record) => record.item.type === "compaction_committed",
    );
    if (attempt?.records.some(
      (record) => record.item.type === "compaction_rollback_committed",
    )) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction attempt already has a durable rollback",
      );
    }
    if (intentRecord === undefined || commitRecord === undefined ||
        intentRecord.lineNumber >= commitRecord.lineNumber) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction rollback lifecycle is out of order",
      );
    }
    const commit = commitRecord.item;
    if (
      commit.type !== "compaction_committed" ||
      digestWithDomain(COMPACTION_ACCOUNTING_DIGEST_DOMAIN, commit.payload) !==
        pin.commitSha256
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction rollback commit digest does not match its pin",
      );
    }
    const laterWork = attempt?.hasLaterCanonicalWork ?? false;
    const reviewedTarget = params.reviewedBranchTargetSessionId;
    if (laterWork && reviewedTarget === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "newer canonical work exists; rollback requires an explicit reviewed branch target",
      );
    }
    if (reviewedTarget !== undefined && reviewedTarget === pin.sessionId) {
      throw new CompactionTransactionError(
        "commit_failed",
        "a reviewed rollback branch must have a distinct target session",
      );
    }
    const sourceHistory = (scan.historyAtAttempts.get(pin.attemptId) ?? [])
      .map(cloneProjectionMessage);
    if (
      digestWithDomain(
        COMPACTION_SOURCE_DIGEST_DOMAIN,
        canonicalCompactionSourceMessages(
          sourceHistory.map(runtimeMessageFromResponseItem),
        ),
      ) !== pin.historyDigest
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "rollback reconstruction does not match the pinned history digest",
      );
    }
    const targetSessionId = reviewedTarget ?? pin.sessionId;
    const event: CompactionRollbackCommittedV1 = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: pin.attemptId,
      recorded_at_ms: nowMs,
      commit_sha256: pin.commitSha256,
      source_sha256: pin.sourceSha256,
      history_digest: pin.historyDigest,
      source_session_id: pin.sessionId,
      source_epoch: pin.epoch,
      rollback_mode:
        reviewedTarget === undefined ? "same_session" : "reviewed_branch",
      target_session_id: targetSessionId,
      source_history: sourceHistory,
    };
    readCompactionRolloutPayload("compaction_rollback_committed", event);
    const sourceHistoryManifest = attempt?.sourceHistoryManifest ??
      this.compactionSourcePayloadBundles.get(pin.attemptId)
        ?.source_history.manifest;
    if (sourceHistoryManifest === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "rollback source-history manifest is unavailable",
      );
    }
    const persistedRollback = persistedCompactionRollback(
      event,
      sourceHistoryManifest,
    );
    assertCompactionItemFitsCanonicalLine({
      type: "compaction_rollback_committed",
      payload: persistedRollback,
    } as unknown as RolloutItem);
    const targetReservation = event.rollback_mode === "reviewed_branch"
      ? this.reserveReviewedRollbackTarget(event)
      : undefined;
    try {
      this.assertValidToolPairHistory(
        event.source_history as readonly ToolPairMessage[],
        "transactional compaction rollback",
      );
      this.appendPersistedCompactionRollout(
        { type: "compaction_rollback_committed", payload: persistedRollback },
        { durable: true },
      );
      this.afterCompactionRollbackAppendForTestingOnly?.();
      if (targetReservation !== undefined) {
        this.completeReviewedRollbackTarget(event, targetReservation);
      }
      this.compactionRetentionRepo.recordRollbackReference({
        attemptId: pin.attemptId,
        mode: event.rollback_mode,
        targetSessionId,
        recordedAtMs: nowMs,
      });
    } catch (error) {
      this.durablyCommittedCompactionsAwaitingReconstruction.add(pin.attemptId);
      throw new CompactionReconstructionRequiredError(pin.attemptId, {
        cause: error,
      });
    } finally {
      if (targetReservation !== undefined) {
        this.closeReviewedRollbackTargetReservation(targetReservation);
      }
    }
    return event;
  }

  /**
   * Materialize a reviewed rollback into its own canonical session journal.
   * The source journal remains authoritative for authorization and lineage;
   * this target is an idempotent, exact projection that can be rebuilt after
   * a crash between the source rollback fsync and target completion.
   */
  private materializeReviewedRollbackTarget(
    rollback: CompactionRollbackCommittedV1,
  ): void {
    const reservation = this.reserveReviewedRollbackTarget(rollback);
    try {
      this.completeReviewedRollbackTarget(rollback, reservation);
    } finally {
      this.closeReviewedRollbackTargetReservation(reservation);
    }
  }

  private reserveReviewedRollbackTarget(
    rollback: CompactionRollbackCommittedV1,
  ): ReviewedRollbackTargetReservation {
    if (
      rollback.rollback_mode !== "reviewed_branch" ||
      rollback.target_session_id === this.sessionId
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target materialization requires a distinct session",
      );
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(
        rollback.target_session_id,
      )
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target session id is not canonical or path-safe",
      );
    }
    const target = new SessionStore({
      cwd: this.store.cwd,
      sessionId: rollback.target_session_id,
      agencVersion: this.store.agencVersion,
      resume: true,
      projectRootMarkers: this.projectRootMarkers,
    });
    const sessionsRoot = resolve(dirname(this.store.sessionDir));
    const confined = relative(sessionsRoot, resolve(target.sessionDir));
    if (
      confined !== rollback.target_session_id ||
      confined.startsWith("..")
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target resolves outside the project session root",
      );
    }
    const reservation = { target, opened: false };
    try {
      target.acquireExclusiveReservation();
      if (existsSync(target.rolloutPath)) {
        this.openAndValidateReviewedRollbackTarget(rollback, reservation);
      }
      return reservation;
    } catch (error) {
      this.closeReviewedRollbackTargetReservation(reservation);
      throw error;
    }
  }

  private openAndValidateReviewedRollbackTarget(
    rollback: CompactionRollbackCommittedV1,
    reservation: ReviewedRollbackTargetReservation,
  ): void {
    const target = reservation.target;
    const lineageOriginator = reviewedRollbackTargetOriginator(rollback);
    if (!reservation.opened) {
      target.open({
        sessionId: rollback.target_session_id,
        timestamp: new Date(rollback.recorded_at_ms).toISOString(),
        cwd: this.store.cwd,
        originator: lineageOriginator,
        agencVersion: this.store.agencVersion,
      });
      reservation.opened = true;
    }
    const existing = target.readAll();
    const metadata = existing.filter(
      (item): item is Extract<RolloutItem, { readonly type: "session_meta" }> =>
        item.type === "session_meta",
    );
    if (
      metadata.length !== 1 ||
      metadata[0]!.payload.sessionId !== rollback.target_session_id ||
      metadata[0]!.payload.originator !== lineageOriginator
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target lacks its authenticated durable lineage binding",
      );
    }
    if (
      existing.some(
        (item) => item.type !== "session_meta" && item.type !== "response_item",
      )
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target already contains unrelated canonical work",
      );
    }
    const projected = existing.flatMap((item) =>
      item.type === "response_item" ? [item.payload] : []
    );
    if (
      projected.length > rollback.source_history.length ||
      projected.some(
        (message, index) =>
          canonicalizeJson(message) !==
          canonicalizeJson(rollback.source_history[index]),
      )
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target conflicts with its authorized source history",
      );
    }
  }

  private completeReviewedRollbackTarget(
    rollback: CompactionRollbackCommittedV1,
    reservation: ReviewedRollbackTargetReservation,
  ): void {
    this.openAndValidateReviewedRollbackTarget(rollback, reservation);
    const target = reservation.target;
    const projected = target.readAll().flatMap((item) =>
      item.type === "response_item" ? [item.payload] : []
    );
    for (
      let index = projected.length;
      index < rollback.source_history.length;
      index += 1
    ) {
      target.appendRollout(
        {
          type: "response_item",
          payload: cloneProjectionMessage(rollback.source_history[index]!),
        },
        { durable: true },
      );
    }
    const materialized = target.readAll().flatMap((item) =>
      item.type === "response_item" ? [item.payload] : []
    );
    if (
      canonicalizeJson(materialized) !==
      canonicalizeJson(rollback.source_history)
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "reviewed rollback target projection is incomplete",
      );
    }
  }

  private closeReviewedRollbackTargetReservation(
    reservation: ReviewedRollbackTargetReservation,
  ): void {
    if (reservation.opened) reservation.target.close();
    else reservation.target.releaseExclusiveReservation();
  }

  /** Append the proof-bearing release tombstone before any source pruning. */
  beginCompactionSourceRelease(params: {
    readonly attemptId: string;
    readonly nowMs: number;
  }): CompactionSourceReleaseV1 {
    const nowMs = this.nowMilliseconds();
    const scan = this.scanCompactionSourceRelease(
      params.attemptId,
      nowMs,
    );
    const pin = scan.pin;
    const event: CompactionSourceReleaseV1 = {
      format_version: COMPACTION_EVENT_FORMAT_VERSION,
      minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
      attempt_id: params.attemptId,
      recorded_at_ms: nowMs,
      source_sha256: pin.sourceSha256,
      source_session_id: pin.sessionId,
      source_epoch: pin.epoch,
      commit_sha256: pin.commitSha256!,
      retention_deadline_ms: Math.max(
        pin.retentionDeadlineMs!,
        pin.rollbackExtendedUntilMs ?? 0,
      ),
      reference_scan_generation: scan.generation,
    };
    this.appendRollout(
      { type: "compaction_source_release", payload: event },
      { durable: true },
    );
    try {
      this.compactionRetentionRepo.markReleasePending(event);
    } catch (error) {
      this.durablyCommittedCompactionsAwaitingReconstruction.add(pin.attemptId);
      throw new CompactionReconstructionRequiredError(pin.attemptId, {
        cause: error,
      });
    }
    this.resumeCompactionSourceRelease({
      attemptId: pin.attemptId,
      nowMs,
    });
    return event;
  }

  /** Resume bounded logical pruning after a durable release tombstone. */
  resumeCompactionSourceRelease(params: {
    readonly attemptId: string;
    readonly nowMs: number;
    readonly maxRecords?: number;
  }): boolean {
    const nowMs = this.nowMilliseconds();
    const pin = this.compactionRetentionRepo.require(params.attemptId);
    if (pin.state === "released") return true;
    if (pin.state !== "release_pending") {
      throw new CompactionTransactionError(
        "commit_failed",
        `compaction source pruning requires release_pending, got ${pin.state}`,
      );
    }
    if (pin.referenceScanGeneration === undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction source release is missing its authoritative scan generation",
      );
    }
    if (this.compactionRetentionRepo.listActiveReferences(pin.attemptId).length !== 0) {
      throw new CompactionTransactionError(
        "commit_failed",
        "compaction source acquired a reference during release",
      );
    }
    this.store.syncCanonicalTail();
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: pin.sessionId,
      expectedEpoch: pin.epoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      capturePayloadRecordsAtAttemptIds: [pin.attemptId],
      additionalSourceLines: pin.activeHistoryRefs.map(
        (ref) => ref.first_sequence,
      ),
    });
    const sourceMatches = compactionPinSourceMatchesScan(pin, scan);
    if (
      !sourceMatches &&
      !(
        pin.pruneCursor === pin.activeHistoryRefs.length &&
        compactionSourceRowsPrunedInScan(pin, scan)
      )
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "release-pending source changed before bounded pruning completed",
      );
    }
    const requestedLimit = params.maxRecords ?? COMPACTION_PRUNE_RECORDS_PER_PAGE;
    const limit = Math.min(
      COMPACTION_PRUNE_RECORDS_PER_PAGE,
      Math.max(1, Math.floor(requestedLimit)),
    );
    const nextCursor = Math.min(
      pin.activeHistoryRefs.length,
      pin.pruneCursor + limit,
    );
    this.compactionRetentionRepo.advancePruneCursor({
      attemptId: pin.attemptId,
      cursor: nextCursor,
      referenceScanGeneration: pin.referenceScanGeneration,
    });
    if (nextCursor < pin.activeHistoryRefs.length) return false;
    if (this.pruneCompactionPhysicalSource(pin, scan)) {
      this.afterCompactionSourcePruneRewriteForTestingOnly?.();
    }
    this.compactionRetentionRepo.markReleased({
      attemptId: pin.attemptId,
      releasedAtMs: nowMs,
      sourceBinding: pin.sourceBinding,
      sourceSha256: pin.sourceSha256,
      completedCursor: pin.activeHistoryRefs.length,
      referenceScanGeneration: pin.referenceScanGeneration,
    });
    return true;
  }

  private pruneCompactionPhysicalSource(
    pin: CompactionPinRecord,
    scan: CanonicalRolloutScan,
  ): boolean {
    const exclusions = pin.activeHistoryRefs.flatMap((ref) => {
      const record = scan.sourceRecords.get(ref.first_sequence);
      if (record === undefined ||
          (record.itemType !== "response_item" && record.itemType !== "compacted") ||
          record.compactionSourceSha256 !== ref.sha256) return [];
      return [{
        lineNumber: ref.first_sequence,
        encodedBytes: ref.encoded_bytes,
        sha256: ref.sha256,
        itemType: record.itemType,
      }];
    });
    const attempt = scan.attempts.get(pin.attemptId);
    const sourceHistoryExclusions = attempt?.sourceHistoryManifest === undefined
      ? []
      : (scan.payloadRecordsAtAttempts.get(pin.attemptId) ?? []).map((record) => ({
          lineNumber: record.lineNumber,
          encodedBytes: record.encodedByteLength,
          sha256: record.compactionSourceSha256,
          itemType: "compaction_payload_chunk" as const,
          attemptId: pin.attemptId,
          payloadKind: record.payloadKind,
        }));
    const physicalExclusions = [...exclusions, ...sourceHistoryExclusions];
    if (physicalExclusions.length === 0) return false;
    this.store.rewriteRolloutExcludingPhysicalLinesAtomically(
      physicalExclusions,
      COMPACTION_SOURCE_DIGEST_DOMAIN,
    );
    return true;
  }

  /** Explicit durable references used by checkpoint/branch/provenance owners. */
  addCompactionSourceReference(params: {
    readonly attemptId: string;
    readonly kind: Exclude<
      CompactionReferenceKind,
      "active_history" | "rollback_window" | "rollback_extension"
    >;
    readonly referenceId: string;
    readonly recordedAtMs: number;
  }): void {
    this.compactionRetentionRepo.addReference({
      attemptId: params.attemptId,
      kind: params.kind,
      referenceId: params.referenceId,
      createdAtMs: params.recordedAtMs,
    });
  }

  releaseCompactionSourceReference(params: {
    readonly attemptId: string;
    readonly kind: CompactionReferenceKind;
    readonly referenceId: string;
    readonly recordedAtMs: number;
  }): void {
    this.compactionRetentionRepo.releaseReference({
      attemptId: params.attemptId,
      kind: params.kind,
      referenceId: params.referenceId,
      releasedAtMs: params.recordedAtMs,
    });
  }

  /** Bounded release/GC pass used at startup, before admission, and by operators. */
  runCompactionRetentionMaintenance(
    _requestedNowMs: number,
    limit = COMPACTION_RECONCILIATION_PAGE_SIZE,
  ): { readonly released: number; readonly deletedPins: number } {
    const nowMs = this.nowMilliseconds();
    const boundedLimit = Math.min(
      COMPACTION_RECONCILIATION_PAGE_SIZE,
      Math.max(1, Math.floor(limit)),
    );
    let released = 0;
    let deletedPins = 0;
    for (
      let page = 0;
      page < MAX_COMPACTION_RECONCILIATION_PAGES_PER_START;
      page += 1
    ) {
      const candidates = this.compactionRetentionRepo.listReleaseCandidates(
        this.sessionId,
        nowMs,
        boundedLimit,
      );
      for (const candidate of candidates) {
        let complete: boolean;
        if (candidate.state === "release_pending") {
          complete = this.resumeCompactionSourceRelease({
              attemptId: candidate.attemptId,
              nowMs,
            });
        } else {
          this.beginCompactionSourceRelease({
              attemptId: candidate.attemptId,
              nowMs,
            });
          complete = this.compactionRetentionRepo.require(candidate.attemptId)
            .state === "released";
        }
        if (complete) released += 1;
      }
      const deletedPage = this.compactionRetentionRepo.deleteReleasedHistory(
        boundedLimit,
      );
      deletedPins += deletedPage;
      if (candidates.length < boundedLimit && deletedPage < boundedLimit) break;
    }
    return { released, deletedPins };
  }

  private scanCompactionSourceRelease(
    attemptId: string,
    nowMs: number,
  ): { readonly pin: CompactionPinRecord; readonly generation: number } {
    const pin = this.compactionRetentionRepo.require(attemptId);
    const references = this.compactionRetentionRepo.listActiveReferences(attemptId);
    if (references.length > 0) {
      throw new CompactionTransactionError(
        "commit_failed",
        `compaction source has active ${references[0]!.kind} reference ${references[0]!.referenceId}`,
      );
    }
    this.store.syncCanonicalTail();
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: pin.sessionId,
      expectedEpoch: pin.epoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      additionalSourceLines: pin.activeHistoryRefs.map(
        (ref) => ref.first_sequence,
      ),
    });
    if (!compactionPinSourceMatchesScan(pin, scan)) {
      throw new CompactionTransactionError(
        "commit_failed",
        "release scan cannot prove the pinned active-history records",
      );
    }
    const attempt = scan.attempts.get(attemptId);
    const intentRecord = attempt?.records.find(
      (record) => record.item.type === "compaction_intent",
    );
    const commitRecord = attempt?.records.find(
      (record) => record.item.type === "compaction_committed",
    );
    if (intentRecord === undefined || commitRecord === undefined ||
        intentRecord.lineNumber >= commitRecord.lineNumber) {
      throw new CompactionTransactionError(
        "commit_failed",
        "release scan found an out-of-order compaction lifecycle",
      );
    }
    const commit = commitRecord.item;
    if (
      commit.type !== "compaction_committed" ||
      pin.commitSha256 === undefined ||
      digestWithDomain(COMPACTION_ACCOUNTING_DIGEST_DOMAIN, commit.payload) !==
        pin.commitSha256
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "release scan cannot bind the canonical compaction commit",
      );
    }
    const sourceLines = new Set(pin.activeHistoryRefs
      .filter((ref) => {
        const record = scan.sourceRecords.get(ref.first_sequence);
        return record !== undefined &&
          (record.itemType === "response_item" ||
            record.itemType === "compacted") &&
          record.compactionSourceSha256 === ref.sha256;
      })
      .map((ref) => ref.first_sequence));
    const earliestRemovedLine = sourceLines.size === 0
      ? undefined
      : Math.min(...sourceLines);
    const endangeredPin = this.compactionRetentionRepo
      .listActiveForSourceBinding(pin.sourceBinding)
      .find(
        (candidate) =>
          candidate.attemptId !== pin.attemptId &&
          earliestRemovedLine !== undefined &&
          candidate.activeHistoryRefs.some((ref) =>
            sourceLines.has(ref.first_sequence) ||
            ref.last_sequence >= earliestRemovedLine
          ),
      );
    if (endangeredPin !== undefined) {
      throw new CompactionTransactionError(
        "commit_failed",
        `compaction ${endangeredPin.attemptId} has a live ordinal at or after records selected for physical pruning`,
      );
    }
    const eligible = this.compactionRetentionRepo.assertReleaseEligible(
      attemptId,
      nowMs,
    );
    return { pin: eligible, generation: scan.proof.recordCount };
  }

  /** Whether this session must be reconstructed before it can accept a turn. */
  get compactionReconstructionRequired(): boolean {
    return this.durablyCommittedCompactionsAwaitingReconstruction.size > 0 ||
      this.compactionRetentionRepo
      .listSession(this.sessionId)
      .some(
        (pin) =>
          pin.state === "committed_reference" &&
          (pin.projectionState !== "complete" ||
            pin.cleanupState !== "complete"),
      );
  }

  assertCompactionProjectionReady(): void {
    const unprojectedAttempt =
      this.durablyCommittedCompactionsAwaitingReconstruction.values().next();
    if (!unprojectedAttempt.done) {
      throw new CompactionReconstructionRequiredError(unprojectedAttempt.value);
    }
    const poisoned = this.compactionRetentionRepo
      .listSession(this.sessionId)
      .find(
        (pin) =>
          pin.state === "committed_reference" &&
          (pin.projectionState !== "complete" ||
            pin.cleanupState !== "complete"),
      );
    if (poisoned !== undefined) {
      throw new CompactionReconstructionRequiredError(poisoned.attemptId);
    }
  }

  /** Called after canonical rollout reconstruction has installed commit state. */
  acknowledgeCompactionReconstruction(attemptIds: readonly string[]): void {
    for (const attemptId of new Set(attemptIds)) {
      const pin = this.compactionRetentionRepo.get(attemptId);
      if (pin?.sessionId !== this.sessionId) continue;
      this.compactionRetentionRepo.markProjectionComplete(attemptId, Date.now());
      this.durablyCommittedCompactionsAwaitingReconstruction.delete(attemptId);
    }
  }

  private compactionSourcePrefixMatches(pin: CompactionPinRecord): boolean {
    try {
      this.store.syncCanonicalTail();
      const scan = scanCanonicalRollout(this.rolloutPath, {
        expectedRunId: pin.sessionId,
        expectedEpoch: pin.epoch,
        maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
        nowMilliseconds: this.nowMilliseconds,
        compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
        additionalSourceLines: pin.activeHistoryRefs.map(
          (ref) => ref.first_sequence,
        ),
      });
      return compactionPinSourceMatchesScan(pin, scan);
    } catch {
      return false;
    }
  }

  private reconcileCompactionsOnOpen(): void {
    const startedAtMs = this.nowMilliseconds();
    this.store.syncCanonicalTail();
    const existingPins = this.compactionRetentionRepo.listSession(this.sessionId);
    const scan = scanCanonicalRollout(this.rolloutPath, {
      expectedRunId: this.sessionId,
      expectedEpoch: this.runEpoch,
      maximumScanMilliseconds: MAX_COMPACTION_RECONCILIATION_MS_PER_START,
      nowMilliseconds: this.nowMilliseconds,
      compactionSourceDigestDomain: COMPACTION_SOURCE_DIGEST_DOMAIN,
      additionalSourceLines: existingPins.flatMap((pin) =>
        pin.activeHistoryRefs.map((ref) => ref.first_sequence)
      ),
    });
    this.rebuildCompactionPinsFromCanonical(scan);
    let pages = 0;
    let exhausted = false;
    while (pages < MAX_COMPACTION_RECONCILIATION_PAGES_PER_START) {
      if (this.nowMilliseconds() - startedAtMs >=
          MAX_COMPACTION_RECONCILIATION_MS_PER_START) {
        exhausted = true;
        break;
      }
      const page = this.compactionRetentionRepo.listReconciliationPage(
        this.sessionId,
      );
      if (page.length === 0) {
        this.compactionRetentionRepo.resetReconciliationCursor(
          this.sessionId,
          this.nowMilliseconds(),
        );
        return;
      }
      pages += 1;
      for (const listedPin of page) {
        if (this.nowMilliseconds() - startedAtMs >=
            MAX_COMPACTION_RECONCILIATION_MS_PER_START) {
          exhausted = true;
          break;
        }
        this.reconcileCompactionPin(
          listedPin,
          scan.attempts.get(listedPin.attemptId),
          scan,
        );
        this.compactionRetentionRepo.persistReconciliationCursor(
          this.sessionId,
          listedPin,
          this.nowMilliseconds(),
        );
      }
      if (exhausted) break;
      if (page.length < COMPACTION_RECONCILIATION_PAGE_SIZE) {
        this.compactionRetentionRepo.resetReconciliationCursor(
          this.sessionId,
          this.nowMilliseconds(),
        );
        return;
      }
    }
    const reason = exhausted
      ? "startup_time_budget"
      : "startup_page_budget";
    this.compactionRetentionRepo.createDeferral({
      sessionId: this.sessionId,
      reason,
      detail: { pages, startedAtMs },
      createdAtMs: this.nowMilliseconds(),
    });
    throw new Error(
      `compaction reconciliation deferred after ${pages} pages; resume before executable recovery`,
    );
  }

  private rebuildCompactionPinsFromCanonical(scan: CanonicalRolloutScan): void {
    const orderedAttempts = [...scan.attempts.values()].sort(
      (left, right) => left.records[0]!.lineNumber - right.records[0]!.lineNumber,
    );
    for (const attempt of orderedAttempts) {
      const intent = attempt.intent;
      if (this.compactionRetentionRepo.get(intent.attempt_id) !== undefined) {
        continue;
      }
      const provenanceAttemptIds = new Set(intent.source.active_history_refs.flatMap(
        (ref) => {
          const ancestor = scan.sourceRecords.get(ref.first_sequence)
            ?.committedAttemptId;
          return ancestor === undefined ? [] : [ancestor];
        },
      ));
      for (const candidate of this.compactionRetentionRepo
        .listActiveForSourceBinding(intent.source.source_binding)) {
        const earliestDeletableLine = candidate.activeHistoryRefs
          .filter((ref) => {
            const record = scan.sourceRecords.get(ref.first_sequence);
            return record !== undefined &&
              (record.itemType === "response_item" ||
                record.itemType === "compacted") &&
              record.compactionSourceSha256 === ref.sha256;
          })
          .reduce<number | undefined>(
            (earliest, ref) => earliest === undefined
              ? ref.first_sequence
              : Math.min(earliest, ref.first_sequence),
            undefined,
          );
        if (earliestDeletableLine !== undefined &&
            intent.source.active_history_refs.some(
              (ref) => ref.last_sequence >= earliestDeletableLine,
            )) {
          provenanceAttemptIds.add(candidate.attemptId);
        }
      }
      let pin = this.compactionRetentionRepo.createPreparingPin(
        intent,
        [...provenanceAttemptIds],
      );
      pin = this.compactionRetentionRepo.bindIntent(
        intent.attempt_id,
        intent.recorded_at_ms,
      );
      const items = attempt.records.map((record) => record.item);
      const failure = items.find(
        (item): item is Extract<RolloutItem, { type: "compaction_failed" }> =>
          item.type === "compaction_failed",
      );
      if (failure !== undefined) {
        this.compactionRetentionRepo.recordFailure({
          attemptId: pin.attemptId,
          sessionId: pin.sessionId,
          historyDigest: failure.payload.history_digest,
          configurationDigest: pin.configurationDigest,
          recordedAtMs: failure.payload.recorded_at_ms,
          sourceStillAuthoritative: compactionPinSourceMatchesScan(pin, scan),
          automatic: pin.automatic,
        });
        continue;
      }
      const commit = items.find(
        (item): item is Extract<RolloutItem, { type: "compaction_committed" }> =>
          item.type === "compaction_committed",
      );
      if (commit === undefined) continue;
      if (!attempt.admissionValid ||
          !compactionCommitMatchesIntentAndPin(commit.payload, intent, pin)) {
        throw new CompactionTransactionError(
          "commit_failed",
          "canonical compaction cannot rebuild an invalid admission or commit binding",
        );
      }
      pin = this.compactionRetentionRepo.markCommitted(
        commit.payload,
        digestWithDomain(COMPACTION_ACCOUNTING_DIGEST_DOMAIN, commit.payload),
      );
      this.compactionRetentionRepo.markProjectionComplete(
        pin.attemptId,
        commit.payload.committed_at_ms,
      );
      this.compactionRetentionRepo.markCleanupComplete(pin.attemptId);
      this.reconcileCompactionRetentionExtensions(pin, items);
      pin = this.compactionRetentionRepo.require(pin.attemptId);
      const rollback = items.find(
        (item): item is Extract<RolloutItem, { type: "compaction_rollback_committed" }> =>
          item.type === "compaction_rollback_committed",
      );
      const release = items.find(
        (item): item is Extract<RolloutItem, { type: "compaction_source_release" }> =>
          item.type === "compaction_source_release",
      );
      if (rollback !== undefined && release === undefined) {
        if (rollback.payload.rollback_mode === "reviewed_branch") {
          this.materializeReviewedRollbackTarget(rollback.payload);
        }
        this.compactionRetentionRepo.recordRollbackReference({
          attemptId: pin.attemptId,
          mode: rollback.payload.rollback_mode,
          targetSessionId: rollback.payload.target_session_id,
          recordedAtMs: rollback.payload.recorded_at_ms,
        });
      }
      if (release === undefined) continue;
      pin = this.compactionRetentionRepo.markReleasePending(release.payload);
      if (!compactionPhysicalPruneCompleteInScan(pin, scan)) continue;
      this.compactionRetentionRepo.advancePruneCursor({
        attemptId: pin.attemptId,
        cursor: pin.activeHistoryRefs.length,
        referenceScanGeneration: release.payload.reference_scan_generation,
      });
      this.compactionRetentionRepo.markReleased({
        attemptId: pin.attemptId,
        releasedAtMs: release.payload.recorded_at_ms,
        sourceBinding: pin.sourceBinding,
        sourceSha256: pin.sourceSha256,
        completedCursor: pin.activeHistoryRefs.length,
        referenceScanGeneration: release.payload.reference_scan_generation,
      });
    }
  }

  private reconcileCompactionPin(
    listedPin: CompactionPinRecord,
    attemptScan: CanonicalCompactionAttemptScan | undefined,
    scan: CanonicalRolloutScan,
  ): void {
    let pin = this.compactionRetentionRepo.require(listedPin.attemptId);
    const items = attemptScan?.records.map((record) => record.item) ?? [];
    const intents = items.filter(
      (item): item is Extract<RolloutItem, { readonly type: "compaction_intent" }> =>
        item.type === "compaction_intent",
    );
    const failures = items.filter(
      (item): item is Extract<RolloutItem, { readonly type: "compaction_failed" }> =>
        item.type === "compaction_failed",
    );
    const commits = items.filter(
      (item): item is Extract<RolloutItem, { readonly type: "compaction_committed" }> =>
        item.type === "compaction_committed",
    );
    const rollbacks = items.filter(
      (item): item is Extract<RolloutItem, { readonly type: "compaction_rollback_committed" }> =>
        item.type === "compaction_rollback_committed",
    );
    const releases = items.filter(
      (item): item is Extract<RolloutItem, { readonly type: "compaction_source_release" }> =>
        item.type === "compaction_source_release",
    );
    if (
      intents.length > 1 ||
      failures.length > 1 ||
      commits.length > 1 ||
      rollbacks.length > 1 ||
      releases.length > 1
    ) {
      throw new CompactionTransactionError(
        "commit_failed",
        "canonical compaction lifecycle contains duplicate durable events",
      );
    }
    const intent = intents[0];
    const failure = failures[0];
    const commit = commits[0];
    const rollback = rollbacks[0];
    const release = releases[0];
    if (intent !== undefined && !compactionIntentMatchesPin(intent.payload, pin)) {
      throw new CompactionTransactionError(
        "commit_failed",
        "canonical compaction intent does not match its immutable retention pin",
      );
    }
    if (pin.state === "preparing" && intent === undefined) {
      if (commit !== undefined || failure !== undefined) {
        this.compactionRetentionRepo.createDeferral({
          sessionId: pin.sessionId,
          attemptId: pin.attemptId,
          reason: "source_proof_unavailable",
          detail: "terminal compaction event exists without its intent",
          createdAtMs: Date.now(),
        });
        return;
      }
      const sourceMatches = compactionPinSourceMatchesScan(
        pin,
        scan,
      );
      if (!sourceMatches) {
        this.compactionRetentionRepo.createDeferral({
          sessionId: pin.sessionId,
          attemptId: pin.attemptId,
          reason: "source_proof_unavailable",
          detail: "orphan pin source prefix no longer matches",
          createdAtMs: this.nowMilliseconds(),
        });
        return;
      }
      this.compactionRetentionRepo.releaseOrphanPreparing(
        pin.attemptId,
        this.nowMilliseconds(),
        true,
      );
      return;
    }
    if (pin.state === "preparing" && intent !== undefined) {
      pin = this.compactionRetentionRepo.bindIntent(
        pin.attemptId,
        intent.payload.recorded_at_ms,
      );
    }
    if (commit !== undefined) {
      if (
        intent === undefined ||
        !compactionCommitMatchesIntentAndPin(commit.payload, intent.payload, pin)
      ) {
        throw new CompactionTransactionError(
          "commit_failed",
          "canonical compaction commit does not match its durable intent and pin",
        );
      }
      if (
        attemptScan === undefined ||
        !attemptScan.admissionValid
      ) {
        throw new CompactionTransactionError(
          "commit_failed",
          "canonical compaction admission lifecycle is incomplete or contaminated",
        );
      }
      const commitSha256 = digestWithDomain(
        COMPACTION_ACCOUNTING_DIGEST_DOMAIN,
        commit.payload,
      );
      if (
        pin.state !== "intent_bound" &&
        pin.commitSha256 !== commitSha256
      ) {
        throw new CompactionTransactionError(
          "commit_failed",
          "canonical compaction commit digest does not match its durable pin",
        );
      }
      if (pin.state === "intent_bound") {
        pin = this.compactionRetentionRepo.markCommitted(
          commit.payload,
          commitSha256,
        );
      }
      this.reconcileCompactionRetentionExtensions(pin, items);
      pin = this.compactionRetentionRepo.require(pin.attemptId);
      if (rollback !== undefined && release === undefined) {
        if (rollback.payload.rollback_mode === "reviewed_branch") {
          this.materializeReviewedRollbackTarget(rollback.payload);
        }
        this.compactionRetentionRepo.recordRollbackReference({
          attemptId: pin.attemptId,
          mode: rollback.payload.rollback_mode,
          targetSessionId: rollback.payload.target_session_id,
          recordedAtMs: rollback.payload.recorded_at_ms,
        });
        pin = this.compactionRetentionRepo.require(pin.attemptId);
      }
      if (release !== undefined && pin.state === "committed_reference") {
        pin = this.compactionRetentionRepo.markReleasePending(release.payload);
      }
      if (pin.state === "release_pending") {
        this.resumeCompactionSourceRelease({
          attemptId: pin.attemptId,
          nowMs: release?.payload.recorded_at_ms ?? Date.now(),
        });
        return;
      }
      if (pin.cleanupState === "pending") {
        // All cleanup targets are process-local caches. A restart reconstructs
        // them from the committed rollout, so the cleanup is idempotently done.
        this.compactionRetentionRepo.markCleanupComplete(pin.attemptId);
      }
      return;
    }
    if (failure !== undefined) {
      this.compactionRetentionRepo.recordFailure({
        attemptId: pin.attemptId,
        sessionId: pin.sessionId,
        historyDigest: failure.payload.history_digest,
        configurationDigest: pin.configurationDigest,
        recordedAtMs: failure.payload.recorded_at_ms,
        sourceStillAuthoritative: compactionPinSourceMatchesScan(pin, scan),
        automatic: pin.automatic,
      });
      return;
    }
    if (pin.state === "intent_bound") {
      const nowMs = this.nowMilliseconds();
      const interrupted: CompactionFailedV1 = {
        format_version: COMPACTION_EVENT_FORMAT_VERSION,
        minimum_reader_runtime: COMPACTION_MINIMUM_READER_RUNTIME,
        attempt_id: pin.attemptId,
        recorded_at_ms: nowMs,
        source_sha256: pin.sourceSha256,
        history_digest: pin.historyDigest,
        reason: "recovery_interrupted",
        detail_digest: sha256Hex("startup reconciliation closed incomplete intent"),
      };
      try {
        this.appendRollout(
          { type: "compaction_failed", payload: interrupted },
          { durable: true },
        );
        this.compactionRetentionRepo.recordFailure({
          attemptId: pin.attemptId,
          sessionId: pin.sessionId,
          historyDigest: pin.historyDigest,
          configurationDigest: pin.configurationDigest,
          recordedAtMs: nowMs,
          sourceStillAuthoritative: compactionPinSourceMatchesScan(pin, scan),
          automatic: pin.automatic,
        });
      } catch (error) {
        this.compactionRetentionRepo.createDeferral({
          sessionId: pin.sessionId,
          attemptId: pin.attemptId,
          reason: "failure_append_unavailable",
          detail: error,
          createdAtMs: nowMs,
        });
      }
    }
  }

  private reconcileCompactionRetentionExtensions(
    initialPin: CompactionPinRecord,
    items: readonly RolloutItem[],
  ): void {
    let pin = initialPin;
    for (const item of items) {
      if (item.type !== "compaction_retention_extended") continue;
      const extension = item.payload;
      if (pin.commitSha256 !== extension.commit_sha256 ||
          pin.sourceSha256 !== extension.source_sha256 ||
          pin.sessionId !== extension.source_session_id ||
          pin.epoch !== extension.source_epoch) {
        throw new CompactionTransactionError(
          "commit_failed",
          "canonical retention extension does not bind the durable compaction pin",
        );
      }
      const currentDeadline = Math.max(
        pin.retentionDeadlineMs ?? 0,
        pin.rollbackExtendedUntilMs ?? 0,
      );
      if (extension.effective_retention_deadline_ms <= currentDeadline) {
        continue;
      }
      if (extension.previous_retention_deadline_ms !== currentDeadline) {
        throw new CompactionTransactionError(
          "commit_failed",
          "canonical retention extension is not contiguous with SQLite state",
        );
      }
      pin = this.compactionRetentionRepo.extendRollbackRetention(
        pin.attemptId,
        extension.effective_retention_deadline_ms,
      );
    }
  }

  /** Project a fsync-committed effect event into rebuildable M4 state. */
  recordEffectEvent(event: Event): void {
    const sequence = event.seq;
    if (!Number.isSafeInteger(sequence) || (sequence ?? 0) <= 0) {
      throw new Error("effect projection requires a positive event sequence");
    }
    const eventId = canonicalRolloutEventId(event);
    const message = event.msg;
    if (message.type === "effect_intent") {
      const payload = message.payload;
      const epoch = this.requireRunEpoch(payload.runId);
      this.runDurabilityRepo.beginEffect({
        runId: payload.runId,
        epoch: epoch.epoch,
        stepId: payload.stepId,
        ...(this.sessionId !== payload.runId
          ? { childRunId: this.sessionId }
          : {}),
        sessionId: this.sessionId,
        callId: payload.callId,
        toolName: payload.toolName,
        recoveryCategory: payload.recoveryCategory,
        ...(payload.idempotencyKey !== undefined
          ? { idempotencyKey: payload.idempotencyKey }
          : {}),
        intentDigest: payload.intentDigest,
        eventId,
        eventSequence: sequence!,
        intentAt: payload.recordedAt,
        effectFormatVersion: payload.formatVersion ?? 1,
        ...(payload.minimumReaderRuntime !== undefined
          ? { minimumReaderRuntime: payload.minimumReaderRuntime }
          : {}),
      });
      return;
    }
    if (message.type === "effect_result") {
      const payload = message.payload;
      if (payload.formatVersion === 2 && payload.effectBoundary === undefined) {
        throw new Error("effect_result format v2 requires effectBoundary");
      }
      if (
        payload.formatVersion === undefined &&
        payload.recoveryCategory !== "idempotent" &&
        (payload.outcome === "failed" || payload.outcome === "cancelled")
      ) {
        this.runDurabilityRepo.markEffectUnknown({
          runId: payload.runId,
          stepId: payload.stepId,
          eventId,
          eventSequence: sequence!,
          reason: "legacy_ambiguous_terminal_evidence",
          evidence: payload.evidence,
          observedAt: payload.recordedAt,
        });
        recordInFlightToolCallUnknownOutcome(this.stateDriver, {
          sessionId: this.sessionId,
          agentId: payload.runId,
          toolCallId: payload.callId,
          toolName: payload.toolName,
          observedAt: payload.recordedAt,
          recoveryCategory: payload.recoveryCategory,
        });
        return;
      }
      this.runDurabilityRepo.completeEffect({
        runId: payload.runId,
        stepId: payload.stepId,
        outcome: payload.outcome,
        effectBoundary: payload.effectBoundary ?? "crossed",
        ...(payload.noEffectEvidence !== undefined
          ? { noEffectEvidence: payload.noEffectEvidence }
          : {}),
        eventId,
        eventSequence: sequence!,
        ...(payload.resultDigest !== undefined
          ? { resultDigest: payload.resultDigest }
          : {}),
        ...(payload.evidence !== undefined
          ? { evidence: payload.evidence }
          : {}),
        completedAt: payload.recordedAt,
      });
      return;
    }
    if (message.type === "effect_unknown_outcome") {
      const payload = message.payload;
      if (payload.recoveryCategory === "idempotent") {
        throw new Error("idempotent effects cannot have unknown outcome");
      }
      this.runDurabilityRepo.markEffectUnknown({
        runId: payload.runId,
        stepId: payload.stepId,
        eventId,
        eventSequence: sequence!,
        reason: payload.reason,
        evidence: {
          requiresReview: payload.requiresReview,
          ...(payload.callerStop !== undefined
            ? { callerStop: payload.callerStop }
            : {}),
          ...(payload.callerStoppedAt !== undefined
            ? { callerStoppedAt: payload.callerStoppedAt }
            : {}),
          ...(payload.reservationId !== undefined
            ? { reservationId: payload.reservationId }
            : {}),
        },
        observedAt: payload.recordedAt,
      });
      recordInFlightToolCallUnknownOutcome(this.stateDriver, {
        sessionId: this.sessionId,
        agentId: payload.runId,
        toolCallId: payload.callId,
        toolName: payload.toolName,
        observedAt: payload.recordedAt,
        recoveryCategory: payload.recoveryCategory,
      });
      return;
    }
    if (message.type === "effect_review_resolved") {
      const payload = message.payload;
      if (typeof payload.resolution === "string") {
        // Legacy arbitrary labels are retained in the canonical journal but
        // can never lift an unknown-outcome mutation gate.
        return;
      }
      const effect = this.runDurabilityRepo.getEffect(
        payload.runId,
        payload.stepId,
      );
      if (effect === undefined || effect.callId !== payload.callId) {
        throw new Error(
          `effect review ${eventId} has no matching durable unknown outcome`,
        );
      }
      this.runDurabilityRepo.resolveEffectReview({
        runId: payload.runId,
        stepId: payload.stepId,
        resolution: payload.resolution,
        eventId,
        evidence: {
          callId: payload.callId,
          sequence,
          source: "canonical_run_journal",
        },
      });
      if (payload.resolution.workflowStatus !== "pending") {
        resolveUnknownOutcomeEffect(this.stateDriver, {
          sessionId: effect.sessionId,
          toolCallId: effect.callId,
        });
      }
    }
  }

  appendRollout(item: RolloutItem, opts: AppendOptions = {}): void {
    if (item.type === "response_item") {
      this.validateLiveResponseItem(item.payload);
    } else if (item.type === "compacted") {
      this.assertLiveToolPairBoundary("compaction append");
      if (item.payload.replacementHistory !== undefined) {
        this.assertValidToolPairHistory(
          item.payload.replacementHistory,
          "compaction append",
        );
      }
    } else if (item.type === "compaction_committed") {
      this.assertLiveToolPairBoundary("transactional compaction commit");
      this.assertValidToolPairHistory(
        item.payload.replacement_history as readonly ToolPairMessage[],
        "transactional compaction commit",
      );
    } else if (item.type === "compaction_rollback_committed") {
      this.assertValidToolPairHistory(
        item.payload.source_history as readonly ToolPairMessage[],
        "transactional compaction rollback",
      );
    }
    this.store.appendRollout(item, opts);
  }

  private appendPersistedCompactionRollout(
    item: PersistedCompactionRolloutItem,
    opts: AppendOptions,
  ): void {
    // Persisted manifest rows deliberately differ from the hydrated in-memory
    // RolloutItem view. The strict persisted readers above are the sole cast
    // boundary; SessionStore hydration restores the public runtime shape.
    this.store.appendRollout(item as unknown as RolloutItem, opts);
  }

  private appendCompactionPayloadBundles(
    bundles: readonly CompactionPayloadBundleV1[],
    durableFinalChunk: boolean,
  ): void {
    const chunks = bundles.flatMap((bundle) => bundle.chunks);
    if (chunks.length === 0) {
      throw new CompactionTransactionError(
        "intent_failed",
        "compaction payload bundles must contain at least one chunk",
      );
    }
    chunks.forEach((chunk, index) => {
      this.store.appendRollout(
        { type: "compaction_payload_chunk", payload: chunk },
        { durable: durableFinalChunk && index === chunks.length - 1 },
      );
    });
  }

  readAll(): RolloutItem[] {
    return this.store.readAll();
  }

  get rolloutPath(): string {
    return this.store.rolloutPath;
  }

  get sessionId(): string {
    return this.store.sessionId;
  }

  /** Fresh exact projection namespace for raw-prefix validation. */
  checkpointProjectionContext(purpose: string): DurableCheckpointProjectionContext {
    return this.toolPairProjectionContext(purpose, true);
  }

  private toolPairProjectionContext(
    purpose: string,
    discardOnTerminal: boolean,
  ): DurableCheckpointProjectionContext {
    const identity = checkpointProjectionIdentity(this.rolloutPath, purpose);
    return {
      projection: new StateToolPairProjection(this.stateDriver, {
        discardOnTerminal,
      }),
      projectionId: `checkpoint:${identity}`,
      sourceKey: `rollout:${checkpointProjectionIdentity(this.rolloutPath, "source")}`,
      expectedRunId: this.sessionId,
    };
  }

  /** Validate a complete durable history at a semantic replacement boundary. */
  assertValidToolPairHistory(
    messages: Iterable<ToolPairMessage>,
    purpose: string,
  ): void {
    const projectionContext = this.checkpointProjectionContext(
      `history:${purpose}`,
    );
    const outcome = validateToolPairSequence(messages, projectionContext.projection, {
      projectionId: projectionContext.projectionId,
      sourceKey: projectionContext.sourceKey,
      requireResultIntegrity: true,
      expectedRunId: this.sessionId,
    });
    if (outcome.status !== "valid") {
      throw new ToolPairHistoryBlockedError(purpose, outcome);
    }
  }

  private promoteDurableCheckpointSchema(
    meta: Parameters<SessionStore["open"]>[0],
  ): void {
    const items = this.store.readAll();
    const sessionMeta = items.find((item) => item.type === "session_meta");
    if (
      sessionMeta?.type === "session_meta" &&
      sessionMeta.payload.rolloutSchemaVersion > DURABLE_ROLLOUT_SCHEMA_V2
    ) {
      return;
    }
    const projectionContext = this.checkpointProjectionContext("upgrade");
    const outcome = planLegacyDurableCheckpointUpgrade({
      items,
      runId: meta.sessionId,
      ...projectionContext,
    });
    if (outcome.status !== "planned") {
      throw new DurableCheckpointUpgradeBlockedError(
        meta.sessionId,
        outcome.failure,
      );
    }
    const { plan } = outcome;
    if (!plan.changed && !plan.sessionMetaPromotionRequired) return;
    this.assertUpgradeableToolPairSequence(
      meta.sessionId,
      responseItemsForToolPairValidation(plan.upgradedItems),
      "canonical-response-stream",
      true,
    );
    for (let itemIndex = 0; itemIndex < plan.upgradedItems.length; itemIndex += 1) {
      const item = plan.upgradedItems[itemIndex];
      if (
        item?.type !== "compacted" ||
        item.payload.replacementHistory === undefined
      ) {
        continue;
      }
      this.assertUpgradeableToolPairSequence(
        meta.sessionId,
        item.payload.replacementHistory,
        `replacement-history:${itemIndex}`,
        false,
      );
    }
    const upgradedItems = plan.sessionMetaPromotionRequired
      ? [
          {
            type: "session_meta" as const,
            payload: {
              ...meta,
              rolloutSchemaVersion: DURABLE_ROLLOUT_SCHEMA_V2,
            },
          },
          ...plan.upgradedItems,
        ]
      : plan.upgradedItems;
    this.beforeCheckpointUpgradePublishForTestingOnly?.();
    this.store.rewriteRolloutItemsAtomically(upgradedItems);
  }

  private assertUpgradeableToolPairSequence(
    runId: string,
    messages: Iterable<ToolPairMessage>,
    purpose: string,
    allowDanglingAtEnd: boolean,
  ): void {
    const context = this.checkpointProjectionContext(`upgrade-history:${purpose}`);
    const outcome = validateToolPairSequence(messages, context.projection, {
      projectionId: context.projectionId,
      sourceKey: context.sourceKey,
      requireResultIntegrity: true,
      expectedRunId: runId,
      allowDanglingAtEnd,
    });
    if (outcome.status === "invalid" || outcome.status === "deferred") {
      throw new DurableCheckpointUpgradeBlockedError(runId, outcome.failure);
    }
  }

  private rebuildLiveToolPairProjection(): void {
    const context = this.toolPairProjectionContext("live-append", false);
    let validator: StreamingToolPairValidator | undefined;
    context.projection.runAtomically(() => {
      validator = new StreamingToolPairValidator(context.projection, {
        projectionId: context.projectionId,
        sourceKey: context.sourceKey,
        requireResultIntegrity: true,
        expectedRunId: this.sessionId,
      });
      for (const item of this.store.readAll()) {
        if (item.type !== "response_item") continue;
        const outcome = validator.push(item.payload);
        if (outcome !== undefined) {
          throw new ToolPairHistoryBlockedError("live projection rebuild", outcome);
        }
      }
      const outcome = validator.finish({
        allowDanglingAtEnd: true,
        persistSuccess: false,
      });
      if (outcome.status === "invalid" || outcome.status === "deferred") {
        throw new ToolPairHistoryBlockedError("live projection rebuild", outcome);
      }
    });
    if (validator === undefined) {
      throw new Error("live tool-pair projection did not initialize");
    }
    this.liveToolPairProjection = context.projection;
    this.liveToolPairValidator = validator;
  }

  private validateLiveResponseItem(message: ToolPairMessage): void {
    const projection = this.liveToolPairProjection;
    const validator = this.liveToolPairValidator;
    if (projection === undefined || validator === undefined) {
      throw new Error("live tool-pair projection is unavailable");
    }
    const outcome = projection.runAtomically(() => validator.push(message));
    if (outcome !== undefined) {
      throw new ToolPairHistoryBlockedError("live append", outcome);
    }
  }

  private assertLiveToolPairBoundary(purpose: string): void {
    const projection = this.liveToolPairProjection;
    const validator = this.liveToolPairValidator;
    if (projection === undefined || validator === undefined) {
      throw new Error("live tool-pair projection is unavailable");
    }
    const outcome = projection.runAtomically(() =>
      validator.finish({ persistSuccess: false }),
    );
    if (outcome.status !== "valid") {
      throw new ToolPairHistoryBlockedError(purpose, outcome);
    }
  }

  /** M3 pre-dispatch gate backed by the same project state database. */
  assertToolAdmissionAllowed(recoveryCategory: ToolRecoveryCategory): void {
    const decision = checkUnknownOutcomeMutationGate(this.stateDriver, {
      sessionId: this.sessionId,
      recoveryCategory,
    });
    if (!decision.allowed) {
      throw new UnknownOutcomeMutationBlockedError(
        this.sessionId,
        decision.blocking,
      );
    }
  }

  /** Fail closed unless prior attempts prove an automatic re-dispatch safe. */
  assertToolEffectAttemptAllowed(options: {
    readonly callId: string;
    readonly recoveryCategory: ToolRecoveryCategory;
    readonly idempotencyKey?: string;
  }): number {
    return this.runDurabilityRepo.assertEffectAttemptAllowed({
      sessionId: this.sessionId,
      ...options,
      ...(options.recoveryCategory === "idempotent"
        ? {
            retrySafeDeferredStepIds: this.retrySafeDeferredEffectSteps,
          }
        : {}),
    });
  }

  get isDegraded(): boolean {
    return this.store.isDegraded;
  }

  /** I-88 — read the per-turn tool-result-bytes index. */
  getToolResultBytes(turnId: string): number {
    return this.store.getToolResultBytes(turnId);
  }

  /** I-88 — snapshot the full index (used by compaction). */
  getToolResultBytesIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getToolResultBytesIndexSnapshot();
  }

  getTokenEstimate(turnId: string): number {
    return this.store.getTokenEstimate(turnId);
  }

  getTokenEstimateIndexSnapshot(): ReadonlyMap<string, number> {
    return this.store.getTokenEstimateIndexSnapshot();
  }

  getToolCallTurnIdSnapshot(): ReadonlyMap<string, string> {
    return this.store.getToolCallTurnIdSnapshot();
  }

  getCompactionIndexSnapshot(): CompactionIndexSnapshot {
    return this.store.getCompactionIndexSnapshot();
  }

  createThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    const normalized = normalizeThreadSpawnEdge(edge);
    this.threadSpawnEdgeRepo.create(normalized);
  }

  /** @deprecated Spawn-edge identity is create-only; use createThreadSpawnEdge. */
  upsertThreadSpawnEdge(edge: ThreadSpawnEdgeRecord): void {
    this.createThreadSpawnEdge(edge);
  }

  setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): void {
    // Never decide from a constructor-time snapshot. Multiple daemon/session
    // handles can share this project database, so the repository performs the
    // authoritative monotonic transition (or idempotent acknowledgement).
    this.threadSpawnEdgeRepo.setStatus(childThreadId, status);
  }

  getThreadSpawnEdge(
    childThreadId: ThreadId,
  ): ThreadSpawnEdgeRecord | undefined {
    const edge = this.threadSpawnEdgeRepo.get(childThreadId);
    return edge ? cloneThreadSpawnEdge(edge) : undefined;
  }

  listThreadSpawnChildrenWithStatus(
    parentThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnChildrenMatching(parentThreadId, status);
  }

  listThreadSpawnChildren(
    parentThreadId: ThreadId,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnChildrenMatching(parentThreadId);
  }

  listThreadSpawnDescendants(
    rootThreadId: ThreadId,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnDescendantsMatching(rootThreadId);
  }

  listThreadSpawnDescendantsWithStatus(
    rootThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.listThreadSpawnDescendantsMatching(rootThreadId, status);
  }

  findThreadSpawnChildByPath(
    parentThreadId: ThreadId,
    agentPath: AgentPath,
  ): ThreadId | undefined {
    const matches = this.listThreadSpawnChildren(parentThreadId)
      .filter((edge) => edge.metadata.agentPath === agentPath)
      .map((edge) => edge.childThreadId)
      .sort();
    return oneThreadIdFromPathMatches(matches, agentPath);
  }

  findThreadSpawnDescendantByPath(
    rootThreadId: ThreadId,
    agentPath: AgentPath,
  ): ThreadId | undefined {
    const matches = this.listThreadSpawnDescendants(rootThreadId)
      .filter((edge) => edge.metadata.agentPath === agentPath)
      .map((edge) => edge.childThreadId)
      .sort();
    return oneThreadIdFromPathMatches(matches, agentPath);
  }

  private listThreadSpawnChildrenMatching(
    parentThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    return this.threadSpawnEdgeRepo
      .list()
      .filter((edge) => edge.parentThreadId === parentThreadId)
      .filter((edge) => status === undefined || edge.status === status)
      .sort(compareThreadSpawnEdges)
      .map((edge) => cloneThreadSpawnEdge(edge));
  }

  private listThreadSpawnDescendantsMatching(
    rootThreadId: ThreadId,
    status?: ThreadSpawnEdgeStatus,
  ): ReadonlyArray<ThreadSpawnEdgeRecord> {
    const childrenByParent = new Map<ThreadId, ThreadSpawnEdgeRecord[]>();
    for (const edge of this.threadSpawnEdgeRepo.list()) {
      if (status !== undefined && edge.status !== status) continue;
      const bucket = childrenByParent.get(edge.parentThreadId) ?? [];
      bucket.push(edge);
      childrenByParent.set(edge.parentThreadId, bucket);
    }
    for (const bucket of childrenByParent.values()) {
      bucket.sort(compareThreadSpawnEdges);
    }

    const descendants: ThreadSpawnEdgeRecord[] = [];
    const seen = new Set<ThreadId>([rootThreadId]);
    let level = [...(childrenByParent.get(rootThreadId) ?? [])];
    while (level.length > 0) {
      level.sort(compareThreadSpawnEdges);
      const nextLevel: ThreadSpawnEdgeRecord[] = [];
      for (const next of level) {
        if (seen.has(next.childThreadId)) continue;
        seen.add(next.childThreadId);
        descendants.push(cloneThreadSpawnEdge(next));
        nextLevel.push(...(childrenByParent.get(next.childThreadId) ?? []));
      }
      level = nextLevel;
    }
    return descendants;
  }

  /** Force an immediate flush (durable=true). */
  flushDurable(): void {
    if (!this.store.flushBatch(true)) {
      throw new Error("rollout flush was not fsync-committed");
    }
  }

  /** Fsync the existing canonical tail even when no batch is pending. */
  syncCanonicalTail(): void {
    this.store.syncCanonicalTail();
  }

  /** @internal Test seam for write-success/fsync-failure recovery. */
  setFsyncImplForTest(impl: (fd: number) => void): void {
    this.store.setFsyncImplForTest(impl);
  }

  close(): void {
    this.scheduler.stop();
    this.stateDriver.close();
    this.store.close();
  }

  private requireRunEpoch(runId: string) {
    const epoch = this.runDurabilityRepo.currentEpoch(runId);
    if (epoch !== undefined) return epoch;
    if (runId !== this.sessionId || this.openedAt === undefined) {
      throw new Error(`run ${runId} has no durable lifecycle epoch`);
    }
    return this.runDurabilityRepo.ensureInitialEpoch({
      runId,
      openedAt: this.openedAt,
    }).value;
  }

  private assertJournalSourceWritable(): void {
    const binding = this.runDurabilityRepo.getJournalBinding(this.rolloutPath);
    if (binding !== undefined && !binding.active) {
      throw new Error(
        `refusing to reopen inactive canonical journal source ${this.rolloutPath}`,
      );
    }
  }

  private currentEpochIsTerminal(runId: string, epoch: number): boolean {
    if (this.runDurabilityRepo.getTerminalResult(runId, epoch) !== undefined) {
      return true;
    }
    if (rolloutItemsContainTerminal(this.store.readAll(), runId, epoch)) {
      return true;
    }

    const projectDir = getProjectDir(this.store.cwd, this.projectRootMarkers);
    for (const binding of this.runDurabilityRepo.listJournalBindings(
      runId,
      epoch,
    )) {
      if (binding.sourcePath === this.rolloutPath) continue;
      const terminal = withPinnedOfflineRolloutLease(
        {
          projectDir,
          sessionId: binding.sessionId,
          sourcePath: binding.sourcePath,
        },
        (rollout) =>
          rolloutContentContainsTerminal(rollout.readUtf8(), runId, epoch),
      );
      if (terminal) return true;
    }
    return false;
  }

  private recoverEffectProjectionOnOpen(): void {
    this.retrySafeDeferredEffectSteps.clear();
    const events = this.store
      .readAll()
      .filter(
        (item): item is Extract<RolloutItem, { readonly type: "event_msg" }> =>
          item.type === "event_msg",
      )
      .map((item) => item.payload)
      .filter(isSequencedEvent)
      .sort((left, right) => left.seq - right.seq);
    const effectEvents = events.filter(isEffectLifecycleEvent);
    for (const event of effectEvents) this.recordEffectEvent(event);

    // Artifact and effect recovery share one canonical sequence cursor. Each
    // recovery append must advance from the tail written by the previous
    // recovery family; otherwise SessionStore can reject the duplicate
    // sequence while SQLite still projects it, splitting the authorities.
    let nextSequence = this.recoverArtifactJournalOnOpen(events);

    const settledSteps = new Set(
      effectEvents
        .filter((event) => event.msg.type !== "effect_intent")
        .map((event) => event.msg.payload.stepId),
    );
    const existingEventIds = new Set(events.map(canonicalRolloutEventId));
    const existingEffectRecoveryEvidence = new Set(
      events.flatMap((event) => {
        if (
          event.msg.type !== "recovery_decision" ||
          typeof event.msg.payload.stepId !== "string" ||
          typeof event.msg.payload.evidenceEventId !== "string" ||
          !Number.isSafeInteger(event.msg.payload.evidenceEventSeq) ||
          event.msg.payload.evidenceEventSeq <= 0
        ) {
          return [];
        }
        return [
          recoveryEvidenceKey(
            event.msg.payload.evidenceEventId,
            event.msg.payload.evidenceEventSeq,
          ),
        ];
      }),
    );
    for (const intent of effectEvents) {
      if (intent.msg.type !== "effect_intent") continue;
      const payload = intent.msg.payload;
      if (settledSteps.has(payload.stepId)) continue;
      const admissionStatus = this.effectAdmissionStatus(
        payload.runId,
        payload.stepId,
      );
      const cancelledBeforeDispatch =
        admissionStatus === "reserved" || admissionStatus === "voided";
      const intentEventId = canonicalRolloutEventId(intent);
      if (
        payload.recoveryCategory === "idempotent" &&
        existingEffectRecoveryEvidence.has(
          recoveryEvidenceKey(intentEventId, intent.seq),
        )
      ) {
        this.retrySafeDeferredEffectSteps.add(payload.stepId);
        continue;
      }
      const preferredEventId =
        payload.recoveryCategory === "idempotent"
          ? `recovery-decision:${intentEventId}`
          : cancelledBeforeDispatch
            ? `effect-cancelled-recovery:${intentEventId}`
            : `effect-unknown-recovery:${intentEventId}`;
      const eventId = uniqueRecoveryEventId(preferredEventId, existingEventIds);
      nextSequence += 1;
      const recordedAt = new Date().toISOString();
      const recovery: Event =
        payload.recoveryCategory === "idempotent"
          ? {
              eventId,
              id: eventId,
              seq: nextSequence,
              msg: {
                type: "recovery_decision",
                payload: {
                  runId: payload.runId,
                  stepId: payload.stepId,
                  decision: "retry_safe_deferred",
                  reason:
                    "durable idempotency key proves retry safety; automatic replay is deferred to an explicit caller",
                  evidenceEventId: intentEventId,
                  evidenceEventSeq: intent.seq,
                  recordedAt,
                },
              },
            }
          : cancelledBeforeDispatch
            ? {
                eventId,
                id: eventId,
                seq: nextSequence,
                msg: {
                  type: "effect_result",
                  payload: {
                    formatVersion: EFFECT_EVIDENCE_FORMAT_VERSION,
                    minimumReaderRuntime:
                      EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
                    runId: payload.runId,
                    stepId: payload.stepId,
                    callId: payload.callId,
                    toolName: payload.toolName,
                    recoveryCategory: payload.recoveryCategory,
                    intentEventSeq: intent.seq,
                    outcome: "cancelled",
                    effectBoundary: "not_crossed",
                    noEffectEvidence: recoveryNoEffectProof({
                      runId: payload.runId,
                      stepId: payload.stepId,
                      recordedAt,
                      admissionStatus,
                    }),
                    evidence: {
                      reason: "daemon_recovered_before_effect_dispatch",
                      admissionStatus,
                    },
                    recordedAt,
                  },
                },
              }
            : {
                eventId,
                id: eventId,
                seq: nextSequence,
                msg: {
                  type: "effect_unknown_outcome",
                  payload: {
                    formatVersion: EFFECT_EVIDENCE_FORMAT_VERSION,
                    minimumReaderRuntime:
                      EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
                    runId: payload.runId,
                    stepId: payload.stepId,
                    callId: payload.callId,
                    toolName: payload.toolName,
                    recoveryCategory: payload.recoveryCategory,
                    intentEventSeq: intent.seq,
                    outcome: "unknown_outcome",
                    reason: "daemon_recovered_without_effect_acknowledgement",
                    requiresReview: true,
                    recordedAt,
                  },
                },
              };
      if (!this.store.append(recovery, { durable: true })) {
        throw new Error(`failed to commit recovery event ${eventId}`);
      }
      existingEventIds.add(eventId);
      if (recovery.msg.type === "recovery_decision") {
        this.retrySafeDeferredEffectSteps.add(payload.stepId);
      }
      if (
        recovery.msg.type === "effect_unknown_outcome" ||
        recovery.msg.type === "effect_result"
      ) {
        this.recordEffectEvent(recovery);
        settledSteps.add(payload.stepId);
      }
    }
  }

  private effectAdmissionStatus(
    runId: string,
    stepId: string,
  ): string | undefined {
    return this.stateDriver
      .prepareState<[string, string], { readonly status: string }>(
        `SELECT status
         FROM execution_admission_reservations
         WHERE run_id = ? AND step_id = ?
         ORDER BY attempt DESC
         LIMIT 1`,
      )
      .get(runId, stepId)?.status;
  }

  private recoverArtifactJournalOnOpen(
    events: readonly SequencedEvent[],
  ): number {
    const committedIntentSequences = new Set(
      events
        .filter(
          (event): event is ArtifactCommittedLifecycleEvent =>
            event.msg.type === "artifact_committed",
        )
        .map((event) => event.msg.payload.intentEventSeq),
    );
    const existingRecoveryEvidence = new Set(
      events
        .filter(
          (event): event is RecoveryDecisionLifecycleEvent =>
            event.msg.type === "recovery_decision",
        )
        .map((event) => event.msg.payload.evidenceEventSeq),
    );
    const existingEventIds = new Set(
      events.flatMap((event) => [canonicalRolloutEventId(event), event.id]),
    );
    let nextSequence = events.at(-1)?.seq ?? 0;

    for (const intent of events) {
      if (intent.msg.type !== "artifact_intent") continue;
      const payload = intent.msg.payload;
      const artifactRoot = trustedArtifactRoot(payload.targetPath, [
        resolve(this.store.sessionDir, "tool-results"),
        resolve(
          getAgenCConfigHomeDir(),
          "projects",
          sanitizePath(this.store.cwd),
          this.sessionId,
          "tool-results",
        ),
      ]);
      const consumeObservation = (
        observation: AtomicArtifactObservation,
      ): void => {
        if (
          committedIntentSequences.has(intent.seq) ||
          (existingRecoveryEvidence.has(intent.seq) && observation !== "match")
        ) {
          return;
        }
        nextSequence += 1;
        const recordedAt = new Date().toISOString();
        const recoveryEventId = uniqueRecoveryEventId(
          observation === "match"
            ? `artifact-committed-recovery:${intent.id}`
            : `artifact-recovery-decision:${intent.id}`,
          existingEventIds,
        );
        const recovery: Event =
          observation === "match"
            ? {
                eventId: recoveryEventId,
                id: recoveryEventId,
                seq: nextSequence,
                msg: {
                  type: "artifact_committed",
                  payload: {
                    ...payload,
                    intentEventSeq: intent.seq,
                    outcome: "recovered",
                    committedAt: recordedAt,
                  },
                },
              }
            : {
                eventId: recoveryEventId,
                id: recoveryEventId,
                seq: nextSequence,
                msg: {
                  type: "recovery_decision",
                  payload: {
                    runId: payload.runId,
                    decision:
                      observation === "missing"
                        ? "artifact_retry_safe_deferred"
                        : "artifact_conflict_review_required",
                    reason:
                      observation === "missing"
                        ? "artifact target was not published; immutable retry is safe but deferred to an explicit caller"
                        : "artifact target contains bytes that do not match the durable intent; automatic overwrite is forbidden",
                    evidenceEventId: canonicalRolloutEventId(intent),
                    evidenceEventSeq: intent.seq,
                    recordedAt,
                  },
                },
              };
        if (!this.store.append(recovery, { durable: true })) {
          throw new Error(
            `failed to commit artifact recovery event ${recovery.id}`,
          );
        }
        existingEventIds.add(recoveryEventId);
      };

      if (artifactRoot === undefined) {
        consumeObservation("conflict");
        continue;
      }
      try {
        withAtomicArtifactObservationSync(
          payload.targetPath,
          payload.contentSha256,
          payload.byteLength,
          {
            trustedRoot: artifactRoot,
            // The resumed session owns the journal lease. A stranded private
            // temp is swept through the same pinned root used for proof; it is
            // never promoted and cannot redirect cleanup outside this run.
            cleanupOrphanedTemps: true,
          },
          consumeObservation,
        );
      } catch (error) {
        if (!(error instanceof AtomicArtifactOperationUnsupportedError)) {
          throw error;
        }
        // Without descriptor-relative child operations there is no safe proof
        // of a match. Continue conservatively as a review-required conflict;
        // never acknowledge bytes observed only through a racy pathname.
        consumeObservation("conflict");
      }
    }
    return nextSequence;
  }

  private loadThreadSpawnEdges(): void {
    const persistedChildIds = new Set(
      this.threadSpawnEdgeRepo.list().map((edge) => edge.childThreadId),
    );

    for (const edge of this.readLegacyThreadSpawnEdges()) {
      if (persistedChildIds.has(edge.childThreadId)) continue;
      try {
        // Historical topology, not a new admission — bypass the gate.
        this.threadSpawnEdgeRepo.create(edge, { admissionGate: "import" });
        persistedChildIds.add(edge.childThreadId);
      } catch (error) {
        // Another process can win the create between list() and legacy import.
        // Accept only its durable row; never rewrite it from the legacy file.
        if (!(error instanceof AgentIdExistsError)) throw error;
        const persisted = this.threadSpawnEdgeRepo.get(edge.childThreadId);
        if (!persisted) throw error;
        persistedChildIds.add(persisted.childThreadId);
      }
    }
  }

  private readLegacyThreadSpawnEdges(): ReadonlyArray<ThreadSpawnEdgeRecord> {
    if (!existsSync(this.threadSpawnEdgePath)) {
      return [];
    }

    try {
      const raw = readFileSync(this.threadSpawnEdgePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeThreadSpawnEdgesSnapshot(parsed);
    } catch {
      this.copyCorruptLegacyThreadSpawnEdges();
      return [];
    }
  }

  private copyCorruptLegacyThreadSpawnEdges(): void {
    const raw = readFileSync(this.threadSpawnEdgePath);
    const hash = createHash("sha256").update(raw).digest("hex");
    const corruptDir = join(this.stateDriver.projectDir, "state-corrupt");
    const target = join(corruptDir, `thread-spawn-edges-${hash}.json`);
    if (existsSync(target)) return;
    mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
    copyFileSync(this.threadSpawnEdgePath, target);
  }
}

type SequencedEvent = Event & { readonly seq: number };
type EffectLifecycleEvent = SequencedEvent & {
  readonly msg: Extract<
    EventMsg,
    {
      readonly type:
        | "effect_intent"
        | "effect_result"
        | "effect_unknown_outcome"
        | "effect_review_resolved";
    }
  >;
};
type ArtifactCommittedLifecycleEvent = SequencedEvent & {
  readonly msg: Extract<EventMsg, { readonly type: "artifact_committed" }>;
};
type RecoveryDecisionLifecycleEvent = SequencedEvent & {
  readonly msg: Extract<EventMsg, { readonly type: "recovery_decision" }>;
};

function isSequencedEvent(event: Event): event is SequencedEvent {
  return (
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
  );
}

function canonicalRolloutEventId(event: SequencedEvent | Event): string {
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
  throw new Error(
    "canonical rollout event identity requires eventId or sequence",
  );
}

function isEffectLifecycleEvent(
  event: SequencedEvent,
): event is EffectLifecycleEvent {
  return (
    event.msg.type === "effect_intent" ||
    event.msg.type === "effect_result" ||
    event.msg.type === "effect_unknown_outcome" ||
    event.msg.type === "effect_review_resolved"
  );
}

function trustedArtifactRoot(
  targetPath: string,
  allowedArtifactRoots: readonly string[],
): string | undefined {
  const targetDirectory = dirname(resolve(targetPath));
  return allowedArtifactRoots.find(
    (artifactRoot) => relative(resolve(artifactRoot), targetDirectory) === "",
  );
}

function uniqueRecoveryEventId(
  base: string,
  existing: ReadonlySet<string>,
): string {
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

function recoveryEvidenceKey(eventId: string, sequence: number): string {
  return `${sequence}\0${eventId}`;
}

function compactionErrorDetail(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}:${reason.message}`;
  }
  return typeof reason === "string" ? reason : "unknown compaction error";
}

function runtimeMessageFromResponseItem(item: ResponseItem): RuntimeMessage {
  const message = responseItemToLlmMessage(item);
  return {
    role: message.role === "developer" ? "user" : message.role,
    ...(message.role === "developer" ? { originalRole: "developer" as const } : {}),
    content: message.content,
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    ...(item.id !== undefined ? { uuid: item.id } : {}),
    ...(message.runtimeOnly !== undefined
      ? { runtimeOnly: message.runtimeOnly }
      : {}),
  };
}

function recoveryNoEffectProof(options: {
  readonly runId: string;
  readonly stepId: string;
  readonly recordedAt: string;
  readonly admissionStatus: string | undefined;
}): EffectNoEffectProof {
  const evidenceRef = `admission-recovery:not-dispatched:${options.runId}:${options.stepId}`;
  return {
    version: 1,
    kind: "effect_no_effect_proof",
    evidenceKind: "boundary_not_crossed",
    evidenceRef,
    evidenceSha256: createHash("sha256")
      .update(
        JSON.stringify({
          evidenceRef,
          admissionStatus: options.admissionStatus ?? null,
          recordedAt: options.recordedAt,
        }),
        "utf8",
      )
      .digest("hex"),
    observedAt: options.recordedAt,
  };
}

function normalizeThreadSpawnEdgesSnapshot(
  parsed: unknown,
): ReadonlyArray<ThreadSpawnEdgeRecord> {
  if (Array.isArray(parsed)) {
    return parsed.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (!isRecord(parsed)) {
    throw new Error("invalid thread-spawn edge snapshot");
  }

  if ("version" in parsed || "edges" in parsed) {
    if (
      parsed.version !== THREAD_SPAWN_EDGE_SNAPSHOT_VERSION ||
      !Array.isArray(parsed.edges)
    ) {
      throw new Error("invalid thread-spawn edge snapshot");
    }
    return parsed.edges.map((edge) => normalizeThreadSpawnEdge(edge));
  }

  if (Array.isArray(parsed.threadSpawnEdges)) {
    return parsed.threadSpawnEdges.map((edge) =>
      normalizeThreadSpawnEdge(edge),
    );
  }

  if (isRecord(parsed.threadSpawnEdges)) {
    return Object.entries(parsed.threadSpawnEdges).map(
      ([childThreadId, edge]) => normalizeThreadSpawnEdge(edge, childThreadId),
    );
  }

  const entries = Object.entries(parsed);
  if (entries.length > 0 && entries.every(([, edge]) => isRecord(edge))) {
    return entries.map(([childThreadId, edge]) =>
      normalizeThreadSpawnEdge(edge, childThreadId),
    );
  }

  throw new Error("invalid thread-spawn edge snapshot");
}

function oneThreadIdFromPathMatches(
  matches: readonly ThreadId[],
  agentPath: AgentPath,
): ThreadId | undefined {
  if (matches.length > 1) {
    throw new Error(
      `multiple spawned threads matched agent path ${agentPath}: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

function compareThreadSpawnEdges(
  left: ThreadSpawnEdgeRecord,
  right: ThreadSpawnEdgeRecord,
): number {
  return left.childThreadId.localeCompare(right.childThreadId);
}

function cloneThreadSpawnEdge(
  edge: ThreadSpawnEdgeRecord,
): ThreadSpawnEdgeRecord {
  return {
    ...edge,
    metadata: cloneAgentMetadata(edge.metadata),
  };
}

function cloneAgentMetadata(metadata: AgentMetadata): AgentMetadata {
  return normalizeAgentMetadata(metadata);
}

function normalizeThreadSpawnEdge(
  edge: unknown,
  fallbackChildThreadId?: string,
): ThreadSpawnEdgeRecord {
  if (!isRecord(edge)) {
    throw new Error("invalid thread-spawn edge record");
  }

  const childThreadId =
    typeof edge.childThreadId === "string"
      ? edge.childThreadId
      : fallbackChildThreadId;
  const status = edge.status === undefined ? "open" : edge.status;

  const metadata = normalizeAgentMetadata(edge.metadata);
  if (
    typeof childThreadId !== "string" ||
    typeof edge.parentThreadId !== "string" ||
    typeof edge.parentPath !== "string" ||
    (status !== "open" && status !== "closed") ||
    metadata.agentId !== childThreadId
  ) {
    throw new InvalidAgentMetadataError(
      "invalid thread-spawn edge record or child identity",
    );
  }

  return {
    childThreadId,
    parentThreadId: edge.parentThreadId,
    parentPath: edge.parentPath,
    metadata,
    status,
  };
}
