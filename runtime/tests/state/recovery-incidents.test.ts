import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CanonicalJournalIntegrityError,
  MAX_RECOVERY_QUARANTINE_INCIDENTS_PER_RUN,
  MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT,
} from "./recovery-contract.js";
import {
  RecoveryCursorError,
  RecoveryHistoryLimitError,
  StateRecoveryIncidentRepository,
} from "./recovery-incidents.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let root = "";
let driver: StateSqliteDriver;
let repository: StateRecoveryIncidentRepository;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-recovery-incidents-"));
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  driver = openStateDatabases({ cwd, agencHome: join(root, "home") });
  repository = new StateRecoveryIncidentRepository(driver);
});

afterEach(() => {
  driver.close();
  rmSync(root, { recursive: true, force: true });
});

describe("StateRecoveryIncidentRepository", () => {
  it("persists typed strict-parser failures without copying source bytes", () => {
    const incident = repository.recordCanonicalJournalFailure({
      runId: "run-parser",
      sourceKind: "run_journal",
      sourcePath: "/journal/run-parser.jsonl",
      error: new CanonicalJournalIntegrityError(
        "malformed_json",
        "canonical journal contains malformed JSON",
        { lineNumber: 7, byteOffset: 512 },
      ),
      sourceSizeBytes: 1_024,
      sourceMtimeMs: 9,
      sourceSha256: "c".repeat(64),
      detectedAtMs: 10,
    });
    expect(incident).toMatchObject({
      reasonCode: "malformed_json",
      lineNumber: 7,
      byteOffset: 512,
    });
    expect(incident.safeDetail).not.toContain("source bytes");
  });

  it("preserves fractional descriptor mtime evidence without truncation", () => {
    const source = fractionalDescriptorEvidence(root);
    const incident = repository.recordQuarantine({
      ...quarantineInput(),
      sourcePath: source.path,
      sourceSizeBytes: source.sizeBytes,
      sourceMtimeMs: source.mtimeMs,
    });

    expect(Number.isInteger(source.mtimeMs)).toBe(false);
    expect(incident.sourceSizeBytes).toBe(source.sizeBytes);
    expect(incident.sourceMtimeMs).toBe(source.mtimeMs);
  });

  it("records identical detections idempotently and bounds distinct observations", () => {
    const first = repository.recordQuarantine(quarantineInput());
    const repeated = repository.recordQuarantine({
      ...quarantineInput(),
      detectedAtMs: 11,
    });
    expect(repeated).toMatchObject({
      quarantineId: first.quarantineId,
      detectionCount: 2,
      lastDetectedAtMs: 11,
    });

    for (
      let lineNumber = 2;
      lineNumber < MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT + 4;
      lineNumber += 1
    ) {
      repository.recordQuarantine({
        ...quarantineInput(),
        detectedAtMs: 10 + lineNumber,
        facts: { lineNumber, byteOffset: lineNumber * 100 },
      });
    }
    expect(
      driver
        .prepareState<[string], { count: number }>(
          `SELECT COUNT(*) AS count
           FROM run_recovery_quarantine_observations
           WHERE quarantine_id = ?`,
        )
        .get(first.quarantineId)?.count,
    ).toBe(MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT);
    expect(repository.getQuarantine(first.quarantineId)?.detectionCount).toBe(
      MAX_RECOVERY_QUARANTINE_OBSERVATIONS_PER_INCIDENT + 4,
    );
  });

  it("rolls strict replay failure back and links a repaired recurrence", () => {
    const first = repository.recordQuarantine(quarantineInput());
    expect(() =>
      repository.repairQuarantine(
        {
          quarantineId: first.quarantineId,
          confirmedSourceSha256: first.sourceSha256,
          actor: "operator-1",
          note: "strict replay",
          resolvedAtMs: 20,
        },
        () => {
          driver
            .prepareState<[string]>(
              `UPDATE run_recovery_quarantine
               SET detection_count = 99 WHERE quarantine_id = ?`,
            )
            .run(first.quarantineId);
          throw new Error("projection failed");
        },
      ),
    ).toThrow("projection failed");
    expect(repository.getQuarantine(first.quarantineId)).toMatchObject({
      state: "active",
      detectionCount: 1,
    });
    expect(repository.getQuarantine(first.quarantineId)).not.toHaveProperty(
      "confirmedSourceSha256",
    );

    const repaired = repository.repairQuarantine(
      {
        quarantineId: first.quarantineId,
        confirmedSourceSha256: first.sourceSha256,
        actor: "operator-1",
        note: "strict replay succeeded",
        resolvedAtMs: 21,
      },
      () => ({ sourceSha256: first.sourceSha256 }),
    );
    expect(repaired.state).toBe("repaired");
    const recurrence = repository.recordQuarantine({
      ...quarantineInput(),
      detectedAtMs: 30,
    });
    expect(recurrence.quarantineId).not.toBe(first.quarantineId);
    expect(recurrence.supersedesQuarantineId).toBe(first.quarantineId);
  });

  it("binds repair resolution to the current digest returned by strict replay", () => {
    const originalDigest = "a".repeat(64);
    const repairedDigest = "b".repeat(64);
    const staleConfirmation = repository.recordQuarantine({
      ...quarantineInput(),
      sourceSha256: originalDigest,
    });
    driver
      .prepareState(
        "CREATE TABLE recovery_test_exclusions (quarantine_id TEXT PRIMARY KEY)",
      )
      .run();
    driver
      .prepareState<[string]>(
        "INSERT INTO recovery_test_exclusions (quarantine_id) VALUES (?)",
      )
      .run(staleConfirmation.quarantineId);

    expect(() =>
      repository.repairQuarantine(
        {
          quarantineId: staleConfirmation.quarantineId,
          confirmedSourceSha256: originalDigest,
          actor: "operator-1",
          note: "stale digest must not clear exclusion",
          resolvedAtMs: 20,
        },
        () => {
          driver
            .prepareState<[string]>(
              "DELETE FROM recovery_test_exclusions WHERE quarantine_id = ?",
            )
            .run(staleConfirmation.quarantineId);
          return { sourceSha256: repairedDigest };
        },
      ),
    ).toThrow(/current source digest/i);
    expect(
      repository.getQuarantine(staleConfirmation.quarantineId)?.state,
    ).toBe("active");
    expect(
      driver
        .prepareState<[string], { count: number }>(
          "SELECT COUNT(*) AS count FROM recovery_test_exclusions WHERE quarantine_id = ?",
        )
        .get(staleConfirmation.quarantineId)?.count,
    ).toBe(1);

    const currentConfirmation = repository.recordQuarantine({
      ...quarantineInput(),
      sourcePath: "/journal/run-1-second.jsonl",
      sourceSha256: originalDigest,
      detectedAtMs: 21,
    });
    const repaired = repository.repairQuarantine(
      {
        quarantineId: currentConfirmation.quarantineId,
        confirmedSourceSha256: repairedDigest,
        actor: "operator-1",
        note: "strict replay bound the repaired source",
        resolvedAtMs: 22,
      },
      () => ({ sourceSha256: repairedDigest }),
    );
    expect(repaired).toMatchObject({
      state: "repaired",
      sourceSha256: originalDigest,
      confirmedSourceSha256: repairedDigest,
    });
    expect(() =>
      driver
        .prepareState<[string, string]>(
          `UPDATE run_recovery_quarantine
           SET confirmed_source_sha256 = ? WHERE quarantine_id = ?`,
        )
        .run("c".repeat(64), currentConfirmation.quarantineId),
    ).toThrow(/confirmation is immutable/);
  });

  it("requires exact confirmations and writes an immutable abandonment tombstone", () => {
    const incident = repository.recordQuarantine(quarantineInput());
    expect(() =>
      repository.abandonQuarantine({
        quarantineId: incident.quarantineId,
        expectedRunId: "wrong-run",
        expectedSourceSha256: incident.sourceSha256,
        actor: "operator-1",
        reason: "unrecoverable source",
        abandonedAtMs: 20,
      }),
    ).toThrow(/run id/);

    const abandonment = repository.abandonQuarantine({
      quarantineId: incident.quarantineId,
      expectedRunId: incident.runId,
      expectedSourceSha256: incident.sourceSha256,
      actor: "operator-1",
      reason: "unrecoverable source",
      abandonedAtMs: 20,
    });
    expect(abandonment).toMatchObject({
      runId: incident.runId,
      quarantineId: incident.quarantineId,
    });
    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "abandoned",
    );
    expect(() =>
      driver
        .prepareState<[string]>(
          "DELETE FROM run_recovery_abandonments WHERE abandonment_id = ?",
        )
        .run(abandonment.abandonmentId),
    ).toThrow(/cannot be deleted/);
    expect(() =>
      repository.recordQuarantine({
        ...quarantineInput(),
        detectedAtMs: 30,
      }),
    ).toThrow(/permanently abandoned/);
  });

  it("tracks operational retries separately from integrity incidents", () => {
    const first = repository.recordDeferred(deferredInput());
    const retried = repository.recordDeferred({
      ...deferredInput(),
      failedAtMs: 20,
      nextRetryMs: 40,
    });
    expect(retried).toMatchObject({
      blockId: first.blockId,
      attemptCount: 2,
      lastFailedAtMs: 20,
      nextRetryMs: 40,
    });
    expect(() =>
      repository.retryDeferred(
        {
          blockId: first.blockId,
          actor: "operator-1",
          note: "retry",
          resolvedAtMs: 50,
        },
        () => {
          throw new Error("still busy");
        },
      ),
    ).toThrow("still busy");
    expect(repository.getDeferred(first.blockId)?.state).toBe("active");

    const resolved = repository.retryDeferred(
      {
        blockId: first.blockId,
        actor: "operator-1",
        note: "strict retry succeeded",
        resolvedAtMs: 51,
      },
      () => {},
    );
    expect(resolved.state).toBe("resolved");
    const recurrence = repository.recordDeferred({
      ...deferredInput(),
      failedAtMs: 60,
      nextRetryMs: 70,
    });
    expect(recurrence.supersedesBlockId).toBe(first.blockId);
  });

  it("uses scope-bound keyset cursors and caps page size", () => {
    for (let index = 0; index < 101; index += 1) {
      repository.recordQuarantine({
        ...quarantineInput(),
        runId: `run-${index}`,
        sourcePath: `/journal/${index}.jsonl`,
        detectedAtMs: index,
      });
    }
    const first = repository.listQuarantines({ limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();
    const second = repository.listQuarantines({
      limit: 100,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.runId)).size,
    ).toBe(101);
    expect(() => repository.listQuarantines({ limit: 101 })).toThrow(
      /between 1 and 100/,
    );
    expect(() => repository.listDeferred({ cursor: first.nextCursor })).toThrow(
      RecoveryCursorError,
    );
    expect(() => repository.listQuarantines({ cursor: "not-json" })).toThrow(
      RecoveryCursorError,
    );
  });

  it("never prunes active evidence merely to make room", () => {
    for (
      let index = 0;
      index < MAX_RECOVERY_QUARANTINE_INCIDENTS_PER_RUN;
      index += 1
    ) {
      repository.recordQuarantine({
        ...quarantineInput(),
        sourcePath: `/journal/active-${index}.jsonl`,
        detectedAtMs: index,
      });
    }
    expect(() =>
      repository.recordQuarantine({
        ...quarantineInput(),
        sourcePath: "/journal/overflow.jsonl",
        detectedAtMs: MAX_RECOVERY_QUARANTINE_INCIDENTS_PER_RUN,
      }),
    ).toThrow(RecoveryHistoryLimitError);
    expect(repository.listQuarantines({ limit: 100 }).items).toHaveLength(100);
  });

  it("redacts and bounds diagnostic detail without storing source payloads", () => {
    const incident = repository.recordQuarantine({
      ...quarantineInput(),
      safeDetail: {
        XAI_API_KEY: "secret-value",
        context: "x".repeat(10_000),
      },
    });
    expect(incident.safeDetail).not.toContain("secret-value");
    expect(Buffer.byteLength(incident.safeDetail, "utf8")).toBeLessThanOrEqual(
      4_096,
    );
  });
});

function quarantineInput() {
  return {
    runId: "run-1",
    sourceKind: "run_journal" as const,
    sourcePath: "/journal/run-1.jsonl",
    reasonCode: "malformed_json" as const,
    safeDetail: { message: "invalid record" },
    sourceSizeBytes: 100,
    sourceMtimeMs: 5,
    sourceSha256: "a".repeat(64),
    detectedAtMs: 10,
    facts: { lineNumber: 1, byteOffset: 0 },
  };
}

function fractionalDescriptorEvidence(directory: string): {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
} {
  const path = join(directory, "descriptor-evidence.jsonl");
  writeFileSync(path, '{"type":"session_state","payload":{}}\n');
  const timestampSeconds = 1_700_000_000.123_456;
  utimesSync(path, timestampSeconds, timestampSeconds);
  const descriptor = openSync(path, "r");
  try {
    const stats = fstatSync(descriptor);
    return { path, sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}

function deferredInput() {
  return {
    runId: "run-deferred",
    sourceKind: "run_journal" as const,
    sourcePath: "/journal/run-deferred.jsonl",
    reasonCode: "database_busy" as const,
    errorClass: "SQLITE_BUSY",
    safeDetail: { message: "database unavailable" },
    failedAtMs: 10,
    nextRetryMs: 30,
  };
}
