import { basename, dirname } from "node:path";

import type {
  AgenCRecoveryMutationAdapter,
  RecoveryMutationCommand,
  RecoveryMutationContext,
} from "../bin/state-cli.js";
import { backfillPinnedRolloutFile } from "./backfill.js";
import {
  CanonicalJournalIntegrityError,
  RecoveryOperationalError,
  assertRecoverySha256,
} from "./recovery-contract.js";
import {
  hashPinnedRecoverySource,
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
    repository.repairQuarantine(
      {
        quarantineId: incident.quarantineId,
        confirmedSourceSha256,
        actor: context.actor,
        note: "descriptor-pinned strict rescan succeeded",
        resolvedAtMs: operatedAtMilliseconds(context),
      },
      (active) => {
        const replay = replayEvidence(driver, active, options);
        if (replay.sourceSha256 !== confirmedSourceSha256) {
          throw new Error(
            "confirmed source digest does not match descriptor-pinned replay",
          );
        }
        return { sourceSha256: replay.sourceSha256 };
      },
    );
  } catch (error) {
    persistReplayFailure(driver, incident, context, options, error);
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
    repository.retryDeferred(
      {
        blockId: block.blockId,
        actor: context.actor,
        note: "descriptor-pinned strict retry succeeded",
        resolvedAtMs: operatedAtMilliseconds(context),
      },
      (active) => {
        replayEvidence(driver, active, options);
      },
    );
  } catch (error) {
    persistReplayFailure(driver, block, context, options, error);
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
    assertAbandonmentEvidence(
      driver,
      evidence,
      expectedRunId,
      expectedSourceSha256,
      options,
    );
    repository.abandonQuarantine({
      quarantineId: evidence.quarantineId,
      expectedRunId,
      expectedSourceSha256,
      actor: context.actor,
      reason: command.reason ?? "operator abandonment",
      abandonedAtMs,
    });
  } else {
    const evidence = requireDeferred(repository, command.id);
    assertAbandonmentEvidence(
      driver,
      evidence,
      expectedRunId,
      expectedSourceSha256,
      options,
    );
    repository.abandonDeferred({
      blockId: evidence.blockId,
      expectedRunId,
      confirmedSourceSha256: expectedSourceSha256,
      actor: context.actor,
      reason: command.reason ?? "operator abandonment",
      abandonedAtMs,
    });
  }
}

function assertAbandonmentEvidence(
  driver: StateSqliteDriver,
  evidence: RecoveryQuarantineIncident | RecoveryDeferredBlock,
  expectedRunId: string,
  expectedSourceSha256: string,
  options: RecoveryMutationAdapterOptions,
): void {
  if (evidence.runId !== expectedRunId) {
    throw new Error("confirmed run id does not match recovery evidence");
  }
  const digest = hashEvidenceSource(driver, evidence, options);
  if (digest.sourceSha256 !== expectedSourceSha256) {
    throw new Error(
      "confirmed source digest does not match descriptor-pinned source",
    );
  }
}

function replayEvidence(
  driver: StateSqliteDriver,
  evidence: RecoveryQuarantineIncident | RecoveryDeferredBlock,
  options: RecoveryMutationAdapterOptions,
) {
  return backfillPinnedRolloutFile({
    projectDir: driver.projectDir,
    sessionId: sessionIdFromSourcePath(evidence.sourcePath),
    rolloutPath: evidence.sourcePath,
    threads: new StateThreadRepository(driver),
    expectedRunId: evidence.runId,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.descriptorBudget !== undefined
      ? { descriptorBudget: options.descriptorBudget }
      : {}),
    ...(options.nowMilliseconds !== undefined
      ? { nowMilliseconds: options.nowMilliseconds }
      : {}),
  }).proof;
}

function hashEvidenceSource(
  driver: StateSqliteDriver,
  evidence: RecoveryQuarantineIncident | RecoveryDeferredBlock,
  options: RecoveryMutationAdapterOptions,
) {
  return hashPinnedRecoverySource({
    projectDir: driver.projectDir,
    sessionId: sessionIdFromSourcePath(evidence.sourcePath),
    sourcePath: evidence.sourcePath,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.descriptorBudget !== undefined
      ? { descriptorBudget: options.descriptorBudget }
      : {}),
    ...(options.nowMilliseconds !== undefined
      ? { nowMilliseconds: options.nowMilliseconds }
      : {}),
  });
}

function persistReplayFailure(
  driver: StateSqliteDriver,
  evidence: RecoveryQuarantineIncident | RecoveryDeferredBlock,
  context: RecoveryMutationContext,
  options: RecoveryMutationAdapterOptions,
  error: unknown,
): void {
  const repository = new StateRecoveryIncidentRepository(driver);
  const failedAtMs = operatedAtMilliseconds(context);
  if (error instanceof CanonicalJournalIntegrityError) {
    const source = hashEvidenceSource(driver, evidence, options);
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
    return;
  }
  if (error instanceof RecoveryOperationalError) {
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
