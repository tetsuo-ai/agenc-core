import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { Session } from "../../src/session/session.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";

let home: string;
let workspace: string;
let configPath: string;
const shutdowns = new Set<() => Promise<void>>();
const kernels = new Set<ExecutionAdmissionKernel>();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agenc-aggregate-budget-home-"));
  workspace = await mkdtemp(join(tmpdir(), "agenc-aggregate-budget-project-"));
  configPath = join(home, "audit.toml");
  await mkdir(join(workspace, ".git"));
  const provider = await import("../../src/llm/provider.js");
  vi.spyOn(provider, "createProvider").mockReturnValue({
    name: "budget-fixture",
    chat: vi.fn().mockRejectedValue(new Error("No model dispatch expected")),
  } as never);
  vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const shutdown of shutdowns) await shutdown();
  shutdowns.clear();
  for (const kernel of kernels) kernel.close();
  kernels.clear();
  vi.restoreAllMocks();
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true }),
  ]);
});

async function bootstrap(config: string, resume = false) {
  await writeFile(configPath, `config_version = 2\n${config}\n`, "utf8");
  const boot = await bootstrapLocalRuntimeSession({
    apiKey: "budget-fixture-only",
    conversationId: "aggregate-budget-parent",
    resumeConversation: resume,
    cwd: workspace,
    argv: ["node", "agenc", "--config", configPath],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      AGENC_HOME: home,
      AGENC_WORKSPACE: workspace,
    },
    fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("Offline fixture")),
  });
  shutdowns.add(boot.shutdown);
  const client = boot.session.services.executionAdmission;
  if (client === undefined) throw new Error("Missing canonical admission client");
  return { ...boot, client };
}

function acquire(client: ExecutionAdmissionClient, stepId: string, cost: number | null) {
  return client.acquire({
    stepId,
    kind: "model_turn",
    model: "budget-fixture",
    provider: "budget-fixture",
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostUsd: cost,
  });
}

function allocations() {
  const driver = openStateDatabases({ cwd: workspace, agencHome: home });
  try {
    return new ExecutionAdmissionRepository(driver).listAllocations();
  } finally {
    driver.close();
  }
}

describe("canonical aggregate bootstrap dollar cap", () => {
  it("shares a flat $3 cap across the parent and concurrent workers", async () => {
    const boot = await bootstrap("max_budget_usd = 3");
    const first = boot.client.forSession({ runId: "worker-first", sessionId: "worker-first" });
    const second = boot.client.forSession({ runId: "worker-second", sessionId: "worker-second" });
    const clients = [boot.client, first, second];
    const leases = await Promise.all(clients.map((client) => acquire(client, "parallel", 1)));

    await expect(acquire(first, "one-nano-over", 0.000000001)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    expect(clients.every((client) => client.scope.hasHardCostCap === true)).toBe(true);
    expect(allocations().find((row) => row.key === "run:aggregate-budget-parent"))
      .toMatchObject({ maxCostUsd: 3, usedCostUsd: 0, heldCostUsd: 3 });

    first.reconcile(leases[1]!.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.25,
    });
    const replacement = await acquire(second, "freed-reservation", 0.75);
    await expect(acquire(boot.client, "still-over", 0.000000001)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    boot.client.reconcile(leases[0]!.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.5,
    });
    second.reconcile(leases[2]!.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.5,
    });
    second.reconcile(replacement.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.25,
    });
    expect(allocations().find((row) => row.key === "run:aggregate-budget-parent"))
      .toMatchObject({ maxCostUsd: 3, usedCostUsd: 1.5, heldCostUsd: 0 });
    await expect(acquire(first, "unknown-price", null)).rejects.toMatchObject({
      reason: "unpriced_under_hard_cap",
    });
  });

  it.each([
    { flat: 3, nested: 2, expected: 2 },
    { flat: 3, nested: 5, expected: 3 },
    { flat: 3, nested: 0, expected: 0 },
  ])("combines flat $flat and nested $nested caps at $expected", async ({ flat, nested, expected }) => {
    const boot = await bootstrap(`max_budget_usd = ${flat}\n[agent.budget]\ndollar_cap = ${nested}`);
    expect(boot.client.scope.maxCostUsd).toBe(expected);
    await expect(acquire(boot.client, "over-minimum", expected + 0.000000001))
      .rejects.toMatchObject({ reason: "budget_exceeded" });
  });

  it("retains a stricter enabled calendar budget alongside the flat cap", async () => {
    const boot = await bootstrap("max_budget_usd = 3\n[budget]\nenabled = true\nenforce_interactive = true\ndaily_usd = 1");
    expect(boot.client.scope.maxCostUsd).toBe(3);
    const lease = await acquire(boot.client, "daily-exact-fit", 1);
    const child = boot.client.forSession({ runId: "daily-child", sessionId: "daily-child" });
    await expect(acquire(child, "daily-over", 0.000000001)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    boot.client.void(lease.reservation.reservationId, "fixture complete");
  });

  it("adds a flat cap on legacy resume without resetting parent or child spend", async () => {
    const first = await bootstrap("");
    const child = first.client.forSession({ runId: "legacy-child", sessionId: "legacy-child" });
    for (const client of [first.client, child]) {
      const lease = await acquire(client, "legacy-spend", 1);
      client.reconcile(lease.reservation.reservationId, {
        inputTokens: 1, outputTokens: 1, costUsd: 1,
      });
    }
    await first.shutdown();
    shutdowns.delete(first.shutdown);

    const resumed = await bootstrap("max_budget_usd = 3", true);
    const worker = resumed.client.forSession({ runId: "resumed-child", sessionId: "resumed-child" });
    await expect(acquire(worker, "legacy-over", 1.000000001)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    const lease = await acquire(worker, "legacy-exact-fit", 1);
    expect(allocations().find((row) => row.key === "run:aggregate-budget-parent"))
      .toMatchObject({ maxCostUsd: 3, usedCostUsd: 2, heldCostUsd: 1 });
    worker.void(lease.reservation.reservationId, "fixture complete");
  });

  it("preserves a cap when resumed config raises or omits it, and allows tightening", async () => {
    let boot = await bootstrap("max_budget_usd = 3");
    const lease = await acquire(boot.client, "spent-before-restart", 1);
    boot.client.reconcile(lease.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.5,
    });
    for (const config of ["max_budget_usd = 8", "", "max_budget_usd = 2"]) {
      await boot.shutdown();
      shutdowns.delete(boot.shutdown);
      boot = await bootstrap(config, true);
      const cap = config.endsWith("2") ? 2 : 3;
      expect(boot.client.scope).toMatchObject({ maxCostUsd: cap, hasHardCostCap: true });
      await expect(acquire(boot.client, `resume-${config}`, cap - 0.5 + 0.000000001))
        .rejects.toMatchObject({ reason: "budget_exceeded" });
      expect(allocations().find((row) => row.key === "run:aggregate-budget-parent"))
        .toMatchObject({ maxCostUsd: cap, usedCostUsd: 0.5, heldCostUsd: 0 });
    }
  });

  it("honors nano-USD boundaries without rounding a shared hold down", async () => {
    const boot = await bootstrap("max_budget_usd = 0.000000003");
    const child = boot.client.forSession({ runId: "nano-child", sessionId: "nano-child" });
    const lease = await acquire(boot.client, "two-nanos", 0.000000002);
    await expect(acquire(child, "two-more-nanos", 0.000000002)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    boot.client.reconcile(lease.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.000000001,
    });
    const exact = await acquire(child, "remaining-nanos", 0.000000002);
    child.void(exact.reservation.reservationId, "fixture complete");
  });

  it("tightens against active reservations and rejects stale bindings without resetting holds", async () => {
    const kernel = new ExecutionAdmissionKernel({ agencHome: home });
    kernels.add(kernel);
    const bind = (maxCostUsd: number) => kernel.bindClient({
      cwd: workspace,
      scope: { runId: "tightening-parent", sessionId: "tightening-parent", autonomous: false, maxCostUsd },
    });
    const original = bind(3);
    const active = await acquire(original, "active-before-tightening", 0.75);
    const tighter = bind(0.5);
    await expect(acquire(original, "stale-binding", 0.01)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    await expect(acquire(tighter, "tight-binding", 0)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    original.reconcile(active.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 0.25,
    });
    const final = await acquire(tighter, "after-settlement", 0.25);
    expect(allocations().find((row) => row.key === "run:tightening-parent"))
      .toMatchObject({ maxCostUsd: 0.5, usedCostUsd: 0.25, heldCostUsd: 0.25 });
    tighter.void(final.reservation.reservationId, "fixture complete");
  });

  it("retains legacy spend above a newly bound cap and denies further work", async () => {
    const kernel = new ExecutionAdmissionKernel({ agencHome: home });
    kernels.add(kernel);
    const scope = { runId: "legacy-over-cap", sessionId: "legacy-over-cap", autonomous: false };
    const legacy = kernel.bindClient({ cwd: workspace, scope });
    const lease = await acquire(legacy, "legacy-expense", 4);
    legacy.reconcile(lease.reservation.reservationId, {
      inputTokens: 1, outputTokens: 1, costUsd: 4,
    });
    const capped = kernel.bindClient({ cwd: workspace, scope: { ...scope, maxCostUsd: 3 } });
    await expect(acquire(capped, "zero-cost-after-cap", 0)).rejects.toMatchObject({
      reason: "budget_exceeded",
    });
    expect(allocations().find((row) => row.key === "run:legacy-over-cap"))
      .toMatchObject({ maxCostUsd: 3, usedCostUsd: 4, heldCostUsd: 0 });
  });
});
