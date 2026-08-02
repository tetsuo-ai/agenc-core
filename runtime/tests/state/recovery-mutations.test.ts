import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runAgenCStateCli,
  type AgenCStateCliIo,
  type RecoveryMutationCommand,
} from "../bin/state-cli.js";
import { StateRecoveryIncidentRepository } from "./recovery-incidents.js";
import { createRecoveryMutationAdapter } from "./recovery-mutations.js";
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
      ),
    ).resolves.toBe(0);
    expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
      "abandoned",
    );
    expect(repository.getAbandonment(incident.runId)).toMatchObject({
      quarantineId: incident.quarantineId,
      sourceSha256: currentSha256,
    });
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
): Promise<number> {
  return runAgenCStateCli(command, {
    driver,
    io,
    now: () => "2026-08-01T00:00:00.000Z",
    recoveryMutations: createRecoveryMutationAdapter(),
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

function event(sequence: number): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId: `event:${sequence}`,
      id: `envelope-${sequence}`,
      seq: sequence,
      msg: {
        type: "turn_started",
        payload: { turnId: "turn-1" },
      },
    },
    eventVersion: 1,
  })}\n`;
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
