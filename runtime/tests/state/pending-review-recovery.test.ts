import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRecoveryRunExclusion } from "../../src/state/recovery-exclusions.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import {
  MISSING_RECOVERY_SOURCE_SHA256,
  recoverPendingEffectReviewsOnStartup,
} from "../../src/state/startup-run-journal-recovery.js";

// #2238: a pending effect review whose canonical journal is gone used to make
// startup recovery throw, which left the home unable to start any daemon.

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;
const NOW = "2026-09-06T21:00:00.000Z";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-review-recovery-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-review-recovery-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
});

afterEach(() => {
  driver.close();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function seedPendingReview(runId: string): void {
  const runs = new StateRunDurabilityRepository(driver);
  runs.ensureInitialEpoch({ runId, openedAt: NOW });
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
    intentAt: NOW,
  });
  runs.markEffectUnknown({
    runId,
    stepId: "tool:step-1",
    eventId: "unknown-1",
    eventSequence: 2,
    reason: "tool_error_result_without_authoritative_effect_disposition",
    observedAt: NOW,
  });
}

describe("startup recovery of a pending effect review without evidence", () => {
  it("quarantines the run and lets startup continue instead of throwing", () => {
    const runId = "conv-review-no-journal";
    seedPendingReview(runId);

    const result = recoverPendingEffectReviewsOnStartup(driver);

    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]).toMatchObject({
      runId,
      kind: "quarantine",
      reasonCode: "source_changed",
      sourceKind: "run_journal",
    });
    expect(result.exclusions[0]?.safeDetail).toContain("without retained canonical journal evidence");
    expect(getRecoveryRunExclusion(driver, runId)).toMatchObject({ runId, kind: "quarantine" });
  });

  it("records the incident once across restarts", () => {
    const runId = "conv-review-no-journal-twice";
    seedPendingReview(runId);

    const first = recoverPendingEffectReviewsOnStartup(driver);
    const second = recoverPendingEffectReviewsOnStartup(driver);

    expect(first.exclusions).toHaveLength(1);
    expect(second.exclusions).toHaveLength(1);
    expect(second.exclusions[0]?.evidenceId).toBe(first.exclusions[0]?.evidenceId);
  });

  it("names the sentinel sha an operator confirms to abandon the incident", () => {
    expect(MISSING_RECOVERY_SOURCE_SHA256).toMatch(/^0{64}$/u);
  });
});
