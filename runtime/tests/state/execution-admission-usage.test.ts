import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { bindExecutionAdmissionJournal } from "../../src/session/execution-admission-journal.js";
import type { Session } from "../../src/session/session.js";
import type { Event, EventMsg } from "../../src/session/event-log.js";

let home: string;
let cwd: string;
const kernels: ExecutionAdmissionKernel[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-usage-state-"));
  cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
});

afterEach(() => {
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

async function reserve(client: ExecutionAdmissionClient, stepId: string, costUsd = 0.5) {
  return client.acquire({
    stepId,
    kind: "model_turn",
    model: "grok-test",
    provider: "grok",
    maxInputTokens: 20,
    maxOutputTokens: 20,
    maxCostUsd: costUsd,
  });
}

async function spend(client: ExecutionAdmissionClient, stepId: string, costUsd: number) {
  const lease = await reserve(client, stepId, costUsd);
  const reservationId = lease.reservation.reservationId;
  client.markDispatched(reservationId, { boundary: "provider_wire" });
  client.reconcile(reservationId, { inputTokens: 10, outputTokens: 5, costUsd });
  client.acknowledgeCompletion(reservationId);
}

describe("canonical session usage", () => {
  it("counts descendants once, excludes unrelated runs, and scopes child totals", async () => {
    const kernel = createKernel();
    const parent = bind(kernel, "parent");
    const core = parent.forSession({ runId: "core", sessionId: "core" });
    const tests = parent.forSession({ runId: "tests", sessionId: "tests" });
    const grandchild = core.forSession({ runId: "grandchild", sessionId: "grandchild" });
    await spend(parent, "parent-work", 0.11);
    await spend(core, "core-work", 0.22);
    await spend(tests, "tests-work", 0.33);
    await spend(grandchild, "grandchild-work", 0.44);
    await spend(bind(kernel, "unrelated"), "other-work", 0.5);
    expect(parent.getUsageSummary?.()).toMatchObject({
      runId: "parent", costUsd: 1.1, inputTokens: 40, outputTokens: 20,
      totalTokens: 60, modelCalls: 4, hasUnknownCost: false, heldCostUsd: 0,
      models: [{ model: "grok-test", provider: "grok", costUsd: 1.1, modelCalls: 4 }],
      agents: [
        { runId: "core", costUsd: 0.22 },
        { runId: "grandchild", costUsd: 0.44 },
        { runId: "tests", costUsd: 0.33 },
      ],
    });
    expect(core.getUsageSummary?.()).toMatchObject({
      costUsd: 0.66, modelCalls: 2, agents: [{ runId: "grandchild", costUsd: 0.44 }],
    });
    expect(tests.getUsageSummary?.()).toMatchObject({ costUsd: 0.33, agents: [] });
  });

  it("never presents open or unknown reservations as recorded spend", async () => {
    const parent = bind(createKernel(), "parent");
    const lease = await reserve(parent, "unknown");
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0, heldCostUsd: 0.5, modelCalls: 0 });
    parent.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    parent.holdUnknown(lease.reservation.reservationId, "provider disconnected");
    expect(parent.getUsageSummary?.()).toMatchObject({
      costUsd: 0, heldCostUsd: 0.5, hasUnknownCost: true, totalTokens: 0, modelCalls: 0,
    });
    parent.acknowledgeCompletion(lease.reservation.reservationId);
  });

  it("includes priced tool work in actual totals without adding model calls", async () => {
    const parent = bind(createKernel(), "parent");
    const child = parent.forSession({ runId: "worker", sessionId: "worker" });
    await spend(parent, "model-work", 0.2);
    const lease = await child.acquire({
      stepId: "priced-tool",
      kind: "tool_exec",
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0.5,
    });
    const reservationId = lease.reservation.reservationId;
    child.markDispatched(reservationId, { boundary: "tool_exec" });
    child.reconcile(reservationId, { inputTokens: 0, outputTokens: 0, costUsd: 0.3 });
    child.acknowledgeCompletion(reservationId);
    expect(parent.getUsageSummary?.()).toMatchObject({
      costUsd: 0.5, modelCalls: 1, inputTokens: 10, outputTokens: 5,
      totalTokens: 15, heldCostUsd: 0, hasUnknownCost: false,
      models: [{ model: "grok-test", provider: "grok", costUsd: 0.2, modelCalls: 1 }],
      agents: [{ runId: "worker", costUsd: 0.3, modelCalls: 0, totalTokens: 0 }],
    });
    expect(child.getUsageSummary?.()).toMatchObject({
      costUsd: 0.3, modelCalls: 0, models: [], agents: [],
    });
  });

  it("retains reported tokens when only the price is unknown", async () => {
    const parent = bind(createKernel(), "parent");
    const child = parent.forSession({ runId: "worker", sessionId: "worker" });
    const lease = await reserve(child, "unpriced-response");
    child.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    child.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: null });
    child.acknowledgeCompletion(lease.reservation.reservationId);
    expect(parent.getUsageSummary?.()).toMatchObject({
      costUsd: 0, heldCostUsd: 0.5, hasUnknownCost: true,
      inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1,
      models: [{ model: "grok-test", totalTokens: 15, modelCalls: 1, hasUnknownCost: true }],
      agents: [{ runId: "worker", totalTokens: 15, modelCalls: 1, hasUnknownCost: true }],
    });
    child.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.2 });
    expect(parent.getUsageSummary?.()).toMatchObject({
      costUsd: 0.2, heldCostUsd: 0, hasUnknownCost: false, totalTokens: 15, modelCalls: 1,
    });
  });

  it("preserves a retained unknown-cost hold on token-only provider overrun", async () => {
    const parent = bind(createKernel(), "parent");
    const lease = await reserve(parent, "overrun");
    parent.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    parent.reconcile(lease.reservation.reservationId, { inputTokens: 50, outputTokens: 1, costUsd: null });
    parent.acknowledgeCompletion(lease.reservation.reservationId);
    expect(parent.getUsageSummary?.()).toMatchObject({
      costUsd: 0, heldCostUsd: 0.5, hasUnknownCost: true, totalTokens: 51, modelCalls: 1,
    });
  });

  it("reports provider-reported overrun cost rather than its reservation", async () => {
    const parent = bind(createKernel(), "parent");
    const lease = await reserve(parent, "overrun");
    parent.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    parent.reconcile(lease.reservation.reservationId, { inputTokens: 10, outputTokens: 5, costUsd: 0.75 });
    parent.acknowledgeCompletion(lease.reservation.reservationId);
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0.75, heldCostUsd: 0, hasUnknownCost: false });
  });

  it("restores aggregate usage from SQLite after restart without counting it again", async () => {
    const first = createKernel();
    const parent = bind(first, "parent");
    await spend(parent.forSession({ runId: "worker", sessionId: "worker" }), "work", 0.2);
    const before = parent.getUsageSummary?.();
    first.close();
    const restored = bind(createKernel(), "parent");
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: 0.2, modelCalls: 1 });
    expect(restored.getUsageSummary?.().sequence).toBeGreaterThanOrEqual(before!.sequence);
    await spend(restored, "follow-up", 0.1);
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: 0.3, modelCalls: 2 });
  });

  it("projects initial and child usage into the parent stream and unsubscribes cleanly", async () => {
    const parent = bind(createKernel(), "parent");
    const child = parent.forSession({ runId: "worker", sessionId: "worker" });
    const events: EventMsg[] = [];
    const session = {
      emit(event: Event): Event {
        events.push(event.msg);
        return event;
      },
    } as unknown as Session;
    const unbind = bindExecutionAdmissionJournal(session, parent);
    expect(events.some((event) => event.type === "session_usage" && event.payload.costUsd === 0)).toBe(true);
    await spend(child, "work", 0.25);
    const snapshots = events.filter((event) => event.type === "session_usage");
    expect(snapshots.at(-1)?.payload).toMatchObject({ costUsd: 0.25, agents: [{ runId: "worker", costUsd: 0.25 }] });
    expect(events.some((event) => event.type === "execution_admission" && event.payload.runId === "worker")).toBe(false);
    unbind();
    const count = events.length;
    await spend(child, "after-unbind", 0.1);
    expect(events).toHaveLength(count);
  });
});
