import {
  open,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createChildProcessHarness,
  MAX_ACTIVE_CHILD_OPERATIONS,
  type ChildInvocation,
  type ChildProcessHarness,
  type ChildProcessHarnessTestHooks,
} from "../helpers/child-process-harness.js";
import {
  expectedScenarioTrace,
  runRestartScenario,
} from "../helpers/restart-harness.js";
import {
  PROCESS_EVIDENCE_NONCE_HEX_LENGTH,
  PROCESS_EVIDENCE_NONCE_JSON_KEY,
} from "../helpers/process-harness-contract.js";
import { pinProcessWorkspace } from "../helpers/process-workspace.js";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";

const CRASH_CHILD = fileURLToPath(
  new URL("./process-fixtures/crash-child.ts", import.meta.url),
);
const CHILD_TIMEOUT_MS = 5_000;
const CHILD_OUTPUT_BYTES = 8_192;
const CHILD_TERMINATE_GRACE_MS = 50;
const SHORT_DEADLINE_MS = 75;
const MARKER_TIMEOUT_MS = 3_000;
const MARKER_MAX_BYTES = 1_024;
const HEARTBEAT_STARTUP_TIMEOUT_MS = 1_000;
const HEARTBEAT_INTERVAL_TIMEOUT_MS = 500;
const SIMULATED_FAILURE_EXIT_CODE = 65;
const LARGE_STDIN_BYTES = 1_048_576;
const STALE_EVIDENCE_NONCE = "0".repeat(PROCESS_EVIDENCE_NONCE_HEX_LENGTH);
const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const PROCESS_EXIT_POLL_MS = 20;
const FILE_IDENTITY_TEST_BYTES = 4;
const ASYNC_SETTLEMENT_PROBE_MS = 30;
const OPERATION_SLOT_RELEASE_TIMEOUT_MS = 2_000;
const OPERATION_SLOT_POLL_MS = 10;
const ACTIVE_OPERATION_LIMIT_PATTERN = new RegExp(
  `at most ${MAX_ACTIVE_CHILD_OPERATIONS} active operations`,
  "u",
);

type FileHandleRead = (
  this: unknown,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;
type FileHandleStat = (
  this: unknown,
  options?: { readonly bigint?: boolean },
) => Promise<unknown>;

const workspaces = createTempWorkspaceFixture("agenc-fnd-process-");
const harnesses = new Set<ChildProcessHarness>();

afterEach(async () => {
  for (const harness of harnesses) await harness.cleanup();
  harnesses.clear();
  await workspaces.cleanup();
});

describe("contained child-process harness", () => {
  it("observes delayed completion and enforces one combined output bound", async () => {
    const { harness, root } = await createHarness();
    const delayed = await harness.run(
      nodeInvocation(root, [
        "--eval",
        "setTimeout(() => process.stdout.write('done'), 30)",
      ]),
    );
    expect(delayed).toMatchObject({
      exitCode: 0,
      signal: null,
      stopReason: "exit",
      forced: false,
      backstopExpired: false,
      heartbeatCount: 0,
    });
    expect(delayed.stdout.toString("utf8")).toBe("done");

    const bounded = await harness.run(
      nodeInvocation(
        root,
        [
          "--eval",
          "process.stdout.write('a'.repeat(4096));setInterval(()=>{},1000)",
        ],
        { maxOutputBytes: 32 },
      ),
    );
    expect(bounded.stopReason).toBe("output-limit");
    expect(bounded.stdout.byteLength + bounded.stderr.byteLength).toBe(32);
    expect(bounded.backstopExpired).toBe(false);
  });

  it("enforces an end-to-end deadline and propagates caller abort", async () => {
    const { harness, root } = await createHarness();
    const started = performance.now();
    const timedOut = await harness.run(
      nodeInvocation(root, ["--eval", "setInterval(()=>{},1000)"], {
        timeoutMs: SHORT_DEADLINE_MS,
      }),
    );
    expect(timedOut).toMatchObject({
      stopReason: "timeout",
      backstopExpired: false,
    });
    expect(typeof timedOut.forced).toBe("boolean");
    expect(performance.now() - started).toBeLessThan(CHILD_TIMEOUT_MS);

    const controller = new AbortController();
    const pending = harness.run(
      nodeInvocation(root, ["--eval", "setInterval(()=>{},1000)"], {
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 30);
    await expect(pending).resolves.toMatchObject({
      stopReason: "aborted",
      backstopExpired: false,
    });
  });

  it("records actual timeout escalation consistently with and without heartbeat observation", async () => {
    const { harness, root } = await createHarness();
    const timeoutMs = 250;
    const withoutHeartbeat = await harness.run(
      nodeInvocation(root, ["--eval", "setInterval(()=>{},1000)"], {
        timeoutMs,
      }),
    );
    const heartbeatPath = join(root, "cooperative-heartbeat.json");
    const withHeartbeat = await harness.run(
      nodeInvocation(
        root,
        [CRASH_CHILD, "heartbeat-cooperative", heartbeatPath],
        {
          heartbeat: heartbeatExpectation(heartbeatPath),
          timeoutMs,
        },
      ),
    );

    expect(withoutHeartbeat).toMatchObject({
      exitCode: null,
      stopReason: "timeout",
      forced: false,
      backstopExpired: false,
    });
    expect(withHeartbeat).toMatchObject({
      exitCode: null,
      stopReason: "timeout",
      forced: false,
      backstopExpired: false,
      heartbeatCount: 1,
    });
    expect(withHeartbeat.signal).toBe(withoutHeartbeat.signal);
  });

  it("waits for active work during idempotent cleanup and then stays closed", async () => {
    const { harness, root } = await createHarness();
    const pending = harness.run(
      nodeInvocation(root, ["--eval", "setInterval(()=>{},1000)"]),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    const firstCleanup = harness.cleanup();
    expect(harness.cleanup()).toBe(firstCleanup);
    await firstCleanup;
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({
      stopReason: "aborted",
      backstopExpired: false,
    });
    expect(() =>
      harness.run(
        nodeInvocation(root, ["--eval", "process.stdout.write('late')"]),
      ),
    ).toThrow(/cleaned/u);
  });

  it("bounds aggregate operations until caller and preparation work both settle", async () => {
    const preparationGate = createDeferred();
    let preparationCount = 0;
    const { harness, root } = await createHarness({
      async beforePreparationValidation() {
        preparationCount += 1;
        await preparationGate.promise;
      },
    });
    const controllers = Array.from(
      { length: MAX_ACTIVE_CHILD_OPERATIONS },
      () => new AbortController(),
    );
    const operations = controllers.map((controller, index) => {
      const invocation = nodeInvocation(root, ["--eval", "process.exit(0)"], {
        signal: controller.signal,
      });
      return index % 2 === 0
        ? harness.run(invocation)
        : harness.spawn(invocation).then((child) => child.settled);
    });
    expect(preparationCount).toBe(MAX_ACTIVE_CHILD_OPERATIONS);
    expect(() =>
      harness.run(nodeInvocation(root, ["--eval", "process.exit(0)"])),
    ).toThrow(ACTIVE_OPERATION_LIMIT_PATTERN);
    expect(() =>
      harness.spawn(nodeInvocation(root, ["--eval", "process.exit(0)"])),
    ).toThrow(ACTIVE_OPERATION_LIMIT_PATTERN);
    expect(preparationCount).toBe(MAX_ACTIVE_CHILD_OPERATIONS);

    for (const controller of controllers) controller.abort();
    expect(
      (await Promise.all(operations)).every(
        (result) => result.stopReason === "aborted",
      ),
    ).toBe(true);
    expect(() =>
      harness.run(nodeInvocation(root, ["--eval", "process.exit(0)"])),
    ).toThrow(ACTIVE_OPERATION_LIMIT_PATTERN);

    preparationGate.resolve();
    const releasedController = new AbortController();
    releasedController.abort();
    const { operation: released } = await waitForOperationAdmission(
      harness,
      nodeInvocation(root, ["--eval", "process.exit(0)"], {
        signal: releasedController.signal,
      }),
    );
    await expect(released).resolves.toMatchObject({ stopReason: "aborted" });
  });

  it("keeps cleanup pending until aborted preparation physically settles", async () => {
    const preparationGate = createDeferred();
    const preparationEntered = createDeferred();
    const { harness, root } = await createHarness({
      async beforePreparationValidation() {
        preparationEntered.resolve();
        await preparationGate.promise;
      },
    });
    const operation = harness.run(
      nodeInvocation(root, ["--eval", "process.exit(0)"]),
    );
    await preparationEntered.promise;

    const cleanup = harness.cleanup();
    await expect(operation).resolves.toMatchObject({ stopReason: "aborted" });
    await expectPromisePending(cleanup);
    preparationGate.resolve();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("retains timed-out preparation until its physical work settles", async () => {
    const preparationGate = createDeferred();
    const preparationEntered = createDeferred();
    const { harness, root } = await createHarness({
      async beforePreparationValidation() {
        preparationEntered.resolve();
        await preparationGate.promise;
      },
    });
    const operation = harness.run(
      nodeInvocation(root, ["--eval", "process.exit(0)"], {
        timeoutMs: SHORT_DEADLINE_MS,
      }),
    );
    await preparationEntered.promise;
    await expect(operation).resolves.toMatchObject({ stopReason: "timeout" });

    const cleanup = harness.cleanup();
    await expectPromisePending(cleanup);
    preparationGate.resolve();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("settles a spawn whose signal was aborted before validation", async () => {
    const { harness, root } = await createHarness();
    const controller = new AbortController();
    controller.abort();
    const child = await harness.spawn(
      nodeInvocation(root, ["--eval", "setInterval(()=>{},1000)"], {
        signal: controller.signal,
      }),
    );
    await expect(child.settled).resolves.toMatchObject({
      stopReason: "aborted",
      backstopExpired: false,
    });
  });

  it("treats early stdin pipe closure as a successful child exit", async () => {
    const { harness, root } = await createHarness();
    const child = await harness.spawn({
      ...nodeInvocation(root, ["--eval", "process.exit(0)"]),
      stdin: Buffer.alloc(LARGE_STDIN_BYTES, 0x61),
    });
    await expect(child.settled).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
      stopReason: "exit",
      forced: false,
      backstopExpired: false,
      heartbeatCount: 0,
    });
    expect((await child.settled).error).toBeUndefined();
    await expect(harness.cleanup()).resolves.toBeUndefined();
  });

  it("snapshots ordinary inputs and rejects executable accessors and shared bytes", async () => {
    const { harness, root } = await createHarness();
    const args = [
      "--eval",
      "setTimeout(() => process.stdout.write('snapshotted'), 30)",
    ];
    const pending = harness.run(nodeInvocation(root, args));
    args[1] = "process.stdout.write('mutated')";
    const result = await pending;
    expect(result.stdout.toString("utf8")).toBe("snapshotted");

    const environment = childEnvironment() as Record<string, string>;
    Object.defineProperty(environment, "HOSTILE", {
      enumerable: true,
      get(): string {
        throw new Error("getter must not execute");
      },
    });
    expect(() =>
      harness.run({
        ...nodeInvocation(root, ["--eval", "process.exit(0)"]),
        env: environment,
      }),
    ).toThrow(/data properties/u);

    const proxiedArgs = new Proxy(["--eval", "process.exit(0)"], {});
    expect(() =>
      harness.run({
        ...nodeInvocation(root, []),
        args: proxiedArgs,
      }),
    ).toThrow(/ordinary dense array/u);

    const sharedInput = new Uint8Array(new SharedArrayBuffer(1));
    expect(() =>
      harness.run({
        ...nodeInvocation(root, ["--eval", "process.stdin.resume()"]),
        stdin: sharedInput,
      }),
    ).toThrow(/exclusive Uint8Array/u);

    const intrinsicInput = Uint8Array.from(Buffer.from("intrinsic"));
    Object.defineProperty(intrinsicInput, "buffer", {
      get(): never {
        throw new Error("shadow buffer getter must not execute");
      },
    });
    const stdinResult = await harness.run({
      ...nodeInvocation(root, [
        "--eval",
        "process.stdin.on('data',chunk=>process.stdout.write(chunk))",
      ]),
      stdin: intrinsicInput,
    });
    expect(stdinResult.stdout.toString("utf8")).toBe("intrinsic");

    let speciesCalls = 0;
    class SpeciesInput extends Uint8Array {
      static get [Symbol.species](): typeof Uint8Array {
        speciesCalls += 1;
        return Uint8Array;
      }
    }
    const speciesInput = new SpeciesInput(Buffer.from("species"));
    let byteLengthCalls = 0;
    Object.defineProperty(speciesInput, "byteLength", {
      get(): number {
        byteLengthCalls += 1;
        return 0;
      },
    });
    const speciesResult = await harness.run({
      ...nodeInvocation(root, [
        "--eval",
        "process.stdin.on('data',chunk=>process.stdout.write(chunk))",
      ]),
      stdin: speciesInput,
    });
    expect(speciesResult.stdout.toString("utf8")).toBe("species");
    expect(speciesCalls).toBe(0);
    expect(byteLengthCalls).toBe(0);

    let constructorCalls = 0;
    const constructorInput = Uint8Array.from(Buffer.from("constructor"));
    Object.defineProperty(constructorInput, "constructor", {
      get(): typeof Uint8Array {
        constructorCalls += 1;
        return Uint8Array;
      },
    });
    const constructorResult = await harness.run({
      ...nodeInvocation(root, [
        "--eval",
        "process.stdin.on('data',chunk=>process.stdout.write(chunk))",
      ]),
      stdin: constructorInput,
    });
    expect(constructorResult.stdout.toString("utf8")).toBe("constructor");
    expect(constructorCalls).toBe(0);

    const shadowedSignal = new AbortController().signal;
    Object.defineProperty(shadowedSignal, "aborted", {
      get(): never {
        throw new Error("shadow signal getter must not execute");
      },
    });
    expect(() =>
      harness.run({
        ...nodeInvocation(root, ["--eval", "process.exit(0)"]),
        signal: shadowedSignal,
      }),
    ).toThrow(/AbortSignal/u);
  });

  it("rejects same-size executable rewrites and pathname swaps", async () => {
    const root = await workspaces.create();
    const workspace = await pinProcessWorkspace(root);
    const programPath = join(root, "program.bin");
    await writeFile(programPath, "aaaa");
    const rewriteLocation = await workspace.validateProcessLocation(
      programPath,
      root,
    );
    await writeFile(programPath, "bbbb");
    const changedTime = new Date(Date.now() + CHILD_TIMEOUT_MS);
    await utimes(programPath, changedTime, changedTime);
    await expect(
      workspace.revalidateProcessLocation(rewriteLocation),
    ).rejects.toThrow(/program identity changed/u);

    const swapLocation = await workspace.validateProcessLocation(
      programPath,
      root,
    );
    const displacedPath = join(root, "program-displaced.bin");
    await rename(programPath, displacedPath);
    await writeFile(programPath, "bbbb");
    await expect(
      workspace.revalidateProcessLocation(swapLocation),
    ).rejects.toThrow(/program identity changed/u);
  });

  it("rejects same-size child-file rewrites and post-read pathname swaps", async () => {
    const root = await workspaces.create();
    const workspace = await pinProcessWorkspace(root);
    const rewrittenPath = join(root, "rewritten.json");
    await writeFile(rewrittenPath, "aaaa");
    await withFirstDescriptorReadHook(
      async () => {
        await writeFile(rewrittenPath, "bbbb");
        const changedTime = new Date(Date.now() + CHILD_TIMEOUT_MS);
        await utimes(rewrittenPath, changedTime, changedTime);
      },
      () =>
        expect(
          workspace.readBoundedFileIfPresent(
            rewrittenPath,
            FILE_IDENTITY_TEST_BYTES,
          ),
        ).rejects.toThrow(/changed while it was read/u),
    );

    const swappedPath = join(root, "swapped.json");
    const displacedPath = join(root, "swapped-displaced.json");
    await writeFile(swappedPath, "same");
    await withSecondDescriptorStatHook(
      async () => {
        await rename(swappedPath, displacedPath);
        await writeFile(swappedPath, "same");
      },
      () =>
        expect(
          workspace.readBoundedFileIfPresent(
            swappedPath,
            FILE_IDENTITY_TEST_BYTES,
          ),
        ).rejects.toThrow(/changed at its pathname/u),
    );
  });

  it("preserves an own __proto__ environment entry without prototype mutation", async () => {
    const { harness, root } = await createHarness();
    const environment = Object.assign(
      Object.create(null) as Record<string, string>,
      childEnvironment(),
      { ["__proto__"]: "literal-value" },
    );
    const result = await harness.run({
      ...nodeInvocation(root, [
        "--eval",
        "process.stdout.write(String(Object.hasOwn(process.env,'__proto__'))+':'+String(process.env.__proto__))",
      ]),
      env: environment,
    });
    expect(result).toMatchObject({ exitCode: 0, stopReason: "exit" });
    expect(result.stdout.toString("utf8")).toBe("true:literal-value");
  });

  it("observes healthy heartbeats and kills a child that stops advancing", async () => {
    const { harness, root } = await createHarness();
    const healthyPath = join(root, "healthy-heartbeat.json");
    const healthy = await harness.run(
      nodeInvocation(root, [CRASH_CHILD, "heartbeat-and-exit", healthyPath], {
        heartbeat: heartbeatExpectation(healthyPath),
      }),
    );
    expect(healthy).toMatchObject({
      exitCode: 0,
      stopReason: "exit",
      forced: false,
      heartbeatCount: 3,
    });

    const stalledPath = join(root, "stalled-heartbeat.json");
    const stalled = await harness.run(
      nodeInvocation(root, [CRASH_CHILD, "heartbeat-stall", stalledPath], {
        heartbeat: heartbeatExpectation(stalledPath),
        timeoutMs: 2_000,
      }),
    );
    expect(stalled).toMatchObject({
      stopReason: "heartbeat-timeout",
      forced: true,
      backstopExpired: false,
      heartbeatCount: 1,
    });
  });

  it("joins an in-flight heartbeat read before cleanup resolves", async () => {
    const heartbeatReadGate = createDeferred();
    const heartbeatReadEntered = createDeferred();
    let shouldBlock = true;
    const { harness, root } = await createHarness({
      async afterHeartbeatRead() {
        if (!shouldBlock) return;
        shouldBlock = false;
        heartbeatReadEntered.resolve();
        await heartbeatReadGate.promise;
      },
    });
    const heartbeatPath = join(root, "cleanup-heartbeat.json");
    const operation = harness.run(
      nodeInvocation(
        root,
        [CRASH_CHILD, "heartbeat-cooperative", heartbeatPath],
        { heartbeat: heartbeatExpectation(heartbeatPath) },
      ),
    );
    await heartbeatReadEntered.promise;

    const cleanup = harness.cleanup();
    await expectPromisePending(cleanup);
    heartbeatReadGate.resolve();
    await expect(cleanup).resolves.toBeUndefined();
    await expect(operation).resolves.toMatchObject({
      stopReason: "aborted",
      backstopExpired: false,
    });
  });

  it("rejects a fresh heartbeat whose first sequence is not one", async () => {
    const { harness, root } = await createHarness();
    const heartbeatPath = join(root, "invalid-first-heartbeat.json");
    const result = await harness.run(
      nodeInvocation(
        root,
        [CRASH_CHILD, "heartbeat-starts-at-two", heartbeatPath],
        { heartbeat: heartbeatExpectation(heartbeatPath) },
      ),
    );
    expect(result).toMatchObject({
      stopReason: "spawn-error",
      forced: false,
      backstopExpired: false,
    });
    expect(result.error?.message).toMatch(/must begin with sequence 1/u);

    harnesses.delete(harness);
    const cleanupError = await harness
      .cleanup()
      .catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toHaveLength(1);
    expect((cleanupError as Error).message).toMatch(
      /could not prove complete settlement/u,
    );
  });

  it("rejects stale precreated marker and heartbeat evidence before spawn", async () => {
    const { harness, root } = await createHarness();
    const statePath = join(root, "stale-state.txt");
    const markerPath = join(root, "stale-marker.json");
    const staleMarker = `${JSON.stringify({
      schemaVersion: 1,
      phase: "prepared",
      [PROCESS_EVIDENCE_NONCE_JSON_KEY]: STALE_EVIDENCE_NONCE,
    })}\n`;
    await writeFile(markerPath, staleMarker);
    await expect(
      harness.spawn(
        nodeInvocation(
          root,
          [CRASH_CHILD, "mark-and-wait", statePath, markerPath],
          { durableMarkers: [markerPath] },
        ),
      ),
    ).rejects.toThrow(/must be absent before spawn/u);
    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(markerPath, "utf8")).toBe(staleMarker);
    await rm(markerPath);

    const heartbeatPath = join(root, "stale-heartbeat.json");
    const staleHeartbeat = `${JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      [PROCESS_EVIDENCE_NONCE_JSON_KEY]: STALE_EVIDENCE_NONCE,
    })}\n`;
    await writeFile(heartbeatPath, staleHeartbeat);
    await expect(
      harness.run(
        nodeInvocation(root, [CRASH_CHILD, "heartbeat-stall", heartbeatPath], {
          heartbeat: heartbeatExpectation(heartbeatPath),
        }),
      ),
    ).rejects.toThrow(/must be absent before spawn/u);
    expect(await readFile(heartbeatPath, "utf8")).toBe(staleHeartbeat);
  });

  it("rejects portable aliases before they can conflate evidence boundaries", async () => {
    const { harness, root } = await createHarness();
    const invocation = (durableMarkers: readonly string[]): ChildInvocation =>
      nodeInvocation(root, ["--eval", "process.exit(0)"], {
        durableMarkers,
      });
    for (const markerPaths of [
      [join(root, "Marker.json"), join(root, "marker.json")],
      [join(root, "caf\u00e9.json"), join(root, "cafe\u0301.json")],
    ]) {
      await expect(harness.spawn(invocation(markerPaths))).rejects.toThrow(
        /resolve uniquely/u,
      );
    }
    await expect(
      harness.spawn(invocation([join(root, "FILE~1.JS")])),
    ).rejects.toThrow(/reserved segment/u);
  });

  it("cleanup removes a termination-resistant detached descendant", async () => {
    const { harness, root } = await createHarness();
    const markerPath = join(root, "descendant.json");
    const child = await harness.spawn(
      nodeInvocation(root, [CRASH_CHILD, "resist", markerPath], {
        durableMarkers: [markerPath],
      }),
    );
    await child.waitForMarker(markerExpectation(markerPath));
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      readonly descendantPid?: unknown;
    };
    const descendantPid = marker.descendantPid;
    expect(isSafeProcessId(descendantPid)).toBe(true);

    await harness.cleanup();
    expect(await child.settled).toMatchObject({
      stopReason: "terminated",
      backstopExpired: false,
    });
    expect(await waitForProcessExit(descendantPid as number)).toBe(true);
  });
});

describe("restart harness", () => {
  it("distinguishes a real crash and proves idempotent recovery state", async () => {
    const { harness, root } = await createHarness();
    const statePath = join(root, "state.txt");
    const markerPath = join(root, "prepared.json");
    const restartCount = 2;
    const trace = await runRestartScenario(harness, {
      initial: nodeInvocation(
        root,
        [CRASH_CHILD, "mark-and-wait", statePath, markerPath],
        {
          durableMarkers: [markerPath],
        },
      ),
      failure: {
        kind: "process-crash",
        marker: {
          ...markerExpectation(markerPath),
          expectedJson: { schemaVersion: 1, phase: "prepared" },
        },
      },
      restartCount,
      expectedTrace: expectedScenarioTrace("process-crash", restartCount),
      restart: () => nodeInvocation(root, [CRASH_CHILD, "recover", statePath]),
      inspect: async () => readFile(statePath, "utf8"),
      fingerprint: (state) => state,
    });

    expect(trace.failureKind).toBe("process-crash");
    expect(trace.initial).toMatchObject({
      exitCode: null,
      stopReason: "crashed",
      forced: false,
      backstopExpired: false,
    });
    expect(trace.initial.signal).not.toBeNull();
    for (const restart of trace.restarts) {
      expect(restart).toMatchObject({
        exitCode: 0,
        signal: null,
        stopReason: "exit",
        forced: false,
        backstopExpired: false,
      });
      expect(restart.error).toBeUndefined();
    }
    expect(trace.fingerprints).toEqual(["recovered\n", "recovered\n"]);
    expect(trace.idempotent).toBe(true);
    expect(trace.checkpoints).toEqual(
      expectedScenarioTrace("process-crash", restartCount),
    );
  });

  it("keeps simulated failure separate and rejects an omitted transition", async () => {
    const { harness, root } = await createHarness();
    const restartCount = 2;
    const stableRestart = (): ChildInvocation =>
      nodeInvocation(root, ["--eval", "process.stdout.write('stable')"]);
    const trace = await runRestartScenario(harness, {
      initial: nodeInvocation(root, [CRASH_CHILD, "simulated-failure"]),
      failure: {
        kind: "simulated",
        expectedExitCode: SIMULATED_FAILURE_EXIT_CODE,
      },
      restartCount,
      expectedTrace: expectedScenarioTrace("simulated", restartCount),
      restart: stableRestart,
      inspect: async (_iteration, result) => result.stdout.toString("utf8"),
      fingerprint: (value) => value,
    });
    expect(trace.failureKind).toBe("simulated");
    expect(trace.initial).toMatchObject({
      exitCode: SIMULATED_FAILURE_EXIT_CODE,
      signal: null,
      stopReason: "exit",
      forced: false,
      backstopExpired: false,
    });
    expect(trace.initial.error).toBeUndefined();

    await expect(
      runRestartScenario(harness, {
        initial: nodeInvocation(root, [CRASH_CHILD, "simulated-failure"]),
        failure: {
          kind: "simulated",
          expectedExitCode: SIMULATED_FAILURE_EXIT_CODE,
        },
        restartCount,
        expectedTrace: ["initial.start", "restart.1.run", "restart.1.inspect"],
        restart: stableRestart,
        inspect: async () => "stable",
        fingerprint: (value) => value,
      }),
    ).rejects.toThrow(/expectedTrace/u);
    expect(() => expectedScenarioTrace("simulated", 1)).toThrow(
      /prove idempotence/u,
    );
  });
});

async function createHarness(
  hooks: ChildProcessHarnessTestHooks = Object.freeze({}),
): Promise<{
  readonly harness: ChildProcessHarness;
  readonly root: string;
}> {
  const root = await workspaces.create();
  const harness = await createChildProcessHarness(root, hooks);
  harnesses.add(harness);
  return { harness, root };
}

function nodeInvocation(
  root: string,
  args: readonly string[],
  overrides: Partial<
    Pick<
      ChildInvocation,
      "durableMarkers" | "heartbeat" | "maxOutputBytes" | "signal" | "timeoutMs"
    >
  > = {},
): ChildInvocation {
  return {
    program: process.execPath,
    args,
    cwd: root,
    env: childEnvironment(),
    timeoutMs: overrides.timeoutMs ?? CHILD_TIMEOUT_MS,
    maxOutputBytes: overrides.maxOutputBytes ?? CHILD_OUTPUT_BYTES,
    terminateGraceMs: CHILD_TERMINATE_GRACE_MS,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.heartbeat === undefined
      ? {}
      : { heartbeat: overrides.heartbeat }),
    ...(overrides.durableMarkers === undefined
      ? {}
      : { durableMarkers: overrides.durableMarkers }),
  };
}

function childEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
  };
  for (const name of [
    "ComSpec",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "WINDIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function markerExpectation(path: string): {
  readonly path: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
} {
  return {
    path,
    timeoutMs: MARKER_TIMEOUT_MS,
    maxBytes: MARKER_MAX_BYTES,
  };
}

function heartbeatExpectation(path: string): {
  readonly path: string;
  readonly startupTimeoutMs: number;
  readonly intervalTimeoutMs: number;
  readonly maxBytes: number;
} {
  return {
    path,
    startupTimeoutMs: HEARTBEAT_STARTUP_TIMEOUT_MS,
    intervalTimeoutMs: HEARTBEAT_INTERVAL_TIMEOUT_MS,
    maxBytes: MARKER_MAX_BYTES,
  };
}

async function withFirstDescriptorReadHook<T>(
  hook: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  const probeRoot = await workspaces.create();
  const probePath = join(probeRoot, "descriptor-probe.bin");
  await writeFile(probePath, "probe");
  const probe = await open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    read: FileHandleRead;
  };
  await probe.close();

  const originalRead = prototype.read;
  let hooked = false;
  prototype.read = async function patchedRead(
    buffer,
    offset,
    length,
    position,
  ) {
    const result = await originalRead.call(
      this,
      buffer,
      offset,
      length,
      position,
    );
    if (!hooked) {
      hooked = true;
      await hook();
    }
    return result;
  };
  try {
    return await action();
  } finally {
    prototype.read = originalRead;
  }
}

async function withSecondDescriptorStatHook<T>(
  hook: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  const probeRoot = await workspaces.create();
  const probePath = join(probeRoot, "descriptor-stat-probe.bin");
  await writeFile(probePath, "probe");
  const probe = await open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    stat: FileHandleStat;
  };
  await probe.close();

  const originalStat = prototype.stat;
  let calls = 0;
  prototype.stat = async function patchedStat(options) {
    const result = await originalStat.call(this, options);
    calls += 1;
    if (calls === 2) await hook();
    return result;
  };
  try {
    return await action();
  } finally {
    prototype.stat = originalStat;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = performance.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, PROCESS_EXIT_POLL_MS),
    );
  }
  return !isProcessRunning(pid);
}

function isSafeProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

function isProcessRunning(pid: number): boolean {
  if (!isSafeProcessId(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await delay(ASYNC_SETTLEMENT_PROBE_MS);
  expect(settled).toBe(false);
}

async function waitForOperationAdmission(
  harness: ChildProcessHarness,
  invocation: ChildInvocation,
): Promise<{ readonly operation: ReturnType<ChildProcessHarness["run"]> }> {
  const deadline = performance.now() + OPERATION_SLOT_RELEASE_TIMEOUT_MS;
  for (;;) {
    try {
      return { operation: harness.run(invocation) };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !ACTIVE_OPERATION_LIMIT_PATTERN.test(error.message)
      ) {
        throw error;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error("timed out waiting for a child-operation slot");
    }
    await delay(OPERATION_SLOT_POLL_MS);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
