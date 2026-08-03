import { basename, dirname } from "node:path";

import type {
  AgenCRecoveryMutationAdapter,
  RecoveryMutationCommand,
  RecoveryMutationContext,
} from "../bin/state-cli.js";
import {
  withPreparedPinnedRolloutRun,
  type BackfillPinnedRolloutSource,
  type PreparedPinnedRolloutRun,
} from "./backfill.js";
import {
  CanonicalJournalIntegrityError,
  HARD_MAX_RECOVERY_SOURCE_BYTES,
  HARD_MAX_RECOVERY_SCAN_MILLISECONDS,
  MAX_RECOVERY_SOURCES_PER_RUN,
  RecoveryOperationalError,
  assertRecoverySha256,
} from "./recovery-contract.js";
import {
  recoveryFailureSourcePath,
  withPinnedRecoverySourceDigest,
  type RecoveryDescriptorBudget,
  type RecoveryFileLimitOverrides,
} from "./recovery-file.js";
import {
  StateRecoveryIncidentRepository,
  type RecoveryDeferredBlock,
  type RecoveryQuarantineIncident,
} from "./recovery-incidents.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

const RECOVERY_RETRY_DELAY_MILLISECONDS = 60_000;

export interface RecoveryMutationAdapterOptions {
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
  /** Diagnostic seam invoked at the final boundary of the outer transaction. */
  readonly beforeTransactionReturn?: () => void;
}

/**
 * E1a's strict replay implementation. It remains opt-in until A2b wires every
 * executable selector to the quarantine/deferred/abandonment exclusions.
 */
export function createRecoveryMutationAdapter(
  options: RecoveryMutationAdapterOptions = {},
): AgenCRecoveryMutationAdapter {
  return Object.freeze({
    rescan: (
      driver: StateSqliteDriver,
      command: RecoveryMutationCommand,
      context: RecoveryMutationContext,
    ) => {
      requireMutation(command, "quarantine", "rescan");
      rescanQuarantine(driver, command, context, options);
    },
    retry: (
      driver: StateSqliteDriver,
      command: RecoveryMutationCommand,
      context: RecoveryMutationContext,
    ) => {
      requireMutation(command, "deferred", "retry");
      retryDeferred(driver, command, context, options);
    },
    abandon: (
      driver: StateSqliteDriver,
      command: RecoveryMutationCommand,
      context: RecoveryMutationContext,
    ) => {
      abandonRecovery(driver, command, context, options);
    },
  });
}

function rescanQuarantine(
  driver: StateSqliteDriver,
  command: RecoveryMutationCommand,
  context: RecoveryMutationContext,
  options: RecoveryMutationAdapterOptions,
): void {
  const repository = new StateRecoveryIncidentRepository(driver);
  const incident = requireQuarantine(repository, command.id);
  const confirmedSourceSha256 = assertRecoverySha256(
    command.confirmedSourceSha256 ?? "",
    "confirmedSourceSha256",
  );
  try {
    withEvidenceReplayRun(driver, incident, options, (prepared, sources) =>
      driver.transactionImmediate(() => {
        const results = prepared.projectAll();
        const sourceIndex = sources.findIndex(
          ({ rolloutPath }) => rolloutPath === incident.sourcePath,
        );
        const replay = results[sourceIndex]?.proof;
        if (replay === undefined) {
          throw new Error("recovery run omitted the selected quarantine source");
        }
        if (replay.sourceSha256 !== confirmedSourceSha256) {
          throw new Error(
            "confirmed source digest does not match descriptor-pinned replay",
          );
        }
        repository.repairQuarantine(
          {
            quarantineId: incident.quarantineId,
            confirmedSourceSha256,
            actor: context.actor,
            note: "descriptor-pinned strict rescan succeeded",
            resolvedAtMs: operatedAtMilliseconds(context),
          },
          () => ({ sourceSha256: replay.sourceSha256 }),
        );
        options.beforeTransactionReturn?.();
        prepared.assertPinned();
      }),
    );
  } catch (error) {
    persistReplayFailure(
      driver,
      failureEvidence(repository, incident, error),
      context,
      options,
      error,
    );
    throw error;
  }
}

function retryDeferred(
  driver: StateSqliteDriver,
  command: RecoveryMutationCommand,
  context: RecoveryMutationContext,
  options: RecoveryMutationAdapterOptions,
): void {
  const repository = new StateRecoveryIncidentRepository(driver);
  const block = requireDeferred(repository, command.id);
  try {
    withEvidenceReplayRun(driver, block, options, (prepared) =>
      driver.transactionImmediate(() => {
        prepared.projectAll();
        repository.retryDeferred(
          {
            blockId: block.blockId,
            actor: context.actor,
            note: "descriptor-pinned strict retry succeeded",
            resolvedAtMs: operatedAtMilliseconds(context),
          },
          () => {},
        );
        options.beforeTransactionReturn?.();
        prepared.assertPinned();
      }),
    );
  } catch (error) {
    persistReplayFailure(
      driver,
      failureEvidence(repository, block, error),
      context,
      options,
      error,
    );
    throw error;
  }
}

function abandonRecovery(
  driver: StateSqliteDriver,
  command: RecoveryMutationCommand,
  context: RecoveryMutationContext,
  options: RecoveryMutationAdapterOptions,
): void {
  if (command.action !== "abandon") {
    throw new Error("recovery abandon adapter received another action");
  }
  const repository = new StateRecoveryIncidentRepository(driver);
  const expectedRunId = command.confirmedRunId ?? "";
  const expectedSourceSha256 = assertRecoverySha256(
    command.confirmedSourceSha256 ?? "",
    "confirmedSourceSha256",
  );
  const abandonedAtMs = operatedAtMilliseconds(context);
  if (command.collection === "quarantine") {
    const evidence = requireQuarantine(repository, command.id);
    try {
      withEvidenceDigest(driver, evidence, options, (source, assertPinned) =>
        driver.transactionImmediate(() => {
          assertAbandonmentEvidence(
            evidence,
            source.sourceSha256,
            expectedRunId,
            expectedSourceSha256,
          );
          repository.abandonQuarantine({
            quarantineId: evidence.quarantineId,
            expectedRunId,
            expectedSourceSha256,
            verifiedCurrentSourceSha256: source.sourceSha256,
            actor: context.actor,
            reason: command.reason ?? "operator abandonment",
            abandonedAtMs,
          });
          options.beforeTransactionReturn?.();
          assertPinned();
        }),
      );
    } catch (error) {
      persistReplayFailure(driver, evidence, context, options, error);
      throw error;
    }
  } else {
    const evidence = requireDeferred(repository, command.id);
    try {
      withEvidenceDigest(driver, evidence, options, (source, assertPinned) =>
        driver.transactionImmediate(() => {
          assertAbandonmentEvidence(
            evidence,
            source.sourceSha256,
            expectedRunId,
            expectedSourceSha256,
          );
          repository.abandonDeferred({
            blockId: evidence.blockId,
            expectedRunId,
            confirmedSourceSha256: source.sourceSha256,
            actor: context.actor,
            reason: command.reason ?? "operator abandonment",
            abandonedAtMs,
          });
          options.beforeTransactionReturn?.();
          assertPinned();
        }),
      );
    } catch (error) {
      persistReplayFailure(driver, evidence, context, options, error);
      throw error;
    }
  }
}

function assertAbandonmentEvidence(
  evidence: RecoveryQuarantineIncident | RecoveryDeferredBlock,
  currentSourceSha256: string,
  expectedRunId: string,
  expectedSourceSha256: string,
): void {
  if (evidence.runId !== expectedRunId) {
    throw new Error("confirmed run id does not match recovery evidence");
  }
  if (currentSourceSha256 !== expectedSourceSha256) {
    throw new Error(
      "confirmed source digest does not match descriptor-pinned source",
    );
  }
}

function withEvidenceReplayRun<T>(
  driver: StateSqliteDriver,
  evidence: RecoveryQuarantineIncident | RecoveryDeferredBlock,
  options: RecoveryMutationAdapterOptions,
  operation: (
    prepared: PreparedPinnedRolloutRun,
    sources: readonly BackfillPinnedRolloutSource[],
  ) => T,
): T {
  const repository = new StateRecoveryIncidentRepository(driver);
  const activeSources = repository.listActiveSourcesForRun(evidence.runId);
  if (activeSources.length > MAX_RECOVERY_SOURCES_PER_RUN) {
    throw new RecoveryOperationalError(
      "concurrency_limit",
      `run ${evidence.runId} exceeds the ${MAX_RECOVERY_SOURCES_PER_RUN}-source recovery limit`,
      "RECOVERY_SOURCE_LIMIT",
    );
  }
  const sources = activeSources.map((source) => ({
    sessionId: sessionIdFromSourcePath(source.sourcePath),
    rolloutPath: source.sourcePath,
    expectedRunId: evidence.runId,
  }));
  if (!sources.some(({ rolloutPath }) => rolloutPath === evidence.sourcePath)) {
    throw new Error("active recovery evidence omitted its selected source");
  }
  return withPreparedPinnedRolloutRun({
    projectDir: driver.projectDir,
    sources,
    threads: new StateThreadRepository(driver),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.descriptorBudget !== undefined
      ? { descriptorBudget: options.descriptorBudget }
      : {}),
    ...(options.nowMilliseconds !== undefined
      ? { nowMilliseconds: options.nowMilliseconds }
      : {}),
  }, (prepared) => operation(prepared, prepared.sources));
}

function withEvidenceDigest<T>(
  driver: StateSqliteDriver,
  evidence: RecoveryEvidenceSource,
  options: RecoveryMutationAdapterOptions,
  operation: (digest: {
    readonly sourceSha256: string;
    readonly sourceByteLength: number;
    readonly sourceMtimeMs: number;
  }, assertPinned: () => void) => T,
): T {
  return withPinnedRecoverySourceDigest({
    projectDir: driver.projectDir,
    sessionId: sessionIdFromSourcePath(evidence.sourcePath),
    sourcePath: evidence.sourcePath,
    limits: {
      ...options.limits,
      maxSourceBytes: HARD_MAX_RECOVERY_SOURCE_BYTES,
      maxReadBytes: HARD_MAX_RECOVERY_SOURCE_BYTES,
      maxScanMilliseconds: HARD_MAX_RECOVERY_SCAN_MILLISECONDS,
    },
    ...(options.descriptorBudget !== undefined
      ? { descriptorBudget: options.descriptorBudget }
      : {}),
    ...(options.nowMilliseconds !== undefined
      ? { nowMilliseconds: options.nowMilliseconds }
      : {}),
  }, operation);
}

function persistReplayFailure(
  driver: StateSqliteDriver,
  evidence: RecoveryEvidenceSource,
  context: RecoveryMutationContext,
  options: RecoveryMutationAdapterOptions,
  error: unknown,
): void {
  const repository = new StateRecoveryIncidentRepository(driver);
  const failedAtMs = operatedAtMilliseconds(context);
  if (error instanceof CanonicalJournalIntegrityError) {
    try {
      withEvidenceDigest(driver, evidence, options, (source, assertPinned) =>
        driver.transactionImmediate(() => {
          repository.recordCanonicalJournalFailure({
            runId: evidence.runId,
            sourceKind: evidence.sourceKind,
            sourcePath: evidence.sourcePath,
            error,
            sourceSizeBytes: source.sourceByteLength,
            sourceMtimeMs: Math.trunc(source.sourceMtimeMs),
            sourceSha256: source.sourceSha256,
            detectedAtMs: failedAtMs,
          });
          options.beforeTransactionReturn?.();
          assertPinned();
        }),
      );
    } catch (digestError) {
      if (!(digestError instanceof RecoveryOperationalError)) {
        throw digestError;
      }
      recordOperationalFailureInTransaction(
        driver,
        repository,
        evidence,
        failedAtMs,
        digestError,
      );
    }
    return;
  }
  if (error instanceof RecoveryOperationalError) {
    try {
      withEvidenceDigest(driver, evidence, options, (_source, assertPinned) =>
        driver.transactionImmediate(() => {
          recordOperationalFailure(repository, evidence, failedAtMs, error);
          options.beforeTransactionReturn?.();
          assertPinned();
        }),
      );
    } catch (leaseError) {
      if (!(leaseError instanceof RecoveryOperationalError)) throw leaseError;
      // Unsupported platforms, live writers, descriptor exhaustion, and hard
      // evidence ceilings cannot supply a retained digest lease. Persist their
      // typed operational block without inventing source evidence.
      recordOperationalFailureInTransaction(
        driver,
        repository,
        evidence,
        failedAtMs,
        error,
      );
    }
  }
}

function recordOperationalFailureInTransaction(
  driver: StateSqliteDriver,
  repository: StateRecoveryIncidentRepository,
  evidence: RecoveryEvidenceSource,
  failedAtMs: number,
  error: RecoveryOperationalError,
): void {
  driver.transactionImmediate(() => {
    recordOperationalFailure(repository, evidence, failedAtMs, error);
  });
}

function recordOperationalFailure(
  repository: StateRecoveryIncidentRepository,
  evidence: RecoveryEvidenceSource,
  failedAtMs: number,
  error: RecoveryOperationalError,
): void {
  repository.recordDeferred({
    runId: evidence.runId,
    sourceKind: evidence.sourceKind,
    sourcePath: evidence.sourcePath,
    reasonCode: error.reasonCode,
    errorClass: error.errorClass,
    safeDetail: { message: error.message },
    failedAtMs,
    nextRetryMs: failedAtMs + RECOVERY_RETRY_DELAY_MILLISECONDS,
  });
}

interface RecoveryEvidenceSource {
  readonly runId: string;
  readonly sourceKind: RecoveryQuarantineIncident["sourceKind"];
  readonly sourcePath: string;
}

function failureEvidence(
  repository: StateRecoveryIncidentRepository,
  fallback: RecoveryEvidenceSource,
  error: unknown,
): RecoveryEvidenceSource {
  const sourcePath = recoveryFailureSourcePath(error);
  const source = repository
    .listActiveSourcesForRun(fallback.runId)
    .find((candidate) => candidate.sourcePath === sourcePath);
  return source === undefined
    ? fallback
    : {
        runId: fallback.runId,
        sourceKind: source.sourceKind,
        sourcePath: source.sourcePath,
      };
}

function requireQuarantine(
  repository: StateRecoveryIncidentRepository,
  quarantineId: string,
): RecoveryQuarantineIncident {
  const incident = repository.getQuarantine(quarantineId);
  if (incident === undefined) {
    throw new Error(`recovery quarantine evidence not found: ${quarantineId}`);
  }
  return incident;
}

function requireDeferred(
  repository: StateRecoveryIncidentRepository,
  blockId: string,
): RecoveryDeferredBlock {
  const block = repository.getDeferred(blockId);
  if (block === undefined) {
    throw new Error(`recovery deferred evidence not found: ${blockId}`);
  }
  return block;
}

function requireMutation(
  command: RecoveryMutationCommand,
  collection: RecoveryMutationCommand["collection"],
  action: RecoveryMutationCommand["action"],
): void {
  if (command.collection !== collection || command.action !== action) {
    throw new Error(
      `recovery ${action} adapter requires the ${collection} collection`,
    );
  }
}

function sessionIdFromSourcePath(sourcePath: string): string {
  const sessionId = basename(dirname(sourcePath));
  if (sessionId.length === 0 || sessionId === "." || sessionId === "..") {
    throw new Error(
      `canonical recovery source has no session id: ${sourcePath}`,
    );
  }
  return sessionId;
}

function operatedAtMilliseconds(context: RecoveryMutationContext): number {
  const value = Date.parse(context.operatedAt);
  if (!Number.isFinite(value)) {
    throw new TypeError("recovery operation timestamp is invalid");
  }
  return value;
}
