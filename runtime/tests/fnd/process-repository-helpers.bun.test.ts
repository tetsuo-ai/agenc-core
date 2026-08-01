import { describe, expect, test } from "bun:test";

import type {
  ChildInvocation,
  ChildProcessHarness,
  ChildResult,
  DurableMarkerExpectation,
  OwnedChild,
} from "../helpers/child-process-harness.js";
import {
  expectedScenarioTrace,
  runRestartScenario,
} from "../helpers/restart-harness.js";

const RESTART_COUNT = 2;
const SIMULATED_FAILURE_EXIT_CODE = 65;
const INSPECTION_TIMEOUT_MS = 50;
const INSPECTION_SETTLE_TIMEOUT_MS = 50;
const LATE_MUTATION_DELAY_MS = 150;

const UNUSED_INVOCATION: ChildInvocation = Object.freeze({
  program: "/runtime-neutral/fake",
  args: Object.freeze([]),
  cwd: "/runtime-neutral",
  env: Object.freeze({}),
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
});

describe("FND runtime-neutral restart contract", () => {
  test("matches the Node simulated-failure transition order", async () => {
    const harness = new ScriptedHarness([
      childResult({ exitCode: SIMULATED_FAILURE_EXIT_CODE }),
      childResult({ stdout: "stable" }),
      childResult({ stdout: "stable" }),
    ]);
    const expectedTrace = expectedScenarioTrace("simulated", RESTART_COUNT);
    const trace = await runRestartScenario(harness, {
      initial: UNUSED_INVOCATION,
      failure: {
        kind: "simulated",
        expectedExitCode: SIMULATED_FAILURE_EXIT_CODE,
      },
      restartCount: RESTART_COUNT,
      expectedTrace,
      restart: () => UNUSED_INVOCATION,
      inspect: async (_iteration, result) => result.stdout.toString("utf8"),
      fingerprint: (value) => value,
    });

    expect(trace.checkpoints).toEqual(expectedTrace);
    expect(trace.fingerprints).toEqual(["stable", "stable"]);
    expect(trace.idempotent).toBe(true);
    expect(harness.runCount).toBe(RESTART_COUNT + 1);
  });

  test("matches the Node process-crash boundary without starting a process", async () => {
    const harness = new ScriptedHarness(
      [
        childResult({ stdout: "recovered" }),
        childResult({ stdout: "recovered" }),
      ],
      childResult({
        exitCode: null,
        stopReason: "crashed",
        forced: false,
        signal: "SIGKILL",
      }),
    );
    const expectedTrace = expectedScenarioTrace("process-crash", RESTART_COUNT);
    const trace = await runRestartScenario(harness, {
      initial: UNUSED_INVOCATION,
      failure: {
        kind: "process-crash",
        marker: {
          path: "prepared.json",
          timeoutMs: 1_000,
          maxBytes: 1_024,
          expectedJson: { schemaVersion: 1, phase: "prepared" },
        },
      },
      restartCount: RESTART_COUNT,
      expectedTrace,
      restart: () => UNUSED_INVOCATION,
      inspect: async (_iteration, result) => result.stdout.toString("utf8"),
      fingerprint: (value) => value,
    });

    expect(trace.checkpoints).toEqual(expectedTrace);
    expect(trace.initial).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      stopReason: "crashed",
      forced: false,
    });
    expect(trace.idempotent).toBe(true);
    expect(harness.markerWaitCount).toBe(1);
    expect(harness.crashCount).toBe(1);
  });

  test("aborts and physically settles inspection callbacks before cleanup", async () => {
    const harness = new ScriptedHarness([
      childResult({ exitCode: SIMULATED_FAILURE_EXIT_CODE }),
      childResult({ stdout: "stable" }),
      childResult({ stdout: "stable" }),
    ]);
    let activeResources = 0;
    let abortObserved = false;
    let lateMutation = false;
    await expect(
      runRestartScenario(harness, {
        initial: UNUSED_INVOCATION,
        failure: {
          kind: "simulated",
          expectedExitCode: SIMULATED_FAILURE_EXIT_CODE,
        },
        restartCount: RESTART_COUNT,
        expectedTrace: expectedScenarioTrace("simulated", RESTART_COUNT),
        inspectionTimeoutMs: INSPECTION_TIMEOUT_MS,
        inspectionSettleTimeoutMs: INSPECTION_SETTLE_TIMEOUT_MS,
        restart: () => UNUSED_INVOCATION,
        inspect: (_iteration, _result, signal) =>
          new Promise<never>((_resolve, reject) => {
            activeResources += 1;
            const mutationTimer = setTimeout(() => {
              lateMutation = true;
            }, LATE_MUTATION_DELAY_MS);
            const resourceTimer = setInterval(() => {}, 10);
            signal.addEventListener(
              "abort",
              () => {
                abortObserved = true;
                clearTimeout(mutationTimer);
                clearInterval(resourceTimer);
                activeResources -= 1;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
        fingerprint: (value) => String(value),
      }),
    ).rejects.toThrow(/inspection exceeded its deadline/u);
    expect(abortObserved).toBe(true);
    expect(activeResources).toBe(0);
    expect(harness.cleanupCount).toBe(1);
    await delay(LATE_MUTATION_DELAY_MS + INSPECTION_TIMEOUT_MS);
    expect(lateMutation).toBe(false);

    const uncooperativeHarness = new ScriptedHarness([
      childResult({ exitCode: SIMULATED_FAILURE_EXIT_CODE }),
      childResult({ stdout: "stable" }),
    ]);
    await expect(
      runRestartScenario(uncooperativeHarness, {
        initial: UNUSED_INVOCATION,
        failure: {
          kind: "simulated",
          expectedExitCode: SIMULATED_FAILURE_EXIT_CODE,
        },
        restartCount: RESTART_COUNT,
        expectedTrace: expectedScenarioTrace("simulated", RESTART_COUNT),
        inspectionTimeoutMs: INSPECTION_TIMEOUT_MS,
        inspectionSettleTimeoutMs: INSPECTION_SETTLE_TIMEOUT_MS,
        restart: () => UNUSED_INVOCATION,
        inspect: () => new Promise<never>(() => {}),
        fingerprint: (value) => String(value),
      }),
    ).rejects.toThrow(/failed to settle after abort/u);
    expect(uncooperativeHarness.cleanupCount).toBe(1);
  });

  test("rejects impossible simulated, crash, and restart result records", async () => {
    const forcedSimulation = new ScriptedHarness([
      childResult({
        exitCode: SIMULATED_FAILURE_EXIT_CODE,
        forced: true,
      }),
    ]);
    await expect(runSimulatedScenario(forcedSimulation)).rejects.toThrow(
      /simulated failure/u,
    );
    expect(forcedSimulation.cleanupCount).toBe(1);

    const determinateCrash = new ScriptedHarness(
      [],
      childResult({
        exitCode: 0,
        signal: "SIGKILL",
        stopReason: "crashed",
        forced: false,
      }),
    );
    await expect(runProcessCrashScenario(determinateCrash)).rejects.toThrow(
      /process-crash scenario/u,
    );
    expect(determinateCrash.cleanupCount).toBe(1);

    const forcedRestart = new ScriptedHarness([
      childResult({ exitCode: SIMULATED_FAILURE_EXIT_CODE }),
      childResult({ forced: true, stdout: "stable" }),
    ]);
    await expect(runSimulatedScenario(forcedRestart)).rejects.toThrow(
      /restart 1/u,
    );
    expect(forcedRestart.cleanupCount).toBe(1);
  });
});

function runSimulatedScenario(
  harness: ChildProcessHarness,
): ReturnType<typeof runRestartScenario<string>> {
  return runRestartScenario(harness, {
    initial: UNUSED_INVOCATION,
    failure: {
      kind: "simulated",
      expectedExitCode: SIMULATED_FAILURE_EXIT_CODE,
    },
    restartCount: RESTART_COUNT,
    expectedTrace: expectedScenarioTrace("simulated", RESTART_COUNT),
    restart: () => UNUSED_INVOCATION,
    inspect: async (_iteration, result) => result.stdout.toString("utf8"),
    fingerprint: (value) => value,
  });
}

function runProcessCrashScenario(
  harness: ChildProcessHarness,
): ReturnType<typeof runRestartScenario<string>> {
  return runRestartScenario(harness, {
    initial: UNUSED_INVOCATION,
    failure: {
      kind: "process-crash",
      marker: {
        path: "prepared.json",
        timeoutMs: 1_000,
        maxBytes: 1_024,
      },
    },
    restartCount: RESTART_COUNT,
    expectedTrace: expectedScenarioTrace("process-crash", RESTART_COUNT),
    restart: () => UNUSED_INVOCATION,
    inspect: async (_iteration, result) => result.stdout.toString("utf8"),
    fingerprint: (value) => value,
  });
}

class ScriptedHarness implements ChildProcessHarness {
  readonly #results: ChildResult[];
  readonly #crashResult: ChildResult | undefined;
  runCount = 0;
  markerWaitCount = 0;
  crashCount = 0;
  cleanupCount = 0;

  constructor(results: readonly ChildResult[], crashResult?: ChildResult) {
    this.#results = [...results];
    this.#crashResult = crashResult;
  }

  run(): Promise<ChildResult> {
    this.runCount += 1;
    const result = this.#results.shift();
    if (result === undefined) {
      return Promise.reject(new Error("scripted run result exhausted"));
    }
    return Promise.resolve(result);
  }

  spawn(): Promise<OwnedChild> {
    const result = this.#crashResult;
    if (result === undefined) {
      return Promise.reject(new Error("scripted crash result is unavailable"));
    }
    const owner = this;
    return Promise.resolve({
      settled: Promise.resolve(result),
      waitForMarker(_expectation: DurableMarkerExpectation): Promise<void> {
        owner.markerWaitCount += 1;
        return Promise.resolve();
      },
      crash(): Promise<ChildResult> {
        owner.crashCount += 1;
        return Promise.resolve(result);
      },
      terminate(): Promise<ChildResult> {
        return Promise.resolve(result);
      },
    });
  }

  cleanup(): Promise<void> {
    this.cleanupCount += 1;
    return Promise.resolve();
  }
}

function childResult(
  overrides: {
    readonly exitCode?: number | null;
    readonly forced?: boolean;
    readonly signal?: NodeJS.Signals | null;
    readonly stdout?: string;
    readonly stopReason?: ChildResult["stopReason"];
  } = {},
): ChildResult {
  return Object.freeze({
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    signal: overrides.signal ?? null,
    stdout: Buffer.from(overrides.stdout ?? ""),
    stderr: Buffer.alloc(0),
    stopReason: overrides.stopReason ?? "exit",
    forced: overrides.forced ?? false,
    backstopExpired: false,
    heartbeatCount: 0,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
