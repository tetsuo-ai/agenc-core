import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRecoveryRunExclusion } from "../../src/state/recovery-exclusions.js";
import {
  MISSING_RECOVERY_SOURCE_SHA256,
  recoverPendingEffectReviewsOnStartup,
} from "../../src/state/startup-run-journal-recovery.js";
import {
  openTempStateDatabases,
  seedPendingEffectReview,
  type TempStateDatabases,
} from "./helpers/effect-review-fixture.js";

// #2238: a pending effect review whose canonical journal is gone used to make
// startup recovery throw, which left the home unable to start any daemon.

let state: TempStateDatabases;
const NOW = "2026-09-06T21:00:00.000Z";

beforeEach(() => {
  state = openTempStateDatabases("agenc-review-recovery");
});

afterEach(() => {
  state.dispose();
});

describe("startup recovery of a pending effect review without evidence", () => {
  it("quarantines the run and lets startup continue instead of throwing", () => {
    const runId = "conv-review-no-journal";
    seedPendingEffectReview(state.driver, runId, NOW);

    const result = recoverPendingEffectReviewsOnStartup(state.driver);

    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]).toMatchObject({
      runId,
      kind: "quarantine",
      reasonCode: "source_changed",
      sourceKind: "run_journal",
    });
    expect(result.exclusions[0]?.safeDetail).toContain("without retained canonical journal evidence");
    expect(getRecoveryRunExclusion(state.driver, runId)).toMatchObject({ runId, kind: "quarantine" });
  });

  it("records the incident once across restarts", () => {
    const runId = "conv-review-no-journal-twice";
    seedPendingEffectReview(state.driver, runId, NOW);

    const first = recoverPendingEffectReviewsOnStartup(state.driver);
    const second = recoverPendingEffectReviewsOnStartup(state.driver);

    expect(first.exclusions).toHaveLength(1);
    expect(second.exclusions).toHaveLength(1);
    expect(second.exclusions[0]?.evidenceId).toBe(first.exclusions[0]?.evidenceId);
  });

  it("names the sentinel sha an operator confirms to abandon the incident", () => {
    expect(MISSING_RECOVERY_SOURCE_SHA256).toMatch(/^0{64}$/u);
  });
});
