import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AdmissionClaimResult,
  AdmissionJournalEvent,
  RuntimeAdmissionRequest,
} from "../../src/budget/admission-types.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import {
  ExecutionAdmissionRepository,
  type PersistedAdmissionReservation,
} from "../../src/state/execution-admission.js";
import {
  openStateDatabases,
  resolveStateDatabasePaths,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";

const PARENT_RUN_ID = "fault-fanout-parent";
const STEP_ID = "model-turn";
const PROVIDER = "test-provider:https://example.test";
const MODEL = "test-model";
const CHILD_COUNT = 100;
const CRASHED_DISPATCH_COUNT = 4;
const PARENT_TOKEN_BUDGET = 200;

const CONCURRENCY_LIMITS = {
  global: 4,
  workspace: 4,
  session: 4,
  parent: 4,
  provider: 4,
} as const;

let home = "";
let cwd = "";
const drivers = new Set<StateSqliteDriver>();
const kernels = new Set<ExecutionAdmissionKernel>();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-fault-admission-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-fault-admission-cwd-"));
  mkdirSync(join(cwd, ".git"));
});

afterEach(() => {
  for (const kernel of kernels) kernel.close();
  kernels.clear();
  for (const driver of drivers) driver.close();
  drivers.clear();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function openDriver(): StateSqliteDriver {
  const driver = openStateDatabases({ cwd, agencHome: home });
  drivers.add(driver);
  return driver;
}

function closeDriver(driver: StateSqliteDriver): void {
  driver.close();
  drivers.delete(driver);
}

function childRunId(index: number): string {
  return `fault-fanout-child-${index}`;
}

function childRequest(
  index: number,
  workspaceId: string,
): RuntimeAdmissionRequest {
  const runId = childRunId(index);
  return {
    step: { runId, stepId: STEP_ID, parentRunId: PARENT_RUN_ID },
    kind: "model_turn",
    estimate: {
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxCostUsd: 0,
    },
    model: MODEL,
    provider: PROVIDER,
    workspaceId,
    sessionId: runId,
    parentScopeId: PARENT_RUN_ID,
    autonomous: false,
    budgetScopes: [
      { key: `run:${PARENT_RUN_ID}`, maxTokens: PARENT_TOKEN_BUDGET },
      {
        key: `run:${runId}`,
        parentKey: `run:${PARENT_RUN_ID}`,
      },
    ],
  };
}

function acquire(client: ExecutionAdmissionClient) {
  return client.acquire({
    stepId: STEP_ID,
    kind: "model_turn",
    model: MODEL,
    provider: PROVIDER,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostUsd: 0,
  });
}

function requireClaimed(result: AdmissionClaimResult): string {
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed") throw new Error("expected claimed admission");
  return result.lease.reservation.reservationId;
}

function countReservationStatuses(
  reservations: readonly PersistedAdmissionReservation[],
): Readonly<Record<PersistedAdmissionReservation["status"], number>> {
  const counts: Record<PersistedAdmissionReservation["status"], number> = {
    reserved: 0,
    dispatched: 0,
    reconciled: 0,
    voided: 0,
    held_unknown: 0,
    provider_overrun: 0,
  };
  for (const reservation of reservations) counts[reservation.status] += 1;
  return counts;
}

function updateActiveCount(
  event: AdmissionJournalEvent,
  state: { active: number; maximum: number },
): void {
  if (event.event === "allowed") {
    state.active += 1;
    state.maximum = Math.max(state.maximum, state.active);
    return;
  }
  if (
    event.event === "reconciled" ||
    event.event === "voided" ||
    event.event === "held_unknown" ||
    event.event === "provider_overrun"
  ) {
    state.active -= 1;
  }
}

describe("execution admission fault/restart acceptance", () => {
  it("conserves a shared parent budget and four-wide capacity across a 100-child crash", async () => {
    const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
    const seedDriver = openDriver();
    let nextId = 0;
    const deadDaemon = new ExecutionAdmissionRepository(seedDriver, {
      id: () => `dead-daemon-id-${++nextId}`,
      ownerId: "dead-daemon",
      ownerPid: 999_999,
    });

    for (let index = 0; index < CHILD_COUNT; index += 1) {
      deadDaemon.enqueue(childRequest(index, paths.projectDir), {
        ownerId: "dead-daemon",
        ownerPid: 999_999,
        attached: true,
      });
    }

    const crashedReservationIds: string[] = [];
    for (let index = 0; index < CRASHED_DISPATCH_COUNT; index += 1) {
      const reservationId = requireClaimed(
        deadDaemon.claim({
          key: `${childRunId(index)}\u0000${STEP_ID}`,
          ownerId: "dead-daemon",
          ownerPid: 999_999,
          attached: true,
        }),
      );
      deadDaemon.markDispatched(reservationId, {
        providerRequestId: `provider-request-${index}`,
        details: { boundary: "provider_wire" },
      });
      crashedReservationIds.push(reservationId);
    }

    expect(
      deadDaemon.list({ statuses: ["running"], limit: CHILD_COUNT }),
    ).toHaveLength(CRASHED_DISPATCH_COUNT);
    expect(
      deadDaemon.list({ statuses: ["queued"], limit: CHILD_COUNT }),
    ).toHaveLength(CHILD_COUNT - CRASHED_DISPATCH_COUNT);

    // Fault injection: close only the SQLite connection, as process death
    // would. ExecutionAdmissionKernel.close() is intentionally not involved,
    // so no graceful cancellation or refund can mutate the crash state.
    closeDriver(seedDriver);

    const restarted = new ExecutionAdmissionKernel({
      agencHome: home,
      limits: CONCURRENCY_LIMITS,
      ownerId: "restarted-daemon",
      ownerPid: process.pid,
      queueAgingMs: 10,
    });
    kernels.add(restarted);
    expect(restarted.initializeExistingState()).toMatchObject({
      databases: 1,
      heldUnknown: CRASHED_DISPATCH_COUNT,
      detachedQueued: CHILD_COUNT - CRASHED_DISPATCH_COUNT,
    });
    expect(restarted.activeCount).toBe(0);
    expect(restarted.queuedCount).toBe(CHILD_COUNT - CRASHED_DISPATCH_COUNT);

    const parent = restarted.bindClient({
      cwd,
      scope: {
        runId: PARENT_RUN_ID,
        sessionId: PARENT_RUN_ID,
        autonomous: false,
      },
      budget: { runMaxTokens: PARENT_TOKEN_BUDGET },
    });
    const active = { active: 0, maximum: 0 };
    const clients = Array.from(
      { length: CHILD_COUNT - CRASHED_DISPATCH_COUNT },
      (_, offset) => {
        const index = offset + CRASHED_DISPATCH_COUNT;
        const runId = childRunId(index);
        const client = parent.forSession({
          runId,
          sessionId: runId,
          parentScopeId: PARENT_RUN_ID,
        });
        client.subscribe((event) => updateActiveCount(event, active));
        return client;
      },
    );

    await Promise.all(
      clients.map(async (client) => {
        const lease = await acquire(client);
        expect(restarted.activeCount).toBeLessThanOrEqual(
          CONCURRENCY_LIMITS.global,
        );
        client.reconcile(lease.reservation.reservationId, {
          inputTokens: 1,
          outputTokens: 0,
          costUsd: 0,
        });
      }),
    );

    expect(active).toEqual({ active: 0, maximum: 4 });
    expect(restarted.activeCount).toBe(0);
    expect(restarted.queuedCount).toBe(0);

    // A provider's late authoritative usage resolves one crash hold as an
    // explicit overrun. The remaining crash outcomes stay charged and
    // visible as unknown; neither condition is silently refunded.
    const auditDriver = openDriver();
    const audit = new ExecutionAdmissionRepository(auditDriver, {
      ownerId: "acceptance-auditor",
      ownerPid: process.pid,
    });
    const overrun = audit.reportProviderOverrun(
      crashedReservationIds[0]!,
      { inputTokens: 2, outputTokens: 1, costUsd: 0 },
      {
        providerRequestId: "provider-request-0",
        reason: "late_provider_usage_after_restart",
      },
    );
    expect(overrun).toMatchObject({
      applied: true,
      outcome: "provider_overrun",
      reservedTokens: 2,
      actualTokens: 3,
    });

    const reservations = audit.listReservations({ limit: CHILD_COUNT });
    expect(reservations).toHaveLength(CHILD_COUNT);
    expect(countReservationStatuses(reservations)).toEqual({
      reserved: 0,
      dispatched: 0,
      reconciled: CHILD_COUNT - CRASHED_DISPATCH_COUNT,
      voided: 0,
      held_unknown: CRASHED_DISPATCH_COUNT - 1,
      provider_overrun: 1,
    });

    const records = audit.list({ limit: CHILD_COUNT });
    expect(records).toHaveLength(CHILD_COUNT);
    expect(
      records.every((record) =>
        ["reconciled", "held_unknown", "provider_overrun"].includes(
          record.status,
        ),
      ),
    ).toBe(true);

    const parentAllocation = audit
      .listAllocations({ limit: CHILD_COUNT + 1 })
      .find((allocation) => allocation.key === `run:${PARENT_RUN_ID}`);
    expect(parentAllocation).toMatchObject({
      maxTokens: PARENT_TOKEN_BUDGET,
      heldTokens: 0,
      // 96 reported tokens + three unresolved crash holds at two tokens each
      // + the late three-token overrun replacing its original two-token hold.
      usedTokens: 105,
      blockedByProviderOverrun: true,
    });
    expect(parentAllocation?.usedTokens).toBeLessThanOrEqual(
      PARENT_TOKEN_BUDGET,
    );

    const journal = audit.listJournal({ limit: 1_000 });
    expect(
      journal.filter((event) => event.event === "held_unknown"),
    ).toHaveLength(CRASHED_DISPATCH_COUNT);
    expect(
      journal.filter((event) => event.event === "provider_overrun"),
    ).toHaveLength(1);
  });

  it("serializes sibling budget claims from independent SQLite connections", async () => {
    const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
    const firstDriver = openDriver();
    const secondDriver = openDriver();
    const first = new ExecutionAdmissionRepository(firstDriver, {
      ownerId: "daemon-a",
      ownerPid: 101,
    });
    const second = new ExecutionAdmissionRepository(secondDriver, {
      ownerId: "daemon-b",
      ownerPid: 202,
    });
    const sharedScope = {
      key: "run:transactional-parent",
      maxTokens: 2,
    } as const;
    const requestFor = (runId: string): RuntimeAdmissionRequest => ({
      step: { runId, stepId: STEP_ID, parentRunId: "transactional-parent" },
      kind: "model_turn",
      estimate: {
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxCostUsd: 0,
      },
      model: MODEL,
      provider: PROVIDER,
      workspaceId: paths.projectDir,
      sessionId: runId,
      parentScopeId: "transactional-parent",
      autonomous: false,
      budgetScopes: [
        sharedScope,
        {
          key: `run:${runId}`,
          parentKey: sharedScope.key,
        },
      ],
    });
    const firstRequest = requestFor("transactional-child-a");
    const secondRequest = requestFor("transactional-child-b");
    first.enqueue(firstRequest, { attached: true });
    second.enqueue(secondRequest, { attached: true });

    // The callers race from separate better-sqlite3 connections. Each claim
    // performs its own BEGIN IMMEDIATE read-check-write transaction, so only
    // one can reserve the shared two-token account.
    const [firstClaim, secondClaim] = await Promise.all([
      Promise.resolve().then(() =>
        first.claim({ key: `${firstRequest.step.runId}\u0000${STEP_ID}` }),
      ),
      Promise.resolve().then(() =>
        second.claim({ key: `${secondRequest.step.runId}\u0000${STEP_ID}` }),
      ),
    ]);
    const claims = [firstClaim, secondClaim];
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(
      claims.filter(
        (claim) =>
          claim.kind === "not_claimed" && claim.reason === "budget_exceeded",
      ),
    ).toHaveLength(1);

    const winningClaim = claims.find((claim) => claim.kind === "claimed");
    if (winningClaim?.kind !== "claimed") {
      throw new Error("expected one winning claim");
    }
    const allocationWhileHeld = second
      .listAllocations({ limit: 10 })
      .find((allocation) => allocation.key === sharedScope.key);
    expect(allocationWhileHeld).toMatchObject({
      maxTokens: 2,
      heldTokens: 2,
      usedTokens: 0,
    });

    first.reconcile(winningClaim.lease.reservation.reservationId, {
      kind: "reported",
      usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 },
    });
    const conserved = second
      .listAllocations({ limit: 10 })
      .find((allocation) => allocation.key === sharedScope.key);
    expect(conserved).toMatchObject({
      maxTokens: 2,
      heldTokens: 0,
      usedTokens: 1,
    });
  });
});
