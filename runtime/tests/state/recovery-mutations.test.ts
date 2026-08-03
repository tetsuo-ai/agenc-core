import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runAgenCStateCli,
  type AgenCStateCliIo,
  type RecoveryMutationCommand,
} from "../bin/state-cli.js";
import { StateRecoveryIncidentRepository } from "./recovery-incidents.js";
import {
  createRecoveryMutationAdapter,
  type RecoveryMutationAdapterOptions,
} from "./recovery-mutations.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let root = "";
let driver: StateSqliteDriver;
let sessionId = "";
let rolloutPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-recovery-mutation-"));
  const cwd = join(root, "repository");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
  sessionId = "mutation-session";
  const sessionDirectory = join(driver.projectDir, "sessions", sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  rolloutPath = join(
    sessionDirectory,
    `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
  );
});

afterEach(() => {
  driver.close();
  rmSync(root, { recursive: true, force: true });
});

describe("E1a recovery mutation adapter", () => {
  it("repairs quarantine only after descriptor-pinned strict replay commits", async () => {
    const quarantinedRaw = "{not-json}\n";
    const raw = event(1) + event(2);
    writeFileSync(rolloutPath, quarantinedRaw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine({
      ...quarantineInput(quarantinedRaw),
    });
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const io = createIo();

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: sha256(raw),
        },
        io,
      ),
    ).resolves.toBe(0);

    expect(io.stderrText()).toBe("");
    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "repaired",
    );
    expect(projectedRows()).toBe(2);
  });

  it("holds every source lease through the outer repair transaction", async () => {
    const raw = event(1);
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    let competingLeaseResult = "";

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: sha256(raw),
        },
        createIo(),
        {
          beforeTransactionReturn: () => {
            competingLeaseResult = attemptCompetingSessionLease(
              `${rolloutPath}.lock`,
            );
          },
        },
      ),
    ).resolves.toBe(0);

    expect(competingLeaseResult).toBe("SessionLockedError");
    expect(attemptCompetingSessionLease(`${rolloutPath}.lock`)).toBe(
      "acquired",
    );
  });

  it("holds all run-source leases through one successful outer commit", async () => {
    const firstRaw = event(1);
    const secondRaw = event(1, "second", "second:event:1");
    writeFileSync(rolloutPath, firstRaw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(firstRaw));
    const second = addSource("mutation-pinned-second", secondRaw);
    repository.recordQuarantine({
      ...quarantineInput(secondRaw),
      sourcePath: second,
      sourceSha256: sha256(secondRaw),
    });
    let competingLeaseResults: readonly string[] = [];

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: sha256(firstRaw),
        },
        createIo(),
        {
          beforeTransactionReturn: () => {
            competingLeaseResults = [
              attemptCompetingSessionLease(`${rolloutPath}.lock`),
              attemptCompetingSessionLease(`${second}.lock`),
            ];
          },
        },
      ),
    ).resolves.toBe(0);

    expect(competingLeaseResults).toEqual([
      "SessionLockedError",
      "SessionLockedError",
    ]);
    expect(attemptCompetingSessionLease(`${rolloutPath}.lock`)).toBe(
      "acquired",
    );
    expect(attemptCompetingSessionLease(`${second}.lock`)).toBe("acquired");
    expect(projectedRows()).toBe(2);
  });

  it("binds the selected incident to the proof in canonical source order", async () => {
    const selectedRaw = event(1, "selected", "selected:event:1");
    const otherRaw = event(1, "other", "other:event:1");
    writeFileSync(rolloutPath, selectedRaw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const selected = repository.recordQuarantine(
      quarantineInput(selectedRaw),
    );
    const otherPath = addSource("aaa-canonical-first", otherRaw);
    repository.recordQuarantine({
      ...quarantineInput(otherRaw),
      sourcePath: otherPath,
      sourceSha256: sha256(otherRaw),
    });
    const originalList =
      StateRecoveryIncidentRepository.prototype.listActiveSourcesForRun;
    const repositoryOrder = vi
      .spyOn(
        StateRecoveryIncidentRepository.prototype,
        "listActiveSourcesForRun",
      )
      .mockImplementation(function (runId) {
        return [...originalList.call(this, runId)].reverse();
      });

    try {
      await expect(
        runMutation(
          {
            kind: "recovery-mutation",
            collection: "quarantine",
            action: "rescan",
            id: selected.quarantineId,
            confirmedSourceSha256: sha256(selectedRaw),
          },
          createIo(),
        ),
      ).resolves.toBe(0);
    } finally {
      repositoryOrder.mockRestore();
    }

    expect(repository.getQuarantine(selected.quarantineId)?.state).toBe(
      "repaired",
    );
    expect(projectedRows()).toBe(2);
  });

  it("validates all active run sources and rolls every projection back", async () => {
    const firstRaw = event(1);
    const secondRaw = event(1, "second", "second:event:1");
    writeFileSync(rolloutPath, firstRaw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(firstRaw));
    const second = addSource("mutation-second", secondRaw);
    repository.recordQuarantine({
      ...quarantineInput(secondRaw),
      sourcePath: second,
      sourceSha256: sha256(secondRaw),
    });
    driver.state.exec(
      `CREATE TEMP TRIGGER reject_second_recovery_source
       BEFORE INSERT ON main.thread_rollout_items
       WHEN NEW.source_path = ${sqlString(second)}
       BEGIN
         SELECT RAISE(ABORT, 'reject second recovery source');
       END`,
    );

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: sha256(firstRaw),
        },
        createIo(),
      ),
    ).resolves.toBe(1);

    expect(projectedRows()).toBe(0);
    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "active",
    );
  });

  it("leaves quarantine active and records a strict replay failure", async () => {
    const raw = `${event(1)}{not-json}\n`;
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    const io = createIo();

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: incident.sourceSha256,
        },
        io,
      ),
    ).resolves.toBe(1);

    expect(io.stderrText()).toContain("malformed JSON");
    expect(repository.getQuarantine(incident.quarantineId)).toMatchObject({
      state: "active",
      detectionCount: 2,
    });
    expect(projectedRows()).toBe(0);
  });

  it("persists a lowered semantic source limit under the hard evidence ceiling", async () => {
    const raw = event(1, "x".repeat(512));
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    let competingLeaseResult = "";

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: incident.sourceSha256,
        },
        createIo(),
        {
          limits: { maxSourceBytes: 128 },
          beforeTransactionReturn: () => {
            competingLeaseResult = attemptCompetingSessionLease(
              `${rolloutPath}.lock`,
            );
          },
        },
      ),
    ).resolves.toBe(1);

    expect(repository.getQuarantine(incident.quarantineId)).toMatchObject({
      state: "active",
      reasonCode: "malformed_json",
      detectionCount: 2,
    });
    expect(projectedRows()).toBe(0);
    expect(competingLeaseResult).toBe("SessionLockedError");
    expect(attemptCompetingSessionLease(`${rolloutPath}.lock`)).toBe(
      "acquired",
    );
  });

  it("rolls a failure classification back when the source path is replaced", async () => {
    const raw = `${event(1)}{not-json}\n`;
    const replacementRaw = event(1, "replacement");
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    const displacedPath = `${rolloutPath}.classified-original`;
    let hookCalls = 0;

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: incident.sourceSha256,
        },
        createIo(),
        {
          beforeTransactionReturn: () => {
            hookCalls += 1;
            if (hookCalls !== 1) return;
            renameSync(rolloutPath, displacedPath);
            writeFileSync(rolloutPath, replacementRaw, { mode: 0o600 });
          },
        },
      ),
    ).resolves.toBe(1);

    expect(repository.getQuarantine(incident.quarantineId)).toMatchObject({
      state: "active",
      detectionCount: 1,
    });
    expect(projectedRows()).toBe(0);
    expect(attemptCompetingSessionLease(`${rolloutPath}.lock`)).toBe(
      "acquired",
    );
  });

  it("defers missing recovery storage with zero projection and active evidence", async () => {
    const raw = event(1);
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    unlinkSync(rolloutPath);

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: incident.sourceSha256,
        },
        createIo(),
      ),
    ).resolves.toBe(1);

    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "active",
    );
    expect(repository.listDeferred().items).toContainEqual(
      expect.objectContaining({
        state: "active",
        sourcePath: rolloutPath,
        reasonCode: "recovery_storage_unavailable",
        errorClass: "RECOVERY_SOURCE_MISSING",
      }),
    );
    expect(projectedRows()).toBe(0);
  });

  it("defers an unsafe linked source with zero projection and active evidence", async () => {
    const raw = event(1);
    const externalPath = join(root, "external-rollout.jsonl");
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    writeFileSync(externalPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    unlinkSync(rolloutPath);
    symlinkSync(externalPath, rolloutPath);

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "rescan",
          id: incident.quarantineId,
          confirmedSourceSha256: incident.sourceSha256,
        },
        createIo(),
      ),
    ).resolves.toBe(1);

    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "active",
    );
    expect(repository.listDeferred().items).toContainEqual(
      expect.objectContaining({
        state: "active",
        sourcePath: rolloutPath,
        reasonCode: "recovery_storage_unavailable",
        errorClass: "RECOVERY_UNSAFE_PATH",
      }),
    );
    expect(projectedRows()).toBe(0);
  });

  it(
    "defers permission-denied recovery storage with zero projection on POSIX",
    async () => {
      if (process.platform === "win32") {
        expect(process.platform).toBe("win32");
        return;
      }
      const raw = event(1);
      writeFileSync(rolloutPath, raw, { mode: 0o600 });
      const repository = new StateRecoveryIncidentRepository(driver);
      const incident = repository.recordQuarantine(quarantineInput(raw));
      chmodSync(rolloutPath, 0o000);

      await expect(
        runMutation(
          {
            kind: "recovery-mutation",
            collection: "quarantine",
            action: "rescan",
            id: incident.quarantineId,
            confirmedSourceSha256: incident.sourceSha256,
          },
          createIo(),
        ),
      ).resolves.toBe(1);

      expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
        "active",
      );
      expect(repository.listDeferred().items).toContainEqual(
        expect.objectContaining({
          state: "active",
          sourcePath: rolloutPath,
          reasonCode: "recovery_storage_unavailable",
          errorClass: "EACCES",
        }),
      );
      expect(projectedRows()).toBe(0);
    },
  );

  it("resolves deferred evidence only after a successful strict retry", async () => {
    const raw = event(1);
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const block = repository.recordDeferred({
      runId: "run-mutation",
      sourceKind: "run_journal",
      sourcePath: rolloutPath,
      reasonCode: "database_busy",
      errorClass: "SQLITE_BUSY",
      safeDetail: { message: "busy" },
      failedAtMs: 1,
      nextRetryMs: 2,
    });
    const io = createIo();

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "deferred",
          action: "retry",
          id: block.blockId,
        },
        io,
      ),
    ).resolves.toBe(0);

    expect(repository.getDeferred(block.blockId)?.state).toBe("resolved");
    expect(projectedRows()).toBe(1);
  });

  it("requires a stable current digest before immutable abandonment", async () => {
    const raw = event(1);
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    const wrongIo = createIo();
    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "abandon",
          id: incident.quarantineId,
          confirmedRunId: incident.runId,
          confirmedSourceSha256: "0".repeat(64),
          reason: "operator determined source is unrecoverable",
        },
        wrongIo,
      ),
    ).resolves.toBe(1);
    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "active",
    );

    const currentRaw = raw + event(2);
    writeFileSync(rolloutPath, currentRaw, { mode: 0o600 });
    const currentSha256 = sha256(currentRaw);
    const io = createIo();
    let competingLeaseResult = "";
    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "abandon",
          id: incident.quarantineId,
          confirmedRunId: incident.runId,
          confirmedSourceSha256: currentSha256,
          reason: "operator determined source is unrecoverable",
        },
        io,
        {
          beforeTransactionReturn: () => {
            competingLeaseResult = attemptCompetingSessionLease(
              `${rolloutPath}.lock`,
            );
          },
        },
      ),
    ).resolves.toBe(0);
    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "abandoned",
    );
    expect(repository.getAbandonment(incident.runId)).toMatchObject({
      quarantineId: incident.quarantineId,
      sourceSha256: currentSha256,
    });
    expect(competingLeaseResult).toBe("SessionLockedError");
    expect(attemptCompetingSessionLease(`${rolloutPath}.lock`)).toBe(
      "acquired",
    );
  });

  it("rolls abandonment back when the source path is replaced", async () => {
    const raw = event(1);
    const replacementRaw = event(1, "replacement");
    writeFileSync(rolloutPath, raw, { mode: 0o600 });
    const repository = new StateRecoveryIncidentRepository(driver);
    const incident = repository.recordQuarantine(quarantineInput(raw));
    const displacedPath = `${rolloutPath}.abandon-original`;
    let hookCalls = 0;

    await expect(
      runMutation(
        {
          kind: "recovery-mutation",
          collection: "quarantine",
          action: "abandon",
          id: incident.quarantineId,
          confirmedRunId: incident.runId,
          confirmedSourceSha256: incident.sourceSha256,
          reason: "operator determined source is unrecoverable",
        },
        createIo(),
        {
          beforeTransactionReturn: () => {
            hookCalls += 1;
            if (hookCalls !== 1) return;
            renameSync(rolloutPath, displacedPath);
            writeFileSync(rolloutPath, replacementRaw, { mode: 0o600 });
          },
        },
      ),
    ).resolves.toBe(1);

    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "active",
    );
    expect(repository.getAbandonment(incident.runId)).toBeUndefined();
    expect(attemptCompetingSessionLease(`${rolloutPath}.lock`)).toBe(
      "acquired",
    );
  });
});

function quarantineInput(raw: string) {
  return {
    runId: "run-mutation",
    sourceKind: "run_journal" as const,
    sourcePath: rolloutPath,
    reasonCode: "malformed_json" as const,
    safeDetail: { message: "strict recovery failed" },
    sourceSizeBytes: Buffer.byteLength(raw),
    sourceMtimeMs: 0,
    sourceSha256: sha256(raw),
    detectedAtMs: 1,
  };
}

function runMutation(
  command: RecoveryMutationCommand,
  io: AgenCStateCliIo,
  options: RecoveryMutationAdapterOptions = {},
): Promise<number> {
  return runAgenCStateCli(command, {
    driver,
    io,
    now: () => "2026-08-01T00:00:00.000Z",
    recoveryMutations: createRecoveryMutationAdapter(options),
  });
}

function projectedRows(): number {
  return (
    driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items",
      )
      .get()?.count ?? -1
  );
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function event(
  sequence: number,
  content = "content",
  eventId = `event:${sequence}`,
): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId,
      id: `envelope-${sequence}`,
      seq: sequence,
      msg: {
        type: "turn_started",
        payload: { turnId: "turn-1", content },
      },
    },
    eventVersion: 1,
  })}\n`;
}

function addSource(sourceSessionId: string, raw: string): string {
  const sessionDirectory = join(
    driver.projectDir,
    "sessions",
    sourceSessionId,
  );
  mkdirSync(sessionDirectory, { recursive: true });
  const sourcePath = join(
    sessionDirectory,
    `rollout-2026-08-01T00-00-00-000Z-${sourceSessionId}.jsonl`,
  );
  writeFileSync(sourcePath, raw, { mode: 0o600 });
  return sourcePath;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function attemptCompetingSessionLease(lockPath: string): string {
  const sessionStoreUrl = new URL(
    "../../src/session/session-store.ts",
    import.meta.url,
  ).href;
  const script = `
    import { SessionLock } from ${JSON.stringify(sessionStoreUrl)};
    const lock = new SessionLock(${JSON.stringify(lockPath)});
    try {
      lock.acquire();
      lock.release();
      process.stdout.write("acquired");
    } catch (error) {
      process.stdout.write(error?.name ?? "unknown");
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: join(import.meta.dirname, "../.."), encoding: "utf8" },
  );
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      `competing session lease probe failed: ${child.error?.message ?? child.stderr}`,
    );
  }
  return child.stdout.trim();
}

function createIo(): AgenCStateCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}
