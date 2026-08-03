import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backfillPinnedRolloutFile } from "./backfill.js";
import { RecoveryOperationalError } from "./recovery-contract.js";
import { StateRecoveryIncidentRepository } from "./recovery-incidents.js";
import { createRecoveryMutationAdapter } from "./recovery-mutations.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

if (process.platform !== "win32") {
  throw new Error("the native recovery integration test requires Windows");
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("descriptor-pinned recovery on Windows", () => {
  it("defers typed and leaves the projection database unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-recovery-win32-"));
    roots.push(root);
    const cwd = join(root, "repository");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
    try {
      const sessionId = "win32-recovery";
      const sessionDirectory = join(driver.projectDir, "sessions", sessionId);
      mkdirSync(sessionDirectory, { recursive: true });
      const rolloutPath = join(
        sessionDirectory,
        `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
      );
      writeFileSync(rolloutPath, event(), { mode: 0o600 });

      expect(() =>
        backfillPinnedRolloutFile({
          projectDir: driver.projectDir,
          sessionId,
          rolloutPath,
          threads: new StateThreadRepository(driver),
        }),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "recovery_lock_unavailable",
          errorClass: "RECOVERY_DESCRIPTOR_PATH_UNAVAILABLE",
        }),
      );
      expect(projectedRows(driver)).toBe(0);
    } finally {
      driver.close();
    }
  });

  it("persists the unsupported platform deferral without resolving evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-recovery-win32-"));
    roots.push(root);
    const cwd = join(root, "repository");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
    try {
      const sessionId = "win32-evidence";
      const sessionDirectory = join(driver.projectDir, "sessions", sessionId);
      mkdirSync(sessionDirectory, { recursive: true });
      const rolloutPath = join(
        sessionDirectory,
        `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
      );
      const raw = event();
      writeFileSync(rolloutPath, raw, { mode: 0o600 });
      const repository = new StateRecoveryIncidentRepository(driver);
      const incident = repository.recordQuarantine({
        runId: "win32-run",
        sourceKind: "run_journal",
        sourcePath: rolloutPath,
        reasonCode: "malformed_json",
        safeDetail: { message: "prior failure" },
        sourceSizeBytes: Buffer.byteLength(raw),
        sourceMtimeMs: 0,
        sourceSha256: "0".repeat(64),
        detectedAtMs: 1,
      });

      expect(() =>
        createRecoveryMutationAdapter().rescan(
          driver,
          {
            kind: "recovery-mutation",
            collection: "quarantine",
            action: "rescan",
            id: incident.quarantineId,
            confirmedSourceSha256: incident.sourceSha256,
          },
          {
            actor: "win32-test",
            operatedAt: "2026-08-01T00:00:00.000Z",
          },
        ),
      ).toThrow(
        expect.objectContaining<Partial<RecoveryOperationalError>>({
          reasonCode: "recovery_lock_unavailable",
          errorClass: "RECOVERY_DESCRIPTOR_PATH_UNAVAILABLE",
        }),
      );
      expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
        "active",
      );
      expect(repository.listDeferred().items).toEqual([
        expect.objectContaining({
          reasonCode: "recovery_lock_unavailable",
          errorClass: "RECOVERY_DESCRIPTOR_PATH_UNAVAILABLE",
          state: "active",
        }),
      ]);
      expect(projectedRows(driver)).toBe(0);
    } finally {
      driver.close();
    }
  });
});

function projectedRows(driver: StateSqliteDriver): number {
  return (
    driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items",
      )
      .get()?.count ?? -1
  );
}

function event(): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      eventId: "event:1",
      id: "envelope-1",
      seq: 1,
      msg: { type: "turn_started", payload: { turnId: "turn-1" } },
    },
    eventVersion: 1,
  })}\n`;
}
