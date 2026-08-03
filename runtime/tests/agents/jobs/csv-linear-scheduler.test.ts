import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CSV_JOB_REGISTRATION_HOLD_MS,
  MAX_RECOVERED_CSV_JOBS,
} from "../../contracts/csv-job-contract.js";
import {
  CsvAgentJobsRepository,
  type CsvJobSupervisorRegistration,
} from "../../state/csv-agent-jobs.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "../../state/sqlite-driver.js";
import {
  CsvJobCompactingQueue,
  CsvJobRecoverySupervisor,
  recordAgentJobResult,
  type AgentJobSpawn,
} from "./job-orchestrator.js";
import { AgentRegistry } from "../registry.js";
import type { Session } from "../../session/session.js";
import {
  _clearAgentControlCacheForTesting,
  _setAgentControlForTesting,
} from "../../bin/delegate-tool.js";
import {
  resumeInterruptedAgentJobs,
  shutdownCsvJobRecoverySupervisor,
} from "../../bin/model-facing-tools.js";
import {
  CsvAgentJobsRepositoryAuthority,
  type CsvAgentJobsRepositoryProvider,
} from "../../app-server/csv-agent-jobs-authority.js";

let home: string;
let cwd: string;
let originalAgencHome: string | undefined;
let driver: StateSqliteDriver;
let repository: CsvAgentJobsRepository;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-linear-scheduler-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-linear-scheduler-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
  repository = new CsvAgentJobsRepository(driver);
});

afterEach(() => {
  vi.useRealTimers();
  driver.close();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function persistedItem(jobId: string, rowIndex: number) {
  const row = { id: `${jobId}-row-${rowIndex}`, value: `${jobId}-${rowIndex}` };
  const contentSha256 = createHash("sha256")
    .update(JSON.stringify(row))
    .digest("hex");
  return {
    itemId: `${jobId}-item-${rowIndex}`,
    rowIndex,
    contentSha256,
    workerName: `csv_row_${rowIndex}_${contentSha256.slice(0, 16)}`,
    row,
  };
}

function createJobInRepository(
  target: CsvAgentJobsRepository,
  workspaceRoot: string,
  jobId: string,
  itemCount: number,
): void {
  target.createJob(
    {
      id: jobId,
      name: jobId,
      instruction: "process {value}",
      autoExport: false,
      inputHeaders: ["id", "value"],
      inputCsvPath: join(workspaceRoot, `${jobId}.csv`),
      outputCsvPath: "",
      requestedMaxConcurrency: 1,
    },
    Array.from({ length: itemCount }, (_, index) =>
      persistedItem(jobId, index),
    ),
  );
}

function createJob(jobId: string, itemCount: number): void {
  createJobInRepository(repository, cwd, jobId, itemCount);
}

function blockingCapacityRegistry(onAbort?: () => void): AgentRegistry {
  return {
    acquireSpawnPermit: vi.fn(
      ({ signal }: { readonly signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const rejectForAbort = (): void => {
            onAbort?.();
            reject(signal?.reason ?? new Error("capacity wait aborted"));
          };
          if (signal?.aborted === true) rejectForAbort();
          else signal?.addEventListener("abort", rejectForAbort, {
            once: true,
          });
        }),
    ),
  } as unknown as AgentRegistry;
}

function trackedRepositoryProvider(
  target: CsvAgentJobsRepository,
  counter: { active: number },
): CsvAgentJobsRepositoryProvider {
  return {
    async withRepository<Result>(_workspaceRoot, operation) {
      counter.active += 1;
      try {
        return await operation(target, new AbortController().signal);
      } finally {
        counter.active -= 1;
      }
    },
  };
}

describe("CsvJobCompactingQueue", () => {
  it("preserves FIFO order while compacting consumed storage geometrically", () => {
    const queue = new CsvJobCompactingQueue<number>();
    for (let value = 0; value < 20_000; value += 1) queue.enqueue(value);

    for (let expected = 0; expected < 15_000; expected += 1) {
      expect(queue.dequeue()).toBe(expected);
    }

    expect(queue.size).toBe(5_000);
    expect(queue.retainedSlots).toBeLessThanOrEqual(queue.size + 4_096);
    for (let expected = 15_000; expected < 20_000; expected += 1) {
      expect(queue.dequeue()).toBe(expected);
    }
    expect(queue.size).toBe(0);
    expect(queue.retainedSlots).toBe(0);
  });

  it("retries the refused FIFO head before later entries", () => {
    const queue = new CsvJobCompactingQueue<string>();
    queue.enqueue("first");
    queue.enqueue("second");
    const refused = queue.dequeue();
    expect(refused).toBe("first");
    queue.enqueueFront(refused!);
    expect(queue.dequeue()).toBe("first");
    expect(queue.dequeue()).toBe("second");
  });
});

describe("CsvJobRecoverySupervisor", () => {
  it("single-flights aliases and retains only the creator lease until shutdown", async () => {
    createJob("alias-recovery", 1);
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let recoveryEntered!: () => void;
    const enteredRecovery = new Promise<void>((resolve) => {
      recoveryEntered = resolve;
    });
    const claimRecovery = repository.claimCsvOutputRecoveryIntents.bind(
      repository,
    );
    const recoverySpy = vi
      .spyOn(repository, "claimCsvOutputRecoveryIntents")
      .mockImplementation(async (input) => {
        recoveryEntered();
        await recoveryGate;
        return claimRecovery(input);
      });
    const ownershipSpy = vi.spyOn(repository, "claimSupervisorOwnership");
    const session = {} as Session;
    const registry = blockingCapacityRegistry();
    _setAgentControlForTesting(session, {
      control: {} as never,
      registry,
    });
    let activeLeases = 0;
    const provider: CsvAgentJobsRepositoryProvider = {
      async withRepository<Result>(_workspaceRoot, operation) {
        activeLeases += 1;
        try {
          return await operation(repository, new AbortController().signal);
        } finally {
          activeLeases -= 1;
        }
      },
    };

    try {
      const first = resumeInterruptedAgentJobs({
        session,
        workspaceRoot: cwd,
        csvAgentJobsRepositories: provider,
      });
      await enteredRecovery;
      const alias = resumeInterruptedAgentJobs({
        session,
        workspaceRoot: `${cwd}/.`,
        csvAgentJobsRepositories: provider,
      });
      const repeated = resumeInterruptedAgentJobs({
        session,
        workspaceRoot: cwd,
        csvAgentJobsRepositories: provider,
      });
      releaseRecovery();

      await expect(Promise.all([first, alias, repeated])).resolves.toEqual([
        1, 1, 1,
      ]);
      expect(recoverySpy).toHaveBeenCalledTimes(1);
      expect(ownershipSpy).toHaveBeenCalledTimes(1);
      expect(activeLeases).toBe(1);

      await shutdownCsvJobRecoverySupervisor({
        workspaceRoot: cwd,
        csvAgentJobsRepositories: provider,
      });
      await vi.waitFor(() => expect(activeLeases).toBe(0));
    } finally {
      await shutdownCsvJobRecoverySupervisor({
        workspaceRoot: cwd,
        csvAgentJobsRepositories: provider,
      });
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("uses repository identity when identical workspace strings have distinct providers", async () => {
    createJob("provider-a", 1);
    const secondaryHome = mkdtempSync(
      join(tmpdir(), "agenc-linear-scheduler-secondary-home-"),
    );
    const secondaryCwd = mkdtempSync(
      join(tmpdir(), "agenc-linear-scheduler-secondary-cwd-"),
    );
    mkdirSync(join(secondaryCwd, ".git"));
    const secondaryDriver = openStateDatabases({
      cwd: secondaryCwd,
      agencHome: secondaryHome,
    });
    const secondaryRepository = new CsvAgentJobsRepository(secondaryDriver);
    createJobInRepository(secondaryRepository, cwd, "provider-b", 1);
    const session = {} as Session;
    _setAgentControlForTesting(session, {
      control: {} as never,
      registry: blockingCapacityRegistry(),
    });
    const leasesA = { active: 0 };
    const leasesB = { active: 0 };
    const providerA = trackedRepositoryProvider(repository, leasesA);
    const providerB = trackedRepositoryProvider(
      secondaryRepository,
      leasesB,
    );

    try {
      await expect(
        Promise.all([
          resumeInterruptedAgentJobs({
            session,
            workspaceRoot: cwd,
            csvAgentJobsRepositories: providerA,
          }),
          resumeInterruptedAgentJobs({
            session,
            workspaceRoot: cwd,
            csvAgentJobsRepositories: providerB,
          }),
        ]),
      ).resolves.toEqual([1, 1]);
      expect(leasesA.active).toBe(1);
      expect(leasesB.active).toBe(1);

      await shutdownCsvJobRecoverySupervisor({
        workspaceRoot: cwd,
        csvAgentJobsRepositories: providerA,
      });
      await vi.waitFor(() => expect(leasesA.active).toBe(0));
      expect(leasesB.active).toBe(1);
      expect(secondaryRepository.getSupervisorState().registeredJobs).toBe(1);

      await shutdownCsvJobRecoverySupervisor({
        workspaceRoot: cwd,
        csvAgentJobsRepositories: providerB,
      });
      await vi.waitFor(() => expect(leasesB.active).toBe(0));
    } finally {
      await shutdownCsvJobRecoverySupervisor({
        workspaceRoot: cwd,
        csvAgentJobsRepositories: providerA,
      });
      await shutdownCsvJobRecoverySupervisor({
        workspaceRoot: cwd,
        csvAgentJobsRepositories: providerB,
      });
      _clearAgentControlCacheForTesting(session);
      secondaryDriver.close();
      rmSync(secondaryHome, { recursive: true, force: true });
      rmSync(secondaryCwd, { recursive: true, force: true });
    }
  });

  it("lets repository authority close drain the owner before its driver", async () => {
    const authorityHome = mkdtempSync(
      join(tmpdir(), "agenc-linear-scheduler-authority-home-"),
    );
    const authorityCwd = mkdtempSync(
      join(tmpdir(), "agenc-linear-scheduler-authority-cwd-"),
    );
    mkdirSync(join(authorityCwd, ".git"));
    const paths = resolveStateDatabasePaths({
      cwd: authorityCwd,
      agencHome: authorityHome,
    });
    const authorityDriver = openStateDatabases({
      cwd: authorityCwd,
      agencHome: authorityHome,
    });
    const authorityRepository = new CsvAgentJobsRepository(authorityDriver);
    createJobInRepository(
      authorityRepository,
      authorityCwd,
      "authority-close",
      1,
    );
    let capacityWaitAborted = false;
    const session = {} as Session;
    _setAgentControlForTesting(session, {
      control: {} as never,
      registry: blockingCapacityRegistry(() => {
        capacityWaitAborted = true;
      }),
    });
    const authority = new CsvAgentJobsRepositoryAuthority({
      canonicalizeWorkspace: async () => authorityCwd,
      resolvePaths: () => paths,
      openDriver: () => authorityDriver,
      openRepository: async () => authorityRepository,
    });
    const leases = { active: 0 };
    const provider: CsvAgentJobsRepositoryProvider = {
      async withRepository<Result>(workspaceRoot, operation, options) {
        leases.active += 1;
        try {
          return await authority.withRepository(
            workspaceRoot,
            operation,
            options,
          );
        } finally {
          leases.active -= 1;
        }
      },
    };
    const closeDriver = authorityDriver.close.bind(authorityDriver);
    const closeEvidence: Array<{
      readonly capacityWaitAborted: boolean;
      readonly activeLeases: number;
    }> = [];
    vi.spyOn(authorityDriver, "close").mockImplementation(() => {
      closeEvidence.push({
        capacityWaitAborted,
        activeLeases: leases.active,
      });
      closeDriver();
    });

    try {
      await expect(
        resumeInterruptedAgentJobs({
          session,
          workspaceRoot: authorityCwd,
          csvAgentJobsRepositories: provider,
        }),
      ).resolves.toBe(1);
      expect(leases.active).toBe(1);

      await authority.close();

      expect(closeEvidence).toEqual([
        { capacityWaitAborted: true, activeLeases: 0 },
      ]);
    } finally {
      await authority.close();
      _clearAgentControlCacheForTesting(session);
      rmSync(authorityHome, { recursive: true, force: true });
      rmSync(authorityCwd, { recursive: true, force: true });
    }
  });

  it("adopts a crash-left registration without replaying its ambiguous item", async () => {
    createJob("restart-job", 2);
    expect(repository.queueNextSupervisorJobPage(1)).toBe(1);
    const abandoned = repository.registerNextSupervisorJob();
    expect(abandoned).not.toBeNull();
    expect(repository.getSupervisorState().registeredJobs).toBe(1);
    repository.beginItemDispatch("restart-job", "restart-job-item-0", {
      supervisorClaim: {
        jobId: abandoned!.jobId,
        supervisorEpoch: abandoned!.supervisorEpoch,
        registrationGeneration: abandoned!.registrationGeneration,
      },
    });
    const spawned: string[] = [];
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        spawned.push(ctx.itemId);
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { value: ctx.row.value },
          });
        });
      },
      async cancelOutstanding() {},
    };

    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });
    expect(await supervisor.start()).toBe(1);
    const results = await supervisor.waitForCompletion();

    expect(results[0]?.summary).toMatchObject({
      status: "needs_review",
      completedItems: 1,
      unknownOutcomeItems: 1,
    });
    expect(spawned).toEqual(["restart-job-item-1"]);
    expect(
      repository.getItem("restart-job", "restart-job-item-0"),
    ).toMatchObject({
      status: "unknown_outcome",
      reviewStatus: "pending",
    });
    expect(repository.getSupervisorRegistration("restart-job")).toMatchObject({
      substate: "done",
    });
    expect(repository.getSupervisorState().registeredJobs).toBe(0);
  });

  it("runs one bounded anomaly reconciliation and exposes poisoned counters", async () => {
    createJob("counter-anomaly", 1);
    expect(repository.queueNextSupervisorJobPage(1)).toBe(1);
    const abandoned = repository.registerNextSupervisorJob()!;
    repository.beginItemDispatch("counter-anomaly", "counter-anomaly-item-0", {
      supervisorClaim: {
        jobId: abandoned.jobId,
        supervisorEpoch: abandoned.supervisorEpoch,
        registrationGeneration: abandoned.registrationGeneration,
      },
    });
    const phases: string[] = [];
    const reconcile = repository.reconcileJobCounters.bind(repository);
    repository.reconcileJobCounters = (jobId, phase) => {
      phases.push(phase);
      return reconcile(jobId, phase);
    };
    const markUnknown = repository.markItemUnknownOutcome.bind(repository);
    repository.markItemUnknownOutcome = (...args) => {
      markUnknown(...args);
      driver
        .prepareState(
          `UPDATE csv_agent_jobs SET pending_items = pending_items + 1
           WHERE id = ?`,
        )
        .run(args[0]);
    };
    let observedErrors = 0;
    const supervisor = new CsvJobRecoverySupervisor({
      repository,
      spawn: {
        async spawn() {
          throw new Error("ambiguous recovered rows must not respawn");
        },
        async cancelOutstanding() {},
      },
      onError: () => {
        observedErrors += 1;
      },
    });

    await supervisor.start();
    await expect(supervisor.waitForCompletion()).rejects.toThrow(
      /counter integrity violation/u,
    );

    expect(phases).toEqual(["startup", "anomaly"]);
    expect(observedErrors).toBe(1);
    expect(repository.getJob("counter-anomaly")).toMatchObject({
      counterIntegrityState: "poisoned",
      automaticFullReconciliations: 2,
    });
    expect(
      repository.getJob("counter-anomaly")?.counterIntegrityError,
    ).toContain("counter integrity mismatch during anomaly");
  });

  it("keeps jobs progressing fairly while retrying a refused FIFO head", async () => {
    createJob("job-a", 3);
    createJob("job-b", 2);
    driver
      .prepareState("UPDATE csv_agent_jobs SET created_at_ms = ?")
      .run(1_000);
    const capacityAttempts: string[] = [];
    const spawned: string[] = [];
    let refusedFirst = false;
    const spawn: AgentJobSpawn = {
      async acquireCapacity({ itemId }) {
        capacityAttempts.push(itemId);
        if (itemId === "job-a-item-0" && !refusedFirst) {
          refusedFirst = true;
          return { kind: "capacity_unavailable", retryAfterMs: 1 };
        }
        return undefined;
      },
      async spawn(ctx) {
        spawned.push(ctx.itemId);
        queueMicrotask(() => {
          recordAgentJobResult({
            jobId: ctx.jobId,
            itemId: ctx.itemId,
            result: { value: ctx.row.value },
          });
        });
      },
      async cancelOutstanding() {},
    };

    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });
    const started = await supervisor.start();
    const results = await supervisor.waitForCompletion();

    expect(started).toBe(2);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.summary.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(capacityAttempts.filter((id) => id === "job-a-item-0")).toHaveLength(
      2,
    );
    expect(spawned.indexOf("job-a-item-0")).toBeLessThan(
      spawned.indexOf("job-a-item-1"),
    );
    expect(spawned.indexOf("job-b-item-0")).toBeLessThan(
      spawned.indexOf("job-a-item-2"),
    );
    expect(repository.getJob("job-a")).toMatchObject({
      status: "completed",
      completedItems: 3,
      automaticFullReconciliations: 2,
    });
    expect(repository.getJob("job-b")).toMatchObject({
      status: "completed",
      completedItems: 2,
      automaticFullReconciliations: 2,
    });
  });

  it("owns cancellation and waits for its launched worker during shutdown", async () => {
    createJob("shutdown-job", 1);
    let resolveWorker!: () => void;
    const workerFinished = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });
    let markSpawned!: () => void;
    const workerSpawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const cancelled: string[] = [];
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        markSpawned();
        return {
          kind: "launched",
          threadId: "owned-thread",
          threadFinished: workerFinished,
        };
      },
      async cancelOutstanding(jobId) {
        cancelled.push(jobId);
        resolveWorker();
      },
    };
    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });

    await supervisor.start();
    await workerSpawned;
    await supervisor.shutdown("test shutdown");

    expect(cancelled).toContain("shutdown-job");
    expect(
      repository.getItem("shutdown-job", "shutdown-job-item-0"),
    ).toMatchObject({
      status: "unknown_outcome",
      assignedThreadId: "owned-thread",
      reviewStatus: "pending",
    });
  });

  it("yields to timers while multiple jobs wait for worker settlement", async () => {
    createJob("blocked-job-a", 1);
    createJob("blocked-job-b", 1);
    const finishWorkers = new Map<string, () => void>();
    let markAllSpawned!: () => void;
    const allSpawned = new Promise<void>((resolve) => {
      markAllSpawned = resolve;
    });
    const cancelled: string[] = [];
    const spawn: AgentJobSpawn = {
      async spawn(ctx) {
        const threadFinished = new Promise<void>((resolve) => {
          finishWorkers.set(ctx.jobId, resolve);
        });
        if (finishWorkers.size === 2) markAllSpawned();
        return {
          kind: "launched",
          threadId: `${ctx.jobId}-thread`,
          threadFinished,
        };
      },
      async cancelOutstanding(jobId) {
        cancelled.push(jobId);
        finishWorkers.get(jobId)?.();
      },
    };
    const supervisor = new CsvJobRecoverySupervisor({ repository, spawn });

    await supervisor.start();
    await allSpawned;
    let heartbeatObserved = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        heartbeatObserved = true;
        resolve();
      }, 25);
    });
    await supervisor.shutdown("test saturated shutdown");

    expect(heartbeatObserved).toBe(true);
    expect(cancelled).toEqual(
      expect.arrayContaining(["blocked-job-a", "blocked-job-b"]),
    );
  });

  it("cancels a parked capacity waiter without leaking the forwarded slot", async () => {
    createJob("capacity-waiter", 1);
    const registry = new AgentRegistry({ maxThreads: 1 });
    const held = await registry.acquireSpawnPermit({ ownerId: "held" });
    let markAcquireStarted!: () => void;
    const acquireStarted = new Promise<void>((resolve) => {
      markAcquireStarted = resolve;
    });
    const supervisor = new CsvJobRecoverySupervisor({
      repository,
      spawn: {
        async acquireCapacity({ jobId, signal }) {
          markAcquireStarted();
          const permit = await registry.acquireSpawnPermit({
            ownerId: jobId,
            ...(signal !== undefined ? { signal } : {}),
          });
          return { kind: "acquired", permit };
        },
        async spawn() {
          throw new Error("a parked capacity waiter must not spawn");
        },
        async cancelOutstanding() {},
      },
    });

    await supervisor.start();
    await acquireStarted;
    await supervisor.shutdown("cancel parked capacity waiter");
    held.cancel();
    const probe = await registry.acquireSpawnPermit({ ownerId: "probe" });
    probe.cancel();
  });

  it("returns an unconsumed permit when supervisor spawn rejects", async () => {
    createJob("rejected-permit", 1);
    const registry = new AgentRegistry({ maxThreads: 1 });
    const supervisor = new CsvJobRecoverySupervisor({
      repository,
      spawn: {
        async acquireCapacity({ jobId, signal }) {
          const permit = await registry.acquireSpawnPermit({
            ownerId: jobId,
            ...(signal !== undefined ? { signal } : {}),
          });
          return { kind: "acquired", permit };
        },
        async spawn() {
          return { kind: "rejected", reason: "test rejection" };
        },
        async cancelOutstanding() {},
      },
    });

    await supervisor.start();
    const [result] = await supervisor.waitForCompletion();
    expect(result?.summary).toMatchObject({
      status: "failed",
      failedItems: 1,
    });
    const probe = await registry.acquireSpawnPermit({ ownerId: "probe" });
    probe.cancel();
  });

  it("observes one terminal rejection across multiple completion waiters", async () => {
    createJob("terminal-rejection", 1);
    let observedErrors = 0;
    const supervisor = new CsvJobRecoverySupervisor({
      repository,
      spawn: {
        async acquireCapacity() {
          throw new Error("terminal scheduler failure");
        },
        async spawn() {
          throw new Error("unreachable spawn");
        },
        async cancelOutstanding() {},
      },
      onError: () => {
        observedErrors += 1;
      },
    });

    await supervisor.start();
    const first = supervisor.waitForCompletion();
    const second = supervisor.waitForCompletion();
    await expect(first).rejects.toThrow("terminal scheduler failure");
    await expect(second).rejects.toThrow("terminal scheduler failure");
    await supervisor.shutdown("terminal rejection observed");
    expect(observedErrors).toBe(1);
  });

  it("releases registration capacity while a rotated worker remains owned", () => {
    const backlogSize = 10_000;
    const registrations = new Map<string, CsvJobSupervisorRegistration>();
    let nextRegistration = 0;
    const fakeRepository = {
      registerNextSupervisorJob() {
        if (nextRegistration >= backlogSize) return null;
        const jobId = `job-${nextRegistration}`;
        const registration: CsvJobSupervisorRegistration = {
          jobId,
          substate: "registered",
          supervisorEpoch: 2,
          registrationGeneration: `generation-${nextRegistration}`,
          queueSequence: nextRegistration + 1,
          admittedItems: 0,
          registeredAtMs: 1,
          updatedAtMs: 1,
        };
        nextRegistration += 1;
        registrations.set(jobId, registration);
        return registration;
      },
      getSupervisorRegistration(jobId: string) {
        return registrations.get(jobId) ?? null;
      },
      completeSupervisorRotation() {
        return true;
      },
    } as unknown as CsvAgentJobsRepository;
    const supervisor = new CsvJobRecoverySupervisor({
      repository: fakeRepository,
      spawn: {
        async spawn() {},
        async cancelOutstanding() {},
      },
    });
    const registerQueuedJobs = (
      supervisor as unknown as { registerQueuedJobs(): number }
    ).registerQueuedJobs.bind(supervisor);

    while (registerQueuedJobs() > 0) {
      // Fill the bounded in-memory window without running the queued jobs.
    }

    expect(supervisor.activeRuntimeCount).toBe(MAX_RECOVERED_CSV_JOBS);
    expect(nextRegistration).toBe(MAX_RECOVERED_CSV_JOBS);
    expect(registerQueuedJobs()).toBe(0);

    const internals = supervisor as unknown as {
      readonly active: Map<string, { readonly inflight: Set<Promise<void>> }>;
      suspendRuntime(runtime: { readonly inflight: Set<Promise<void>> }): void;
    };
    const rotated = internals.active.values().next().value;
    expect(rotated).toBeDefined();
    rotated!.inflight.add(new Promise<void>(() => {}));
    internals.suspendRuntime(rotated!);
    expect(supervisor.activeRuntimeCount).toBe(MAX_RECOVERED_CSV_JOBS);
    expect(supervisor.registeredRuntimeCount).toBe(MAX_RECOVERED_CSV_JOBS - 1);
    expect(registerQueuedJobs()).toBe(1);
    expect(supervisor.activeRuntimeCount).toBe(MAX_RECOVERED_CSV_JOBS + 1);
    expect(supervisor.registeredRuntimeCount).toBe(MAX_RECOVERED_CSV_JOBS);
    expect(nextRegistration).toBe(MAX_RECOVERED_CSV_JOBS + 1);
  });

  it("wakes a saturated inflight runtime at the registration hold deadline", async () => {
    vi.useFakeTimers();
    const registration: CsvJobSupervisorRegistration = {
      jobId: "deadline-job",
      substate: "registered",
      supervisorEpoch: 2,
      registrationGeneration: "deadline-generation",
      queueSequence: 1,
      admittedItems: 1,
      registeredAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    const fakeRepository = {
      registerNextSupervisorJob: vi
        .fn()
        .mockReturnValueOnce(registration)
        .mockReturnValue(null),
      getSupervisorRegistration: vi.fn(() => registration),
    } as unknown as CsvAgentJobsRepository;
    const supervisor = new CsvJobRecoverySupervisor({
      repository: fakeRepository,
      spawn: {
        async spawn() {},
        async cancelOutstanding() {},
      },
    });
    const internals = supervisor as unknown as {
      supervisorStarted: boolean;
      readonly round: CsvJobCompactingQueue<string>;
      readonly active: Map<
        string,
        {
          inflight: Set<Promise<void>>;
          queuedForRound: boolean;
          rotationDue: boolean;
        }
      >;
      registerQueuedJobs(): number;
      scheduleRegistrationHoldWake(runtime: unknown): void;
      nextSupervisorWake(): Promise<void>;
    };
    internals.supervisorStarted = true;
    expect(internals.registerQueuedJobs()).toBe(1);
    const runtime = internals.active.get("deadline-job")!;
    expect(internals.round.dequeue()).toBe("deadline-job");
    runtime.queuedForRound = false;
    runtime.inflight.add(new Promise<void>(() => {}));
    internals.scheduleRegistrationHoldWake(runtime);
    const wake = internals.nextSupervisorWake();

    await vi.advanceTimersByTimeAsync(MAX_CSV_JOB_REGISTRATION_HOLD_MS - 1);
    expect(runtime.rotationDue).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wake;

    expect(runtime.rotationDue).toBe(true);
    expect(internals.round.dequeue()).toBe("deadline-job");
  });
});
