import { describe, expect, it } from "vitest";

import {
  COMPLETION_VALIDATOR_ORDER,
  createRuntimeContractSnapshot,
} from "./types.js";

describe("runtime-contract types", () => {
  it("includes request_task_progress in the validator order and snapshot", () => {
    expect(COMPLETION_VALIDATOR_ORDER).toEqual([
      "artifact_evidence",
      "turn_end_stop_gate",
      "request_task_progress",
      "filesystem_artifact_verification",
      "deterministic_acceptance_probes",
      "top_level_verifier",
    ]);

    const snapshot = createRuntimeContractSnapshot({
      runtimeContractV2: false,
      stopHooksEnabled: false,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: false,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    });

    expect(snapshot.validatorOrder).toEqual(COMPLETION_VALIDATOR_ORDER);
    expect(snapshot.validators.map((validator) => validator.id)).toEqual(
      COMPLETION_VALIDATOR_ORDER,
    );
  });
});
