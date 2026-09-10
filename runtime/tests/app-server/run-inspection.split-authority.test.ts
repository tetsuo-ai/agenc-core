import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";

const RUN_ID = "split-child";
let root: string;
let home: string;
let parent: StateSqliteDriver;
let child: StateSqliteDriver;
let kernel: ExecutionAdmissionKernel;
let client: ExecutionAdmissionClient;
let service: AgenCDaemonRunInspectionService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-split-authority-"));
  home = join(root, "home");
  const parentCwd = join(root, "parent");
  const childCwd = join(root, "worktree");
  mkdirSync(join(parentCwd, ".git"), { recursive: true });
  mkdirSync(join(childCwd, ".git"), { recursive: true });
  parent = openStateDatabases({ cwd: parentCwd, agencHome: home });
  child = openStateDatabases({ cwd: childCwd, agencHome: home });
  kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "split-test", ownerPid: process.pid });
  client = kernel.bindClient({
    cwd: parentCwd,
    scope: { runId: "parent-run", sessionId: "parent-run", autonomous: false },
    budget: { runMaxCostUsd: 1 },
  }).forSession({ runId: RUN_ID, sessionId: RUN_ID });
  service = new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => [parent, child] });
});

afterEach(() => {
  kernel.close();
  parent.close();
  child.close();
  rmSync(root, { recursive: true, force: true });
});

async function seedSplitRun(options: { legacy?: boolean; owner?: string; corruptEvent?: boolean; omitEvents?: boolean; beforeAdmission?: boolean } = {}): Promise<void> {
  if (!options.beforeAdmission) {
    const lease = await client.acquire({ stepId: "model:1", kind: "model_turn", maxInputTokens: 10, maxOutputTokens: 5, maxCostUsd: 0.1 });
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(lease.reservation.reservationId, { inputTokens: 4, outputTokens: 2, costUsd: 0.03 });
  }
  const store = new RolloutStore({ cwd: join(root, "worktree"), agencHome: home, sessionId: RUN_ID, agencVersion: "0.17.0", sessionTempRoot: join(root, "session-tmp") });
  store.open({
    sessionId: RUN_ID, cwd: join(root, "worktree"), timestamp: new Date().toISOString(), originator: "agenc-subagent", agencVersion: "0.17.0",
    ...(options.legacy ? {} : { admissionOwner: { workspaceId: options.owner ?? parent.projectDir, runId: RUN_ID, parentRunId: "parent-run" } }),
  });
  let sequence = 0;
  for (const event of options.omitEvents ? [] : client.replayJournal?.() ?? []) {
    sequence += 1;
    store.append({ id: event.eventId, eventId: event.eventId, seq: sequence, msg: { type: "execution_admission", payload: options.corruptEvent ? { ...event, stepId: "forged-step" } : event } }, { durable: true });
  }
  store.append({ id: "split-terminal", eventId: "split-terminal", seq: sequence + 1, msg: { type: "run_terminal", payload: {
    runId: RUN_ID, epoch: store.runEpoch, status: "failed", exitCode: 1, stopReason: "budget_exhausted", finalMessage: "child failed truthfully", usage: null,
    lastSequenceBeforeTerminal: sequence || null, finishedAt: new Date().toISOString(),
  } } }, { durable: true });
  store.close();
}

describe("split canonical journal and admission ownership", () => {
  it("advances admission provenance with a later descendant settlement", async () => {
    const rootClient = kernel.bindClient({
      cwd: join(root, "parent"),
      scope: { runId: "parent-run", sessionId: "parent-run", autonomous: false },
      budget: { runMaxCostUsd: 1 },
    });
    const rootLease = await rootClient.acquire({ stepId: "root", kind: "spawn", maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 });
    rootClient.markDispatched(rootLease.reservation.reservationId, { boundary: "child_agent" });
    rootClient.reconcile(rootLease.reservation.reservationId, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    await seedSplitRun();
    const before = service.status({ runId: RUN_ID });
    const descendant = client.forSession({ runId: "split-grandchild", sessionId: "split-grandchild" });
    const lease = await descendant.acquire({ stepId: "model:grandchild", kind: "model_turn", maxInputTokens: 10, maxOutputTokens: 5, maxCostUsd: 0.1 });
    descendant.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    descendant.reconcile(lease.reservation.reservationId, { inputTokens: 3, outputTokens: 1, costUsd: 0.02 });
    const after = service.status({ runId: RUN_ID });
    expect(after.admission.actualCostUsd).toBeCloseTo(0.05);
    expect(after.source.admissionLastSequence).toBeGreaterThan(before.source.admissionLastSequence!);
    const latest = parent.state.prepare("SELECT MAX(sequence) AS sequence FROM execution_admission_journal WHERE run_id = ?").get("split-grandchild") as { sequence: number };
    expect(after.source.admissionLastSequence).toBe(latest.sequence);
    expect(service.evidence({ runId: RUN_ID }).source.admissionLastSequence).toBe(latest.sequence);
  });
  it("resolves a declared discovered owner before the child's first admission", async () => {
    await seedSplitRun({ beforeAdmission: true });
    expect(service.status({ runId: RUN_ID })).toMatchObject({ status: "failed", admission: { actualCostUsd: 0, reservationCount: 0 }, source: { projectDir: child.projectDir, admissionProjectDir: parent.projectDir } });
    expect(service.replay({ runId: RUN_ID }).events).toHaveLength(1);
  });
  it.each([false, true])("reads the exact child and parent admission without double counting (legacy=%s)", async (legacy) => {
    await seedSplitRun({ legacy });
    child.state.prepare("DELETE FROM thread_rollout_items WHERE thread_id = ?").run(RUN_ID);
    const status = service.status({ runId: RUN_ID });
    expect(status).toMatchObject({ status: "failed", terminal: true, admission: { actualCostUsd: 0.03, actualTokens: 6, reservationCount: 1 }, source: { projectDir: child.projectDir, admissionProjectDir: parent.projectDir } });
    const replay = service.replay({ runId: RUN_ID, limit: 2 });
    expect(replay.source).toMatchObject({ kind: "run_journal", sequenceScope: "run", projectDir: child.projectDir });
    expect(replay.events.map((event) => event.sequence)).toEqual([1, 2]);
    const next = service.replay({ runId: RUN_ID, afterSequence: replay.nextAfterSequence });
    expect(next.events.at(-1)).toMatchObject({ event: "run_terminal", payload: { finalMessage: "child failed truthfully" } });
    expect(service.result({ runId: RUN_ID })).toMatchObject({ status: "failed", output: { available: true, finalMessage: "child failed truthfully" } });
    expect(service.evidence({ runId: RUN_ID }).source).toMatchObject({ completeness: "partial", admissionProjectDir: parent.projectDir, admissionLastSequence: status.source.admissionLastSequence });
    const reverse = new AgenCDaemonRunInspectionService({ stateDatabasePaths: () => [child, parent] });
    expect(reverse.status({ runId: RUN_ID })).toEqual(status);
  });

  it.each([
    { owner: "/outside/owner" },
    { corruptEvent: true },
    { legacy: true, omitEvents: true },
  ])("refuses unproved or conflicting ownership %j", async (options) => {
    await seedSplitRun(options);
    expect(() => service.replay({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }));
  });

  it("does not treat a distinct journal with the same run ID as an admission mirror", async () => {
    await seedSplitRun();
    const store = new RolloutStore({ cwd: join(root, "parent"), agencHome: home, sessionId: RUN_ID, agencVersion: "0.17.0", sessionTempRoot: join(root, "session-tmp") });
    store.open({ sessionId: RUN_ID, cwd: join(root, "parent"), timestamp: new Date().toISOString(), originator: "agenc-subagent", agencVersion: "0.17.0" });
    store.close();
    expect(() => service.status({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS" }));
  });
});
