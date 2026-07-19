import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdmissionLease } from "../../src/budget/admission-types.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

let home = "";
let firstCwd = "";
let secondCwd = "";
const kernels = new Set<ExecutionAdmissionKernel>();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-concurrency-home-"));
  firstCwd = mkdtempSync(join(tmpdir(), "agenc-concurrency-a-"));
  secondCwd = mkdtempSync(join(tmpdir(), "agenc-concurrency-b-"));
  mkdirSync(join(firstCwd, ".git"));
  mkdirSync(join(secondCwd, ".git"));
});

afterEach(() => {
  for (const kernel of kernels) kernel.close();
  kernels.clear();
  rmSync(home, { recursive: true, force: true });
  rmSync(firstCwd, { recursive: true, force: true });
  rmSync(secondCwd, { recursive: true, force: true });
});

function createKernel(limited: "global" | "workspace" | "session" | "parent" | "provider") {
  const limits = {
    global: 10,
    workspace: 10,
    session: 10,
    parent: 10,
    provider: 10,
    [limited]: 1,
  };
  const kernel = new ExecutionAdmissionKernel({
    agencHome: home,
    limits,
    ownerId: `limit-${limited}`,
    ownerPid: process.pid,
  });
  kernels.add(kernel);
  return kernel;
}

function bind(
  kernel: ExecutionAdmissionKernel,
  options: {
    readonly cwd: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly parentScopeId: string;
  },
): ExecutionAdmissionClient {
  return kernel.bindClient({
    cwd: options.cwd,
    scope: {
      runId: options.runId,
      sessionId: options.sessionId,
      parentScopeId: options.parentScopeId,
      autonomous: false,
    },
  });
}

function acquire(
  client: ExecutionAdmissionClient,
  provider: string,
  signal?: AbortSignal,
): Promise<AdmissionLease> {
  return client.acquire(
    {
      stepId: "turn-1",
      kind: "model_turn",
      provider,
      model: "test-model",
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0,
    },
    signal,
  );
}

async function expectSerialized(
  kernel: ExecutionAdmissionKernel,
  first: ExecutionAdmissionClient,
  second: ExecutionAdmissionClient,
  providers: readonly [string, string],
  expectedParentScopeId?: string,
): Promise<void> {
  const controller = new AbortController();
  const firstLease = await acquire(first, providers[0], controller.signal);
  if (expectedParentScopeId !== undefined) {
    expect(firstLease.request.parentScopeId).toBe(expectedParentScopeId);
  }
  first.markDispatched(firstLease.reservation.reservationId, {
    boundary: "provider_wire",
  });
  controller.abort("caller_cancelled");

  let secondSettled = false;
  const secondPromise = acquire(second, providers[1]).finally(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(secondSettled).toBe(false);
  expect(kernel.activeCount).toBe(1);
  expect(kernel.queuedCount).toBe(1);

  // Cancellation is already durable and the lease signal is aborted, but an
  // abort-ignoring boundary is still physically in flight. Only its explicit
  // completion acknowledgement may hand capacity to the queued replacement.
  first.acknowledgeCompletion(firstLease.reservation.reservationId);
  const secondLease = await secondPromise;
  if (expectedParentScopeId !== undefined) {
    expect(secondLease.request.parentScopeId).toBe(expectedParentScopeId);
  }
  expect(kernel.activeCount).toBe(1);
  second.reconcile(secondLease.reservation.reservationId, {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  expect(kernel.activeCount).toBe(0);
}

describe("execution admission concurrency dimensions", () => {
  it("enforces the global limit across workspaces", async () => {
    const kernel = createKernel("global");
    await expectSerialized(
      kernel,
      bind(kernel, {
        cwd: firstCwd,
        runId: "global-a",
        sessionId: "global-session-a",
        parentScopeId: "global-parent-a",
      }),
      bind(kernel, {
        cwd: secondCwd,
        runId: "global-b",
        sessionId: "global-session-b",
        parentScopeId: "global-parent-b",
      }),
      ["provider-a", "provider-b"],
    );
  });

  it("enforces the workspace limit across independent sessions", async () => {
    const kernel = createKernel("workspace");
    await expectSerialized(
      kernel,
      bind(kernel, {
        cwd: firstCwd,
        runId: "workspace-a",
        sessionId: "workspace-session-a",
        parentScopeId: "workspace-parent-a",
      }),
      bind(kernel, {
        cwd: firstCwd,
        runId: "workspace-b",
        sessionId: "workspace-session-b",
        parentScopeId: "workspace-parent-b",
      }),
      ["provider-a", "provider-b"],
    );
  });

  it("enforces the session limit independently of run identity", async () => {
    const kernel = createKernel("session");
    await expectSerialized(
      kernel,
      bind(kernel, {
        cwd: firstCwd,
        runId: "session-a",
        sessionId: "shared-session",
        parentScopeId: "session-parent-a",
      }),
      bind(kernel, {
        cwd: firstCwd,
        runId: "session-b",
        sessionId: "shared-session",
        parentScopeId: "session-parent-b",
      }),
      ["provider-a", "provider-b"],
    );
  });

  it("honors the contract parentScopeId across child sessions", async () => {
    const kernel = createKernel("parent");
    await expectSerialized(
      kernel,
      bind(kernel, {
        cwd: firstCwd,
        runId: "parent-a",
        sessionId: "parent-session-a",
        parentScopeId: "shared-parent",
      }),
      bind(kernel, {
        cwd: firstCwd,
        runId: "parent-b",
        sessionId: "parent-session-b",
        parentScopeId: "shared-parent",
      }),
      ["provider-a", "provider-b"],
      "shared-parent",
    );
  });

  it("enforces the provider limit across workspaces", async () => {
    const kernel = createKernel("provider");
    await expectSerialized(
      kernel,
      bind(kernel, {
        cwd: firstCwd,
        runId: "provider-a",
        sessionId: "provider-session-a",
        parentScopeId: "provider-parent-a",
      }),
      bind(kernel, {
        cwd: secondCwd,
        runId: "provider-b",
        sessionId: "provider-session-b",
        parentScopeId: "provider-parent-b",
      }),
      ["shared-provider", "shared-provider"],
    );
  });
});
