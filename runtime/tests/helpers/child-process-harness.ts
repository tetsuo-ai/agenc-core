import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  isProcessTreeAlive,
  runSupervisedProcess,
  signalProcessTree,
  spawnContainedProcess,
  terminateProcessTreeAndWait,
  waitForProcessTreeExit,
  type SupervisedProcessResult,
} from "../../src/utils/supervisedProcess.js";
import {
  snapshotBoundedJsonObject,
  snapshotChildInvocation,
  snapshotMarkerExpectation,
  PROCESS_EVIDENCE_NONCE_ENV,
  PROCESS_EVIDENCE_NONCE_HEX_LENGTH,
  PROCESS_EVIDENCE_NONCE_JSON_KEY,
  type ChildHeartbeatExpectation,
  type ChildInvocation,
  type DurableMarkerExpectation,
  type SnapshottedChildInvocation,
  type SnapshottedMarkerExpectation,
} from "./process-harness-contract.js";
import {
  pinProcessWorkspace,
  type PinnedProcessWorkspace,
  type ValidatedProcessLocation,
} from "./process-workspace.js";

export type {
  ChildHeartbeatExpectation,
  ChildInvocation,
  DurableMarkerExpectation,
} from "./process-harness-contract.js";

const DEFAULT_SETTLE_BACKSTOP_MS = 1_000;
const MARKER_POLL_INTERVAL_MS = 10;
const HEARTBEAT_POLL_INTERVAL_MS = 10;
const EVIDENCE_NONCE_BYTES = PROCESS_EVIDENCE_NONCE_HEX_LENGTH / 2;
const TERMINATION_RECHECK_GRACE_MS = 1;
export const MAX_ACTIVE_CHILD_OPERATIONS = 8;
export const MAX_INTERNAL_OPERATION_SETTLEMENT_MS = 2_000;

export type ChildStopReason =
  | "exit"
  | "signal"
  | "timeout"
  | "heartbeat-timeout"
  | "output-limit"
  | "aborted"
  | "spawn-error"
  | "residual-process"
  | "terminated"
  | "crashed";

export interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stopReason: ChildStopReason;
  readonly forced: boolean;
  readonly backstopExpired: boolean;
  readonly heartbeatCount: number;
  readonly error?: Error;
}

export interface OwnedChild {
  readonly settled: Promise<ChildResult>;
  waitForMarker(expectation: DurableMarkerExpectation): Promise<void>;
  terminate(): Promise<ChildResult>;
  crash(): Promise<ChildResult>;
}

export interface ChildProcessHarness {
  run(invocation: ChildInvocation): Promise<ChildResult>;
  spawn(invocation: ChildInvocation): Promise<OwnedChild>;
  cleanup(): Promise<void>;
}

export interface ChildProcessHarnessTestHooks {
  beforePreparationValidation?(): void | Promise<void>;
  afterHeartbeatRead?(): void | Promise<void>;
}

interface PreparedHeartbeat extends ChildHeartbeatExpectation {
  readonly absolutePath: string;
}

interface PreparedInvocation {
  readonly location: ValidatedProcessLocation;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly maxOutputBytes: number;
  readonly terminateGraceMs: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly heartbeat?: PreparedHeartbeat;
  readonly durableMarkers: readonly string[];
  readonly evidenceNonce: string;
}

type PreparationOutcome =
  | { readonly kind: "prepared"; readonly value: PreparedInvocation }
  | { readonly kind: "aborted" }
  | { readonly kind: "timeout" };

interface TrackedPreparation {
  readonly outcome: Promise<PreparationOutcome>;
  readonly physicalSettlement: Promise<void>;
}

interface TrackedOperation<T> {
  readonly result: Promise<T>;
  readonly physicalSettlement: Promise<void>;
}

type InternalOperationOutcome =
  | { readonly kind: "fulfilled" }
  | { readonly kind: "rejected"; readonly error: unknown };

type HarnessState = "open" | "cleaning" | "cleaned" | "failed";

export async function createChildProcessHarness(
  workspaceRoot: string,
  hooks: ChildProcessHarnessTestHooks = Object.freeze({}),
): Promise<ChildProcessHarness> {
  const workspace = await pinProcessWorkspace(workspaceRoot);
  return new ChildProcessHarnessImplementation(workspace, hooks);
}

class ChildProcessHarnessImplementation implements ChildProcessHarness {
  readonly #workspace: PinnedProcessWorkspace;
  readonly #hooks: ChildProcessHarnessTestHooks;
  readonly #children = new Set<OwnedChildImplementation>();
  readonly #activeRuns = new Map<Promise<ChildResult>, AbortController>();
  readonly #pendingSpawns = new Map<Promise<OwnedChild>, AbortController>();
  readonly #operationSlots = new Set<object>();
  readonly #preparations = new Set<Promise<void>>();
  readonly #recordedSettlements = new WeakSet<object>();
  readonly #settlementFailures: Error[] = [];
  #state: HarnessState = "open";
  #cleanupPromise: Promise<void> | undefined;

  constructor(
    workspace: PinnedProcessWorkspace,
    hooks: ChildProcessHarnessTestHooks,
  ) {
    this.#workspace = workspace;
    this.#hooks = Object.freeze({ ...hooks });
  }

  run(invocation: ChildInvocation): Promise<ChildResult> {
    this.#assertUsable();
    const releaseSlot = this.#acquireOperationSlot();
    let snapshot: SnapshottedChildInvocation;
    try {
      snapshot = snapshotChildInvocation(invocation);
    } catch (error) {
      releaseSlot();
      throw error;
    }
    const cleanupController = new AbortController();
    const tracked = this.#runTracked(snapshot, cleanupController);
    const operation = tracked.result;
    this.#activeRuns.set(operation, cleanupController);
    void operation.then(
      (result) => {
        this.#recordSettlement(result);
        this.#activeRuns.delete(operation);
      },
      () => {
        this.#activeRuns.delete(operation);
      },
    );
    void Promise.allSettled([operation, tracked.physicalSettlement]).then(
      releaseSlot,
    );
    return operation;
  }

  spawn(invocation: ChildInvocation): Promise<OwnedChild> {
    this.#assertUsable();
    const releaseSlot = this.#acquireOperationSlot();
    let snapshot: SnapshottedChildInvocation;
    try {
      snapshot = snapshotChildInvocation(invocation);
    } catch (error) {
      releaseSlot();
      throw error;
    }
    const cleanupController = new AbortController();
    const tracked = this.#spawnTracked(snapshot, cleanupController);
    const operation = tracked.result;
    this.#pendingSpawns.set(operation, cleanupController);
    void operation.then(
      () => {
        this.#pendingSpawns.delete(operation);
      },
      () => {
        this.#pendingSpawns.delete(operation);
      },
    );
    const childSettlement = operation.then(
      (child) => child.settled,
      () => undefined,
    );
    void Promise.allSettled([
      operation,
      tracked.physicalSettlement,
      childSettlement,
    ]).then(releaseSlot);
    return operation;
  }

  cleanup(): Promise<void> {
    if (this.#cleanupPromise !== undefined) return this.#cleanupPromise;
    this.#state = "cleaning";
    this.#cleanupPromise = this.#performCleanup().then(
      () => {
        this.#state = "cleaned";
      },
      (error: unknown) => {
        this.#state = "failed";
        throw error;
      },
    );
    return this.#cleanupPromise;
  }

  #runTracked(
    snapshot: SnapshottedChildInvocation,
    cleanupController: AbortController,
  ): TrackedOperation<ChildResult> {
    const preparation = this.#startPreparation(
      snapshot,
      cleanupController.signal,
    );
    const result = (async (): Promise<ChildResult> => {
      const outcome = await preparation.outcome;
      if (outcome.kind === "aborted") return stoppedBeforeSpawn("aborted");
      if (outcome.kind === "timeout") return stoppedBeforeSpawn("timeout");
      const prepared = outcome.value;

      if (prepared.heartbeat !== undefined) {
        const child = this.#spawnPrepared(prepared);
        return child.settled;
      }

      const supervised = await runSupervisedProcess(
        {
          program: prepared.location.program,
          args: prepared.args,
          cwd: prepared.location.cwd,
          env: prepared.env,
        },
        {
          timeoutMs: prepared.timeoutMs,
          maxOutputBytes: prepared.maxOutputBytes,
          ...(prepared.stdin === undefined
            ? {}
            : { stdin: Buffer.from(prepared.stdin) }),
          signal: prepared.signal,
          terminateGraceMs: prepared.terminateGraceMs,
          settleBackstopMs: DEFAULT_SETTLE_BACKSTOP_MS,
        },
      );
      return mapSupervisedResult(supervised);
    })();
    return Object.freeze({
      result,
      physicalSettlement: preparation.physicalSettlement,
    });
  }

  #spawnTracked(
    snapshot: SnapshottedChildInvocation,
    cleanupController: AbortController,
  ): TrackedOperation<OwnedChild> {
    const preparation = this.#startPreparation(
      snapshot,
      cleanupController.signal,
    );
    const result = (async (): Promise<OwnedChild> => {
      const outcome = await preparation.outcome;
      if (outcome.kind === "aborted") {
        return new SettledOwnedChild(stoppedBeforeSpawn("aborted"));
      }
      if (outcome.kind === "timeout") {
        return new SettledOwnedChild(stoppedBeforeSpawn("timeout"));
      }
      return this.#spawnPrepared(outcome.value);
    })();
    return Object.freeze({
      result,
      physicalSettlement: preparation.physicalSettlement,
    });
  }

  #startPreparation(
    snapshot: SnapshottedChildInvocation,
    cleanupSignal: AbortSignal,
  ): TrackedPreparation {
    const signal =
      snapshot.signal === undefined
        ? cleanupSignal
        : AbortSignal.any([snapshot.signal, cleanupSignal]);
    if (signal.aborted) {
      return Object.freeze({
        outcome: Promise.resolve<PreparationOutcome>({ kind: "aborted" }),
        physicalSettlement: Promise.resolve(),
      });
    }

    const validation = (async (): Promise<PreparedInvocation> => {
      await this.#hooks.beforePreparationValidation?.();
      const evidenceNonce = randomBytes(EVIDENCE_NONCE_BYTES).toString("hex");
      const location = await this.#workspace.validateProcessLocation(
        snapshot.program,
        snapshot.cwd,
      );
      const durableMarkers = await Promise.all(
        snapshot.durableMarkers.map((path, index) =>
          this.#workspace.resolveOwnedFile(
            path,
            `child durable marker ${index + 1}`,
          ),
        ),
      );
      const heartbeat =
        snapshot.heartbeat === undefined
          ? undefined
          : Object.freeze({
              ...snapshot.heartbeat,
              absolutePath: await this.#workspace.resolveOwnedFile(
                snapshot.heartbeat.path,
                "child heartbeat path",
              ),
            });
      const evidencePaths = [
        ...durableMarkers,
        ...(heartbeat === undefined ? [] : [heartbeat.absolutePath]),
      ];
      const evidenceIdentities = evidencePaths.map((path) =>
        this.#workspace.portableIdentityOfOwnedFile(
          path,
          "child evidence path",
        ),
      );
      if (new Set(evidenceIdentities).size !== evidenceIdentities.length) {
        throw new Error("child evidence paths must resolve uniquely");
      }
      await Promise.all(
        evidencePaths.map((path) =>
          this.#workspace.assertOwnedFileAbsent(path, "child evidence path"),
        ),
      );
      await this.#workspace.revalidateProcessLocation(location);
      const timeoutMs = remainingMilliseconds(snapshot.deadline);
      if (timeoutMs === 0) {
        throw new PreparationTimeout();
      }
      const env = Object.assign(Object.create(null) as Record<string, string>, {
        ...snapshot.env,
        [PROCESS_EVIDENCE_NONCE_ENV]: evidenceNonce,
      });
      return Object.freeze({
        location,
        args: snapshot.args,
        env: Object.freeze(env),
        ...(snapshot.stdin === undefined ? {} : { stdin: snapshot.stdin }),
        maxOutputBytes: snapshot.maxOutputBytes,
        terminateGraceMs: snapshot.terminateGraceMs,
        signal,
        timeoutMs,
        ...(heartbeat === undefined ? {} : { heartbeat }),
        durableMarkers: Object.freeze(durableMarkers),
        evidenceNonce,
      });
    })();
    const validationOutcome = validation.then(
      (value) => ({ kind: "fulfilled", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );
    let resolveDisposition!: (disposition: "detached" | "observed") => void;
    const disposition = new Promise<"detached" | "observed">((resolve) => {
      resolveDisposition = resolve;
    });
    const outcome = racePreparation(validation, signal, snapshot.deadline).then(
      (result) => {
        resolveDisposition(
          result.kind === "prepared" ? "observed" : "detached",
        );
        return result;
      },
      (error: unknown) => {
        resolveDisposition("observed");
        throw error;
      },
    );
    const physicalSettlement = Promise.all([
      validationOutcome,
      disposition,
    ]).then(([settlement, finalDisposition]) => {
      if (
        finalDisposition === "detached" &&
        settlement.kind === "rejected" &&
        !(settlement.error instanceof PreparationTimeout)
      ) {
        this.#settlementFailures.push(
          new Error(
            "child preparation failed after its caller stopped waiting",
            {
              cause: toError(settlement.error),
            },
          ),
        );
      }
    });
    this.#preparations.add(physicalSettlement);
    void physicalSettlement.then(() => {
      this.#preparations.delete(physicalSettlement);
    });
    return Object.freeze({ outcome, physicalSettlement });
  }

  #spawnPrepared(prepared: PreparedInvocation): OwnedChild {
    let process: ChildProcessWithoutNullStreams;
    try {
      process = spawnContainedProcess(
        prepared.location.program,
        prepared.args,
        {
          cwd: prepared.location.cwd,
          env: prepared.env,
        },
      );
    } catch (error) {
      const result = spawnErrorResult(error);
      this.#recordSettlement(result);
      return new SettledOwnedChild(result);
    }

    const owned = new OwnedChildImplementation(
      this.#workspace,
      process,
      prepared,
      this.#hooks,
    );
    this.#children.add(owned);
    void owned.settled.then(
      (result) => {
        this.#recordSettlement(result);
        this.#children.delete(owned);
      },
      (error: unknown) => {
        this.#settlementFailures.push(toError(error));
        this.#children.delete(owned);
      },
    );
    return owned;
  }

  async #performCleanup(): Promise<void> {
    const cleanupErrors: Error[] = [];
    for (;;) {
      const runs = [...this.#activeRuns.entries()];
      const spawns = [...this.#pendingSpawns.entries()];
      const children = [...this.#children];
      const preparations = [...this.#preparations];
      for (const [, controller] of [...runs, ...spawns]) controller.abort();

      const outcomes = await Promise.allSettled([
        ...runs.map(([operation]) => operation),
        ...spawns.map(([operation]) => operation),
        ...children.map((child) => child.terminate()),
        ...preparations.map((preparation) =>
          awaitPhysicalSettlementWithinBound(
            preparation,
            MAX_INTERNAL_OPERATION_SETTLEMENT_MS,
            "child preparation",
          ),
        ),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          cleanupErrors.push(toError(outcome.reason));
        }
      }
      if (
        this.#activeRuns.size === 0 &&
        this.#pendingSpawns.size === 0 &&
        this.#children.size === 0 &&
        this.#preparations.size === 0 &&
        this.#operationSlots.size === 0
      ) {
        break;
      }
    }

    cleanupErrors.push(...this.#settlementFailures.splice(0));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "child-process harness cleanup could not prove complete settlement",
      );
    }
  }

  #recordSettlement(result: ChildResult): void {
    if (this.#recordedSettlements.has(result)) return;
    this.#recordedSettlements.add(result);
    if (
      result.error === undefined &&
      !result.backstopExpired &&
      result.stopReason !== "residual-process"
    ) {
      return;
    }
    this.#settlementFailures.push(
      new Error(
        `child-process settlement failed (stop=${result.stopReason}, backstop=${String(result.backstopExpired)})`,
        result.error === undefined ? undefined : { cause: result.error },
      ),
    );
  }

  #assertUsable(): void {
    if (this.#state !== "open") {
      throw new Error(`child-process harness is ${this.#state}`);
    }
  }

  #acquireOperationSlot(): () => void {
    if (this.#operationSlots.size >= MAX_ACTIVE_CHILD_OPERATIONS) {
      throw new Error(
        `child-process harness supports at most ${MAX_ACTIVE_CHILD_OPERATIONS} active operations`,
      );
    }
    const token = Object.freeze({});
    this.#operationSlots.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#operationSlots.delete(token);
    };
  }
}

class SettledOwnedChild implements OwnedChild {
  readonly settled: Promise<ChildResult>;

  constructor(result: ChildResult) {
    this.settled = Promise.resolve(result);
  }

  waitForMarker(): Promise<void> {
    return Promise.reject(new Error("settled child cannot publish a marker"));
  }

  terminate(): Promise<ChildResult> {
    return this.settled;
  }

  crash(): Promise<ChildResult> {
    return this.settled;
  }
}

class OwnedChildImplementation implements OwnedChild {
  readonly settled: Promise<ChildResult>;

  readonly #workspace: PinnedProcessWorkspace;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #invocation: PreparedInvocation;
  readonly #hooks: ChildProcessHarnessTestHooks;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];

  #resolveSettled!: (result: ChildResult) => void;
  #outputBytes = 0;
  #heartbeatCount = 0;
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #error: Error | undefined;
  #requestedStopReason: ChildStopReason | undefined;
  #forced = false;
  #backstopExpired = false;
  #closed = false;
  #termination: Promise<void> | undefined;
  #finishing: Promise<void> | undefined;
  #heartbeatMonitor: Promise<void> | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    workspace: PinnedProcessWorkspace,
    child: ChildProcessWithoutNullStreams,
    invocation: PreparedInvocation,
    hooks: ChildProcessHarnessTestHooks,
  ) {
    this.#workspace = workspace;
    this.#child = child;
    this.#invocation = invocation;
    this.#hooks = hooks;
    this.settled = new Promise((resolve) => {
      this.#resolveSettled = resolve;
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.#append(this.#stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#append(this.#stderr, chunk);
    });
    child.on("error", (error) => {
      this.#error = error;
      this.#requestedStopReason ??= "spawn-error";
    });
    child.on("exit", (exitCode, signal) => {
      this.#exitCode = exitCode;
      this.#exitSignal = signal;
    });
    child.on("close", () => {
      void this.#finish();
    });

    invocation.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (invocation.signal.aborted) this.#onAbort();
    this.#timeout = setTimeout(() => {
      void this.#requestStop("timeout");
    }, invocation.timeoutMs);
    if (invocation.heartbeat !== undefined) {
      this.#heartbeatMonitor = this.#monitorHeartbeat(
        invocation.heartbeat,
      ).catch(async (error: unknown) => {
        if (this.#closed) return;
        this.#error ??= toError(error);
        await this.#requestStop("spawn-error");
      });
    }
    this.#writeStdin(invocation.stdin);
  }

  waitForMarker(expectation: DurableMarkerExpectation): Promise<void> {
    const snapshot = snapshotMarkerExpectation(expectation);
    return this.#waitForMarker(snapshot);
  }

  async terminate(): Promise<ChildResult> {
    if (!this.#closed) await this.#requestStop("terminated");
    return this.settled;
  }

  async crash(): Promise<ChildResult> {
    if (!this.#closed) {
      this.#requestedStopReason ??= "crashed";
      signalProcessTree(this.#child, "SIGKILL");
      await this.#ensureTermination();
    }
    return this.settled;
  }

  #onAbort = (): void => {
    void this.#requestStop("aborted");
  };

  async #waitForMarker(
    expectation: SnapshottedMarkerExpectation,
  ): Promise<void> {
    const absolutePath = await this.#workspace.resolveOwnedFile(
      expectation.path,
      "child marker path",
    );
    if (!this.#invocation.durableMarkers.includes(absolutePath)) {
      throw new Error("child marker path was not declared before spawn");
    }
    const deadline = performance.now() + expectation.timeoutMs;
    for (;;) {
      const marker = await this.#workspace.readBoundedFileIfPresent(
        absolutePath,
        expectation.maxBytes,
      );
      if (marker !== null) {
        const json = evidencePayload(
          parseBoundedJson(
            marker.bytes,
            expectation.maxBytes,
            "durable child marker",
          ),
          this.#invocation.evidenceNonce,
          "durable child marker",
        );
        if (
          expectation.expectedJson !== undefined &&
          !isDeepStrictEqual(json, expectation.expectedJson)
        ) {
          throw new Error(
            "durable child marker JSON does not match expectation",
          );
        }
        return;
      }
      if (this.#closed) {
        const result = await this.settled;
        throw new Error(
          `child settled before its durable marker (exit=${String(result.exitCode)}, signal=${String(result.signal)})`,
        );
      }
      if (performance.now() >= deadline) {
        throw new Error("timed out waiting for durable child marker");
      }
      await delay(MARKER_POLL_INTERVAL_MS);
    }
  }

  async #monitorHeartbeat(heartbeat: PreparedHeartbeat): Promise<void> {
    const started = performance.now();
    let lastChange = started;
    let lastSequence: number | undefined;
    for (;;) {
      if (this.#closed) return;
      const snapshot = await this.#workspace.readBoundedFileIfPresent(
        heartbeat.absolutePath,
        heartbeat.maxBytes,
      );
      await this.#hooks.afterHeartbeatRead?.();
      if (this.#closed) return;
      const now = performance.now();
      if (snapshot !== null) {
        const sequence = parseHeartbeatSequence(
          snapshot.bytes,
          heartbeat.maxBytes,
          this.#invocation.evidenceNonce,
        );
        if (lastSequence === undefined && sequence !== 1) {
          throw new Error("child heartbeat must begin with sequence 1");
        }
        if (lastSequence !== undefined && sequence < lastSequence) {
          throw new Error("child heartbeat sequence moved backwards");
        }
        if (lastSequence === undefined || sequence > lastSequence) {
          lastSequence = sequence;
          lastChange = now;
          this.#heartbeatCount = sequence;
        }
      }
      if (
        (lastSequence === undefined &&
          now - started >= heartbeat.startupTimeoutMs) ||
        (lastSequence !== undefined &&
          now - lastChange >= heartbeat.intervalTimeoutMs)
      ) {
        await this.#requestStop("heartbeat-timeout");
        return;
      }
      await delay(HEARTBEAT_POLL_INTERVAL_MS);
    }
  }

  #writeStdin(stdin: Uint8Array | undefined): void {
    this.#child.stdin.on("error", (error) => {
      if (this.#closed || isExpectedStdinEarlyClose(error)) return;
      this.#error ??= error;
      void this.#requestStop("spawn-error");
    });
    try {
      this.#child.stdin.end(
        stdin === undefined ? undefined : Buffer.from(stdin),
      );
    } catch (error) {
      if (isExpectedStdinEarlyClose(error)) return;
      this.#error ??= toError(error);
      void this.#requestStop("spawn-error");
    }
  }

  #append(target: Buffer[], chunk: Buffer | string): void {
    if (this.#closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.#invocation.maxOutputBytes - this.#outputBytes;
    const accepted = bytes.subarray(0, Math.max(0, remaining));
    if (accepted.byteLength > 0) {
      target.push(accepted);
      this.#outputBytes += accepted.byteLength;
    }
    if (accepted.byteLength !== bytes.byteLength) {
      void this.#requestStop("output-limit");
    }
  }

  async #requestStop(reason: ChildStopReason): Promise<void> {
    if (this.#closed) return;
    this.#requestedStopReason ??= reason;
    await this.#ensureTermination();
  }

  #ensureTermination(): Promise<void> {
    if (this.#termination === undefined) {
      this.#termination = this.#terminateOwnedTree().catch((error: unknown) => {
        this.#error ??= toError(error);
        this.#backstopExpired = true;
      });
      void this.#termination.then(() => this.#finish());
    }
    return this.#termination;
  }

  async #terminateOwnedTree(): Promise<void> {
    const options = {
      terminateGraceMs: this.#invocation.terminateGraceMs,
      killGraceMs: DEFAULT_SETTLE_BACKSTOP_MS,
      label: "FND child-process harness child",
    } as const;
    if (
      this.#requestedStopReason === "crashed" ||
      !isProcessTreeAlive(this.#child)
    ) {
      await terminateProcessTreeAndWait(this.#child, options);
      return;
    }

    signalProcessTree(this.#child, "SIGTERM");
    const exitedGracefully = await waitForProcessTreeExit(
      this.#child,
      this.#invocation.terminateGraceMs,
    );
    if (exitedGracefully) {
      await terminateProcessTreeAndWait(this.#child, options);
      return;
    }

    this.#forced = true;
    signalProcessTree(this.#child, "SIGKILL");
    await terminateProcessTreeAndWait(this.#child, {
      ...options,
      terminateGraceMs: TERMINATION_RECHECK_GRACE_MS,
    });
  }

  #finish(): Promise<void> {
    this.#finishing ??= this.#finishAfterTreeSettlement();
    return this.#finishing;
  }

  async #finishAfterTreeSettlement(): Promise<void> {
    this.#closed = true;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#invocation.signal.removeEventListener("abort", this.#onAbort);
    this.#child.stdout.removeAllListeners();
    this.#child.stderr.removeAllListeners();
    await this.#ensureTermination();
    if (this.#heartbeatMonitor !== undefined) {
      try {
        await awaitPhysicalSettlementWithinBound(
          this.#heartbeatMonitor,
          MAX_INTERNAL_OPERATION_SETTLEMENT_MS,
          "child heartbeat monitor",
        );
      } catch (error) {
        this.#error ??= toError(error);
        this.#backstopExpired = true;
      }
    }
    this.#exitCode ??= this.#child.exitCode;
    this.#exitSignal ??= this.#child.signalCode;
    this.#resolveSettled({
      exitCode: this.#exitCode,
      signal: this.#exitSignal,
      stdout: Buffer.concat(this.#stdout),
      stderr: Buffer.concat(this.#stderr),
      stopReason:
        this.#requestedStopReason ??
        (this.#exitSignal === null ? "exit" : "signal"),
      forced: this.#forced,
      backstopExpired: this.#backstopExpired,
      heartbeatCount: this.#heartbeatCount,
      ...(this.#error === undefined ? {} : { error: this.#error }),
    });
  }
}

async function racePreparation(
  preparation: Promise<PreparedInvocation>,
  signal: AbortSignal,
  deadline: number,
): Promise<PreparationOutcome> {
  if (signal.aborted) return { kind: "aborted" };
  const remaining = remainingMilliseconds(deadline);
  if (remaining === 0) return { kind: "timeout" };

  return new Promise<PreparationOutcome>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => settle({ kind: "timeout" }), remaining);
    const onAbort = (): void => settle({ kind: "aborted" });
    const settle = (outcome: PreparationOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void preparation.then(
      (value) => settle({ kind: "prepared", value }),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error instanceof PreparationTimeout) {
          resolve({ kind: "timeout" });
        } else {
          reject(error);
        }
      },
    );
  });
}

async function awaitPhysicalSettlementWithinBound(
  operation: Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const outcome: Promise<InternalOperationOutcome> = operation.then(
    (): InternalOperationOutcome => ({ kind: "fulfilled" }),
    (error: unknown): InternalOperationOutcome => ({
      kind: "rejected",
      error,
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline("deadline"), timeoutMs);
  });
  const initial = await Promise.race([outcome, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  if (initial !== "deadline") {
    if (initial.kind === "rejected") throw initial.error;
    return;
  }

  const boundError = new Error(
    `${label} exceeded its ${timeoutMs}-millisecond physical-settlement bound`,
  );
  const final = await outcome;
  if (final.kind === "rejected") {
    throw new AggregateError(
      [boundError, toError(final.error)],
      `${label} exceeded its bound and then failed`,
    );
  }
  throw boundError;
}

class PreparationTimeout extends Error {}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, Math.ceil(deadline - performance.now()));
}

function parseBoundedJson(
  bytes: Buffer,
  maximumBytes: number,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    return snapshotBoundedJsonObject(parsed, maximumBytes);
  } catch (error) {
    throw new Error(`${label} is not valid bounded JSON`, { cause: error });
  }
}

function parseHeartbeatSequence(
  bytes: Buffer,
  maximumBytes: number,
  evidenceNonce: string,
): number {
  const heartbeat = parseBoundedJson(bytes, maximumBytes, "child heartbeat");
  const keys = Object.keys(heartbeat).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== PROCESS_EVIDENCE_NONCE_JSON_KEY ||
    keys[1] !== "schemaVersion" ||
    keys[2] !== "sequence" ||
    heartbeat[PROCESS_EVIDENCE_NONCE_JSON_KEY] !== evidenceNonce ||
    heartbeat.schemaVersion !== 1 ||
    !Number.isSafeInteger(heartbeat.sequence) ||
    (heartbeat.sequence as number) <= 0
  ) {
    throw new Error(
      "child heartbeat must contain schemaVersion 1 and a sequence",
    );
  }
  return heartbeat.sequence as number;
}

function evidencePayload(
  record: Readonly<Record<string, unknown>>,
  evidenceNonce: string,
  label: string,
): Readonly<Record<string, unknown>> {
  if (record[PROCESS_EVIDENCE_NONCE_JSON_KEY] !== evidenceNonce) {
    throw new Error(`${label} does not belong to the current child`);
  }
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === PROCESS_EVIDENCE_NONCE_JSON_KEY) continue;
    Object.defineProperty(payload, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: record[key],
    });
  }
  return Object.freeze(payload);
}

function mapSupervisedResult(result: SupervisedProcessResult): ChildResult {
  let stopReason: ChildStopReason;
  switch (result.stopReason) {
    case undefined:
      stopReason = result.signal === null ? "exit" : "signal";
      break;
    case "timeout":
      stopReason = "timeout";
      break;
    case "aborted":
      stopReason = "aborted";
      break;
    case "output_limit":
    case "consumer_limit":
      stopReason = "output-limit";
      break;
    case "spawn_error":
      stopReason = "spawn-error";
      break;
    case "residual_process":
      stopReason = "residual-process";
      break;
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stopReason,
    forced: result.forced,
    backstopExpired: result.backstopExpired,
    heartbeatCount: 0,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function stoppedBeforeSpawn(reason: "aborted" | "timeout"): ChildResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stopReason: reason,
    forced: false,
    backstopExpired: false,
    heartbeatCount: 0,
  };
}

function spawnErrorResult(error: unknown): ChildResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stopReason: "spawn-error",
    forced: false,
    backstopExpired: false,
    heartbeatCount: 0,
    error: toError(error),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isExpectedStdinEarlyClose(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}
