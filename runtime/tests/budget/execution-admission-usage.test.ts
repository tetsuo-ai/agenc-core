import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { LLMRateLimitError } from "../../src/llm/errors.js";
import type { LLMProvider } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import type { AdmissionUsageSummary } from "../../src/budget/admission-types.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";

let home: string;
let workspace: string;
let kernel: ExecutionAdmissionKernel;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-usage-home-"));
  workspace = mkdtempSync(join(tmpdir(), "agenc-usage-project-"));
  mkdirSync(join(workspace, ".git"));
  kernel = new ExecutionAdmissionKernel({ agencHome: home });
});

afterEach(() => {
  kernel.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function bind(runId: string, cwd = workspace) {
  return kernel.bindClient({
    cwd,
    scope: { runId, sessionId: runId, autonomous: false, maxCostUsd: 3 },
  });
}

function acquire(client: ExecutionAdmissionClient, stepId: string, cost = 1) {
  return client.acquire({
    stepId,
    kind: "model_turn",
    model: "usage-fixture",
    provider: "usage-fixture",
    maxInputTokens: 4,
    maxOutputTokens: 2,
    maxCostUsd: cost,
  });
}

function observe(client: ExecutionAdmissionClient) {
  const snapshots: AdmissionUsageSummary[] = [];
  if (client.subscribeUsage === undefined) throw new Error("Missing usage subscription");
  const unsubscribe = client.subscribeUsage((summary) => snapshots.push(summary));
  return { snapshots, unsubscribe };
}

describe("canonical allocation usage observers", () => {
  it("releases every rejected model attempt under a $20 Goal cap", async () => {
    const parent = kernel.bindClient({
      cwd: workspace,
      scope: { runId: "goal", sessionId: "goal", autonomous: true, maxCostUsd: 20, maxTokens: 156_392 },
    });
    const child = parent.forSession({ runId: "worker", sessionId: "worker" });
    const acquireModel = child.acquire.bind(child);
    vi.spyOn(child, "acquire").mockImplementation((input) => acquireModel({
      ...input, maxInputTokens: 150_000, maxOutputTokens: 6_392, maxCostUsd: 1.02,
    }));
    const session = { services: { executionAdmission: child } } as unknown as Session;
    const provider = {
      name: "grok",
      getExecutionProfile: async () => ({ usageReporting: "authoritative", supportsMaxOutputTokens: true }),
    } as unknown as LLMProvider;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const error = new LLMRateLimitError("grok", 30_000);
      await expect(runAdmittedModelCall({
        session, provider, messages: [], options: { maxOutputTokens: 6_392 },
        stepId: `retry:${attempt}`, model: "grok-4.5", providerName: "grok",
        invoke: async () => { throw error; },
      })).rejects.toBe(error);
      expect(parent.getUsageSummary?.()).toMatchObject({
        costUsd: 0, totalTokens: 0, heldCostUsd: 0, hasUnknownCost: false,
      });
    }
    const journal = child.replayJournal?.() ?? [];
    expect(journal.filter((event) => event.event === "allowed")).toHaveLength(25);
    expect(journal.filter((event) => event.event === "reconciled")).toHaveLength(25);
    expect(journal.filter((event) => event.event === "held_unknown")).toHaveLength(0);
  });

  it("reports descendants once without rewriting their journal identity", async () => {
    const parent = bind("parent");
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    const grandchild = child.forSession({ runId: "grandchild", sessionId: "grandchild" });
    const parentJournal: string[] = [];
    parent.subscribe((event) => parentJournal.push(event.runId));
    const observed = observe(parent);
    for (const [index, client] of [parent, child, grandchild].entries()) {
      const lease = await acquire(client, "sample");
      client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
      client.reconcile(lease.reservation.reservationId, {
        inputTokens: 4, outputTokens: 2, costUsd: (index + 1) / 10,
      });
    }
    expect(parent.getUsageSummary?.()).toMatchObject({
      runId: "parent", costUsd: 0.6, inputTokens: 12, outputTokens: 6,
      totalTokens: 18, modelCalls: 3, heldCostUsd: 0, hasUnknownCost: false,
    });
    expect(child.getUsageSummary?.()).toMatchObject({
      runId: "child", costUsd: 0.5, modelCalls: 2,
    });
    expect(observed.snapshots.at(-1)?.costUsd).toBe(0.6);
    expect(new Set(parentJournal)).toEqual(new Set(["parent"]));
    expect(observed.snapshots.map((snapshot) => snapshot.sequence))
      .toEqual([...observed.snapshots.map((snapshot) => snapshot.sequence)].sort((left, right) => left - right));
    observed.unsubscribe();
  });

  it("does not notify unrelated run scopes in the same or another workspace", async () => {
    const parent = bind("parent");
    const sibling = bind("unrelated");
    const otherWorkspace = join(home, "other-project");
    mkdirSync(join(otherWorkspace, ".git"), { recursive: true });
    const outside = bind("outside", otherWorkspace);
    const observed = observe(parent);
    for (const client of [sibling, outside]) {
      const lease = await acquire(client, "unrelated-spend");
      client.reconcile(lease.reservation.reservationId, {
        inputTokens: 4, outputTokens: 2, costUsd: 0.5,
      });
    }
    expect(observed.snapshots).toEqual([]);
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0, modelCalls: 0 });
    observed.unsubscribe();
  });

  it("keeps unknown holds separate from actual usage and refreshes after late reconciliation", async () => {
    const parent = bind("parent");
    const child = parent.forSession({ runId: "child", sessionId: "child" });
    const observed = observe(parent);
    const lease = await acquire(child, "unknown-response");
    child.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    child.holdUnknown(lease.reservation.reservationId, "fixture missing usage");
    expect(observed.snapshots.at(-1)).toMatchObject({
      costUsd: 0, modelCalls: 0, hasUnknownCost: true, heldCostUsd: 1,
    });
    child.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(observed.snapshots.at(-1)).toMatchObject({
      costUsd: 0.25, modelCalls: 1, hasUnknownCost: false, heldCostUsd: 0,
    });
    const count = observed.snapshots.length;
    child.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(observed.snapshots).toHaveLength(count);
    observed.unsubscribe();
  });

  it("drops observers on unsubscribe and restores authoritative totals after restart", async () => {
    const parent = bind("parent");
    const observed = observe(parent);
    const lease = await acquire(parent, "sample");
    observed.unsubscribe();
    const count = observed.snapshots.length;
    parent.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(observed.snapshots).toHaveLength(count);
    kernel.close();
    kernel = new ExecutionAdmissionKernel({ agencHome: home });
    kernel.initializeExistingState();
    const restored = bind("parent");
    expect(restored.getUsageSummary?.()).toMatchObject({ costUsd: 0.25, modelCalls: 1 });
    const renewed = observe(restored);
    const next = await acquire(restored, "next");
    restored.void(next.reservation.reservationId, "fixture complete");
    expect(renewed.snapshots.at(-1)).toMatchObject({ costUsd: 0.25, heldCostUsd: 0 });
    expect(observed.snapshots).toHaveLength(count);
    renewed.unsubscribe();
  });

  it("retries a failed observer on the next journal boundary without charging usage twice", async () => {
    const parent = bind("parent");
    const unrelated = bind("unrelated");
    const lease = await acquire(parent, "sample");
    const snapshots: AdmissionUsageSummary[] = [];
    let attempts = 0;
    const unsubscribe = parent.subscribeUsage?.((summary) => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture observer unavailable");
      snapshots.push(summary);
    });
    parent.reconcile(lease.reservation.reservationId, {
      inputTokens: 4, outputTokens: 2, costUsd: 0.25,
    });
    expect(attempts).toBe(1);
    expect(snapshots).toEqual([]);
    const other = await acquire(unrelated, "next-boundary");
    expect(attempts).toBe(2);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ costUsd: 0.25, modelCalls: 1, heldCostUsd: 0 });
    unrelated.void(other.reservation.reservationId, "fixture complete");
    expect(attempts).toBe(2);
    expect(parent.getUsageSummary?.()).toMatchObject({ costUsd: 0.25, modelCalls: 1 });
    unsubscribe?.();
  });
});
