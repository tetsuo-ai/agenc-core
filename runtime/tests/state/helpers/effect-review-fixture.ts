import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateRunDurabilityRepository } from "../../../src/state/run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../../src/state/sqlite-driver.js";

export interface TempStateDatabases {
  readonly driver: StateSqliteDriver;
  readonly home: string;
  readonly cwd: string;
  /** Close the driver, restore AGENC_HOME and remove both directories. */
  readonly dispose: () => void;
}

/** A project state database in a throwaway home and workspace, with AGENC_HOME pointed at it. */
export function openTempStateDatabases(prefix: string): TempStateDatabases {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
  mkdirSync(join(cwd, ".git"));
  const originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  const driver = openStateDatabases({ cwd });
  return {
    driver,
    home,
    cwd,
    dispose: () => {
      driver.close();
      if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
      else delete process.env.AGENC_HOME;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/**
 * Record, through the run-durability repository so every table constraint is
 * met the way the runtime meets it, a side-effecting tool call whose outcome
 * is unknown: a `run_effects` row with `review_status = 'pending'` (#2238).
 */
export function seedPendingEffectReview(
  driver: StateSqliteDriver,
  runId: string,
  now: string,
): void {
  const runs = new StateRunDurabilityRepository(driver);
  runs.ensureInitialEpoch({ runId, openedAt: now });
  runs.beginEffect({
    runId,
    stepId: "tool:step-1",
    epoch: 1,
    sessionId: runId,
    callId: "call-1",
    toolName: "exec_command",
    recoveryCategory: "side-effecting",
    intentDigest: "d".repeat(64),
    eventId: "intent-1",
    eventSequence: 1,
    intentAt: now,
  });
  runs.markEffectUnknown({
    runId,
    stepId: "tool:step-1",
    eventId: "unknown-1",
    eventSequence: 2,
    reason: "tool_error_result_without_authoritative_effect_disposition",
    observedAt: now,
  });
}
