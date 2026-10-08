import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionJournalEvent, AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";

let home: string;
let cwd: string;
const kernels: ExecutionAdmissionKernel[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-journal-publish-"));
  cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const kernel of kernels.splice(0)) kernel.close();
  rmSync(home, { recursive: true, force: true });
});

function createKernel(): ExecutionAdmissionKernel {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  kernels.push(kernel);
  return kernel;
}

function bind(kernel: ExecutionAdmissionKernel, runId: string): ExecutionAdmissionClient {
  return kernel.bindClient({ cwd, scope: { runId, sessionId: runId, autonomous: false } });
}

async function acquire(client: ExecutionAdmissionClient, stepId: string) {
  return client.acquire({
    stepId,
    kind: "model_turn",
    model: "grok-test",
    provider: "grok",
    maxInputTokens: 20,
    maxOutputTokens: 20,
    maxCostUsd: 0.5,
  });
}

async function spend(client: ExecutionAdmissionClient, stepId: string, costUsd = 0.25): Promise<void> {
  const lease = await acquire(client, stepId);
  const reservationId = lease.reservation.reservationId;
  client.markDispatched(reservationId, { boundary: "provider_wire" });
  client.reconcile(reservationId, { inputTokens: 10, outputTokens: 5, costUsd });
  client.acknowledgeCompletion(reservationId);
}

function tableJournal(kernel: ExecutionAdmissionKernel, runId: string): readonly AdmissionJournalEvent[] {
  return kernel.listJournal({ cwd, runId });
}

describe("admission journal publication", () => {
  it("deduplicates critical listeners by identity and either unsubscribe removes them", async () => {
    const client = bind(createKernel(), "run-a");
    const critical = vi.fn();
    const barrier = vi.fn();
    const duplicateBarrier = vi.fn();
    const unsubscribe = client.subscribeCritical!(critical, barrier);
    const unsubscribeDuplicate = client.subscribeCritical!(critical, duplicateBarrier);
    client.subscribe(() => {});
    await spend(client, "one");
    expect(critical).toHaveBeenCalledTimes(4);
    expect(barrier).toHaveBeenCalledTimes(4);
    expect(duplicateBarrier).not.toHaveBeenCalled();
    unsubscribeDuplicate();
    await spend(client, "two");
    expect(critical).toHaveBeenCalledTimes(4);
    expect(barrier).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("projects this connection's commits without reading them back, equal to the table", async () => {
    const kernel = createKernel();
    const client = bind(kernel, "run-a");
    const critical: AdmissionJournalEvent[] = [];
    const observed: AdmissionJournalEvent[] = [];
    client.subscribeCritical?.((event) => critical.push(event));
    client.subscribe((event) => observed.push(event));
    const reads = vi.spyOn(ExecutionAdmissionRepository.prototype, "listJournal");
    await spend(client, "turn-1");
    await spend(client, "turn-2");
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    const table = tableJournal(kernel, "run-a");
    expect(table.map((event) => event.event)).toEqual([
      "queued", "allowed", "dispatched", "reconciled",
      "queued", "allowed", "dispatched", "reconciled",
    ]);
    expect(critical).toEqual(table);
    expect(observed).toEqual(table);
  });

  it("recomputes usage only after usage-changing events and publishes the same summaries", async () => {
    const kernel = createKernel();
    const client = bind(kernel, "run-a");
    const summaries: AdmissionUsageSummary[] = [];
    client.subscribeUsage?.((summary) => summaries.push(summary));
    const usage = vi.spyOn(ExecutionAdmissionRepository.prototype, "getUsageSummary");
    const lease = await acquire(client, "turn-1");
    const afterAcquire = usage.mock.calls.length;
    expect(afterAcquire).toBeGreaterThan(0);
    const heldSummary = summaries.at(-1);
    expect(heldSummary?.heldCostUsd).toBeGreaterThan(0);

    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    // reserved -> dispatched leaves every summary field unchanged.
    expect(usage.mock.calls.length).toBe(afterAcquire);
    expect(summaries.at(-1)).toBe(heldSummary);

    client.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
    expect(usage.mock.calls.length).toBeGreaterThan(afterAcquire);
    usage.mockRestore();
    const final = client.getUsageSummary?.();
    expect(summaries.at(-1)).toEqual(final);
    expect(final).toMatchObject({ costUsd: 0.25, heldCostUsd: 0, inputTokens: 10, outputTokens: 5 });
    // Every delivered summary differs from the one before it (no duplicates, no skipped change).
    for (let index = 1; index < summaries.length; index += 1) {
      expect({ ...summaries[index], sequence: 0 }).not.toEqual({ ...summaries[index - 1], sequence: 0 });
    }
  });

  it("still projects rows another connection committed, in sequence order", async () => {
    const kernelA = createKernel();
    const kernelB = createKernel();
    const clientA = bind(kernelA, "run-a");
    const clientB = bind(kernelB, "run-b");
    const seenByA: AdmissionJournalEvent[] = [];
    kernelA.subscribe("run-b", (event) => seenByA.push(event));
    await spend(clientA, "turn-1");
    await spend(clientB, "turn-1");
    expect(seenByA).toEqual([]);
    // A's next publication cannot be served from its own commits alone.
    await spend(clientA, "turn-2");
    expect(seenByA).toEqual(tableJournal(kernelA, "run-b"));
    expect(seenByA.map((event) => event.event)).toEqual(["queued", "allowed", "dispatched", "reconciled"]);
  });

  it("retries a failed critical projection from the table without losing or repeating events", async () => {
    const kernel = createKernel();
    const client = bind(kernel, "run-a");
    const critical: AdmissionJournalEvent[] = [];
    let fail = false;
    client.subscribeCritical?.((event) => {
      if (fail && event.event === "dispatched") throw new Error("canonical append failed");
      critical.push(event);
    });
    const lease = await acquire(client, "turn-1");
    fail = true;
    expect(() => client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" }))
      .toThrow("canonical append failed");
    fail = false;
    client.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
    expect(critical).toEqual(tableJournal(kernel, "run-a"));
  });
});
