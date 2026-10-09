import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionUsageSnapshot, AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { captureMaterializedUsage } from "../../src/state/admission-usage-snapshot.js";

let home: string;
let cwd: string;
const kernels: ExecutionAdmissionKernel[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "usage-snapshot-"));
  cwd = join(home, "project"); mkdirSync(join(cwd, ".git"), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const kernel of kernels.splice(0)) kernel.close();
  rmSync(home, { recursive: true, force: true });
});
function kernel() { const result = new ExecutionAdmissionKernel({ agencHome: home }); kernels.push(result); return result; }
function bind(owner: ExecutionAdmissionKernel, runId: string) {
  return owner.bindClient({ cwd, scope: { runId, sessionId: runId, autonomous: false } });
}
function reserve(client: ExecutionAdmissionClient, stepId: string, kind: "model_turn" | "tool_exec" = "model_turn") {
  return client.acquire({ stepId, kind, model: "test", provider: "test", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: kind === "tool_exec" ? 0 : 0.5 });
}
async function spend(client: ExecutionAdmissionClient, stepId: string, kind: "model_turn" | "tool_exec" = "model_turn") {
  const lease = await reserve(client, stepId, kind);
  const id = lease.reservation.reservationId;
  client.markDispatched(id, { boundary: kind === "tool_exec" ? "tool_effect" : "provider_wire" });
  client.reconcile(id, { inputTokens: kind === "tool_exec" ? 0 : 10, outputTokens: kind === "tool_exec" ? 0 : 5, costUsd: kind === "tool_exec" ? 0 : 0.25 });
}

describe("immutable usage observations", () => {
  it("matches every legacy observation while delaying materialization across later mutations", async () => {
    const parent = bind(kernel(), "parent");
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    const legacy: AdmissionUsageSummary[] = [];
    const captured: AdmissionUsageSnapshot[] = [];
    parent.subscribeUsage!(summary => legacy.push(summary));
    parent.subscribeUsageSnapshot!(snapshot => captured.push(snapshot));
    await spend(parent, "first");
    await spend(parent, "tool", "tool_exec");
    await spend(child, "child-tool", "tool_exec");
    await spend(child, "child-model");
    const held = await reserve(parent, "unknown");
    parent.markDispatched(held.reservation.reservationId, { boundary: "provider_wire" });
    parent.reconcile(held.reservation.reservationId, { inputTokens: 7, outputTokens: 3, costUsd: null });
    const voided = await reserve(child, "void");
    child.void(voided.reservation.reservationId, "not sent");
    expect(captured.map(snapshot => snapshot.read())).toEqual(legacy);
    expect(captured.map(snapshot => snapshot.signature)).toEqual(legacy.map(summary => captureMaterializedUsage(summary).signature));
    const first = captured[0]!.read();
    if (first.models.length > 0) Object.assign(first.models[0]!, { inputTokens: 999 });
    expect(captured[0]!.read()).toEqual(legacy[0]);
    expect(captured.at(-1)!.read()).toEqual(parent.getUsageSummary!());
  });

  it("rebuilds after another connection changes a shared ancestor", async () => {
    const ownerA = kernel(); const ownerB = kernel();
    const parentA = bind(ownerA, "parent"); const parentB = bind(ownerB, "parent");
    const child = parentB.forSession({ runId: "external-child", sessionId: "external-child" });
    const captured: AdmissionUsageSnapshot[] = [];
    parentA.subscribeUsageSnapshot!(snapshot => captured.push(snapshot));
    await spend(parentA, "first");
    await spend(child, "external");
    await spend(parentA, "after-external");
    expect(captured.at(-1)!.read()).toEqual(parentA.getUsageSummary!());
    expect(captured.at(-1)!.read().modelCalls).toBe(3);
  });

  it("does not run the SQL aggregate for snapshot observers and propagates canonical failure", async () => {
    const client = bind(kernel(), "run");
    client.subscribeUsageSnapshot!(() => {});
    const reads = vi.spyOn(ExecutionAdmissionRepository.prototype, "getUsageSummary");
    await spend(client, "first");
    expect(reads).not.toHaveBeenCalled();
    const failure = new Error("durable usage queue failed");
    client.subscribeUsageSnapshot!(() => { throw failure; });
    await expect(Promise.resolve().then(() => reserve(client, "next"))).rejects.toThrow("durable usage queue failed");
  });

  it("keeps estimated prices and bulk overrun cancellation equal to SQL", async () => {
    const owner = kernel();
    const client = owner.bindClient({ cwd, scope: { runId: "capped", sessionId: "capped", autonomous: false }, budget: { runMaxCostUsd: 2 } });
    const snapshots: AdmissionUsageSnapshot[] = [];
    const legacy: AdmissionUsageSummary[] = [];
    client.subscribeUsage!(summary => legacy.push(summary));
    client.subscribeUsageSnapshot!(snapshot => snapshots.push(snapshot));
    const estimated = await reserve(client, "estimated");
    client.markDispatched(estimated.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(estimated.reservation.reservationId, { inputTokens: 5, outputTokens: 3, costUsd: 0.1, costEstimated: true });
    const overrun = await reserve(client, "overrun");
    client.markDispatched(overrun.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(overrun.reservation.reservationId, { inputTokens: 100, outputTokens: 50, costUsd: 0.7 });
    expect(snapshots.map(snapshot => snapshot.read())).toEqual(legacy);
    expect(snapshots.map(snapshot => snapshot.signature)).toEqual(legacy.map(summary => captureMaterializedUsage(summary).signature));
    expect(snapshots.at(-1)!.read()).toEqual(client.getUsageSummary!());
  });
});
