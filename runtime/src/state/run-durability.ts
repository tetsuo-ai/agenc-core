import type {
  EffectBoundary,
  EffectNoEffectProof,
  EffectOutcome,
  EffectReviewResolution,
  EffectReviewWorkflowStatus,
  RunId,
  RunResumedBoundary,
  RunRuntimeSettingsBoundary,
  RunRuntimeSettingsSnapshot,
  RunStartupActivatedBoundary,
  RunSuspendedBoundary,
  RunTerminalResult,
  RunUsageTotals,
} from "../contracts/run-contracts.js";
import {
  EFFECT_EVIDENCE_FORMAT_VERSION,
  EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME,
  EFFECT_REVIEW_ACTOR_KINDS,
  EFFECT_REVIEW_DISPOSITIONS,
  EFFECT_REVIEW_DOMAIN_ACTIONS,
  EFFECT_REVIEW_EVIDENCE_KINDS,
  EFFECT_REVIEW_WORKFLOW_STATUSES,
} from "../contracts/run-contracts.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { redactSecretsInValue } from "../secrets/sanitizer.js";
import { stableStringify } from "../utils/stableStringify.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { updateAgentRunStatus } from "./agent-runs.js";
import { assertRecoverySha256 } from "./recovery-contract.js";
import type { CanonicalJournalFormat } from "./recovery-journal-contract.js";
import { isCancelLockedAgentRunStatus } from "./run-cancellation.js";

export type RunDurabilityConflictCode =
  | "RUN_EPOCH_CONFLICT"
  | "RUN_EPOCH_NOT_TERMINAL"
  | "RUN_SUSPENSION_CONFLICT"
  | "RUN_SUSPENSION_EFFECT_PENDING"
  | "RUN_CANCELLATION_CONFLICT"
  | "RUN_STARTUP_ACTIVATION_CONFLICT"
  | "RUN_RUNTIME_SETTINGS_CONFLICT"
  | "RUN_REOPEN_REVIEW_REQUIRED"
  | "RUN_TERMINAL_RESULT_CONFLICT"
  | "RUN_EFFECT_INTENT_CONFLICT"
  | "RUN_EFFECT_OUTCOME_CONFLICT"
  | "RUN_EFFECT_NOT_FOUND"
  | "RUN_EFFECT_REVIEW_CONFLICT"
  | "RUN_EFFECT_REVIEW_REQUIRED"
  | "RUN_EVENT_SEQUENCE_CONFLICT"
  | "RUN_JOURNAL_BINDING_CONFLICT";

const EFFECT_REVIEW_ACTOR_ID_MAX_UTF8_BYTES = 512;
const EFFECT_REVIEW_EVIDENCE_REF_MAX_UTF8_BYTES = 4_096;
const EFFECT_REVIEW_REVIEWED_AT_MAX_UTF8_BYTES = 128;
const EFFECT_REVIEW_PAYLOAD_MAX_UTF8_BYTES = 4_096;
const EFFECT_REVIEW_REQUIRED_KEYS = [
  "version",
  "kind",
  "disposition",
  "actorKind",
  "actorId",
  "evidenceKind",
  "evidenceRef",
  "evidenceSha256",
  "reviewedAt",
  "workflowStatus",
] as const;
const EFFECT_REVIEW_ALLOWED_KEYS = new Set<PropertyKey>([
  ...EFFECT_REVIEW_REQUIRED_KEYS,
  "domainAction",
]);
const CANONICAL_EFFECT_REVIEW_RESOLUTIONS = new WeakSet<object>();

export class RunDurabilityConflictError extends Error {
  constructor(
    readonly code: RunDurabilityConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "RunDurabilityConflictError";
  }
}

export interface DurableWriteOutcome<T> {
  readonly applied: boolean;
  readonly value: T;
}

export interface RunLifecycleEpoch {
  readonly runId: RunId;
  readonly epoch: number;
  readonly openedAt: string;
  readonly openedEventId?: string;
  readonly reopenedFromEpoch?: number;
  readonly reopenReason?: string;
}

export interface DurableRunTerminalRecord extends RunTerminalResult {
  readonly epoch: number;
  readonly eventId: string;
}

export interface DurableRunSuspension extends RunSuspendedBoundary {
  readonly suspensionSequence: number;
  readonly resumeEventId?: string;
  readonly resumeSequence?: number;
  readonly resumeReason?: RunResumedBoundary["reason"];
  readonly resumedAt?: string;
  readonly activationEventId?: string;
  readonly activationSequence?: number;
  readonly activatedAt?: string;
}

export interface DurableRunRuntimeSettings extends RunRuntimeSettingsSnapshot {
  readonly runId: RunId;
  readonly epoch: number;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly previousSettingsEventId: string | null;
  readonly rollbackOfSettingsEventId: string | null;
  readonly reason: RunRuntimeSettingsBoundary["reason"];
  readonly changedAt: string;
}

export type EffectReviewStatus = "none" | EffectReviewWorkflowStatus;

export interface DurableRunEffect {
  readonly runId: RunId;
  readonly stepId: string;
  readonly epoch: number;
  readonly childRunId?: RunId;
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly idempotencyKey?: string;
  readonly intentDigest: string;
  readonly intentEventId: string;
  readonly intentSequence: number;
  readonly intentAt: string;
  readonly effectFormatVersion: 1 | 2;
  readonly minimumReaderRuntime?: string;
  readonly outcome?: EffectOutcome;
  readonly effectBoundary?: EffectBoundary;
  readonly noEffectEvidence?: EffectNoEffectProof;
  readonly resultEventId?: string;
  readonly resultSequence?: number;
  readonly resultDigest?: string;
  readonly result?: unknown;
  readonly evidence?: unknown;
  readonly unknownReason?: string;
  readonly completedAt?: string;
  readonly reviewStatus: EffectReviewStatus;
  readonly reviewedAt?: string;
  readonly reviewedBy?: string;
  readonly reviewResolution?: string;
  readonly reviewEventId?: string;
  readonly reviewEvidence?: unknown;
  readonly review?: EffectReviewResolution;
  readonly legacyReview?: unknown;
}

export type RunJournalGapReason =
  "retention" | "corruption_truncated" | "compaction";

export interface RunJournalBinding {
  readonly runId: RunId;
  readonly epoch: number;
  readonly childRunId: RunId;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly active: boolean;
  readonly firstAvailableSequence?: number;
  readonly lastSequence?: number;
  readonly retiredThroughSequence?: number;
  readonly gapReason?: RunJournalGapReason;
  readonly gapObservedAt?: string;
  readonly authoritativeSourceSha256?: string;
  readonly authoritativeSourceSizeBytes?: number;
  readonly authoritativeSourceMtimeMs?: number;
  readonly journalFormat?: Exclude<CanonicalJournalFormat, "empty">;
  readonly minimumReaderRuntime?: string;
  readonly boundAt: string;
  readonly updatedAt: string;
}

interface EpochRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly opened_at: string;
  readonly opened_event_id: string | null;
  readonly reopened_from_epoch: number | null;
  readonly reopen_reason: string | null;
}

interface TerminalRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly status: RunTerminalResult["status"];
  readonly exit_code: number | null;
  readonly stop_reason: string | null;
  readonly final_message: string | null;
  readonly usage_json: string | null;
  readonly last_sequence: number | null;
  readonly finished_at: string;
  readonly event_id: string;
}

interface SuspensionRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly suspension_event_id: string;
  readonly suspension_sequence: number;
  readonly reason: RunSuspendedBoundary["reason"];
  readonly suspended_at: string;
  readonly resume_event_id: string | null;
  readonly resume_sequence: number | null;
  readonly resume_reason: RunResumedBoundary["reason"] | null;
  readonly resumed_at: string | null;
  readonly activation_event_id: string | null;
  readonly activation_sequence: number | null;
  readonly activated_at: string | null;
}

interface RuntimeSettingsRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly settings_event_id: string;
  readonly settings_sequence: number;
  readonly previous_settings_event_id: string | null;
  readonly rollback_of_settings_event_id: string | null;
  readonly reason: RunRuntimeSettingsBoundary["reason"];
  readonly changed_at: string;
  readonly permission_mode: RunRuntimeSettingsSnapshot["permissionMode"];
  readonly pre_plan_mode: RunRuntimeSettingsSnapshot["prePlanMode"];
  readonly auto_mode_active: number;
  readonly bypass_permissions_workspace: string | null;
  readonly model: string;
  readonly provider: string;
  readonly profile: string | null;
  readonly reasoning_effort: RunRuntimeSettingsSnapshot["reasoningEffort"];
  readonly model_verbosity: RunRuntimeSettingsSnapshot["modelVerbosity"];
  readonly service_tier: RunRuntimeSettingsSnapshot["serviceTier"];
  readonly hooks_disabled: number;
}

interface EffectRow {
  readonly run_id: string;
  readonly step_id: string;
  readonly epoch: number;
  readonly child_run_id: string | null;
  readonly session_id: string;
  readonly call_id: string;
  readonly tool_name: string;
  readonly recovery_category: ToolRecoveryCategory;
  readonly idempotency_key: string | null;
  readonly intent_digest: string;
  readonly intent_event_id: string;
  readonly intent_sequence: number;
  readonly intent_at: string;
  readonly effect_format_version: 1 | 2;
  readonly minimum_reader_runtime: string | null;
  readonly outcome: EffectOutcome | null;
  readonly effect_boundary: EffectBoundary | null;
  readonly no_effect_evidence_json: string | null;
  readonly result_event_id: string | null;
  readonly result_sequence: number | null;
  readonly result_digest: string | null;
  readonly result_json: string | null;
  readonly evidence_json: string | null;
  readonly unknown_reason: string | null;
  readonly completed_at: string | null;
  readonly review_status: Exclude<EffectReviewStatus, "none"> | null;
  readonly reviewed_at: string | null;
  readonly reviewed_by: string | null;
  readonly review_resolution: string | null;
  readonly review_event_id: string | null;
  readonly review_evidence_json: string | null;
  readonly review_resolution_version: number | null;
  readonly review_disposition: EffectReviewResolution["disposition"] | null;
  readonly review_actor_kind: EffectReviewResolution["actorKind"] | null;
  readonly review_actor_id: string | null;
  readonly review_evidence_kind: EffectReviewResolution["evidenceKind"] | null;
  readonly review_evidence_ref: string | null;
  readonly review_evidence_sha256: string | null;
  readonly review_domain_action: EffectReviewResolution["domainAction"] | null;
  readonly legacy_review_json: string | null;
}

interface JournalBindingRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly child_run_id: string;
  readonly session_id: string;
  readonly source_path: string;
  readonly active: number;
  readonly first_available_sequence: number | null;
  readonly last_sequence: number | null;
  readonly retired_through_sequence: number | null;
  readonly gap_reason: RunJournalGapReason | null;
  readonly gap_observed_at: string | null;
  readonly authoritative_source_sha256: string | null;
  readonly authoritative_source_size_bytes: number | null;
  readonly authoritative_source_mtime_ms: number | null;
  readonly journal_format: Exclude<CanonicalJournalFormat, "empty"> | null;
  readonly minimum_reader_runtime: string | null;
  readonly bound_at: string;
  readonly updated_at: string;
}

const EFFECT_COLUMNS = `
  run_id, step_id, epoch, child_run_id, session_id, call_id, tool_name,
  recovery_category, idempotency_key, intent_digest, intent_event_id,
  intent_sequence, intent_at, effect_format_version, minimum_reader_runtime,
  outcome, effect_boundary, no_effect_evidence_json, result_event_id,
  result_sequence, result_digest, result_json, evidence_json, unknown_reason, completed_at,
  review_status, reviewed_at, reviewed_by, review_resolution, review_event_id,
  review_evidence_json, review_resolution_version, review_disposition,
  review_actor_kind, review_actor_id, review_evidence_kind, review_evidence_ref,
  review_evidence_sha256, review_domain_action, legacy_review_json`;

const JOURNAL_BINDING_COLUMNS = `
  run_id, epoch, child_run_id, session_id, source_path, active,
  first_available_sequence, last_sequence, retired_through_sequence,
  gap_reason, gap_observed_at, authoritative_source_sha256,
  authoritative_source_size_bytes, authoritative_source_mtime_ms,
  journal_format, minimum_reader_runtime, bound_at, updated_at`;

const SUSPENSION_COLUMNS = `
  run_id, epoch, suspension_event_id, suspension_sequence, reason,
  suspended_at, resume_event_id, resume_sequence, resume_reason, resumed_at,
  activation_event_id, activation_sequence, activated_at`;

const RUNTIME_SETTINGS_COLUMNS = `
  run_id, epoch, settings_event_id, settings_sequence,
  previous_settings_event_id, rollback_of_settings_event_id, reason,
  changed_at, permission_mode, pre_plan_mode, auto_mode_active,
  bypass_permissions_workspace, model, provider, profile, reasoning_effort,
  model_verbosity, service_tier, hooks_disabled`;

/**
 * Durable run lifecycle/effect state plus bindings into the canonical rollout
 * JSONL projection. Event payload bytes belong only to the rollout store.
 */
export class StateRunDurabilityRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  ensureInitialEpoch(params: {
    readonly runId: RunId;
    readonly openedAt: string;
    readonly openedEventId?: string;
  }): DurableWriteOutcome<RunLifecycleEpoch> {
    return this.driver.transactionImmediate(() => {
      const existingRow = this.driver
        .prepareState<[string], EpochRow>(
          `SELECT run_id, epoch, opened_at, opened_event_id,
                  reopened_from_epoch, reopen_reason
           FROM run_lifecycle_epochs
           WHERE run_id = ? AND epoch = 1`,
        )
        .get(params.runId);
      const existing =
        existingRow === undefined ? undefined : epochFromRow(existingRow);
      if (existing !== undefined) {
        if (
          existing.epoch === 1 &&
          (params.openedEventId === undefined ||
            existing.openedEventId === params.openedEventId)
        ) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} initial lifecycle event conflicts with its durable epoch`,
        );
      }
      this.driver
        .prepareState<[string, number, string, string | null]>(
          `INSERT INTO run_lifecycle_epochs (
             run_id, epoch, opened_at, opened_event_id
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          1,
          required(params.openedAt, "openedAt"),
          optionalRequired(params.openedEventId, "openedEventId"),
        );
      return {
        applied: true,
        value: {
          runId: params.runId,
          epoch: 1,
          openedAt: params.openedAt,
          ...(params.openedEventId !== undefined
            ? { openedEventId: params.openedEventId }
            : {}),
        },
      };
    });
  }

  currentEpoch(runId: RunId): RunLifecycleEpoch | undefined {
    const row = this.driver
      .prepareState<[string], EpochRow>(
        `SELECT run_id, epoch, opened_at, opened_event_id,
                reopened_from_epoch, reopen_reason
         FROM run_lifecycle_epochs
         WHERE run_id = ?
         ORDER BY epoch DESC
         LIMIT 1`,
      )
      .get(runId);
    return row === undefined ? undefined : epochFromRow(row);
  }

  /** Read one canonical lifecycle epoch for ordered journal reconciliation. */
  getEpoch(runId: RunId, epoch: number): RunLifecycleEpoch | undefined {
    const row = this.driver
      .prepareState<[string, number], EpochRow>(
        `SELECT run_id, epoch, opened_at, opened_event_id,
                reopened_from_epoch, reopen_reason
         FROM run_lifecycle_epochs
         WHERE run_id = ? AND epoch = ?`,
      )
      .get(runId, epoch);
    return row === undefined ? undefined : epochFromRow(row);
  }

  recordRunSuspended(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly reason: RunSuspendedBoundary["reason"];
    readonly suspendedAt: string;
  }): DurableWriteOutcome<DurableRunSuspension> {
    return this.driver.transactionImmediate(() => {
      const replayed = this.driver
        .prepareState<[string, string], SuspensionRow>(
          `SELECT ${SUSPENSION_COLUMNS}
           FROM run_suspensions
           WHERE run_id = ? AND suspension_event_id = ?`,
        )
        .get(params.runId, params.eventId);
      if (replayed !== undefined) {
        const value = suspensionFromRow(replayed);
        if (
          value.epoch === params.epoch &&
          value.suspensionSequence === params.eventSequence &&
          value.reason === params.reason &&
          value.suspendedAt === params.suspendedAt
        ) {
          return { applied: false, value };
        }
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `suspension event ${params.eventId} conflicts with its durable projection`,
        );
      }
      const current = this.requireEpoch(params.runId, params.epoch);
      this.assertNotCancellationLocked(params.runId);
      if (
        current.epoch !== params.epoch ||
        this.currentEpoch(params.runId)?.epoch !== params.epoch
      ) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is not active`,
        );
      }
      if (this.getTerminalResult(params.runId, params.epoch) !== undefined) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is already terminal`,
        );
      }
      if (this.getActiveSuspension(params.runId) !== undefined) {
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is already suspended`,
        );
      }
      this.assertNoPendingEffects(params.runId);
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      this.driver
        .prepareState<[string, number, string, number, string, string]>(
          `INSERT INTO run_suspensions (
             run_id, epoch, suspension_event_id, suspension_sequence,
             reason, suspended_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          positiveInteger(params.epoch, "epoch"),
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          params.reason,
          required(params.suspendedAt, "suspendedAt"),
        );
      return {
        applied: true,
        value: {
          runId: params.runId,
          epoch: params.epoch,
          eventId: params.eventId,
          suspensionSequence: params.eventSequence,
          reason: params.reason,
          suspendedAt: params.suspendedAt,
        },
      };
    });
  }

  recordRunResumed(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly suspensionEventId: string;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly reason: RunResumedBoundary["reason"];
    readonly resumedAt: string;
  }): DurableWriteOutcome<DurableRunSuspension> {
    return this.driver.transactionImmediate(() => {
      const replayed = this.driver
        .prepareState<[string, string], SuspensionRow>(
          `SELECT ${SUSPENSION_COLUMNS}
           FROM run_suspensions
           WHERE run_id = ? AND resume_event_id = ?`,
        )
        .get(params.runId, params.eventId);
      if (replayed !== undefined) {
        const value = suspensionFromRow(replayed);
        if (
          value.epoch === params.epoch &&
          value.eventId === params.suspensionEventId &&
          value.resumeSequence === params.eventSequence &&
          value.resumeReason === params.reason &&
          value.resumedAt === params.resumedAt
        ) {
          return { applied: false, value };
        }
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `resume event ${params.eventId} conflicts with its durable projection`,
        );
      }
      const current = this.currentEpoch(params.runId);
      this.assertNotCancellationLocked(params.runId);
      if (current?.epoch !== params.epoch) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is not active`,
        );
      }
      if (this.getTerminalResult(params.runId, params.epoch) !== undefined) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is terminal and cannot resume`,
        );
      }
      const suspension = this.getActiveSuspension(params.runId);
      if (
        suspension === undefined ||
        suspension.epoch !== params.epoch ||
        suspension.eventId !== params.suspensionEventId
      ) {
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `run ${params.runId} has no matching active suspension`,
        );
      }
      if (params.eventSequence <= suspension.suspensionSequence) {
        throw conflict(
          "RUN_EVENT_SEQUENCE_CONFLICT",
          `resume sequence must follow suspension ${params.suspensionEventId}`,
        );
      }
      this.assertNoPendingEffects(params.runId);
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      this.driver
        .prepareState<[string, number, string, string, string, string]>(
          `UPDATE run_suspensions
           SET resume_event_id = ?, resume_sequence = ?, resume_reason = ?, resumed_at = ?
           WHERE run_id = ? AND suspension_event_id = ? AND resume_event_id IS NULL`,
        )
        .run(
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          params.reason,
          required(params.resumedAt, "resumedAt"),
          params.runId,
          params.suspensionEventId,
        );
      return {
        applied: true,
        value: {
          ...suspension,
          resumeEventId: params.eventId,
          resumeSequence: params.eventSequence,
          resumeReason: params.reason,
          resumedAt: params.resumedAt,
        },
      };
    });
  }

  recordRunStartupActivated(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly resumeEventId: string;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly activatedAt: string;
  }): DurableWriteOutcome<RunStartupActivatedBoundary> {
    return this.driver.transactionImmediate(() => {
      const replayed = this.driver
        .prepareState<[string, string], SuspensionRow>(
          `SELECT ${SUSPENSION_COLUMNS}
           FROM run_suspensions
           WHERE run_id = ? AND activation_event_id = ?`,
        )
        .get(params.runId, params.eventId);
      if (replayed !== undefined) {
        if (
          replayed.epoch === params.epoch &&
          replayed.resume_event_id === params.resumeEventId &&
          replayed.activation_sequence === params.eventSequence &&
          replayed.activated_at === params.activatedAt
        ) {
          return {
            applied: false,
            value: {
              runId: params.runId,
              epoch: params.epoch,
              eventId: params.eventId,
              resumeEventId: params.resumeEventId,
              activatedAt: params.activatedAt,
            },
          };
        }
        throw conflict(
          "RUN_STARTUP_ACTIVATION_CONFLICT",
          `startup activation ${params.eventId} conflicts with its durable projection`,
        );
      }
      this.assertNotCancellationLocked(params.runId);
      if (
        this.currentEpoch(params.runId)?.epoch !== params.epoch ||
        this.getTerminalResult(params.runId, params.epoch) !== undefined ||
        this.getActiveSuspension(params.runId) !== undefined
      ) {
        throw conflict(
          "RUN_STARTUP_ACTIVATION_CONFLICT",
          `run ${params.runId} is not an open resumed epoch`,
        );
      }
      const resumed = this.driver
        .prepareState<[string, string], SuspensionRow>(
          `SELECT ${SUSPENSION_COLUMNS}
           FROM run_suspensions
           WHERE run_id = ? AND resume_event_id = ?`,
        )
        .get(params.runId, params.resumeEventId);
      if (
        resumed === undefined ||
        resumed.epoch !== params.epoch ||
        resumed.resume_sequence === null ||
        resumed.activation_event_id !== null ||
        params.eventSequence <= resumed.resume_sequence
      ) {
        throw conflict(
          "RUN_STARTUP_ACTIVATION_CONFLICT",
          `run ${params.runId} has no matching pending startup activation`,
        );
      }
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      const update = this.driver
        .prepareState<[string, number, string, string, string]>(
          `UPDATE run_suspensions
           SET activation_event_id = ?, activation_sequence = ?, activated_at = ?
           WHERE run_id = ? AND resume_event_id = ?
             AND activation_event_id IS NULL`,
        )
        .run(
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          required(params.activatedAt, "activatedAt"),
          params.runId,
          params.resumeEventId,
        );
      if (update.changes !== 1) {
        throw conflict(
          "RUN_STARTUP_ACTIVATION_CONFLICT",
          `run ${params.runId} startup activation raced another writer`,
        );
      }
      return {
        applied: true,
        value: {
          runId: params.runId,
          epoch: params.epoch,
          eventId: params.eventId,
          resumeEventId: params.resumeEventId,
          activatedAt: params.activatedAt,
        },
      };
    });
  }

  getPendingStartupActivation(runId: RunId): DurableRunSuspension | undefined {
    const row = this.driver
      .prepareState<[string], SuspensionRow>(
        `SELECT ${SUSPENSION_COLUMNS}
         FROM run_suspensions
         WHERE run_id = ? AND resume_event_id IS NOT NULL
           AND activation_event_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM run_suspensions later
             WHERE later.run_id = run_suspensions.run_id
               AND later.suspension_sequence > run_suspensions.resume_sequence
           )
         ORDER BY epoch DESC, resume_sequence DESC
         LIMIT 1`,
      )
      .get(runId);
    return row === undefined ? undefined : suspensionFromRow(row);
  }

  getActiveSuspension(runId: RunId): DurableRunSuspension | undefined {
    const row = this.driver
      .prepareState<[string], SuspensionRow>(
        `SELECT ${SUSPENSION_COLUMNS}
         FROM run_suspensions
         WHERE run_id = ? AND resume_event_id IS NULL
         ORDER BY epoch DESC, suspension_sequence DESC
         LIMIT 1`,
      )
      .get(runId);
    return row === undefined ? undefined : suspensionFromRow(row);
  }

  listSuspensions(runId: RunId): readonly DurableRunSuspension[] {
    return this.driver
      .prepareState<[string], SuspensionRow>(
        `SELECT ${SUSPENSION_COLUMNS}
         FROM run_suspensions
         WHERE run_id = ?
         ORDER BY epoch ASC, suspension_sequence ASC`,
      )
      .all(runId)
      .map(suspensionFromRow);
  }

  recordRuntimeSettingsChanged(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly previousSettingsEventId: string | null;
    readonly rollbackOfSettingsEventId: string | null;
    readonly reason: RunRuntimeSettingsBoundary["reason"];
    readonly changedAt: string;
    readonly settings: RunRuntimeSettingsSnapshot;
  }): DurableWriteOutcome<DurableRunRuntimeSettings> {
    return this.driver.transactionImmediate(() => {
      const replayed = this.driver
        .prepareState<[string, string], RuntimeSettingsRow>(
          `SELECT ${RUNTIME_SETTINGS_COLUMNS}
           FROM run_runtime_settings
           WHERE run_id = ? AND settings_event_id = ?`,
        )
        .get(params.runId, params.eventId);
      if (replayed !== undefined) {
        const value = runtimeSettingsFromRow(replayed);
        if (
          value.epoch === params.epoch &&
          value.eventSequence === params.eventSequence &&
          value.previousSettingsEventId === params.previousSettingsEventId &&
          value.rollbackOfSettingsEventId ===
            params.rollbackOfSettingsEventId &&
          value.reason === params.reason &&
          value.changedAt === params.changedAt &&
          runtimeSettingsEqual(value, params.settings)
        ) {
          return { applied: false, value };
        }
        throw conflict(
          "RUN_RUNTIME_SETTINGS_CONFLICT",
          `runtime settings event ${params.eventId} conflicts with its durable projection`,
        );
      }
      this.assertNotCancellationLocked(params.runId);
      if (
        this.currentEpoch(params.runId)?.epoch !== params.epoch ||
        this.getTerminalResult(params.runId, params.epoch) !== undefined ||
        this.getActiveSuspension(params.runId) !== undefined
      ) {
        throw conflict(
          "RUN_RUNTIME_SETTINGS_CONFLICT",
          `run ${params.runId} cannot change settings outside an open epoch`,
        );
      }
      const latest = this.getCurrentRuntimeSettings(params.runId);
      if (
        params.previousSettingsEventId !== (latest?.eventId ?? null) ||
        (latest === undefined
          ? params.reason !== "initial"
          : params.reason === "initial")
      ) {
        throw conflict(
          "RUN_RUNTIME_SETTINGS_CONFLICT",
          `run ${params.runId} runtime settings chain is not contiguous`,
        );
      }
      if (params.reason === "compensating_rollback") {
        const preceding = this.driver
          .prepareState<[string, number], RuntimeSettingsRow>(
            `SELECT ${RUNTIME_SETTINGS_COLUMNS}
             FROM run_runtime_settings
             WHERE run_id = ? AND settings_sequence < ?
             ORDER BY settings_sequence DESC
             LIMIT 1`,
          )
          .get(params.runId, latest!.eventSequence);
        if (
          params.rollbackOfSettingsEventId !== latest!.eventId ||
          preceding === undefined ||
          !runtimeSettingsEqual(
            runtimeSettingsFromRow(preceding),
            params.settings,
          )
        ) {
          throw conflict(
            "RUN_RUNTIME_SETTINGS_CONFLICT",
            `run ${params.runId} settings compensation is not an exact rollback`,
          );
        }
      } else if (params.rollbackOfSettingsEventId !== null) {
        throw conflict(
          "RUN_RUNTIME_SETTINGS_CONFLICT",
          `run ${params.runId} non-compensating settings event names a rollback target`,
        );
      }
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      this.driver
        .prepareState(
          `INSERT INTO run_runtime_settings (
             run_id, epoch, settings_event_id, settings_sequence,
             previous_settings_event_id, rollback_of_settings_event_id,
             reason, changed_at, permission_mode, pre_plan_mode,
             auto_mode_active, bypass_permissions_workspace, model, provider,
             profile, reasoning_effort, model_verbosity, service_tier,
             hooks_disabled
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          positiveInteger(params.epoch, "epoch"),
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          optionalRequired(
            params.previousSettingsEventId ?? undefined,
            "previousSettingsEventId",
          ),
          optionalRequired(
            params.rollbackOfSettingsEventId ?? undefined,
            "rollbackOfSettingsEventId",
          ),
          params.reason,
          required(params.changedAt, "changedAt"),
          params.settings.permissionMode,
          params.settings.prePlanMode,
          params.settings.autoModeActive ? 1 : 0,
          params.settings.bypassPermissionsWorkspace,
          required(params.settings.model, "model"),
          required(params.settings.provider, "provider"),
          params.settings.profile,
          params.settings.reasoningEffort,
          params.settings.modelVerbosity,
          params.settings.serviceTier,
          params.settings.hooksDisabled ? 1 : 0,
        );
      return {
        applied: true,
        value: this.getCurrentRuntimeSettings(params.runId)!,
      };
    });
  }

  getCurrentRuntimeSettings(
    runId: RunId,
  ): DurableRunRuntimeSettings | undefined {
    const row = this.driver
      .prepareState<[string], RuntimeSettingsRow>(
        `SELECT ${RUNTIME_SETTINGS_COLUMNS}
         FROM run_runtime_settings
         WHERE run_id = ?
         ORDER BY settings_sequence DESC
         LIMIT 1`,
      )
      .get(runId);
    return row === undefined ? undefined : runtimeSettingsFromRow(row);
  }

  reopenRun(params: {
    readonly runId: RunId;
    readonly fromEpoch: number;
    readonly openedAt: string;
    readonly eventId: string;
    readonly reason: string;
  }): DurableWriteOutcome<RunLifecycleEpoch> {
    return this.driver.transactionImmediate(() => {
      const replayed = this.driver
        .prepareState<[string, string], EpochRow>(
          `SELECT run_id, epoch, opened_at, opened_event_id,
                  reopened_from_epoch, reopen_reason
           FROM run_lifecycle_epochs
           WHERE run_id = ? AND opened_event_id = ?`,
        )
        .get(params.runId, params.eventId);
      if (replayed !== undefined) {
        const epoch = epochFromRow(replayed);
        if (
          epoch.reopenedFromEpoch === params.fromEpoch &&
          epoch.openedAt === params.openedAt &&
          epoch.reopenReason === params.reason
        ) {
          return { applied: false, value: epoch };
        }
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `reopen event ${params.eventId} conflicts with its durable epoch`,
        );
      }

      const current = this.currentEpoch(params.runId);
      this.assertNotCancellationLocked(params.runId);
      if (current === undefined || current.epoch !== params.fromEpoch) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} current epoch does not match ${params.fromEpoch}`,
        );
      }
      const terminalResult = this.getTerminalResult(
        params.runId,
        params.fromEpoch,
      );
      if (terminalResult === undefined) {
        throw conflict(
          "RUN_EPOCH_NOT_TERMINAL",
          `run ${params.runId} epoch ${params.fromEpoch} is not terminal`,
        );
      }
      if (this.getActiveSuspension(params.runId) !== undefined) {
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `run ${params.runId} cannot reopen while suspended`,
        );
      }
      // Pending unknown-outcome reviews do not block the reopen itself
      // (#1750/#1751): the operator review the M4 contract requires happens
      // inside the reopened session (/resolve → effect-review RPC), so
      // refusing here made restarted sessions permanently unrecoverable.
      // Dependent mutations remain stopped by
      // `assertDependentMutationAllowed` and the unknown-outcome mutation
      // gate until every effect is explicitly resolved. An intent with NO
      // settlement record at all is an evidence gap, not a review queue —
      // reopening over it stays refused.
      const pendingReviews = this.listPendingEffectReviews(params.runId);
      const dangling = this.listUnsettledEffectIntents(params.runId);
      if (dangling.length > 0) {
        throw conflict(
          "RUN_REOPEN_REVIEW_REQUIRED",
          `run ${params.runId} has ${dangling.length} unsettled effect intent(s)`,
        );
      }
      // An unknown-outcome TERMINAL is itself unreconciled evidence; its
      // reviews must resolve before the run re-enters a live epoch. Settled
      // terminals (completed, failed, cancelled) reopen with reviews still
      // pending — the reopened session is where /resolve runs.
      if (
        terminalResult.status === "unknown_outcome" &&
        pendingReviews.length > 0
      ) {
        throw conflict(
          "RUN_REOPEN_REVIEW_REQUIRED",
          `run ${params.runId} has ${pendingReviews.length} unresolved unknown-outcome effect(s)`,
        );
      }

      const nextEpoch = params.fromEpoch + 1;
      this.driver
        .prepareState<[string, number, string, string, number, string]>(
          `INSERT INTO run_lifecycle_epochs (
             run_id, epoch, opened_at, opened_event_id,
             reopened_from_epoch, reopen_reason
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          positiveInteger(nextEpoch, "epoch"),
          required(params.openedAt, "openedAt"),
          required(params.eventId, "eventId"),
          params.fromEpoch,
          required(params.reason, "reason"),
        );
      /*
       * The mirror of the terminal-time rail update: reopening puts the run
       * back to work, so the rail row says running again. Without this, a
       * reopened run kept the previous epoch's verdict on the rail and
       * startup recovery treated its in-flight tool calls as orphans.
       */
      updateAgentRunStatus(this.driver, {
        id: params.runId,
        status: "running",
        lastActiveAt: params.openedAt,
      });
      const value: RunLifecycleEpoch = {
        runId: params.runId,
        epoch: nextEpoch,
        openedAt: params.openedAt,
        openedEventId: params.eventId,
        reopenedFromEpoch: params.fromEpoch,
        reopenReason: params.reason,
      };
      return { applied: true, value };
    });
  }

  recordTerminalResult(params: {
    readonly epoch: number;
    readonly result: RunTerminalResult;
    readonly eventId: string;
  }): DurableWriteOutcome<DurableRunTerminalRecord> {
    return this.driver.transactionImmediate(() => {
      const epoch = this.requireEpoch(params.result.runId, params.epoch);
      if (epoch.epoch !== params.epoch) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.result.runId} epoch ${params.epoch} does not exist`,
        );
      }
      const existing = this.getTerminalResult(
        params.result.runId,
        params.epoch,
      );
      if (existing !== undefined) {
        if (
          existing.eventId === params.eventId &&
          terminalContent(existing) === terminalContent(params.result)
        ) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_TERMINAL_RESULT_CONFLICT",
          `run ${params.result.runId} epoch ${params.epoch} already has a different terminal result`,
        );
      }
      if (this.getActiveSuspension(params.result.runId) !== undefined) {
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `run ${params.result.runId} cannot become terminal while suspended`,
        );
      }
      this.assertSequenceUnclaimed(
        params.result.runId,
        params.result.lastSequence,
      );
      const usageJson =
        params.result.usage === null
          ? null
          : stableStringify(params.result.usage);
      this.driver
        .prepareState(
          `INSERT INTO run_terminal_results (
             run_id, epoch, status, exit_code, stop_reason, final_message,
             usage_json, last_sequence, finished_at, event_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.result.runId, "runId"),
          positiveInteger(params.epoch, "epoch"),
          params.result.status,
          params.result.exitCode,
          params.result.stopReason,
          params.result.finalMessage,
          usageJson,
          nullablePositiveInteger(params.result.lastSequence, "lastSequence"),
          required(params.result.finishedAt, "finishedAt"),
          required(params.eventId, "eventId"),
        );
      /*
       * The rail row keeps up with the verdict, in the same transaction.
       * Terminal results landed here while agent_runs.status stayed
       * "running" forever — dozens of long-dead runs per project database
       * still advertising themselves as live to anything that reads the
       * rail. Only for the run's CURRENT epoch: a terminal recovered into a
       * reopened run's history must not repaint the live epoch's status.
       * Child runs (`wf-…:plan#1`) have no rail row; the update is a no-op
       * for them, and a cancel-locked row keeps its cancel.
       */
      if (this.currentEpoch(params.result.runId)?.epoch === params.epoch) {
        updateAgentRunStatus(this.driver, {
          id: params.result.runId,
          status: params.result.status,
          lastActiveAt: params.result.finishedAt,
        });
      }
      return {
        applied: true,
        value: {
          ...params.result,
          epoch: params.epoch,
          eventId: params.eventId,
        },
      };
    });
  }

  getTerminalResult(
    runId: RunId,
    epoch: number,
  ): DurableRunTerminalRecord | undefined {
    const row = this.driver
      .prepareState<[string, number], TerminalRow>(
        `SELECT run_id, epoch, status, exit_code, stop_reason, final_message,
                usage_json, last_sequence, finished_at, event_id
         FROM run_terminal_results
         WHERE run_id = ? AND epoch = ?`,
      )
      .get(runId, epoch);
    return row === undefined ? undefined : terminalFromRow(row);
  }

  getCurrentTerminalResult(runId: RunId): DurableRunTerminalRecord | undefined {
    const current = this.currentEpoch(runId);
    return current === undefined
      ? undefined
      : this.getTerminalResult(runId, current.epoch);
  }

  listTerminalHistory(runId: RunId): readonly DurableRunTerminalRecord[] {
    return this.driver
      .prepareState<[string], TerminalRow>(
        `SELECT run_id, epoch, status, exit_code, stop_reason, final_message,
                usage_json, last_sequence, finished_at, event_id
         FROM run_terminal_results
         WHERE run_id = ?
         ORDER BY epoch ASC`,
      )
      .all(runId)
      .map(terminalFromRow);
  }

  beginEffect(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly stepId: string;
    readonly childRunId?: RunId;
    readonly sessionId: string;
    readonly callId?: string;
    readonly toolName: string;
    readonly recoveryCategory: ToolRecoveryCategory;
    readonly idempotencyKey?: string;
    readonly intentDigest: string;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly intentAt: string;
    /** Canonical journal format. Omitted only by live v2 writers. */
    readonly effectFormatVersion?: 1 | 2;
    readonly minimumReaderRuntime?: string;
    /** Internal rebuild path for already-terminal canonical history. */
    readonly projection?: "canonical_replay";
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.driver.transactionImmediate(() => {
      this.requireEpoch(params.runId, params.epoch);
      const existing = this.getEffect(params.runId, params.stepId);
      if (existing !== undefined) {
        if (effectIntentContent(existing) === effectIntentContent(params)) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EFFECT_INTENT_CONFLICT",
          `run ${params.runId} step ${params.stepId} already has a different effect intent`,
        );
      }
      const terminal = this.getTerminalResult(params.runId, params.epoch);
      if (
        terminal !== undefined &&
        (params.projection !== "canonical_replay" ||
          terminal.lastSequence === null ||
          params.eventSequence >= terminal.lastSequence)
      ) {
        throw conflict(
          "RUN_EPOCH_CONFLICT",
          `run ${params.runId} epoch ${params.epoch} is already terminal`,
        );
      }
      if (
        (params.recoveryCategory === "side-effecting" ||
          params.recoveryCategory === "interactive") &&
        params.projection !== "canonical_replay"
      ) {
        this.assertDependentMutationAllowed(params.runId);
      }
      if (
        params.projection !== "canonical_replay" &&
        this.getActiveSuspension(params.runId) !== undefined
      ) {
        throw conflict(
          "RUN_SUSPENSION_CONFLICT",
          `run ${params.runId} cannot begin an effect while suspended`,
        );
      }
      if (
        params.recoveryCategory === "idempotent" &&
        params.idempotencyKey === undefined
      ) {
        throw new TypeError("idempotent effects require idempotencyKey");
      }
      if (
        params.recoveryCategory !== "idempotent" &&
        params.idempotencyKey !== undefined
      ) {
        throw new TypeError(
          "idempotencyKey is reserved for effects classified as idempotent",
        );
      }
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      const effectFormatVersion =
        params.effectFormatVersion ?? EFFECT_EVIDENCE_FORMAT_VERSION;
      const minimumReaderRuntime =
        effectFormatVersion === EFFECT_EVIDENCE_FORMAT_VERSION
          ? (params.minimumReaderRuntime ??
            EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME)
          : undefined;
      if (
        effectFormatVersion === 1 &&
        params.minimumReaderRuntime !== undefined
      ) {
        throw new TypeError(
          "legacy effect evidence cannot declare a minimum reader runtime",
        );
      }
      this.driver
        .prepareState(
          `INSERT INTO run_effects (
             run_id, step_id, epoch, child_run_id, session_id, call_id, tool_name,
             recovery_category, idempotency_key, intent_digest,
             intent_event_id, intent_sequence, intent_at, effect_format_version,
             minimum_reader_runtime
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          required(params.stepId, "stepId"),
          positiveInteger(params.epoch, "epoch"),
          optionalRequired(params.childRunId, "childRunId"),
          required(params.sessionId, "sessionId"),
          required(params.callId ?? params.stepId, "callId"),
          required(params.toolName, "toolName"),
          params.recoveryCategory,
          optionalRequired(params.idempotencyKey, "idempotencyKey"),
          required(params.intentDigest, "intentDigest"),
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          required(params.intentAt, "intentAt"),
          effectFormatVersion,
          minimumReaderRuntime ?? null,
        );
      return {
        applied: true,
        value: this.getEffect(params.runId, params.stepId)!,
      };
    });
  }

  completeEffect(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly outcome: Exclude<EffectOutcome, "unknown_outcome">;
    readonly effectBoundary: EffectBoundary;
    readonly noEffectEvidence?: EffectNoEffectProof;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly resultDigest?: string;
    readonly result?: unknown;
    readonly evidence?: unknown;
    readonly completedAt: string;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.finishEffect({ ...params, unknownReason: undefined });
  }

  markEffectUnknown(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly reason: string;
    readonly evidence?: unknown;
    readonly observedAt: string;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.finishEffect({
      runId: params.runId,
      stepId: params.stepId,
      outcome: "unknown_outcome",
      eventId: params.eventId,
      eventSequence: params.eventSequence,
      evidence: params.evidence,
      completedAt: params.observedAt,
      unknownReason: params.reason,
    });
  }

  getEffect(runId: RunId, stepId: string): DurableRunEffect | undefined {
    const row = this.driver
      .prepareState<[string, string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ? AND step_id = ?`,
      )
      .get(runId, stepId);
    return row === undefined ? undefined : effectFromRow(row);
  }

  getEffectBySessionCall(
    sessionId: string,
    callId: string,
  ): DurableRunEffect | undefined {
    const row = this.driver
      .prepareState<[string, string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE session_id = ? AND call_id = ?
         ORDER BY CASE WHEN review_status = 'pending' THEN 0 ELSE 1 END,
                  intent_sequence DESC
         LIMIT 1`,
      )
      .get(sessionId, callId);
    return row === undefined ? undefined : effectFromRow(row);
  }

  listEffectsBySessionCall(
    sessionId: string,
    callId: string,
  ): readonly DurableRunEffect[] {
    return this.driver
      .prepareState<[string, string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE session_id = ? AND call_id = ?
         ORDER BY intent_sequence ASC, step_id ASC`,
      )
      .all(sessionId, callId)
      .map(effectFromRow);
  }

  assertEffectAttemptAllowed(params: {
    readonly sessionId: string;
    readonly callId: string;
    readonly recoveryCategory: ToolRecoveryCategory;
    readonly idempotencyKey?: string;
    /**
     * Canonical steps whose dangling idempotent intent was recovered after
     * process restart and durably classified as `retry_safe_deferred`.
     */
    readonly retrySafeDeferredStepIds?: ReadonlySet<string>;
  }): number {
    const prior = this.listEffectsBySessionCall(
      params.sessionId,
      params.callId,
    );
    for (const effect of prior) {
      if (params.recoveryCategory === "idempotent") {
        if (
          params.idempotencyKey === undefined ||
          effect.idempotencyKey !== params.idempotencyKey
        ) {
          throw conflict(
            "RUN_EFFECT_OUTCOME_CONFLICT",
            `tool call ${params.callId} cannot change its durable idempotency key`,
          );
        }
        if (
          effect.outcome !== undefined ||
          params.retrySafeDeferredStepIds?.has(effect.stepId) === true
        ) {
          continue;
        }
        throw conflict(
          "RUN_EFFECT_OUTCOME_CONFLICT",
          `tool call ${params.callId} retains a live idempotent attempt; rendezvous or durable retry-safe recovery is required`,
        );
      }
      if (effect.noEffectEvidence !== undefined) continue;
      if (
        effect.review?.disposition === "confirmed_no_effect" &&
        effect.review.domainAction === "retry_new_attempt" &&
        effect.review.workflowStatus === "resolved"
      ) {
        continue;
      }
      throw conflict(
        effect.outcome === "unknown_outcome" || effect.outcome === undefined
          ? "RUN_EFFECT_REVIEW_REQUIRED"
          : "RUN_EFFECT_OUTCOME_CONFLICT",
        `tool call ${params.callId} has no authoritative no-effect proof and cannot be dispatched again`,
      );
    }
    return prior.length + 1;
  }

  /**
   * Runs that recorded a specific durable step (e.g. `workflow.intake`).
   * Additive M5 helper: lets the workflow controller enumerate workflow runs
   * without a parallel registry table (D2).
   */
  listRunIdsWithStep(stepId: string): readonly RunId[] {
    return this.driver
      .prepareState<[string], { readonly run_id: string }>(
        `SELECT DISTINCT run_id
         FROM run_effects
         WHERE step_id = ?
         ORDER BY run_id ASC`,
      )
      .all(stepId)
      .map((row) => row.run_id);
  }

  listEffects(runId: RunId): readonly DurableRunEffect[] {
    return this.driver
      .prepareState<[string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ?
         ORDER BY intent_sequence ASC, step_id ASC`,
      )
      .all(runId)
      .map(effectFromRow);
  }

  /**
   * Side-effecting/interactive intents with NO settlement record at all
   * (no result, no unknown-outcome evidence). These are evidence gaps —
   * distinct from review-pending unknown outcomes — and block epoch reopen.
   */
  listUnsettledEffectIntents(runId: RunId): readonly DurableRunEffect[] {
    return this.driver
      .prepareState<[string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ?
           AND recovery_category IN ('side-effecting', 'interactive')
           AND outcome IS NULL
         ORDER BY intent_sequence ASC, step_id ASC`,
      )
      .all(runId)
      .map(effectFromRow);
  }

  listPendingEffectReviews(runId: RunId): readonly DurableRunEffect[] {
    return this.driver
      .prepareState<[string], EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM run_effects
         WHERE run_id = ? AND review_status = 'pending'
         ORDER BY intent_sequence ASC, step_id ASC`,
      )
      .all(runId)
      .map(effectFromRow);
  }

  assertDependentMutationAllowed(runId: RunId): void {
    const pending = this.listPendingEffectReviews(runId);
    if (pending.length === 0) return;
    throw conflict(
      "RUN_EFFECT_REVIEW_REQUIRED",
      `run ${runId} has unresolved unknown-outcome effect(s): ${pending
        .map((effect) => effect.stepId)
        .join(", ")}`,
    );
  }

  resolveEffectReview(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly resolution: EffectReviewResolution;
    readonly eventId: string;
    readonly evidence?: unknown;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.driver.transactionImmediate(() => {
      const resolution = canonicalizeEffectReviewResolution(params.resolution);
      const existing = this.getEffect(params.runId, params.stepId);
      if (existing === undefined) {
        throw conflict(
          "RUN_EFFECT_NOT_FOUND",
          `run ${params.runId} step ${params.stepId} has no durable effect`,
        );
      }
      const reviewContent = stableStringify({
        resolution,
        eventId: params.eventId,
        evidence: params.evidence ?? null,
      });
      if (existing.review !== undefined) {
        const existingContent = stableStringify({
          resolution: existing.review,
          eventId: existing.reviewEventId,
          evidence: existing.reviewEvidence ?? null,
        });
        if (reviewContent === existingContent) {
          return { applied: false, value: existing };
        }
        if (
          existing.reviewStatus === "pending" &&
          resolution.workflowStatus !== "pending"
        ) {
          // A later authoritative/operator resolution may close a prior
          // remains-unknown system observation. The canonical journal retains
          // both events; this row is only the latest rebuildable projection.
        } else {
          throw conflict(
            "RUN_EFFECT_REVIEW_CONFLICT",
            `run ${params.runId} step ${params.stepId} already has a different review resolution`,
          );
        }
      }
      if (
        existing.reviewStatus === "resolved" ||
        existing.reviewStatus === "abandoned"
      ) {
        throw conflict(
          "RUN_EFFECT_REVIEW_CONFLICT",
          `run ${params.runId} step ${params.stepId} already has a different review resolution`,
        );
      }
      if (
        existing.outcome !== "unknown_outcome" ||
        existing.reviewStatus !== "pending"
      ) {
        throw conflict(
          "RUN_EFFECT_REVIEW_CONFLICT",
          `run ${params.runId} step ${params.stepId} is not awaiting review`,
        );
      }
      this.driver
        .prepareState(
          `UPDATE run_effects
           SET review_status = ?, reviewed_at = ?, reviewed_by = ?,
               review_resolution = ?, review_event_id = ?,
               review_evidence_json = ?, review_resolution_version = ?,
               review_disposition = ?, review_actor_kind = ?,
               review_actor_id = ?, review_evidence_kind = ?,
               review_evidence_ref = ?, review_evidence_sha256 = ?,
               review_domain_action = ?
           WHERE run_id = ? AND step_id = ? AND review_status = 'pending'`,
        )
        .run(
          resolution.workflowStatus,
          required(resolution.reviewedAt, "reviewedAt"),
          required(resolution.actorId, "actorId"),
          resolution.disposition,
          required(params.eventId, "eventId"),
          serializeOptionalJson(params.evidence),
          resolution.version,
          resolution.disposition,
          resolution.actorKind,
          resolution.actorId,
          resolution.evidenceKind,
          resolution.evidenceRef,
          resolution.evidenceSha256,
          resolution.domainAction ?? null,
          params.runId,
          params.stepId,
        );
      return {
        applied: true,
        value: this.getEffect(params.runId, params.stepId)!,
      };
    });
  }

  bindJournalSource(params: {
    readonly runId: RunId;
    readonly epoch: number;
    readonly childRunId: RunId;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly active?: boolean;
    readonly firstAvailableSequence?: number;
    readonly lastSequence?: number;
    readonly boundAt: string;
  }): DurableWriteOutcome<RunJournalBinding> {
    return this.driver.transactionImmediate(() => {
      this.requireEpoch(params.runId, params.epoch);
      const existing = this.getJournalBinding(params.sourcePath);
      const active = params.active !== false;
      if (existing !== undefined) {
        const same =
          existing.runId === params.runId &&
          existing.epoch === params.epoch &&
          existing.childRunId === params.childRunId &&
          existing.sessionId === params.sessionId &&
          existing.active === active &&
          existing.firstAvailableSequence === params.firstAvailableSequence &&
          existing.lastSequence === params.lastSequence &&
          existing.boundAt === params.boundAt;
        if (same) return { applied: false, value: existing };
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          `rollout source ${params.sourcePath} already has a different run binding`,
        );
      }
      validateBounds(
        params.firstAvailableSequence,
        params.lastSequence,
        undefined,
      );
      if (active) {
        this.driver
          .prepareState<[string, string, number]>(
            `UPDATE run_journal_bindings
             SET active = 0, updated_at = ?
             WHERE run_id = ? AND epoch = ? AND active = 1`,
          )
          .run(params.boundAt, params.runId, params.epoch);
      }
      this.driver
        .prepareState(
          `INSERT INTO run_journal_bindings (
             run_id, epoch, child_run_id, session_id, source_path, active,
             first_available_sequence, last_sequence, bound_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          required(params.runId, "runId"),
          positiveInteger(params.epoch, "epoch"),
          required(params.childRunId, "childRunId"),
          required(params.sessionId, "sessionId"),
          required(params.sourcePath, "sourcePath"),
          active ? 1 : 0,
          optionalPositiveInteger(
            params.firstAvailableSequence,
            "firstAvailableSequence",
          ),
          optionalPositiveInteger(params.lastSequence, "lastSequence"),
          required(params.boundAt, "boundAt"),
          params.boundAt,
        );
      return {
        applied: true,
        value: this.getJournalBinding(params.sourcePath)!,
      };
    });
  }

  updateJournalBounds(params: {
    readonly sourcePath: string;
    readonly firstAvailableSequence: number;
    readonly lastSequence: number;
    readonly updatedAt: string;
  }): RunJournalBinding {
    return this.driver.transactionImmediate(() => {
      const existing = this.requireJournalBinding(params.sourcePath);
      validateBounds(
        params.firstAvailableSequence,
        params.lastSequence,
        existing.retiredThroughSequence,
      );
      if (
        existing.firstAvailableSequence !== undefined &&
        params.firstAvailableSequence > existing.firstAvailableSequence
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          "journal bounds cannot silently advance past retained events; record an explicit gap",
        );
      }
      if (
        existing.lastSequence !== undefined &&
        params.lastSequence < existing.lastSequence
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          "journal bounds cannot silently truncate events; record an explicit gap",
        );
      }
      const first =
        existing.firstAvailableSequence === undefined
          ? params.firstAvailableSequence
          : Math.min(
              existing.firstAvailableSequence,
              params.firstAvailableSequence,
            );
      const last = Math.max(existing.lastSequence ?? 0, params.lastSequence);
      this.driver
        .prepareState<[number, number, string, string]>(
          `UPDATE run_journal_bindings
           SET first_available_sequence = ?, last_sequence = ?, updated_at = ?
           WHERE source_path = ?`,
        )
        .run(
          first,
          last,
          required(params.updatedAt, "updatedAt"),
          params.sourcePath,
        );
      return this.requireJournalBinding(params.sourcePath);
    });
  }

  /**
   * Bind a descriptor-stable strict scan to this source. A fresh digest alone
   * is not authority; callers invoke this only in the transaction that proves
   * descriptor stability through projection commit.
   */
  bindAuthoritativeJournalEvidence(params: {
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly sourceSizeBytes: number;
    readonly sourceMtimeMs: number;
    readonly journalFormat: Exclude<CanonicalJournalFormat, "empty">;
    readonly minimumReaderRuntime: string;
    readonly updatedAt: string;
  }): RunJournalBinding {
    return this.driver.transactionImmediate(() => {
      const existing = this.requireJournalBinding(params.sourcePath);
      const sourceSha256 = assertRecoverySha256(
        params.sourceSha256,
        "sourceSha256",
      );
      const sourceSizeBytes = nonNegativeInteger(
        params.sourceSizeBytes,
        "sourceSizeBytes",
      );
      const sourceMtimeMs = nonNegativeFiniteNumber(
        params.sourceMtimeMs,
        "sourceMtimeMs",
      );
      if (
        existing.authoritativeSourceSha256 !== undefined &&
        (existing.authoritativeSourceSha256 !== sourceSha256 ||
          existing.authoritativeSourceSizeBytes !== sourceSizeBytes ||
          existing.authoritativeSourceMtimeMs !== sourceMtimeMs ||
          existing.journalFormat !== params.journalFormat)
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          `rollout source ${params.sourcePath} already has different authoritative evidence`,
        );
      }
      if (
        params.journalFormat !== "sequenced_v1" &&
        params.journalFormat !== "legacy_unsequenced_v1"
      ) {
        throw new TypeError("journalFormat is invalid");
      }
      this.driver
        .prepareState(
          `UPDATE run_journal_bindings
           SET authoritative_source_sha256 = ?,
               authoritative_source_size_bytes = ?,
               authoritative_source_mtime_ms = ?, journal_format = ?,
               minimum_reader_runtime = ?, updated_at = ?
           WHERE source_path = ?`,
        )
        .run(
          sourceSha256,
          sourceSizeBytes,
          sourceMtimeMs,
          params.journalFormat,
          required(params.minimumReaderRuntime, "minimumReaderRuntime"),
          required(params.updatedAt, "updatedAt"),
          params.sourcePath,
        );
      return this.requireJournalBinding(params.sourcePath);
    });
  }

  markJournalGap(params: {
    readonly sourcePath: string;
    readonly retiredThroughSequence: number;
    readonly firstAvailableSequence?: number;
    readonly lastSequence?: number;
    readonly reason: RunJournalGapReason;
    readonly observedAt: string;
  }): RunJournalBinding {
    return this.driver.transactionImmediate(() => {
      const existing = this.requireJournalBinding(params.sourcePath);
      const retired = nonNegativeInteger(
        params.retiredThroughSequence,
        "retiredThroughSequence",
      );
      if (
        existing.retiredThroughSequence !== undefined &&
        retired < existing.retiredThroughSequence
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          "journal retirement boundary cannot move backwards",
        );
      }
      validateBounds(
        params.firstAvailableSequence,
        params.lastSequence,
        retired,
      );
      this.driver
        .prepareState(
          `UPDATE run_journal_bindings
           SET first_available_sequence = ?, last_sequence = ?,
               retired_through_sequence = ?, gap_reason = ?,
               gap_observed_at = ?, updated_at = ?
           WHERE source_path = ?`,
        )
        .run(
          optionalPositiveInteger(
            params.firstAvailableSequence,
            "firstAvailableSequence",
          ),
          optionalPositiveInteger(params.lastSequence, "lastSequence"),
          retired,
          params.reason,
          required(params.observedAt, "observedAt"),
          params.observedAt,
          params.sourcePath,
        );
      return this.requireJournalBinding(params.sourcePath);
    });
  }

  /**
   * Fully retire one canonical rollout source before retention removes its
   * SQLite projection and JSONL file. The binding is deliberately preserved:
   * it is the durable explanation for why a once-known source is now missing.
   *
   * The tail is resolved inside the same write transaction from both the
   * binding and the current `thread_rollout_items` mirror. Callers may wrap
   * this method and mirror-row deletion in an outer immediate transaction;
   * nested driver transactions become savepoints, so retirement cannot commit
   * without the matching projection deletion.
   */
  retireJournalSource(params: {
    readonly sourcePath: string;
    readonly reason: RunJournalGapReason;
    readonly observedAt: string;
    /** Highest sequence parsed from the canonical source under its lease. */
    readonly canonicalLastSequence?: number;
  }): DurableWriteOutcome<RunJournalBinding | undefined> {
    return this.driver.transactionImmediate(() => {
      const existing = this.getJournalBinding(params.sourcePath);
      if (existing === undefined) {
        // Legacy rollout sources can predate M4 bindings. Retention remains
        // safe and idempotent for those sources; there is no identity to keep.
        return { applied: false, value: undefined };
      }
      const projectedTail = this.driver
        .prepareState<[string], { readonly last_sequence: number | null }>(
          `SELECT MAX(event_seq) AS last_sequence
           FROM thread_rollout_items
           WHERE source_path = ? AND event_seq IS NOT NULL`,
        )
        .get(params.sourcePath)?.last_sequence;
      const canonicalTail =
        params.canonicalLastSequence === undefined
          ? undefined
          : nonNegativeInteger(
              params.canonicalLastSequence,
              "canonicalLastSequence",
            );
      if (
        existing.lastSequence === undefined &&
        existing.retiredThroughSequence === undefined &&
        (projectedTail === null || projectedTail === undefined) &&
        canonicalTail === undefined
      ) {
        throw conflict(
          "RUN_JOURNAL_BINDING_CONFLICT",
          `rollout source ${params.sourcePath} cannot be retired without an authoritative sequence tail`,
        );
      }
      const tail = Math.max(
        existing.lastSequence ?? 0,
        existing.retiredThroughSequence ?? 0,
        projectedTail ?? 0,
        canonicalTail ?? 0,
      );
      if (
        !existing.active &&
        existing.firstAvailableSequence === undefined &&
        existing.retiredThroughSequence === tail &&
        existing.gapReason === params.reason
      ) {
        return { applied: false, value: existing };
      }
      const observedAt = required(params.observedAt, "observedAt");
      this.driver
        .prepareState(
          `UPDATE run_journal_bindings
           SET active = 0,
               first_available_sequence = NULL,
               last_sequence = ?,
               retired_through_sequence = ?,
               gap_reason = ?,
               gap_observed_at = ?,
               updated_at = ?
           WHERE source_path = ?`,
        )
        .run(
          tail > 0 ? tail : null,
          tail,
          params.reason,
          observedAt,
          observedAt,
          params.sourcePath,
        );
      return {
        applied: true,
        value: this.requireJournalBinding(params.sourcePath),
      };
    });
  }

  getJournalBinding(sourcePath: string): RunJournalBinding | undefined {
    const row = this.driver
      .prepareState<[string], JournalBindingRow>(
        `SELECT ${JOURNAL_BINDING_COLUMNS}
         FROM run_journal_bindings
         WHERE source_path = ?`,
      )
      .get(sourcePath);
    return row === undefined ? undefined : journalBindingFromRow(row);
  }

  listJournalBindings(
    runId: RunId,
    epoch?: number,
  ): readonly RunJournalBinding[] {
    const statement = this.driver.prepareState<unknown[], JournalBindingRow>(
      `SELECT ${JOURNAL_BINDING_COLUMNS}
       FROM run_journal_bindings
       WHERE run_id = ?${epoch === undefined ? "" : " AND epoch = ?"}
       ORDER BY epoch ASC, bound_at ASC, source_path ASC`,
    );
    const rows =
      epoch === undefined ? statement.all(runId) : statement.all(runId, epoch);
    return rows.map(journalBindingFromRow);
  }

  private finishEffect(params: {
    readonly runId: RunId;
    readonly stepId: string;
    readonly outcome: EffectOutcome;
    readonly eventId: string;
    readonly eventSequence: number;
    readonly resultDigest?: string;
    readonly result?: unknown;
    readonly evidence?: unknown;
    readonly effectBoundary?: EffectBoundary;
    readonly noEffectEvidence?: EffectNoEffectProof;
    readonly completedAt: string;
    readonly unknownReason?: string;
  }): DurableWriteOutcome<DurableRunEffect> {
    return this.driver.transactionImmediate(() => {
      const existing = this.getEffect(params.runId, params.stepId);
      if (existing === undefined) {
        throw conflict(
          "RUN_EFFECT_NOT_FOUND",
          `run ${params.runId} step ${params.stepId} has no durable effect intent`,
        );
      }
      const incomingContent = effectOutcomeContent(params);
      if (existing.outcome !== undefined) {
        if (effectOutcomeContent(existing) === incomingContent) {
          return { applied: false, value: existing };
        }
        throw conflict(
          "RUN_EFFECT_OUTCOME_CONFLICT",
          `run ${params.runId} step ${params.stepId} already has a sticky ${existing.outcome} outcome`,
        );
      }
      if (
        params.outcome === "unknown_outcome" &&
        existing.recoveryCategory === "idempotent"
      ) {
        throw new TypeError(
          "an idempotent effect may not enter unknown_outcome",
        );
      }
      if (params.outcome === "unknown_outcome") {
        if (params.unknownReason === undefined) {
          throw new TypeError("unknownReason is required for unknown_outcome");
        }
        required(params.unknownReason, "unknownReason");
      } else if (params.unknownReason !== undefined) {
        throw new TypeError("unknownReason requires unknown_outcome");
      }
      if (
        params.outcome !== "unknown_outcome" &&
        params.effectBoundary === undefined
      ) {
        throw new TypeError(
          "effectBoundary is required for a terminal effect result",
        );
      }
      if (
        params.noEffectEvidence !== undefined &&
        params.outcome !== "failed" &&
        params.outcome !== "cancelled"
      ) {
        throw new TypeError(
          "noEffectEvidence requires failed or cancelled outcome",
        );
      }
      validateNoEffectEvidence(params.noEffectEvidence);
      this.assertSequenceUnclaimed(params.runId, params.eventSequence);
      this.driver
        .prepareState(
          `UPDATE run_effects
           SET outcome = ?, effect_boundary = ?, no_effect_evidence_json = ?,
               result_event_id = ?, result_sequence = ?,
               result_digest = ?, result_json = ?, evidence_json = ?,
               unknown_reason = ?, completed_at = ?, review_status = ?
           WHERE run_id = ? AND step_id = ? AND outcome IS NULL`,
        )
        .run(
          params.outcome,
          params.effectBoundary ?? null,
          serializeOptionalJson(params.noEffectEvidence),
          required(params.eventId, "eventId"),
          positiveInteger(params.eventSequence, "eventSequence"),
          optionalRequired(params.resultDigest, "resultDigest"),
          serializeOptionalJson(params.result),
          serializeOptionalJson(params.evidence),
          optionalRequired(params.unknownReason, "unknownReason"),
          required(params.completedAt, "completedAt"),
          params.outcome === "unknown_outcome" ? "pending" : null,
          params.runId,
          params.stepId,
        );
      return {
        applied: true,
        value: this.getEffect(params.runId, params.stepId)!,
      };
    });
  }

  private requireEpoch(runId: RunId, epoch: number): RunLifecycleEpoch {
    const row = this.driver
      .prepareState<[string, number], EpochRow>(
        `SELECT run_id, epoch, opened_at, opened_event_id,
                reopened_from_epoch, reopen_reason
         FROM run_lifecycle_epochs
         WHERE run_id = ? AND epoch = ?`,
      )
      .get(runId, positiveInteger(epoch, "epoch"));
    if (row === undefined) {
      throw conflict(
        "RUN_EPOCH_CONFLICT",
        `run ${runId} epoch ${epoch} does not exist`,
      );
    }
    return epochFromRow(row);
  }

  private requireJournalBinding(sourcePath: string): RunJournalBinding {
    const binding = this.getJournalBinding(sourcePath);
    if (binding === undefined) {
      throw conflict(
        "RUN_JOURNAL_BINDING_CONFLICT",
        `rollout source ${sourcePath} is not bound to a run`,
      );
    }
    return binding;
  }

  private assertSequenceUnclaimed(runId: RunId, sequence: number | null): void {
    if (sequence === null) return;
    const normalized = positiveInteger(sequence, "sequence");
    const effect = this.driver
      .prepareState<[string, number, number], { readonly step_id: string }>(
        `SELECT step_id
         FROM run_effects
         WHERE run_id = ?
           AND (intent_sequence = ? OR result_sequence = ?)
         LIMIT 1`,
      )
      .get(runId, normalized, normalized);
    const terminal = this.driver
      .prepareState<[string, number], { readonly epoch: number }>(
        `SELECT epoch
         FROM run_terminal_results
         WHERE run_id = ? AND last_sequence = ?
         LIMIT 1`,
      )
      .get(runId, normalized);
    const suspension = this.driver
      .prepareState<
        [string, number, number, number],
        { readonly epoch: number }
      >(
        `SELECT epoch
         FROM run_suspensions
         WHERE run_id = ?
           AND (suspension_sequence = ? OR resume_sequence = ?
             OR activation_sequence = ?)
         LIMIT 1`,
      )
      .get(runId, normalized, normalized, normalized);
    const settings = this.driver
      .prepareState<[string, number], { readonly epoch: number }>(
        `SELECT epoch
         FROM run_runtime_settings
         WHERE run_id = ? AND settings_sequence = ?
         LIMIT 1`,
      )
      .get(runId, normalized);
    if (
      effect === undefined &&
      terminal === undefined &&
      suspension === undefined &&
      settings === undefined
    )
      return;
    throw conflict(
      "RUN_EVENT_SEQUENCE_CONFLICT",
      `run ${runId} sequence ${normalized} is already projected`,
    );
  }

  private assertNoPendingEffects(runId: RunId): void {
    const unsettled = this.listEffects(runId).filter(
      (effect) =>
        effect.outcome === undefined || effect.reviewStatus === "pending",
    );
    if (unsettled.length === 0) return;
    throw conflict(
      "RUN_SUSPENSION_EFFECT_PENDING",
      `run ${runId} has unsettled effect(s): ${unsettled
        .map((effect) => effect.stepId)
        .join(", ")}`,
    );
  }

  private assertNotCancellationLocked(runId: RunId): void {
    const state = this.driver
      .prepareState<
        [string, string],
        { readonly admission_cancelled: number; readonly status: string | null }
      >(
        `SELECT
           EXISTS (
             SELECT 1
             FROM execution_admission_cancellations
             WHERE run_id = ?
           ) AS admission_cancelled,
           (SELECT status FROM agent_runs WHERE id = ?) AS status`,
      )
      .get(runId, runId);
    if (
      state?.admission_cancelled === 1 ||
      (state?.status !== null &&
        state?.status !== undefined &&
        isCancelLockedAgentRunStatus(state.status))
    ) {
      throw conflict(
        "RUN_CANCELLATION_CONFLICT",
        `run ${runId} is cancellation-locked and cannot cross an executable lifecycle boundary`,
      );
    }
  }
}

function epochFromRow(row: EpochRow): RunLifecycleEpoch {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    openedAt: row.opened_at,
    ...(row.opened_event_id !== null
      ? { openedEventId: row.opened_event_id }
      : {}),
    ...(row.reopened_from_epoch !== null
      ? { reopenedFromEpoch: row.reopened_from_epoch }
      : {}),
    ...(row.reopen_reason !== null ? { reopenReason: row.reopen_reason } : {}),
  };
}

function terminalFromRow(row: TerminalRow): DurableRunTerminalRecord {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    status: row.status,
    exitCode: row.exit_code,
    stopReason: row.stop_reason,
    finalMessage: row.final_message,
    usage: parseUsage(row.usage_json),
    lastSequence: row.last_sequence,
    finishedAt: row.finished_at,
    eventId: row.event_id,
  };
}

function suspensionFromRow(row: SuspensionRow): DurableRunSuspension {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    eventId: row.suspension_event_id,
    suspensionSequence: row.suspension_sequence,
    reason: row.reason,
    suspendedAt: row.suspended_at,
    ...(row.resume_event_id !== null
      ? { resumeEventId: row.resume_event_id }
      : {}),
    ...(row.resume_sequence !== null
      ? { resumeSequence: row.resume_sequence }
      : {}),
    ...(row.resume_reason !== null ? { resumeReason: row.resume_reason } : {}),
    ...(row.resumed_at !== null ? { resumedAt: row.resumed_at } : {}),
    ...(row.activation_event_id !== null
      ? { activationEventId: row.activation_event_id }
      : {}),
    ...(row.activation_sequence !== null
      ? { activationSequence: row.activation_sequence }
      : {}),
    ...(row.activated_at !== null ? { activatedAt: row.activated_at } : {}),
  };
}

function runtimeSettingsFromRow(
  row: RuntimeSettingsRow,
): DurableRunRuntimeSettings {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    eventId: row.settings_event_id,
    eventSequence: row.settings_sequence,
    previousSettingsEventId: row.previous_settings_event_id,
    rollbackOfSettingsEventId: row.rollback_of_settings_event_id,
    reason: row.reason,
    changedAt: row.changed_at,
    permissionMode: row.permission_mode,
    prePlanMode: row.pre_plan_mode,
    autoModeActive: row.auto_mode_active === 1,
    bypassPermissionsWorkspace: row.bypass_permissions_workspace,
    model: row.model,
    provider: row.provider,
    profile: row.profile,
    reasoningEffort: row.reasoning_effort,
    modelVerbosity: row.model_verbosity,
    serviceTier: row.service_tier,
    hooksDisabled: row.hooks_disabled === 1,
  };
}

function runtimeSettingsEqual(
  left: RunRuntimeSettingsSnapshot,
  right: RunRuntimeSettingsSnapshot,
): boolean {
  return (
    left.permissionMode === right.permissionMode &&
    left.prePlanMode === right.prePlanMode &&
    left.autoModeActive === right.autoModeActive &&
    left.bypassPermissionsWorkspace === right.bypassPermissionsWorkspace &&
    left.model === right.model &&
    left.provider === right.provider &&
    left.profile === right.profile &&
    left.reasoningEffort === right.reasoningEffort &&
    left.modelVerbosity === right.modelVerbosity &&
    left.serviceTier === right.serviceTier &&
    left.hooksDisabled === right.hooksDisabled
  );
}

function effectFromRow(row: EffectRow): DurableRunEffect {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    epoch: row.epoch,
    ...(row.child_run_id !== null ? { childRunId: row.child_run_id } : {}),
    sessionId: row.session_id,
    callId: row.call_id,
    toolName: row.tool_name,
    recoveryCategory: row.recovery_category,
    ...(row.idempotency_key !== null
      ? { idempotencyKey: row.idempotency_key }
      : {}),
    intentDigest: row.intent_digest,
    intentEventId: row.intent_event_id,
    intentSequence: row.intent_sequence,
    intentAt: row.intent_at,
    effectFormatVersion: row.effect_format_version,
    ...(row.minimum_reader_runtime !== null
      ? { minimumReaderRuntime: row.minimum_reader_runtime }
      : {}),
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
    ...(row.effect_boundary !== null
      ? { effectBoundary: row.effect_boundary }
      : {}),
    ...(row.no_effect_evidence_json !== null
      ? {
          noEffectEvidence: parseJson(
            row.no_effect_evidence_json,
          ) as EffectNoEffectProof,
        }
      : {}),
    ...(row.result_event_id !== null
      ? { resultEventId: row.result_event_id }
      : {}),
    ...(row.result_sequence !== null
      ? { resultSequence: row.result_sequence }
      : {}),
    ...(row.result_digest !== null ? { resultDigest: row.result_digest } : {}),
    ...(row.result_json !== null ? { result: parseJson(row.result_json) } : {}),
    ...(row.evidence_json !== null
      ? { evidence: parseJson(row.evidence_json) }
      : {}),
    ...(row.unknown_reason !== null
      ? { unknownReason: row.unknown_reason }
      : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    reviewStatus: row.review_status ?? "none",
    ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.reviewed_by !== null ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.review_resolution !== null
      ? { reviewResolution: row.review_resolution }
      : {}),
    ...(row.review_event_id !== null
      ? { reviewEventId: row.review_event_id }
      : {}),
    ...(row.review_evidence_json !== null
      ? { reviewEvidence: parseJson(row.review_evidence_json) }
      : {}),
    ...(row.review_resolution_version === 1 &&
    row.review_disposition !== null &&
    row.review_actor_kind !== null &&
    row.review_actor_id !== null &&
    row.review_evidence_kind !== null &&
    row.review_evidence_ref !== null &&
    row.review_evidence_sha256 !== null &&
    row.review_status !== null &&
    row.reviewed_at !== null
      ? {
          review: {
            version: 1,
            kind: "effect_review_resolution",
            disposition: row.review_disposition,
            actorKind: row.review_actor_kind,
            actorId: row.review_actor_id,
            evidenceKind: row.review_evidence_kind,
            evidenceRef: row.review_evidence_ref,
            evidenceSha256: row.review_evidence_sha256,
            reviewedAt: row.reviewed_at,
            workflowStatus: row.review_status,
            ...(row.review_domain_action !== null
              ? { domainAction: row.review_domain_action }
              : {}),
          } satisfies EffectReviewResolution,
        }
      : {}),
    ...(row.legacy_review_json !== null
      ? { legacyReview: parseJson(row.legacy_review_json) }
      : {}),
  };
}

function journalBindingFromRow(row: JournalBindingRow): RunJournalBinding {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    childRunId: row.child_run_id,
    sessionId: row.session_id,
    sourcePath: row.source_path,
    active: row.active === 1,
    ...(row.first_available_sequence !== null
      ? { firstAvailableSequence: row.first_available_sequence }
      : {}),
    ...(row.last_sequence !== null ? { lastSequence: row.last_sequence } : {}),
    ...(row.retired_through_sequence !== null
      ? { retiredThroughSequence: row.retired_through_sequence }
      : {}),
    ...(row.gap_reason !== null ? { gapReason: row.gap_reason } : {}),
    ...(row.gap_observed_at !== null
      ? { gapObservedAt: row.gap_observed_at }
      : {}),
    ...(row.authoritative_source_sha256 !== null
      ? { authoritativeSourceSha256: row.authoritative_source_sha256 }
      : {}),
    ...(row.authoritative_source_size_bytes !== null
      ? { authoritativeSourceSizeBytes: row.authoritative_source_size_bytes }
      : {}),
    ...(row.authoritative_source_mtime_ms !== null
      ? { authoritativeSourceMtimeMs: row.authoritative_source_mtime_ms }
      : {}),
    ...(row.journal_format !== null
      ? { journalFormat: row.journal_format }
      : {}),
    ...(row.minimum_reader_runtime !== null
      ? { minimumReaderRuntime: row.minimum_reader_runtime }
      : {}),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}

function effectIntentContent(
  effect:
    | DurableRunEffect
    | {
        readonly runId: RunId;
        readonly epoch: number;
        readonly stepId: string;
        readonly childRunId?: RunId;
        readonly sessionId: string;
        readonly callId?: string;
        readonly toolName: string;
        readonly recoveryCategory: ToolRecoveryCategory;
        readonly idempotencyKey?: string;
        readonly intentDigest: string;
        readonly eventId: string;
        readonly eventSequence: number;
        readonly intentAt: string;
        readonly effectFormatVersion?: 1 | 2;
        readonly minimumReaderRuntime?: string;
      },
): string {
  const formatVersion =
    effect.effectFormatVersion ?? EFFECT_EVIDENCE_FORMAT_VERSION;
  return stableStringify({
    runId: effect.runId,
    epoch: effect.epoch,
    stepId: effect.stepId,
    childRunId: effect.childRunId ?? null,
    sessionId: effect.sessionId,
    callId: effect.callId ?? effect.stepId,
    toolName: effect.toolName,
    recoveryCategory: effect.recoveryCategory,
    idempotencyKey: effect.idempotencyKey ?? null,
    intentDigest: effect.intentDigest,
    eventId: "intentEventId" in effect ? effect.intentEventId : effect.eventId,
    eventSequence:
      "intentSequence" in effect ? effect.intentSequence : effect.eventSequence,
    intentAt: effect.intentAt,
    effectFormatVersion: formatVersion,
    minimumReaderRuntime:
      effect.minimumReaderRuntime ??
      (formatVersion === EFFECT_EVIDENCE_FORMAT_VERSION
        ? EFFECT_EVIDENCE_MINIMUM_READER_RUNTIME
        : null),
  });
}

function effectOutcomeContent(
  effect:
    | DurableRunEffect
    | {
        readonly outcome: EffectOutcome;
        readonly eventId: string;
        readonly eventSequence: number;
        readonly resultDigest?: string;
        readonly result?: unknown;
        readonly evidence?: unknown;
        readonly effectBoundary?: EffectBoundary;
        readonly noEffectEvidence?: EffectNoEffectProof;
        readonly completedAt: string;
        readonly unknownReason?: string;
      },
): string {
  const durable = "intentEventId" in effect;
  return stableStringify({
    outcome: effect.outcome,
    eventId: durable ? effect.resultEventId : effect.eventId,
    eventSequence: durable ? effect.resultSequence : effect.eventSequence,
    resultDigest: effect.resultDigest ?? null,
    result: effect.result ?? null,
    evidence: effect.evidence ?? null,
    effectBoundary: effect.effectBoundary ?? null,
    noEffectEvidence: effect.noEffectEvidence ?? null,
    completedAt: effect.completedAt,
    unknownReason: effect.unknownReason ?? null,
  });
}

function validateNoEffectEvidence(
  proof: EffectNoEffectProof | undefined,
): void {
  if (proof === undefined) return;
  if (
    proof.version !== 1 ||
    proof.kind !== "effect_no_effect_proof" ||
    (proof.evidenceKind !== "provider_receipt" &&
      proof.evidenceKind !== "idempotency_lookup" &&
      proof.evidenceKind !== "boundary_not_crossed")
  ) {
    throw new TypeError("no-effect evidence is invalid");
  }
  required(proof.evidenceRef, "noEffectEvidence.evidenceRef");
  required(proof.observedAt, "noEffectEvidence.observedAt");
  if (!/^[0-9a-f]{64}$/u.test(proof.evidenceSha256)) {
    throw new TypeError("no-effect evidence digest must be lowercase sha256");
  }
}

export function canonicalizeEffectReviewResolution(
  input: EffectReviewResolution,
): EffectReviewResolution {
  if (input === null || typeof input !== "object") {
    throw new TypeError("effect review resolution must be an object");
  }
  if (CANONICAL_EFFECT_REVIEW_RESOLUTIONS.has(input)) return input;
  const ownKeys = Reflect.ownKeys(input);
  for (const key of ownKeys) {
    if (!EFFECT_REVIEW_ALLOWED_KEYS.has(key)) {
      throw new TypeError("effect review resolution has unknown fields");
    }
  }
  const values = Object.create(null) as Record<string, unknown>;
  for (const key of EFFECT_REVIEW_REQUIRED_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        `effect review resolution ${key} must be an enumerable data field`,
      );
    }
    values[key] = descriptor.value;
  }
  const hasDomainAction = ownKeys.includes("domainAction");
  if (hasDomainAction) {
    const descriptor = Object.getOwnPropertyDescriptor(input, "domainAction");
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        "effect review resolution domainAction must be an enumerable data field",
      );
    }
    values.domainAction = descriptor.value;
  }
  if (values.version !== 1 || values.kind !== "effect_review_resolution") {
    throw new TypeError("effect review resolution version/kind is invalid");
  }
  if (!EFFECT_REVIEW_DISPOSITIONS.includes(values.disposition as never)) {
    throw new TypeError("effect review disposition is invalid");
  }
  if (!EFFECT_REVIEW_ACTOR_KINDS.includes(values.actorKind as never)) {
    throw new TypeError("effect review actor kind is invalid");
  }
  if (!EFFECT_REVIEW_EVIDENCE_KINDS.includes(values.evidenceKind as never)) {
    throw new TypeError("effect review evidence kind is invalid");
  }
  if (
    !EFFECT_REVIEW_WORKFLOW_STATUSES.includes(values.workflowStatus as never)
  ) {
    throw new TypeError("effect review workflow status is invalid");
  }
  if (
    hasDomainAction &&
    !EFFECT_REVIEW_DOMAIN_ACTIONS.includes(values.domainAction as never)
  ) {
    throw new TypeError("effect review domain action is invalid");
  }
  boundedRequiredUtf8(
    values.actorId,
    "review.actorId",
    EFFECT_REVIEW_ACTOR_ID_MAX_UTF8_BYTES,
  );
  boundedRequiredUtf8(
    values.evidenceRef,
    "review.evidenceRef",
    EFFECT_REVIEW_EVIDENCE_REF_MAX_UTF8_BYTES,
  );
  boundedRequiredUtf8(
    values.reviewedAt,
    "review.reviewedAt",
    EFFECT_REVIEW_REVIEWED_AT_MAX_UTF8_BYTES,
  );
  if (
    typeof values.evidenceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(values.evidenceSha256)
  ) {
    throw new TypeError("review evidence digest must be lowercase sha256");
  }
  if (
    values.actorKind === "system_settlement" &&
    values.evidenceKind === "operator_evidence"
  ) {
    throw new TypeError("system settlement cannot assert operator evidence");
  }
  if (values.workflowStatus === "pending") {
    if (values.disposition !== "remains_unknown" || hasDomainAction) {
      throw new TypeError(
        "pending effect review must remain unknown without a domain action",
      );
    }
  } else {
    const isCommittedResolution =
      values.workflowStatus === "resolved" &&
      values.disposition === "confirmed_committed" &&
      values.domainAction === "mark_completed";
    const isNoEffectResolution =
      values.workflowStatus === "resolved" &&
      values.disposition === "confirmed_no_effect" &&
      values.domainAction === "retry_new_attempt";
    const isAbandonedResolution =
      values.workflowStatus === "abandoned" &&
      values.disposition === "remains_unknown" &&
      values.domainAction === "abandon_item";
    if (
      !isCommittedResolution &&
      !isNoEffectResolution &&
      !isAbandonedResolution
    ) {
      throw new TypeError(
        "terminal effect review disposition, workflow status, and domain action disagree",
      );
    }
  }
  const canonical = Object.create(null) as Record<string, unknown>;
  for (const key of EFFECT_REVIEW_REQUIRED_KEYS) {
    Object.defineProperty(canonical, key, {
      value: values[key],
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  if (hasDomainAction) {
    Object.defineProperty(canonical, "domainAction", {
      value: values.domainAction,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  const canonicalJson = stableStringify(canonical);
  const journalJson = stableStringify(redactSecretsInValue(canonical));
  if (journalJson !== canonicalJson) {
    throw new TypeError(
      "effect review resolution contains content unsafe for canonical journaling",
    );
  }
  if (
    Buffer.byteLength(canonicalJson, "utf8") >
    EFFECT_REVIEW_PAYLOAD_MAX_UTF8_BYTES
  ) {
    throw new TypeError("effect review resolution payload is too large");
  }
  Object.freeze(canonical);
  CANONICAL_EFFECT_REVIEW_RESOLUTIONS.add(canonical);
  return canonical as unknown as EffectReviewResolution;
}

function boundedRequiredUtf8(
  value: unknown,
  name: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new TypeError(`${name} contains ill-formed UTF-16`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function isWellFormedUtf16(value: string): boolean {
  const highSurrogateStart = 0xd800;
  const highSurrogateEnd = 0xdbff;
  const lowSurrogateStart = 0xdc00;
  const lowSurrogateEnd = 0xdfff;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= highSurrogateStart && codeUnit <= highSurrogateEnd) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < lowSurrogateStart || next > lowSurrogateEnd) return false;
      index += 1;
    } else if (codeUnit >= lowSurrogateStart && codeUnit <= lowSurrogateEnd) {
      return false;
    }
  }
  return true;
}

function terminalContent(result: RunTerminalResult): string {
  return stableStringify({
    runId: result.runId,
    status: result.status,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    finalMessage: result.finalMessage,
    usage: result.usage,
    lastSequence: result.lastSequence,
    finishedAt: result.finishedAt,
  });
}

function parseUsage(value: string | null): RunUsageTotals | null {
  if (value === null) return null;
  const parsed = parseJson(value) as Partial<RunUsageTotals>;
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "costUsd",
  ] as const) {
    if (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field])) {
      throw new Error(`invalid durable terminal usage field: ${field}`);
    }
  }
  return parsed as RunUsageTotals;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function serializeOptionalJson(value: unknown): string | null {
  return value === undefined ? null : stableStringify(value);
}

function validateBounds(
  firstAvailableSequence: number | undefined,
  lastSequence: number | undefined,
  retiredThroughSequence: number | undefined,
): void {
  const first = optionalPositiveInteger(
    firstAvailableSequence,
    "firstAvailableSequence",
  );
  const last = optionalPositiveInteger(lastSequence, "lastSequence");
  if (first !== null && last !== null && last < first) {
    throw new RangeError("lastSequence must be >= firstAvailableSequence");
  }
  if (
    retiredThroughSequence !== undefined &&
    first !== null &&
    retiredThroughSequence >= first
  ) {
    throw new RangeError(
      "firstAvailableSequence must be after retiredThroughSequence",
    );
  }
}

function required(value: string, name: string): string {
  if (value.trim().length === 0)
    throw new TypeError(`${name} must not be empty`);
  return value;
}

function optionalRequired(
  value: string | undefined,
  name: string,
): string | null {
  return value === undefined ? null : required(value, name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeFiniteNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(name + " must be a non-negative finite number");
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function optionalPositiveInteger(
  value: number | undefined,
  name: string,
): number | null {
  return value === undefined ? null : positiveInteger(value, name);
}

function nullablePositiveInteger(
  value: number | null,
  name: string,
): number | null {
  return value === null ? null : positiveInteger(value, name);
}

function conflict(
  code: RunDurabilityConflictCode,
  message: string,
): RunDurabilityConflictError {
  return new RunDurabilityConflictError(code, message);
}
