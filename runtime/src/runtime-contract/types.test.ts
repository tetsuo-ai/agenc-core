import { describe, expect, it } from "vitest";

import {
  COMPLETION_VALIDATOR_ORDER,
  createRuntimeContractSnapshot,
} from "./types.js";

describe("runtime-contract types", () => {
  it("keeps the full completion validator snapshot shape", () => {
    expect(COMPLETION_VALIDATOR_ORDER).toEqual([
      "artifact_evidence",
      "turn_end_stop_gate",
      "request_task_progress",
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
    expect(
      snapshot.validators.find((validator) => validator.id === "artifact_evidence"),
    ).toMatchObject({ enabled: true });
    expect(
      snapshot.validators.find((validator) => validator.id === "turn_end_stop_gate"),
    ).toMatchObject({ enabled: false });
    expect(
      snapshot.validators.find(
        (validator) => validator.id === "request_task_progress",
      ),
    ).toMatchObject({ enabled: true });
    expect(
      snapshot.validators.find((validator) => validator.id === "top_level_verifier"),
    ).toMatchObject({ enabled: false });
    expect(snapshot.mailboxLayer).toEqual({
      configured: false,
      effective: false,
      pendingParentToWorker: 0,
      pendingWorkerToParent: 0,
      unackedCount: 0,
      inactiveReason: "flag_disabled",
    });
  });

  it("keeps task and verifier gates in the runtime snapshot order and enables them by flag", () => {
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

    expect(snapshot.validators.map((validator) => validator.id)).toEqual(
      COMPLETION_VALIDATOR_ORDER,
    );
    expect(
      snapshot.validators.find(
        (validator) => validator.id === "request_task_progress",
      ),
    ).toMatchObject({ enabled: true });
    expect(
      snapshot.validators.find((validator) => validator.id === "top_level_verifier"),
    ).toMatchObject({ enabled: true });
    expect(snapshot).not.toHaveProperty("legacyTopLevelVerifierMode");
  });
});
