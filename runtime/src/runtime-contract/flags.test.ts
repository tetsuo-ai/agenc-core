import { describe, expect, it } from "vitest";

import { resolveRuntimeContractFlags } from "./flags.js";

describe("resolveRuntimeContractFlags", () => {
  it("defaults core completion-contract flags on when unspecified", () => {
    expect(resolveRuntimeContractFlags(undefined)).toEqual({
      runtimeContractV2: true,
      stopHooksEnabled: true,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: true,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    });
  });

  it("honors explicit false for core rollback flags", () => {
    expect(resolveRuntimeContractFlags({
      runtimeContractV2: false,
      stopHooks: { enabled: false },
      verifier: { runtimeRequired: false },
    })).toEqual({
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
  });
});
