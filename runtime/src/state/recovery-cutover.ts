import type { BackfillPinnedRolloutSource } from "./backfill.js";
import {
  CanonicalJournalIntegrityError,
  DEFAULT_MAX_STARTUP_RECOVERY_BYTES,
  DEFAULT_MAX_STARTUP_RECOVERY_MS,
  RecoveryOperationalError,
} from "./recovery-contract.js";
import {
  recoveryFailureSourcePath,
  withPinnedRecoverySourceDigest,
  type RecoveryDescriptorBudget,
  type RecoveryFileLimitOverrides,
} from "./recovery-file.js";
import {
  getRecoveryRunExclusion,
  storageUnavailableRecoveryExclusion,
  type RecoveryRunExclusion,
} from "./recovery-exclusions.js";
import { StateRecoveryIncidentRepository } from "./recovery-incidents.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

const RECOVERY_RETRY_DELAY_MILLISECONDS = 60_000;

export interface RecoveryCutoverOptions {
  readonly limits?: RecoveryFileLimitOverrides;
  readonly descriptorBudget?: RecoveryDescriptorBudget;
  readonly nowMilliseconds?: () => number;
  readonly startupBudget?: StartupRecoveryBudget;
}

/** One aggregate E1a byte/time ceiling shared by every startup entrypoint. */
export class StartupRecoveryBudget {
  readonly #startedAtMs: number;
  readonly #maxReadBytes: number;
  readonly #maxMilliseconds: number;
  readonly #nowMilliseconds: () => number;
  #readBytes = 0;

  constructor(
    options: {
      readonly maxReadBytes?: number;
      readonly maxMilliseconds?: number;
      readonly nowMilliseconds?: () => number;
    } = {},
  ) {
    this.#maxReadBytes = boundedStartupLimit(
      options.maxReadBytes,
      DEFAULT_MAX_STARTUP_RECOVERY_BYTES,
      "maxReadBytes",
    );
    this.#maxMilliseconds = boundedStartupLimit(
      options.maxMilliseconds,
      DEFAULT_MAX_STARTUP_RECOVERY_MS,
      "maxMilliseconds",
    );
    this.#nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.#startedAtMs = this.#nowMilliseconds();
  }

  remaining(): {
    readonly maxReadBytes: number;
    readonly maxMilliseconds: number;
  } {
    const elapsed = Math.max(0, this.#nowMilliseconds() - this.#startedAtMs);
    return {
      maxReadBytes: this.#maxReadBytes - this.#readBytes,
      maxMilliseconds: this.#maxMilliseconds - elapsed,
    };
  }

  consume(readBytes: number): void {
    if (!Number.isSafeInteger(readBytes) || readBytes < 0) {
      throw new TypeError("startup recovery byte consumption is invalid");
    }
    this.#readBytes += readBytes;
  }
}

export function persistRecoveryFailure(
  driver: StateSqliteDriver,
  runId: string,
  sources: readonly BackfillPinnedRolloutSource[],
  options: RecoveryCutoverOptions,
  error: unknown,
): RecoveryRunExclusion {
  const failedPath = recoveryFailureSourcePath(error);
  const source =
    sources.find(({ rolloutPath }) => rolloutPath === failedPath) ??
    sources[0]!;
  const failedAtMs = (options.nowMilliseconds ?? Date.now)();
  const repository = new StateRecoveryIncidentRepository(driver);

  if (error instanceof CanonicalJournalIntegrityError) {
    try {
      return withPinnedRecoverySourceDigest(
        {
          projectDir: driver.projectDir,
          sessionId: source.sessionId,
          sourcePath: source.rolloutPath,
          ...(options.descriptorBudget !== undefined
            ? { descriptorBudget: options.descriptorBudget }
            : {}),
          ...(options.nowMilliseconds !== undefined
            ? { nowMilliseconds: options.nowMilliseconds }
            : {}),
        },
        (digest, assertPinned) =>
          driver.transactionImmediate(() => {
            repository.recordCanonicalJournalFailure({
              runId,
              sourceKind: "run_journal",
              sourcePath: source.rolloutPath,
              error,
              sourceSizeBytes: digest.sourceByteLength,
              sourceMtimeMs: Math.trunc(digest.sourceMtimeMs),
              sourceSha256: digest.sourceSha256,
              detectedAtMs: failedAtMs,
            });
            assertPinned();
            return getRecoveryRunExclusion(driver, runId)!;
          }),
      );
    } catch (digestError) {
      if (!(digestError instanceof RecoveryOperationalError)) {
        return storageUnavailableRecoveryExclusion(
          runId,
          "recovery evidence storage is unavailable",
        );
      }
      return persistOperationalFailure(
        driver,
        repository,
        runId,
        source,
        failedAtMs,
        digestError,
      );
    }
  }

  const operational =
    error instanceof RecoveryOperationalError
      ? error
      : new RecoveryOperationalError(
          "projection_failure",
          "canonical recovery projection failed",
          error instanceof Error ? error.name : "RECOVERY_PROJECTION",
        );
  return persistOperationalFailure(
    driver,
    repository,
    runId,
    source,
    failedAtMs,
    operational,
  );
}

export function persistStartupBudgetExclusion(
  driver: StateSqliteDriver,
  runId: string,
  source: BackfillPinnedRolloutSource,
  reasonCode: "startup_byte_budget" | "startup_time_budget",
  failedAtMs: number,
): RecoveryRunExclusion {
  return persistOperationalFailure(
    driver,
    new StateRecoveryIncidentRepository(driver),
    runId,
    source,
    failedAtMs,
    new RecoveryOperationalError(
      reasonCode,
      "daemon startup recovery reached its bounded aggregate ceiling",
      "RECOVERY_STARTUP_BUDGET",
    ),
  );
}

function persistOperationalFailure(
  driver: StateSqliteDriver,
  repository: StateRecoveryIncidentRepository,
  runId: string,
  source: BackfillPinnedRolloutSource,
  failedAtMs: number,
  error: RecoveryOperationalError,
): RecoveryRunExclusion {
  try {
    driver.transactionImmediate(() => {
      repository.recordDeferred({
        runId,
        sourceKind: "run_journal",
        sourcePath: source.rolloutPath,
        reasonCode: error.reasonCode,
        errorClass: error.errorClass,
        safeDetail: { message: error.message },
        failedAtMs,
        nextRetryMs: failedAtMs + RECOVERY_RETRY_DELAY_MILLISECONDS,
      });
    });
    return getRecoveryRunExclusion(driver, runId)!;
  } catch {
    return storageUnavailableRecoveryExclusion(
      runId,
      "recovery evidence storage is unavailable",
    );
  }
}

function boundedStartupLimit(
  value: number | undefined,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? maximum;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    resolved > maximum
  ) {
    throw new TypeError(`${name} must be an integer in [1, ${maximum}]`);
  }
  return resolved;
}
