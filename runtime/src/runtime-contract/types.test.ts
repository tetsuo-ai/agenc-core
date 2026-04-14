import { describe, expect, it } from "vitest";

import {
  COMPLETION_VALIDATOR_ORDER,
  createRuntimeContractSnapshot,
} from "./types.js";

describe("runtime-contract types", () => {
  it("keeps the reduced hook-backed validator snapshot shape", () => {
    expect(COMPLETION_VALIDATOR_ORDER).toEqual([
      "artifact_evidence",
      "turn_end_stop_gate",
      "filesystem_artifact_verification",
      "deterministic_acceptance_probes",
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
    expect(snapshot.mailboxLayer).toEqual({
      configured: false,
      effective: false,
      pendingParentToWorker: 0,
      pendingWorkerToParent: 0,
      unackedCount: 0,
      inactiveReason: "flag_disabled",
    });
  });

  it("omits task and verifier completion gates from the runtime snapshot order", () => {
    const snapshot = createRuntimeContractSnapshot({
      runtimeContractV2: false,
      stopHooksEnabled: false,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: true,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    });

    expect(snapshot.validators.map((validator) => validator.id)).not.toContain(
      "top_level_verifier",
    );
    expect(snapshot.validators.map((validator) => validator.id)).not.toContain(
      "request_task_progress",
    );
    expect(snapshot).not.toHaveProperty("legacyTopLevelVerifierMode");
  });
});
