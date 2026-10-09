import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { SessionStore } from "../../src/session/session-store.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import { withSessionWriteBehind } from "../../src/session/write-behind.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

function fixture(relaxed = true, autonomous = false) {
 const root = mkdtempSync(join(tmpdir(), "captured-admission-"));
 const cwd = join(root, "workspace"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home);
 const store = new SessionStore({ cwd, agencHome: home, sessionId: "root", agencVersion: "test", relaxedOneShot: relaxed, checkpointOneShot: () => {} });
 store.open({ cwd, sessionId: "root", agencVersion: "test", originator: "test", timestamp: "2026-10-09T00:00:00Z" });
 if (relaxed) store.enableOneShotFastMode();
 const kernel = new ExecutionAdmissionKernel({ agencHome: home, limits: { global: 1, workspace: 1, session: 1, parent: 1, provider: 1 } });
 const client = kernel.bindClient({ cwd, scope: { runId: "root", sessionId: "root", autonomous } });
 const reader = openStateDatabases({ cwd, agencHome: home, deferLogs: true });
 const fast = <T>(run: () => T) => withSessionWriteBehind(store.writeBehind, () => withOneShotFastMode(run));
 const request = (stepId: string) => ({ stepId, kind: "model_turn" as const, provider: "ollama", model: "test", maxInputTokens: 20, maxOutputTokens: 20, maxCostUsd: 0.5 });
 const rows = () => reader.state.prepare("SELECT * FROM execution_admission_reservations ORDER BY created_at, rowid").all() as Record<string, unknown>[];
 const close = () => { try { store.close(); } finally { try { kernel.close(); } finally { reader.close(); rmSync(root, { recursive: true, force: true }); } } };
 return { root, cwd, home, store, kernel, client, reader, fast, request, rows, close };
}

describe("captured uncapped model admission", () => {
 it.each([false, true])("admits before wire and persists identities, times and usage (autonomous=%s)", async autonomous => {
  const f = fixture(true, autonomous);
  try {
   const ids: string[] = [];
   await f.fast(async () => {
    for (const step of ["one", "two"]) {
     const lease = await f.client.acquire(f.request(step)); ids.push(lease.reservation.reservationId);
     expect(f.kernel.activeCount).toBe(1); expect(f.rows()).toEqual([]);
     f.client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire", timestamp: "2026-10-09T00:00:01Z" });
     f.client.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
     f.client.acknowledgeCompletion(lease.reservation.reservationId);
     expect(f.kernel.activeCount).toBe(0); expect(f.rows()).toEqual([]);
    }
   });
   f.store.writeBehind.finish();
   expect(f.rows().map(row => row.reservation_id)).toEqual(ids);
   expect(f.rows()).toHaveLength(2);
   for (const row of f.rows()) expect(row).toMatchObject({ status: "reconciled", actual_input_tokens: 10, actual_output_tokens: 5, dispatched_at: "2026-10-09T00:00:01.000Z" });
   expect(f.client.replayJournal!({ limit: 100 }).map(event => event.event)).toEqual(["queued", "allowed", "dispatched", "reconciled", "queued", "allowed", "dispatched", "reconciled"]);
   expect(f.client.getUsageSummary!()).toMatchObject({ modelCalls: 2, costUsd: 0.5, inputTokens: 20, outputTokens: 10 });
  } finally { f.close(); }
 });

 it("persists call-only reservations before dispatch and enforces the retained cap", async () => {
  const f = fixture();
  const capped = f.kernel.bindClient({ cwd: f.cwd,
   scope: { runId: "root", sessionId: "root", autonomous: false, maxModelCalls: 1 } });
  try {
   await f.fast(async () => {
    // The original client has no cap in memory; the durable allocation does.
    const lease = await f.client.acquire(f.request("one"));
    expect(f.rows()).toHaveLength(1);
    f.client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    f.client.holdUnknown(lease.reservation.reservationId, "missing_provider_usage");
    f.client.acknowledgeCompletion(lease.reservation.reservationId);
    await expect(capped.acquire(f.request("two"))).rejects.toThrow("model_call_budget_exceeded");
    await expect(f.client.acquire(f.request("three"))).rejects.toThrow("model_call_budget_exceeded");
    expect(f.rows()).toHaveLength(1);
   });
  } finally { capped.release?.(); f.close(); }
 });

 it("keeps exposed grant identities and policy immutable until the final batch", async () => {
  const f = fixture();
  try {
   await f.fast(async () => {
    const input = f.request("one");
    const lease = await f.client.acquire(input), id = lease.reservation.reservationId;
    expect(Reflect.set(lease.reservation, "reservationId", "forged")).toBe(false);
    expect(Reflect.set(lease.reservation.step, "runId", "forged")).toBe(false);
    expect(Reflect.set(lease.request, "model", "forged")).toBe(false);
    expect(Reflect.set(lease.request.estimate, "maxCostUsd", 100)).toBe(false);
    expect(Reflect.set(lease.request.budgetScopes![0]!, "maxCostUsd", 0)).toBe(false);
    expect(Reflect.set(lease.request.budgetScopes!, "0", { key: "forged" })).toBe(false);
    input.stepId = "changed-input";
    const details = { nested: { outcome: "actual" } };
    f.client.markDispatched(id, { boundary: "provider_wire", details });
    details.nested.outcome = "forged";
    f.client.reconcile(id, { inputTokens: 3, outputTokens: 2, costUsd: 0.25 });
    f.client.acknowledgeCompletion(id);
   });
   f.store.writeBehind.finish();
   expect(f.rows()[0]).toMatchObject({ run_id: "root", step_id: "one", model: "test", reserved_cost_nanos: 500000000, actual_cost_nanos: 250000000 });
   expect(f.client.replayJournal!({ limit: 100 }).find(event => event.event === "dispatched")?.details).toMatchObject({ nested: { outcome: "actual" } });
  } finally { f.close(); }
 });

 it.each(["unknown", "void", "void-after-dispatch", "unpriced"])("preserves %s settlement", async kind => {
  const f = fixture();
  try {
   await f.fast(async () => {
    const lease = await f.client.acquire(f.request("one")); const id = lease.reservation.reservationId;
    if (kind !== "void") f.client.markDispatched(id, { boundary: "provider_wire" });
    if (kind === "unknown") f.client.holdUnknown(id, "missing_provider_usage");
    else if (kind === "unpriced") f.client.reconcile(id, { inputTokens: 3, outputTokens: 2, costUsd: null });
    else f.client.void(id, "provider_failed");
    f.client.acknowledgeCompletion(id);
   });
   f.store.writeBehind.finish();
   expect(f.rows()[0]?.status).toBe(kind === "void" ? "voided" : "held_unknown");
  } finally { f.close(); }
 });

 it.each([false, true])("cancels with physical capacity retained, dispatched=%s", async dispatched => {
  const f = fixture(); const abort = new AbortController();
  try {
   await f.fast(async () => {
    const lease = await f.client.acquire(f.request("one"), abort.signal); const id = lease.reservation.reservationId;
    if (dispatched) f.client.markDispatched(id, { boundary: "provider_wire" });
    abort.abort(new Error("stop"));
    expect(lease.signal.aborted).toBe(true); expect(f.kernel.activeCount).toBe(1);
    expect(f.rows()[0]?.status).toBe(dispatched ? "held_unknown" : "voided");
    f.client.acknowledgeCompletion(id); expect(f.kernel.activeCount).toBe(0);
   });
  } finally { f.close(); }
 });

 it("promotes before queueing another call and retains shared capacity", async () => {
  const f = fixture();
  try {
   await f.fast(async () => {
    const a = await f.client.acquire(f.request("a"));
    f.client.markDispatched(a.reservation.reservationId, { boundary: "provider_wire" });
    let resolved = false;
    const b = f.client.acquire(f.request("b")).then(lease => { resolved = true; return lease; });
    await Promise.resolve(); expect(resolved).toBe(false); expect(f.kernel.activeCount).toBe(1);
    f.client.reconcile(a.reservation.reservationId, { inputTokens: 1, outputTokens: 1, costUsd: 0 });
    const lease = await b; f.client.void(lease.reservation.reservationId, "unused");
   });
  } finally { f.close(); }
 });

 it("observes a retained calendar cap even when this client has no configured cap", async () => {
  const f = fixture();
  try {
   const capped = f.kernel.bindClient({ cwd: f.cwd, scope: { runId: "capped", sessionId: "capped", autonomous: false }, budget: { dailyUsd: 0 } });
   await expect(capped.acquire(f.request("denied"))).rejects.toThrow("budget");
   expect(f.client.scope.hasHardCostCap).not.toBe(true);
   await f.fast(async () => { await expect(f.client.acquire(f.request("one"))).rejects.toThrow("budget"); });
   expect(f.rows()).toHaveLength(0); capped.release?.();
  } finally { f.close(); }
 });

 it.each(["reader", "policy-change"])("promotes captured decisions before %s", async barrier => {
  const f = fixture();
  try {
   await f.fast(async () => {
    const lease = await f.client.acquire(f.request("one"));
    f.client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    f.client.reconcile(lease.reservation.reservationId, { inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
   });
   if (barrier === "reader") f.reader.prepareState("SELECT COUNT(*) FROM execution_admission_reservations").get();
   else {
    const other = new ExecutionAdmissionKernel({ agencHome: f.home });
    try {
     const changed = other.bindClient({ cwd: f.cwd, scope: { runId: "root", sessionId: "root", autonomous: false }, budget: { runMaxCostUsd: 0.1 } });
     changed.release?.();
     await f.fast(async () => { await expect(f.client.acquire(f.request("two"))).rejects.toThrow("budget"); });
    } finally { other.close(); }
   }
   expect(f.rows()).toHaveLength(1); expect(f.rows()[0]?.actual_cost_nanos).toBe(250000000);
  } finally { f.close(); }
 });

 it("flush failure retains the failed batch and prevents further dispatch", async () => {
  const f = fixture();
  try {
   await f.fast(async () => {
    const lease = await f.client.acquire(f.request("one"));
    f.client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    f.client.holdUnknown(lease.reservation.reservationId, "lost usage");
   });
   f.reader.state.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON agent_jobs BEGIN SELECT RAISE(ABORT, 'capture failed'); END");
   expect(() => f.store.writeBehind.finish()).toThrow("capture failed");
   expect(f.rows()).toEqual([]); expect(f.store.writeBehind.pending).toBeGreaterThan(0);
   await expect(f.fast(async () => f.client.acquire(f.request("two")))).rejects.toThrow("capture failed");
   expect(f.kernel.activeCount).toBe(0);
  } finally {
   f.reader.state.exec("DROP TRIGGER IF EXISTS fail_capture");
   try { f.close(); } catch (error) {
    expect(String(error instanceof AggregateError ? error.errors : error)).toContain("capture failed");
   }
  }
 });

 it("preserves deadline, duplicate-step and ordinary-observer boundaries", async () => {
  const f = fixture();
  try {
   await f.fast(async () => {
    const lease = await f.client.acquire(f.request("one"));
    await expect(f.client.acquire(f.request("one"))).rejects.toThrow("already_running");
    f.client.void(lease.reservation.reservationId, "unused");
    await expect(f.client.acquire({ ...f.request("expired"), deadlineAt: "2020-01-01T00:00:00Z" })).rejects.toThrow("deadline");
   });
   const events: string[] = []; const unsubscribe = f.client.subscribe(event => events.push(event.event));
   try { await f.fast(async () => {
    const lease = await f.client.acquire(f.request("observed"));
    expect(events).toEqual(["queued", "allowed"]); expect(f.rows()).toHaveLength(2);
    f.client.void(lease.reservation.reservationId, "unused");
   }); } finally { unsubscribe(); }
  } finally { f.close(); }
 });

 it("run cancellation records the dispatched call before locking the run", async () => {
  const f = fixture();
  try { await f.fast(async () => {
   const lease = await f.client.acquire(f.request("one"));
   f.client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
   f.client.cancelRun("stop");
   expect(lease.signal.aborted).toBe(true); expect(f.kernel.activeCount).toBe(1);
   expect(f.rows()[0]?.status).toBe("held_unknown");
   f.client.acknowledgeCompletion(lease.reservation.reservationId);
   await expect(f.client.acquire(f.request("two"))).rejects.toThrow("cancel");
  }); } finally { f.close(); }
 });

 it("never selects memory admission without the authenticated relaxed writer", async () => {
  const f = fixture(false);
  try { await f.fast(async () => {
   const lease = await f.client.acquire(f.request("one"));
   expect(f.rows()).toHaveLength(1); f.client.void(lease.reservation.reservationId, "unused");
  }); } finally { f.close(); }
 });

 it("rejects malformed dispatch evidence before marking the wire boundary", async () => {
  const f = fixture();
  try { await f.fast(async () => {
   const lease = await f.client.acquire(f.request("one"));
   expect(() => f.client.markDispatched(lease.reservation.reservationId,
    { boundary: "provider_wire", timestamp: "invalid" })).toThrow();
   expect(() => f.client.markDispatched(lease.reservation.reservationId,
    { boundary: "provider_wire", details: { invalid: 1n } })).toThrow();
   f.client.void(lease.reservation.reservationId, "invalid evidence");
  });
  f.store.writeBehind.finish(); expect(f.rows()[0]?.status).toBe("voided");
  } finally { f.close(); }
 });

 it("a canonical reader flushes the owned buffer before reading it", async () => {
  const f = fixture();
  try {
   f.store.appendRollout({ type: "response_item", payload: { role: "user", content: "buffered message" } });
   expect(f.store.writeBehind.oneShotBuffering).toBe(true);
   expect(JSON.stringify(f.store.readAll())).toContain("buffered message");
   expect(f.store.writeBehind.oneShotBuffering).toBe(false);
   await f.fast(async () => {
    const lease = await f.client.acquire(f.request("one"));
    expect(f.rows()).toHaveLength(1); f.client.void(lease.reservation.reservationId, "unused");
   });
  } finally { f.close(); }
 });
});
