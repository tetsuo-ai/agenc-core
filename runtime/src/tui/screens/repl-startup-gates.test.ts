import { describe, expect, test } from "vitest";

import {
  allStartupGatesCleared,
  anyStartupGateBlocked,
  createInitialStartupGates,
  deriveStartupGatesFromRuntime,
  nextActiveStartupGate,
  nextPendingStartupGate,
  setStartupGate,
  shouldRunStartupChecks,
  visibleStartupGateNames,
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
  test("initial snapshot omits unsupported trust and starts live gates pending", () => {
    const initial = createInitialStartupGates();
    expect(initial.trust).toBe("omitted");
    expect(initial.apiKey).toBe("pending");
    expect(initial.policy).toBe("pending");
  });

  test("setStartupGate is immutable when state unchanged", () => {
    const initial = createInitialStartupGates();
    const next = setStartupGate(initial, "apiKey", "pending");
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
    expect(nextPendingStartupGate(snapshot)).toBe("apiKey");
    snapshot = setStartupGate(snapshot, "apiKey", "cleared");
    expect(nextPendingStartupGate(snapshot)).toBe("policy");
    snapshot = setStartupGate(snapshot, "policy", "cleared");
    expect(nextPendingStartupGate(snapshot)).toBeNull();
  });

  test("allStartupGatesCleared only after every gate cleared", () => {
    let snapshot = createInitialStartupGates();
    expect(allStartupGatesCleared(snapshot)).toBe(false);
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

  test("visibleStartupGateNames hides omitted gates", () => {
    const snapshot = createInitialStartupGates();
    expect(visibleStartupGateNames(snapshot)).toEqual(["apiKey", "policy"]);
  });

  test("nextActiveStartupGate keeps a blocked-only gate visible", () => {
    let snapshot = createInitialStartupGates();
    snapshot = setStartupGate(snapshot, "apiKey", "blocked");
    snapshot = setStartupGate(snapshot, "policy", "cleared");
    expect(nextPendingStartupGate(snapshot)).toBeNull();
    expect(nextActiveStartupGate(snapshot)).toBe("apiKey");
  });
});

describe("deriveStartupGatesFromRuntime", () => {
  test("omits trust without a concrete AgenC trust signal", () => {
    const gates = deriveStartupGatesFromRuntime({
      session: { services: { provider: { name: "ollama" } } },
      config: {},
      env: {},
    });
    expect(gates.trust).toBe("omitted");
    expect(gates.apiKey).toBe("cleared");
    expect(gates.policy).toBe("cleared");
  });

  test("blocks API-key gate for known remote providers without a key", () => {
    const gates = deriveStartupGatesFromRuntime({
      session: { services: { provider: { name: "openai" } } },
      config: {},
      env: {},
    });
    expect(gates.apiKey).toBe("blocked");
  });

  test("clears API-key gate from provider factory runtime state", () => {
    const provider = { name: "openai" };
    Object.defineProperty(provider, Symbol.for("agenc.factoryProviderState"), {
      value: { provider: "openai", options: { apiKey: "sk-test" } },
    });

    const gates = deriveStartupGatesFromRuntime({
      session: { services: { provider } },
      config: {},
      env: {},
    });

    expect(gates.apiKey).toBe("cleared");
  });

  test("clears API-key gate for OAuth-authenticated provider sessions", () => {
    const gates = deriveStartupGatesFromRuntime({
      session: {
        services: {
          provider: { name: "openai" },
          authManager: { mode: "oauth" },
        },
      },
      config: {},
      env: {},
    });

    expect(gates.apiKey).toBe("cleared");
  });

  test("blocks policy gate when the config store read failed", () => {
    const gates = deriveStartupGatesFromRuntime({
      configError: new Error("bad config"),
    });
    expect(gates.policy).toBe("blocked");
  });
});
