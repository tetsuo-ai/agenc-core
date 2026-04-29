import { describe, expect, test } from "vitest";

import {
  allStartupGatesCleared,
  anyStartupGateBlocked,
  createInitialStartupGates,
  nextPendingStartupGate,
  setStartupGate,
  shouldRunStartupChecks,
} from "./repl-startup-gates.js";

describe("shouldRunStartupChecks", () => {
  test("runs checks after first message submission", () => {
    expect(
      shouldRunStartupChecks({
        isRemoteSession: false,
        hasStarted: false,
        hasHadFirstSubmission: true,
      }),
    ).toBe(true);
  });

  test("skips checks in remote sessions even after submission", () => {
    expect(
      shouldRunStartupChecks({
        isRemoteSession: true,
        hasStarted: false,
        hasHadFirstSubmission: true,
      }),
    ).toBe(false);
  });

  test("skips checks if already started", () => {
    expect(
      shouldRunStartupChecks({
        isRemoteSession: false,
        hasStarted: true,
        hasHadFirstSubmission: true,
      }),
    ).toBe(false);
  });

  test("does not run checks before first submission", () => {
    expect(
      shouldRunStartupChecks({
        isRemoteSession: false,
        hasStarted: false,
        hasHadFirstSubmission: false,
      }),
    ).toBe(false);
  });

  test("skips checks in remote session regardless of other conditions", () => {
    expect(
      shouldRunStartupChecks({
        isRemoteSession: true,
        hasStarted: false,
        hasHadFirstSubmission: false,
      }),
    ).toBe(false);
  });
});

describe("AgenC startup gate state machine", () => {
  test("initial snapshot has all gates pending", () => {
    const initial = createInitialStartupGates();
    expect(initial.trust).toBe("pending");
    expect(initial.apiKey).toBe("pending");
    expect(initial.policy).toBe("pending");
  });

  test("setStartupGate is immutable when state unchanged", () => {
    const initial = createInitialStartupGates();
    const next = setStartupGate(initial, "trust", "pending");
    expect(next).toBe(initial);
  });

  test("setStartupGate produces a new snapshot when state changes", () => {
    const initial = createInitialStartupGates();
    const next = setStartupGate(initial, "trust", "cleared");
    expect(next).not.toBe(initial);
    expect(next.trust).toBe("cleared");
    expect(next.apiKey).toBe("pending");
  });

  test("nextPendingStartupGate respects declared order", () => {
    let snapshot = createInitialStartupGates();
    expect(nextPendingStartupGate(snapshot)).toBe("trust");
    snapshot = setStartupGate(snapshot, "trust", "cleared");
    expect(nextPendingStartupGate(snapshot)).toBe("apiKey");
    snapshot = setStartupGate(snapshot, "apiKey", "cleared");
    expect(nextPendingStartupGate(snapshot)).toBe("policy");
    snapshot = setStartupGate(snapshot, "policy", "cleared");
    expect(nextPendingStartupGate(snapshot)).toBeNull();
  });

  test("allStartupGatesCleared only after every gate cleared", () => {
    let snapshot = createInitialStartupGates();
    expect(allStartupGatesCleared(snapshot)).toBe(false);
    snapshot = setStartupGate(snapshot, "trust", "cleared");
    snapshot = setStartupGate(snapshot, "apiKey", "cleared");
    expect(allStartupGatesCleared(snapshot)).toBe(false);
    snapshot = setStartupGate(snapshot, "policy", "cleared");
    expect(allStartupGatesCleared(snapshot)).toBe(true);
  });

  test("anyStartupGateBlocked surfaces a blocked gate", () => {
    let snapshot = createInitialStartupGates();
    expect(anyStartupGateBlocked(snapshot)).toBe(false);
    snapshot = setStartupGate(snapshot, "policy", "blocked");
    expect(anyStartupGateBlocked(snapshot)).toBe(true);
  });
});
