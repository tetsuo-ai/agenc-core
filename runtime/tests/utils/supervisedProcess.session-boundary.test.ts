import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

import {
  sessionProcessBoundaries,
  type SessionProcessBoundary,
} from "../../src/utils/session-process-boundary.js";
import {
  captureProcessTreeDescendants,
  containedProcessCommandOutcome,
  isProcessTreeAlive,
  signalProcessTree,
  terminateProcessTreeAndReport,
  waitForContainedProcessSettlement,
} from "../../src/utils/supervisedProcess.js";

const SESSION_OUTCOME = {
  kind: "reported",
  result: { kind: "exit", code: 7 },
  residual: "none",
} as const;

const SESSION_TERMINATE = {
  commandOutcome: SESSION_OUTCOME,
  residualProcessesTerminated: false,
} as const;

function fakeChild(pid = 2_147_483_647) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
}

function registerBoundary(
  child: object,
  overrides: Partial<SessionProcessBoundary> = {},
): SessionProcessBoundary {
  const boundary: SessionProcessBoundary = {
    alive: () => true,
    settled: Promise.resolve(),
    outcome: () => SESSION_OUTCOME,
    terminate: async () => SESSION_TERMINATE,
    ...overrides,
  };
  sessionProcessBoundaries.set(child, boundary);
  return boundary;
}

describe("supervisedProcess sessionProcessBoundaries", () => {
  test("reads outcome, liveness and settlement from the registered boundary", async () => {
    const child = fakeChild();
    let settled = false;
    registerBoundary(child, {
      alive: () => false,
      settled: Promise.resolve().then(() => {
        settled = true;
      }),
    });

    expect(containedProcessCommandOutcome(child as never)).toEqual(SESSION_OUTCOME);
    expect(isProcessTreeAlive(child)).toBe(false);
    await waitForContainedProcessSettlement(child as never);
    expect(settled).toBe(true);
  });

  test("terminate and signal stay on the virtual handle instead of walking /proc", async () => {
    const child = fakeChild(1);
    const terminate = vi.fn(async () => SESSION_TERMINATE);
    registerBoundary(child, { terminate });

    await expect(terminateProcessTreeAndReport(child as never)).resolves.toEqual(
      SESSION_TERMINATE,
    );
    expect(terminate).toHaveBeenCalledTimes(1);

    captureProcessTreeDescendants(child);
    signalProcessTree(child, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test("leaves ordinary children on the native ownership path", () => {
    const child = fakeChild();

    expect(containedProcessCommandOutcome(child as never)).toBeUndefined();
    expect(isProcessTreeAlive(child)).toBe(true);
    child.exitCode = 0;
    expect(isProcessTreeAlive(child)).toBe(false);
  });
});
