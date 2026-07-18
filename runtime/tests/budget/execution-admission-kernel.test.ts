import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdmissionLease } from "../../src/budget/admission-types.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

const LIMITS = {
  global: 1,
  workspace: 1,
  session: 1,
  parent: 1,
  provider: 1,
} as const;

let home = "";
let cwd = "";
const kernels = new Set<ExecutionAdmissionKernel>();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-kernel-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-kernel-cwd-"));
  mkdirSync(join(cwd, ".git"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const kernel of kernels) kernel.close();
  kernels.clear();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function kernel(
  ownerId: string,
  limits: typeof LIMITS = LIMITS,
): ExecutionAdmissionKernel {
  const value = new ExecutionAdmissionKernel({
    agencHome: home,
    limits,
    ownerId,
    ownerPid: process.pid,
    queueAgingMs: 10,
  });
  kernels.add(value);
  return value;
}

function bind(
  value: ExecutionAdmissionKernel,
  runId: string,
  options: { readonly deadlineAt?: string } = {},
): ExecutionAdmissionClient {
  return value.bindClient({
    cwd,
    scope: {
      runId,
      sessionId: runId,
      autonomous: false,
      ...(options.deadlineAt !== undefined
        ? { deadlineAt: options.deadlineAt }
        : {}),
    },
  });
}

function acquire(
  client: ExecutionAdmissionClient,
  stepId = "step-1",
): Promise<AdmissionLease> {
  return client.acquire({
    stepId,
    kind: "model_turn",
    model: "test-model",
    provider: "test-provider",
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostUsd: 0,
  });
}

async function flushScheduler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function leaveDetachedQueues(
  runIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const suffix = runIds.join(",");
  const before = kernel(`before-restart:${suffix}`);
  const blockerClient = bind(before, `blocker:${suffix}`);
  await acquire(blockerClient);

  const queuedOutcomes = runIds.map((runId) =>
    acquire(bind(before, runId)).then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
  await flushScheduler();
  expect(before.queuedCount).toBe(runIds.length);

  const sequences = new Map<string, number>();
  for (const runId of runIds) {
    const queuedEvent = before
      .listJournal({ cwd, runId })
      .find((event) => event.event === "queued");
    expect(queuedEvent).toBeDefined();
    if (queuedEvent === undefined) throw new Error("missing queued event");
    sequences.set(runId, queuedEvent.sequence);
  }

  before.close();
  for (const closeError of await Promise.all(queuedOutcomes)) {
    expect(closeError).toMatchObject({
      name: "AdmissionDeniedError",
      reason: "admission_kernel_closed",
    });
  }
  return sequences;
}

async function leaveDetachedQueue(runId: string): Promise<number> {
  const sequence = (await leaveDetachedQueues([runId])).get(runId);
  if (sequence === undefined) throw new Error("missing queued sequence");
  return sequence;
}

function waitForAbort(signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for admission abort")),
      2_000,
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(signal.reason);
      },
      { once: true },
    );
  });
}

describe("ExecutionAdmissionKernel recovery", () => {
  it("ages an old low-priority row ahead of fresh high-priority work", async () => {
    await leaveDetachedQueues(["aged-low", "fresh-high"]);
    let clock = new Date();
    const oldTimestamp = new Date(clock.getTime() - 100).toISOString();
    const freshTimestamp = new Date(clock.getTime() - 5).toISOString();
    const driver = openStateDatabases({ cwd, agencHome: home });
    driver
      .prepareState<[number, string, string, string, string]>(
        `UPDATE agent_jobs
         SET priority = ?, created_at = ?, updated_at = ?, available_at = ?
         WHERE admission_run_id = ? AND status = 'queued'`,
      )
      .run(1, oldTimestamp, oldTimestamp, oldTimestamp, "aged-low");
    driver
      .prepareState<[number, string, string, string, string]>(
        `UPDATE agent_jobs
         SET priority = ?, created_at = ?, updated_at = ?, available_at = ?
         WHERE admission_run_id = ? AND status = 'queued'`,
      )
      .run(100, freshTimestamp, freshTimestamp, freshTimestamp, "fresh-high");
    driver.close();

    const value = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "aging-restart",
      ownerPid: process.pid,
      now: () => clock,
      queueAgingMs: 10,
    });
    kernels.add(value);
    expect(value.initializeExistingState()).toMatchObject({
      detachedQueued: 2,
    });

    const blocker = bind(value, "aging-blocker");
    const blockerLease = await acquire(blocker);
    const agedClient = bind(value, "aged-low");
    const freshClient = bind(value, "fresh-high");
    const aged = acquire(agedClient);
    const fresh = acquire(freshClient);
    await flushScheduler();
    blocker.reconcile(blockerLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });

    const agedLease = await aged;
    expect(agedLease.request.step.runId).toBe("aged-low");
    agedClient.reconcile(agedLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    const freshLease = await fresh;
    expect(freshLease.request.step.runId).toBe("fresh-high");
    freshClient.reconcile(freshLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("wakes a recovered row when its durable availability time arrives", async () => {
    await leaveDetachedQueue("delayed-run");
    const availableAt = new Date(Date.now() + 100).toISOString();
    const driver = openStateDatabases({ cwd, agencHome: home });
    driver
      .prepareState<[string, string]>(
        `UPDATE agent_jobs SET available_at = ?
         WHERE admission_run_id = ? AND status = 'queued'`,
      )
      .run(availableAt, "delayed-run");
    driver.close();

    const value = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "delayed-restart",
      ownerPid: process.pid,
    });
    kernels.add(value);
    expect(value.initializeExistingState()).toMatchObject({
      detachedQueued: 1,
    });
    const client = bind(value, "delayed-run");
    const pending = acquire(client);
    await flushScheduler();
    expect(value.activeCount).toBe(0);
    expect(value.queuedCount).toBe(1);

    const lease = await pending;
    expect(lease.request.step.runId).toBe("delayed-run");
    client.reconcile(lease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("keeps detached recovery durable without blocking runnable work", async () => {
    const originalQueueSequence = await leaveDetachedQueue("recovered-run");
    const after = kernel("after-restart");

    const recovery = after.initializeExistingState();
    expect(recovery).toMatchObject({ databases: 1, detachedQueued: 1 });
    expect(after.queuedCount).toBe(1);

    const freshClient = bind(after, "fresh-run");
    const freshLease = await acquire(freshClient);
    expect(freshLease.request.step.runId).toBe("fresh-run");
    freshClient.reconcile(freshLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });

    const recoveredClient = bind(after, "recovered-run");
    const recoveredLease = await acquire(recoveredClient);
    expect(recoveredLease.request.step.runId).toBe("recovered-run");
    expect(after.activeCount).toBe(1);
    expect(after.queuedCount).toBe(0);

    const recoveredQueuedEvents = after
      .listJournal({ cwd, runId: "recovered-run" })
      .filter((event) => event.event === "queued");
    expect(recoveredQueuedEvents).toHaveLength(1);
    expect(recoveredQueuedEvents[0]?.sequence).toBe(originalQueueSequence);

    const allowed = after
      .listJournal({ cwd })
      .filter((event) => event.event === "allowed")
      .filter((event) =>
        ["recovered-run", "fresh-run"].includes(event.runId),
      );
    expect(allowed.map((event) => event.runId)).toEqual([
      "fresh-run",
      "recovered-run",
    ]);
    recoveredClient.reconcile(recoveredLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("hydrates a detached queue before the first client binds", async () => {
    await leaveDetachedQueue("late-bind-run");
    const after = kernel("late-bind-restart");

    const client = bind(after, "late-bind-run");
    expect(after.queuedCount).toBe(1);
    const lease = await acquire(client);
    expect(lease.request.step.runId).toBe("late-bind-run");
    client.reconcile(lease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("keeps subordinate sessions on the root run id with unique step identities", async () => {
    const value = kernel("subordinate-session", {
      global: 2,
      workspace: 2,
      session: 2,
      parent: 2,
      provider: 2,
    });
    const root = bind(value, "root-run-id");
    const first = root.forSession({ sessionId: "review-a" });
    const second = root.forSession({ sessionId: "review-b" });
    const [firstLease, secondLease] = await Promise.all([
      acquire(first, "same-logical-step"),
      acquire(second, "same-logical-step"),
    ]);

    expect(first.scope.runId).toBe("root-run-id");
    expect(second.scope.runId).toBe("root-run-id");
    expect(firstLease.request.step).toMatchObject({
      runId: "root-run-id",
      stepId: "session:review-a:same-logical-step",
    });
    expect(secondLease.request.step).toMatchObject({
      runId: "root-run-id",
      stepId: "session:review-b:same-logical-step",
    });
    first.reconcile(firstLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    second.reconcile(secondLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("bounds a 100-child fan-out across restart by concurrency and parent budget", async () => {
    const fanoutLimits = {
      global: 4,
      workspace: 4,
      session: 4,
      parent: 4,
      provider: 4,
    } as const;
    const before = kernel("fanout-before", fanoutLimits);
    const parentBefore = before.bindClient({
      cwd,
      scope: {
        runId: "fanout-parent",
        sessionId: "fanout-parent",
        autonomous: false,
      },
      budget: { runMaxTokens: 8 },
    });
    const childrenBefore = Array.from({ length: 100 }, (_, index) =>
      parentBefore.forSession({
        runId: `fanout-child-${index}`,
        sessionId: `fanout-child-${index}`,
        parentScopeId: "fanout-parent",
      }),
    );
    const beforeOutcomes = childrenBefore.map((child) =>
      acquire(child).then(
        (lease) => ({ kind: "lease" as const, lease }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    );
    await flushScheduler();
    expect(before.activeCount).toBe(4);
    expect(before.queuedCount).toBe(96);

    before.close();
    const closed = await Promise.all(beforeOutcomes);
    expect(closed.filter((result) => result.kind === "lease")).toHaveLength(4);
    expect(closed.filter((result) => result.kind === "error")).toHaveLength(
      96,
    );

    const after = kernel("fanout-after", fanoutLimits);
    expect(after.initializeExistingState()).toMatchObject({
      databases: 1,
      detachedQueued: 96,
    });
    expect(after.queuedCount).toBe(96);
    const parentAfter = after.bindClient({
      cwd,
      scope: {
        runId: "fanout-parent",
        sessionId: "fanout-parent",
        autonomous: false,
      },
      budget: { runMaxTokens: 8 },
    });

    let activeReservations = 0;
    let heldTokens = 0;
    let maxActiveReservations = 0;
    let maxHeldTokens = 0;
    const unsubscribes: Array<() => void> = [];
    const childrenAfter = Array.from({ length: 100 }, (_, index) => {
      const child = parentAfter.forSession({
        runId: `fanout-child-${index}`,
        sessionId: `fanout-child-${index}`,
        parentScopeId: "fanout-parent",
      });
      if (index >= 4) {
        unsubscribes.push(
          child.subscribe((event) => {
            const reservationTokens = event.reservedTokens ?? 0;
            if (event.event === "allowed") {
              activeReservations += 1;
              heldTokens += reservationTokens;
              maxActiveReservations = Math.max(
                maxActiveReservations,
                activeReservations,
              );
              maxHeldTokens = Math.max(maxHeldTokens, heldTokens);
            } else if (
              event.event === "reconciled" ||
              event.event === "voided" ||
              event.event === "held_unknown" ||
              event.event === "provider_overrun"
            ) {
              activeReservations -= 1;
              heldTokens -= reservationTokens;
            }
          }),
        );
      }
      return child;
    });

    const drained = await Promise.all(
      childrenAfter.slice(4).map(async (child) => {
        const lease = await acquire(child);
        expect(lease.reservation.reservedTokens).toBe(2);
        child.reconcile(lease.reservation.reservationId, {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
        return lease.reservation.reservationId;
      }),
    );
    for (const unsubscribe of unsubscribes) unsubscribe();

    expect(drained).toHaveLength(96);
    expect(new Set(drained)).toHaveLength(96);
    expect(after.activeCount).toBe(0);
    expect(after.queuedCount).toBe(0);
    expect(maxActiveReservations).toBe(4);
    expect(maxActiveReservations).toBeLessThanOrEqual(fanoutLimits.global);
    expect(maxHeldTokens).toBe(8);
    expect(maxHeldTokens).toBeLessThanOrEqual(8);
    expect(activeReservations).toBe(0);
    expect(heldTokens).toBe(0);
    expect(
      after
        .listJournal({ cwd })
        .filter((event) => event.runId.startsWith("fanout-child-"))
        .some((event) => event.event === "denied"),
    ).toBe(false);
  });
});

describe("ExecutionAdmissionKernel active cancellation", () => {
  it("enforces a direct scope hard cap across sibling reservations", async () => {
    const siblingLimits = {
      global: 2,
      workspace: 2,
      session: 2,
      parent: 2,
      provider: 2,
    } as const;
    const value = kernel("scope-cap", siblingLimits);
    const parent = value.bindClient({
      cwd,
      scope: {
        runId: "scope-parent",
        sessionId: "scope-parent",
        autonomous: false,
        maxTokens: 2,
      },
    });
    const first = parent.forSession({
      runId: "scope-child-1",
      sessionId: "scope-child-1",
      parentScopeId: "scope-parent",
    });
    const second = parent.forSession({
      runId: "scope-child-2",
      sessionId: "scope-child-2",
      parentScopeId: "scope-parent",
    });
    const firstLease = await acquire(first);

    await expect(acquire(second)).rejects.toMatchObject({
      name: "AdmissionDeniedError",
      reason: "budget_exceeded",
    });
    expect(
      value
        .listJournal({ cwd, runId: "scope-child-2" })
        .map((event) => event.event),
    ).toEqual(["queued", "denied"]);
    first.reconcile(firstLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("cancels a dispatched child when its parent is cancelled", async () => {
    const value = kernel("parent-cancel");
    const parent = bind(value, "parent-run");
    const child = parent.forSession({
      runId: "child-run",
      sessionId: "child-run",
    });
    const lease = await acquire(child);
    child.markDispatched(lease.reservation.reservationId, {
      boundary: "provider_wire",
    });
    const aborted = waitForAbort(lease.signal);

    const result = value.cancelRun("parent-run", "operator_cancel");

    expect(result.affectedRunIds).toEqual(["parent-run", "child-run"]);
    expect(result.heldUnknownReservations).toBe(1);
    expect(await aborted).toMatchObject({
      name: "AdmissionDeniedError",
      reason: "operator_cancel",
      decision: "cancelled",
    });
    // Durable cancellation and signal propagation are immediate, but the
    // still-running boundary keeps its concurrency slot until it acknowledges
    // termination.
    expect(value.activeCount).toBe(1);
    const events = value.listJournal({ cwd, runId: "child-run" });
    expect(events.map((event) => event.event)).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "held_unknown",
      "cancelled",
    ]);
    expect(events.find((event) => event.event === "held_unknown")?.reason).toBe(
      "cancelled_after_dispatch:operator_cancel",
    );
    child.acknowledgeCompletion(lease.reservation.reservationId);
    expect(value.activeCount).toBe(0);
  });

  it("rolls provider-overrun accounting back when the canonical cascade fails", async () => {
    const seededAt = "2026-07-18T12:00:00.000Z";
    const setup = openStateDatabases({ cwd, agencHome: home });
    try {
      for (const id of ["atomic_overrun_root", "atomic_overrun_child"]) {
        upsertAgentRun(setup, {
          id,
          objective: "atomic provider overrun",
          status: "running",
          startedAt: seededAt,
          lastActiveAt: seededAt,
        });
      }
      new ThreadSpawnEdgeRepository(setup).create({
        childThreadId: "atomic_overrun_child",
        parentThreadId: "atomic_overrun_root",
        parentPath: "/root",
        metadata: {
          agentId: "atomic_overrun_child",
          agentPath: "/root/atomic_overrun_child",
          depth: 1,
        },
        status: "open",
      });
    } finally {
      setup.close();
    }

    const value = kernel("atomic-provider-overrun");
    const client = bind(value, "atomic_overrun_root");
    const lease = await acquire(client);
    client.markDispatched(lease.reservation.reservationId, {
      boundary: "provider_wire",
    });

    const inspection = openStateDatabases({ cwd, agencHome: home });
    try {
      inspection.prepareState(
        `CREATE TRIGGER reject_provider_overrun_cascade
         BEFORE UPDATE OF status ON agent_runs
         WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
         BEGIN
           SELECT RAISE(ABORT, 'fault-injected canonical cascade failure');
         END`,
      ).run();

      expect(() =>
        client.reconcile(lease.reservation.reservationId, {
          inputTokens: 2,
          outputTokens: 1,
          costUsd: 0,
        }),
      ).toThrow(/fault-injected canonical cascade failure/);

      expect(
        inspection
          .prepareState<[string], { readonly status: string }>(
            "SELECT status FROM execution_admission_reservations WHERE reservation_id = ?",
          )
          .get(lease.reservation.reservationId)?.status,
      ).toBe("dispatched");
      expect(
        inspection
          .prepareState<[], { readonly count: number }>(
            "SELECT COUNT(*) AS count FROM execution_admission_cancellations",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        inspection
          .prepareState<[], { readonly count: number }>(
            "SELECT COUNT(*) AS count FROM execution_admission_journal WHERE event = 'provider_overrun'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        inspection
          .prepareState<
            [],
            {
              readonly used_tokens: number;
              readonly held_tokens: number;
              readonly blocked_by_provider_overrun: number;
            }
          >(
            `SELECT used_tokens, held_tokens, blocked_by_provider_overrun
             FROM execution_admission_allocations
             WHERE scope_key = 'run:atomic_overrun_root'`,
          )
          .get(),
      ).toEqual({
        used_tokens: 0,
        held_tokens: 2,
        blocked_by_provider_overrun: 0,
      });
      expect(
        inspection
          .prepareState<[], { readonly statuses: string }>(
            "SELECT group_concat(status, ',') AS statuses FROM agent_runs ORDER BY id",
          )
          .get()?.statuses,
      ).toBe("running,running");
      expect(
        inspection
          .prepareState<[string], { readonly status: string }>(
            "SELECT status FROM thread_spawn_edges WHERE child_thread_id = ?",
          )
          .get("atomic_overrun_child")?.status,
      ).toBe("open");

      inspection
        .prepareState("DROP TRIGGER reject_provider_overrun_cascade")
        .run();

      expect(
        client.reconcile(lease.reservation.reservationId, {
          inputTokens: 2,
          outputTokens: 1,
          costUsd: 0,
        }),
      ).toMatchObject({ applied: true, outcome: "provider_overrun" });
      expect(
        inspection
          .prepareState<[], { readonly statuses: string }>(
            "SELECT group_concat(status, ',') AS statuses FROM agent_runs ORDER BY id",
          )
          .get()?.statuses,
      ).toBe("cancelled,cancelled");
      expect(
        inspection
          .prepareState<[string], { readonly status: string }>(
            "SELECT status FROM thread_spawn_edges WHERE child_thread_id = ?",
          )
          .get("atomic_overrun_child")?.status,
      ).toBe("closed");
      expect(
        inspection
          .prepareState<
            [],
            {
              readonly used_tokens: number;
              readonly held_tokens: number;
              readonly blocked_by_provider_overrun: number;
            }
          >(
            `SELECT used_tokens, held_tokens, blocked_by_provider_overrun
             FROM execution_admission_allocations
             WHERE scope_key = 'run:atomic_overrun_root'`,
          )
          .get(),
      ).toEqual({
        used_tokens: 3,
        held_tokens: 0,
        blocked_by_provider_overrun: 1,
      });
      expect(value.activeCount).toBe(0);
    } finally {
      inspection.close();
    }
  });

  it("cancels only the queued step when its caller aborts", async () => {
    const value = kernel("queued-abort");
    const blocker = bind(value, "queue-blocker");
    const blockerLease = await acquire(blocker);
    const parent = bind(value, "queued-parent");
    const child = parent.forSession({
      runId: "queued-child",
      sessionId: "queued-child",
    });
    const controller = new AbortController();
    const parentOutcome = parent
      .acquire(
        {
          stepId: "parent-step",
          kind: "model_turn",
          maxInputTokens: 1,
          maxOutputTokens: 1,
          maxCostUsd: 0,
        },
        controller.signal,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const childOutcome = acquire(child);
    await flushScheduler();
    expect(value.queuedCount).toBe(2);

    controller.abort("caller_disconnected");

    await expect(parentOutcome).resolves.toMatchObject({
      reason: "caller_disconnected",
      decision: "cancelled",
    });
    expect(
      value
        .listJournal({ cwd, runId: "queued-parent" })
        .map((event) => event.event),
    ).toEqual(["queued", "cancelled"]);

    blocker.reconcile(blockerLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    const childLease = await childOutcome;
    child.reconcile(childLease.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    const followUp = await acquire(parent, "future-step");
    parent.reconcile(followUp.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("holds an aborted dispatched step without poisoning the run", async () => {
    const value = kernel("active-abort");
    const client = bind(value, "active-abort-run");
    const controller = new AbortController();
    const lease = await client.acquire(
      {
        stepId: "cancelled-turn",
        kind: "model_turn",
        model: "test-model",
        provider: "test-provider",
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxCostUsd: 0,
      },
      controller.signal,
    );
    client.markDispatched(lease.reservation.reservationId, {
      boundary: "provider_wire",
    });

    controller.abort("turn_cancelled");

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({
      reason: "turn_cancelled",
      decision: "cancelled",
    });
    expect(
      value
        .listJournal({ cwd, runId: "active-abort-run" })
        .map((event) => event.event),
    ).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "held_unknown",
      "cancelled",
    ]);

    let followUpSettled = false;
    const followUpPending = acquire(client, "follow-up-turn").finally(() => {
      followUpSettled = true;
    });
    await flushScheduler();
    expect(value.activeCount).toBe(1);
    expect(value.queuedCount).toBe(1);
    expect(followUpSettled).toBe(false);

    client.acknowledgeCompletion(lease.reservation.reservationId);
    const followUp = await followUpPending;
    client.reconcile(followUp.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(value.activeCount).toBe(0);
  });

  it("cascades an active deadline to queued and future descendants", async () => {
    const value = kernel("deadline");
    const deadlineAt = new Date(Date.now() + 150).toISOString();
    const parent = bind(value, "deadline-run", { deadlineAt });
    const child = parent.forSession({
      runId: "deadline-child",
      sessionId: "deadline-child",
    });
    const lease = await acquire(parent);
    parent.markDispatched(lease.reservation.reservationId, {
      boundary: "provider_wire",
    });
    const childOutcome = acquire(child).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(await waitForAbort(lease.signal)).toMatchObject({
      name: "AdmissionDeniedError",
      reason: "deadline_expired",
      decision: "cancelled",
    });
    await expect(childOutcome).resolves.toMatchObject({
      reason: "deadline_expired",
      decision: "cancelled",
    });
    await expect(acquire(child, "future-step")).rejects.toMatchObject({
      reason: "parent_cancel_locked",
    });
    expect(value.activeCount).toBe(1);
    const events = value.listJournal({ cwd, runId: "deadline-run" });
    expect(events.map((event) => event.event)).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "held_unknown",
      "cancelled",
    ]);
    expect(events.find((event) => event.event === "held_unknown")?.reason).toBe(
      "cancelled_after_dispatch:deadline_expired",
    );
    parent.acknowledgeCompletion(lease.reservation.reservationId);
    expect(value.activeCount).toBe(0);
  });

  it("refuses dispatch when the deadline expires after claim", async () => {
    let clock = new Date("2026-07-18T00:00:00.000Z");
    const value = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "dispatch-deadline-race",
      ownerPid: process.pid,
      now: () => clock,
    });
    kernels.add(value);
    const client = bind(value, "dispatch-deadline-race", {
      deadlineAt: "2026-07-18T00:00:01.000Z",
    });
    const lease = await acquire(client);

    // Advance only the injected wall clock: the live deadline timer has not
    // fired, so markDispatched itself must perform the final durable check.
    clock = new Date("2026-07-18T00:00:02.000Z");
    expect(() =>
      client.markDispatched(lease.reservation.reservationId, {
        boundary: "provider_wire",
      }),
    ).toThrow(/deadline_expired/);

    expect(lease.signal.aborted).toBe(true);
    expect(value.activeCount).toBe(1);
    expect(
      value
        .listJournal({ cwd, runId: "dispatch-deadline-race" })
      .map((event) => event.event),
    ).toEqual(["queued", "allowed", "voided", "cancelled"]);
    client.acknowledgeCompletion(lease.reservation.reservationId);
    expect(value.activeCount).toBe(0);
  });

  it("persists the original run deadline across restart and rejects extension", async () => {
    let clock = new Date("2026-07-18T00:00:00.000Z");
    const originalDeadline = "2026-07-18T00:01:00.000Z";
    const before = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "deadline-before-restart",
      ownerPid: process.pid,
      now: () => clock,
    });
    kernels.add(before);
    const original = before.bindClient({
      cwd,
      scope: {
        runId: "durable-deadline-run",
        sessionId: "durable-deadline-run",
        autonomous: true,
      },
      budget: { deadlineAt: originalDeadline },
    });
    const first = await acquire(original);
    original.reconcile(first.reservation.reservationId, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    before.close();

    clock = new Date("2026-07-18T00:02:00.000Z");
    const after = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "deadline-after-restart",
      ownerPid: process.pid,
      now: () => clock,
    });
    kernels.add(after);
    expect(after.initializeExistingState()).toMatchObject({ databases: 1 });
    const rebound = after.bindClient({
      cwd,
      scope: {
        runId: "durable-deadline-run",
        sessionId: "durable-deadline-run",
        autonomous: true,
      },
      budget: { deadlineAt: "2026-07-18T01:02:00.000Z" },
    });

    expect(rebound.scope.deadlineAt).toBe(originalDeadline);
    await expect(acquire(rebound, "after-restart")).rejects.toMatchObject({
      reason: "parent_cancel_locked",
    });
  });

  it("chunks deadlines beyond the Node timer ceiling", async () => {
    vi.useFakeTimers();
    let clock = new Date("2026-07-18T00:00:00.000Z");
    const deadlineMs = clock.getTime() + 30 * 24 * 60 * 60 * 1_000;
    const value = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "long-deadline",
      ownerPid: process.pid,
      now: () => clock,
    });
    kernels.add(value);
    const client = bind(value, "long-deadline-run", {
      deadlineAt: new Date(deadlineMs).toISOString(),
    });
    const lease = await acquire(client);
    client.markDispatched(lease.reservation.reservationId, {
      boundary: "provider_wire",
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(lease.signal.aborted).toBe(false);

    clock = new Date(deadlineMs);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    await vi.runOnlyPendingTimersAsync();
    expect(lease.signal.aborted).toBe(true);
    expect(
      value
        .listJournal({ cwd, runId: "long-deadline-run" })
        .map((event) => event.event),
    ).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "held_unknown",
      "cancelled",
    ]);
  });

  it("rolls daily budget scopes for a long-lived client at UTC midnight", async () => {
    let clock = new Date("2026-07-18T23:59:59.000Z");
    const value = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "period-rollover",
      ownerPid: process.pid,
      now: () => clock,
    });
    kernels.add(value);
    const client = value.bindClient({
      cwd,
      scope: {
        runId: "period-run",
        sessionId: "period-run",
        autonomous: true,
      },
      budget: { dailyTokens: 2 },
    });

    const first = await acquire(client, "day-one");
    client.reconcile(first.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    await expect(acquire(client, "same-day")).rejects.toMatchObject({
      reason: "budget_exceeded",
    });

    clock = new Date("2026-07-19T00:00:01.000Z");
    const nextDay = await acquire(client, "day-two");
    client.reconcile(nextDay.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    expect(
      value
        .listJournal({ cwd, runId: "period-run" })
        .filter((event) => event.event === "allowed")
        .map((event) => event.stepId),
    ).toEqual(["day-one", "day-two"]);
  });

  it("isolates cumulative period caps by durable root-agent identity", async () => {
    const value = kernel("period-agent-isolation", {
      global: 2,
      workspace: 2,
      session: 2,
      parent: 2,
      provider: 2,
    });
    const firstAgent = value.bindClient({
      cwd,
      budgetIdentity: "period-agent-a",
      scope: {
        runId: "period-agent-a",
        sessionId: "period-agent-a",
        autonomous: true,
      },
      budget: { dailyTokens: 2 },
    });
    const secondAgent = value.bindClient({
      cwd,
      budgetIdentity: "period-agent-b",
      scope: {
        runId: "period-agent-b",
        sessionId: "period-agent-b",
        autonomous: true,
      },
      budget: { dailyTokens: 2 },
    });

    const [first, second] = await Promise.all([
      acquire(firstAgent),
      acquire(secondAgent),
    ]);
    firstAgent.reconcile(first.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    secondAgent.reconcile(second.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
  });

  it("defaults distinct workspace conversations to one calendar cap", async () => {
    const value = kernel("period-agent-shared");
    const firstConversation = value.bindClient({
      cwd,
      scope: {
        runId: "conversation-a",
        sessionId: "conversation-a",
        autonomous: true,
      },
      budget: { dailyTokens: 2 },
    });
    const secondConversation = value.bindClient({
      cwd,
      scope: {
        runId: "conversation-b",
        sessionId: "conversation-b",
        autonomous: true,
      },
      budget: { dailyTokens: 2 },
    });

    expect(firstConversation.scope.budgetIdentity).toBe(
      firstConversation.scope.workspaceId,
    );
    expect(secondConversation.scope.budgetIdentity).toBe(
      secondConversation.scope.workspaceId,
    );

    const first = await acquire(firstConversation);
    firstConversation.reconcile(first.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });

    await expect(acquire(secondConversation)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
  });

  it("keeps the current calendar cap after restart when config omits it", async () => {
    const before = kernel("period-cap-before-restart");
    const capped = before.bindClient({
      cwd,
      budgetIdentity: "sticky-agent",
      scope: {
        runId: "sticky-conversation-a",
        sessionId: "sticky-conversation-a",
        autonomous: true,
      },
      budget: { dailyTokens: 2 },
    });
    const first = await acquire(capped);
    capped.reconcile(first.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    before.close();

    const after = kernel("period-cap-after-restart");
    after.initializeExistingState();
    const omitted = after.bindClient({
      cwd,
      budgetIdentity: "sticky-agent",
      scope: {
        runId: "sticky-conversation-b",
        sessionId: "sticky-conversation-b",
        autonomous: true,
      },
    });

    await expect(acquire(omitted)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
  });

  it("rejects rebinding one durable run identity to another workspace", () => {
    const value = kernel("run-workspace-pinning");
    bind(value, "workspace-pinned-run");
    const otherCwd = mkdtempSync(join(tmpdir(), "agenc-kernel-other-cwd-"));
    mkdirSync(join(otherCwd, ".git"));
    try {
      expect(() =>
        value.bindClient({
          cwd: otherCwd,
          scope: {
            runId: "workspace-pinned-run",
            sessionId: "workspace-pinned-run",
            autonomous: true,
          },
          budget: { dailyTokens: 2 },
        }),
      ).toThrow(/admission_run_workspace_conflict/);
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("rolls monthly budget scopes for a long-lived client at UTC month end", async () => {
    let clock = new Date("2026-07-31T23:59:59.000Z");
    const value = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: LIMITS,
      ownerId: "month-rollover",
      ownerPid: process.pid,
      now: () => clock,
    });
    kernels.add(value);
    const client = value.bindClient({
      cwd,
      scope: {
        runId: "month-run",
        sessionId: "month-run",
        autonomous: true,
      },
      budget: { monthlyTokens: 2 },
    });

    const first = await acquire(client, "month-one");
    client.reconcile(first.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    await expect(acquire(client, "same-month")).rejects.toMatchObject({
      reason: "budget_exceeded",
    });

    clock = new Date("2026-08-01T00:00:01.000Z");
    const nextMonth = await acquire(client, "month-two");
    client.reconcile(nextMonth.reservation.reservationId, {
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    });
    expect(
      value
        .listJournal({ cwd, runId: "month-run" })
        .filter((event) => event.event === "allowed")
        .map((event) => event.stepId),
    ).toEqual(["month-one", "month-two"]);
  });
});
