import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backfillPinnedRolloutFile } from "./backfill.js";
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

// Windows has no descriptor filesystem, so the pinned directories are used
// through their canonical paths once the retained descriptor proves the same
// directory (offline-rollout.ts). Before that, recovery deferred every source
// here, and every daemon start excluded every open chat for good.
describe("descriptor-pinned recovery on Windows", () => {
  it("projects a rollout through the identity-pinned directories", () => {
    withRollout("win32-recovery", (driver, rolloutPath, sessionId) => {
      backfillPinnedRolloutFile({
        projectDir: driver.projectDir,
        sessionId,
        rolloutPath,
        threads: new StateThreadRepository(driver),
      });

      expect(projectedRows(driver)).toBe(1);
      expect(
        new StateRecoveryIncidentRepository(driver).listDeferred().items,
      ).toEqual([]);
    });
  });

  it("repairs a stale quarantine on an operator rescan", () => {
    withRollout("win32-evidence", (driver, rolloutPath) => {
      const raw = event();
      const repository = new StateRecoveryIncidentRepository(driver);
      const incident = repository.recordQuarantine({
        runId: "win32-run",
        sourceKind: "run_journal",
        sourcePath: rolloutPath,
        reasonCode: "malformed_json",
        safeDetail: { message: "prior failure" },
        sourceSizeBytes: Buffer.byteLength(raw),
        sourceMtimeMs: 0,
        sourceSha256: createHash("sha256").update(raw).digest("hex"),
        detectedAtMs: 1,
      });

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
      );

      expect(repository.getQuarantine(incident.quarantineId)?.state).toBe(
        "repaired",
      );
      expect(repository.listDeferred().items).toEqual([]);
      expect(projectedRows(driver)).toBe(1);
    });
  });
});

/** A project state database with one session rollout holding event(). */
function withRollout(
  sessionId: string,
  run: (driver: StateSqliteDriver, rolloutPath: string, sessionId: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "agenc-recovery-win32-"));
  roots.push(root);
  const cwd = join(root, "repository");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({ cwd, agencHome: join(root, "state") });
  try {
    const sessionDirectory = join(driver.projectDir, "sessions", sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    const rolloutPath = join(
      sessionDirectory,
      `rollout-2026-08-01T00-00-00-000Z-${sessionId}.jsonl`,
    );
    writeFileSync(rolloutPath, event(), { mode: 0o600 });
    run(driver, rolloutPath, sessionId);
  } finally {
    driver.close();
  }
}

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
