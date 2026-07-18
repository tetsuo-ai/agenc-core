import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCInProcessDaemonTransport } from "../../src/app-server/transport/in-process.js";
import {
  AgenCDaemonRunInspectionError,
  AgenCDaemonRunInspectionService,
} from "../../src/app-server/run-inspection.js";
import { admissionRecordKey } from "../../src/budget/admission-types.js";
import type { RuntimeAdmissionRequest } from "../../src/budget/admission-types.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { ExecutionAdmissionRepository } from "../../src/state/execution-admission.js";
import {
  openStateDatabases,
  type StateDatabasePaths,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import {
  AGENC_DAEMON_METHOD_CAPABILITIES_KEY,
  JSON_RPC_VERSION,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";
import {
  createAgencClient,
  type AgencTransport,
} from "../../../packages/agenc-sdk/src/index.js";

const NOW = "2026-07-18T12:00:00.000Z";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;
let paths: StateDatabasePaths;
let service: AgenCDaemonRunInspectionService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-run-inspection-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-run-inspection-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
  paths = {
    projectDir: driver.projectDir,
    stateDbPath: driver.stateDbPath,
    logsDbPath: driver.logsDbPath,
  };
  service = new AgenCDaemonRunInspectionService({
    stateDatabasePaths: () => [paths],
  });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function admissionRequest(
  stepId: string,
  options: { readonly runId?: string; readonly parentRunId?: string } = {},
): RuntimeAdmissionRequest {
  const runId = options.runId ?? "run-complete";
  return {
    step: {
      runId,
      stepId,
      ...(options.parentRunId !== undefined
        ? { parentRunId: options.parentRunId }
        : {}),
    },
    kind: "model_turn",
    estimate: {
      maxInputTokens: 20,
      maxOutputTokens: 30,
      maxCostUsd: 0.01,
    },
    model: "test-model",
    provider: "test-provider:https://example.test",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    parentScopeId: "session-a",
    autonomous: false,
    budgetScopes: [
      { key: `run:${runId}`, maxTokens: 1_000, maxCostUsd: 1 },
    ],
  };
}

function seedDurableRuns(): readonly number[] {
  const admissions = new ExecutionAdmissionRepository(driver, {
    now: () => new Date(NOW),
    id: (() => {
      let id = 0;
      return () => `inspection-${++id}`;
    })(),
    ownerId: "daemon-test",
    ownerPid: 42,
  });
  for (const stepId of ["turn-1", "turn-2"]) {
    const request = admissionRequest(stepId);
    admissions.enqueue(request);
    const claimed = admissions.claim({ key: admissionRecordKey(request.step) });
    if (claimed.kind !== "claimed") throw new Error("expected admission claim");
    admissions.markDispatched(claimed.lease.reservation.reservationId, {
      providerRequestId: `provider-${stepId}`,
      details: { boundary: "test_model" },
    });
    admissions.reconcile(claimed.lease.reservation.reservationId, {
      kind: "reported",
      usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.002 },
    });
  }
  admissions.recordFallback(
    admissionRecordKey(admissionRequest("turn-2").step),
    {
      reason: "primary_rate_limited",
      model: "fallback-model",
      provider: "fallback-provider:https://example.test",
    },
  );
  upsertAgentRun(driver, {
    id: "run-complete",
    objective: "finish the proof slice",
    status: "completed",
    startedAt: NOW,
    lastActiveAt: "2026-07-18T12:05:00.000Z",
    currentSessionId: "session-a",
    metadata: { terminalReason: "completed" },
  });
  upsertAgentRun(driver, {
    id: "run-live",
    objective: "still running",
    status: "running",
    startedAt: NOW,
    lastActiveAt: NOW,
  });
  return admissions
    .listJournal({ runId: "run-complete" })
    .map((event) => event.sequence);
}

function request(id: string, method: string, params?: JsonObject): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

describe("durable run inspection", () => {
  it("summarizes durable run, reservation, allocation, and fallback state", () => {
    seedDurableRuns();

    expect(service.status({ runId: "run-complete" })).toMatchObject({
      runId: "run-complete",
      status: "completed",
      terminal: true,
      statusSource: "agent_run",
      durableRun: {
        objective: "finish the proof slice",
        currentSessionId: "session-a",
      },
      admission: {
        present: true,
        currentStatus: "reconciled",
        active: false,
        stepCount: 2,
        stepStatusCounts: { reconciled: 2 },
        reservationCount: 2,
        openReservationCount: 0,
        reservedTokens: 100,
        reservedCostUsd: 0.02,
        actualTokens: 40,
        actualCostUsd: 0.004,
        allocationCount: 1,
        usedTokens: 40,
        heldTokens: 0,
        fallbackCount: 1,
      },
      source: { readonly: true },
    });
  });

  it("aggregates descendant admission state and evidence under the root run id", () => {
    const admissions = new ExecutionAdmissionRepository(driver, {
      now: () => new Date(NOW),
      id: (() => {
        let id = 0;
        return () => `tree-${++id}`;
      })(),
      ownerId: "daemon-test",
      ownerPid: 42,
    });
    const root = admissionRequest("root-turn", { runId: "root-run" });
    admissions.enqueue(root);
    const rootClaim = admissions.claim({ key: admissionRecordKey(root.step) });
    if (rootClaim.kind !== "claimed") throw new Error("expected root claim");
    admissions.markDispatched(rootClaim.lease.reservation.reservationId);
    admissions.reconcile(rootClaim.lease.reservation.reservationId, {
      kind: "reported",
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.001 },
    });
    const child = admissionRequest("child-turn", {
      runId: "child-run",
      parentRunId: "root-run",
    });
    admissions.enqueue(child);
    const childClaim = admissions.claim({ key: admissionRecordKey(child.step) });
    if (childClaim.kind !== "claimed") throw new Error("expected child claim");
    admissions.markDispatched(childClaim.lease.reservation.reservationId);
    upsertAgentRun(driver, {
      id: "root-run",
      objective: "root with active child",
      status: "running",
      startedAt: NOW,
      lastActiveAt: NOW,
    });

    const status = service.status({ runId: "root-run" });
    expect(status.admission).toMatchObject({
      active: true,
      stepCount: 2,
      stepStatusCounts: { reconciled: 1, running: 1 },
      reservationCount: 2,
      openReservationCount: 1,
    });
    const replay = service.replay({ runId: "root-run", limit: 200 });
    expect(new Set(replay.events.map((event) => event.runId))).toEqual(
      new Set(["root-run", "child-run"]),
    );
    const evidence = service.evidence({ runId: "root-run", limit: 200 });
    expect(evidence.events.some((event) => event.runId === "child-run")).toBe(
      true,
    );

    upsertAgentRun(driver, {
      id: "root-run",
      objective: "root row ended before its child",
      status: "completed",
      startedAt: NOW,
      lastActiveAt: NOW,
    });
    expect(service.status({ runId: "root-run" })).toMatchObject({
      status: "completed",
      terminal: false,
      admission: { active: true },
    });
    expect(() => service.result({ runId: "root-run" })).toThrowError(
      expect.objectContaining({ code: "RUN_NOT_TERMINAL" }),
    );
  });

  it("reports one charge across hierarchical scopes and excludes unrelated runs", () => {
    const admissions = new ExecutionAdmissionRepository(driver, {
      now: () => new Date(NOW),
      ownerId: "usage-test",
      ownerPid: 42,
    });
    const settle = (
      runId: string,
      stepId: string,
      inputTokens: number,
      outputTokens: number,
      costUsd: number,
    ): void => {
      const request: RuntimeAdmissionRequest = {
        ...admissionRequest(stepId, { runId }),
        budgetScopes: [
          { key: "period:day", maxTokens: 10_000, maxCostUsd: 10 },
          {
            key: "workspace:shared",
            parentKey: "period:day",
            maxTokens: 5_000,
            maxCostUsd: 5,
          },
          {
            key: `run:${runId}`,
            parentKey: "workspace:shared",
            maxTokens: 1_000,
            maxCostUsd: 1,
          },
        ],
      };
      admissions.enqueue(request);
      const claimed = admissions.claim({
        key: admissionRecordKey(request.step),
      });
      if (claimed.kind !== "claimed") throw new Error("expected claim");
      admissions.markDispatched(claimed.lease.reservation.reservationId);
      admissions.reconcile(claimed.lease.reservation.reservationId, {
        kind: "reported",
        usage: { inputTokens, outputTokens, costUsd },
      });
    };
    settle("usage-root", "root-turn", 10, 5, 0.002);
    settle("unrelated-run", "other-turn", 6, 2, 0.001);
    upsertAgentRun(driver, {
      id: "usage-root",
      objective: "inspect exact usage",
      status: "completed",
      startedAt: NOW,
      lastActiveAt: NOW,
    });

    expect(service.status({ runId: "usage-root" }).admission).toMatchObject({
      reservationCount: 1,
      actualTokens: 15,
      usedTokens: 15,
      usedCostUsd: 0.002,
      heldTokens: 0,
      heldCostUsd: 0,
      allocationCount: 1,
    });
  });

  it("bounds run-tree inspection before constructing unbounded status queries", () => {
    const admissions = new ExecutionAdmissionRepository(driver, {
      now: () => new Date(NOW),
      ownerId: "tree-bound-test",
      ownerPid: 42,
    });
    upsertAgentRun(driver, {
      id: "wide-root",
      objective: "wide tree",
      status: "running",
      startedAt: NOW,
      lastActiveAt: NOW,
    });
    for (let index = 0; index < 1_001; index += 1) {
      admissions.enqueue(
        admissionRequest(`turn-${index}`, {
          runId: `wide-child-${index}`,
          parentRunId: "wide-root",
        }),
      );
    }

    expect(() => service.status({ runId: "wide-root" })).toThrowError(
      expect.objectContaining<AgenCDaemonRunInspectionError>({
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("searches every discovered project DB and refuses ambiguous run ids", () => {
    const secondCwd = mkdtempSync(join(tmpdir(), "agenc-run-inspection-cwd-"));
    mkdirSync(join(secondCwd, ".git"));
    const secondDriver = openStateDatabases({
      cwd: secondCwd,
      agencHome: home,
    });
    const secondPaths = {
      projectDir: secondDriver.projectDir,
      stateDbPath: secondDriver.stateDbPath,
      logsDbPath: secondDriver.logsDbPath,
    };
    try {
      upsertAgentRun(secondDriver, {
        id: "cross-project-run",
        objective: "found outside primary cwd",
        status: "completed",
        startedAt: NOW,
        lastActiveAt: NOW,
      });
      const discovered = new AgenCDaemonRunInspectionService({
        stateDatabasePaths: () => [paths, secondPaths],
      });
      expect(discovered.status({ runId: "cross-project-run" })).toMatchObject({
        terminal: true,
        durableRun: { objective: "found outside primary cwd" },
        source: { projectDir: secondDriver.projectDir },
      });

      upsertAgentRun(driver, {
        id: "cross-project-run",
        objective: "colliding primary run",
        status: "running",
        startedAt: NOW,
        lastActiveAt: NOW,
      });
      expect(() =>
        discovered.status({ runId: "cross-project-run" }),
      ).toThrowError(
        expect.objectContaining<AgenCDaemonRunInspectionError>({
          code: "RUN_ID_AMBIGUOUS",
        }),
      );
    } finally {
      secondDriver.close();
      rmSync(secondCwd, { recursive: true, force: true });
    }
  });

  it("replays bounded cursor pages without overlaps or silent omissions", () => {
    const expectedSequences = seedDurableRuns();
    const observed: number[] = [];
    let afterSequence = 0;
    let pages = 0;
    do {
      const page = service.replay({
        runId: "run-complete",
        afterSequence,
        limit: 2,
      });
      pages += 1;
      expect(page.afterSequence).toBe(afterSequence);
      expect(page.events.length).toBeLessThanOrEqual(2);
      expect(page.gap).toBeNull();
      observed.push(...page.events.map((event) => event.sequence));
      expect(page.nextAfterSequence).toBeGreaterThanOrEqual(afterSequence);
      afterSequence = page.nextAfterSequence;
      if (!page.hasMore) break;
    } while (pages < 20);

    expect(pages).toBeGreaterThan(1);
    expect(observed).toEqual(expectedSequences);
    expect(new Set(observed).size).toBe(observed.length);
  });

  it("returns only durable terminal results and labels absent output honestly", () => {
    seedDurableRuns();

    expect(service.result({ runId: "run-complete" })).toMatchObject({
      runId: "run-complete",
      terminal: true,
      outcome: "completed",
      output: {
        available: false,
        reason: "terminal_output_not_persisted_in_existing_state",
      },
    });
    expect(() => service.result({ runId: "run-live" })).toThrowError(
      expect.objectContaining<AgenCDaemonRunInspectionError>({
        code: "RUN_NOT_TERMINAL",
      }),
    );
  });

  it("exports bounded hashes and explicitly excludes workflow evidence", () => {
    seedDurableRuns();

    const partial = service.evidence({ runId: "run-complete", limit: 1 });
    expect(partial).toMatchObject({
      runId: "run-complete",
      hasMore: true,
      source: {
        kind: "existing_m3_admission_state",
        workflowEvidenceIncluded: false,
        completeness: "partial",
      },
      cursor: { afterSequence: 0, limit: 1 },
      hashes: { algorithm: "sha256" },
    });
    expect(partial.events).toHaveLength(1);
    expect(partial.hashes.eventHashes).toHaveLength(1);
    for (const digest of [
      partial.hashes.runStateSha256,
      partial.hashes.admissionSummarySha256,
      partial.hashes.bundleSha256,
      partial.hashes.eventHashes[0]?.sha256,
    ]) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }

    const complete = service.evidence({
      runId: "run-complete",
      limit: 200,
    });
    expect(complete.hasMore).toBe(false);
    expect(complete.source.completeness).toBe("complete");
  });

  it("advertises, validates, and maps typed dispatcher errors", async () => {
    seedDurableRuns();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      runInspection: service,
    });
    const connection = dispatcher.createConnection({
      sendNotification: () => {},
    });
    const initialized = await connection.dispatch(
      request("init", "initialize", { protocol: { version: "1.0.0" } }),
    );
    const capabilities = (
      initialized.result as {
        capabilities: Record<string, Record<string, boolean>>;
      }
    ).capabilities[AGENC_DAEMON_METHOD_CAPABILITIES_KEY];
    for (const method of [
      "run.status",
      "run.result",
      "run.replay",
      "run.evidence",
    ]) {
      expect(capabilities[method]).toBe(true);
    }

    await expect(
      connection.dispatch(
        request("status", "run.status", { runId: "run-complete" }),
      ),
    ).resolves.toMatchObject({ result: { terminal: true } });
    await expect(
      connection.dispatch(request("live", "run.result", { runId: "run-live" })),
    ).resolves.toMatchObject({
      error: { data: { code: "RUN_NOT_TERMINAL" } },
    });
    await expect(
      connection.dispatch(
        request("missing", "run.status", { runId: "missing" }),
      ),
    ).resolves.toMatchObject({ error: { data: { code: "RUN_NOT_FOUND" } } });
    await expect(
      connection.dispatch(
        request("invalid", "run.replay", {
          runId: "run-complete",
          afterSequence: -1,
          limit: 201,
        }),
      ),
    ).resolves.toMatchObject({ error: { data: { code: "INVALID_ARGUMENT" } } });
    await dispatcher.closeConnection(connection);
  });

  it("serves the typed SDK helpers over the real in-process transport", async () => {
    seedDurableRuns();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      runInspection: service,
    });
    const transport = new AgenCInProcessDaemonTransport({ dispatcher });
    const client = createAgencClient({
      transport: transport as unknown as AgencTransport,
    });
    await client.initialize();

    await expect(client.runStatus("run-complete")).resolves.toMatchObject({
      terminal: true,
      admission: { reservationCount: 2 },
    });
    await expect(
      client.replayRun({ runId: "run-complete", limit: 1 }),
    ).resolves.toMatchObject({ hasMore: true, events: [{ sequence: 1 }] });
    await expect(client.runResult("run-live")).rejects.toMatchObject({
      name: "AgencRpcError",
      data: { code: "RUN_NOT_TERMINAL" },
      method: "run.result",
    });

    await client.close();
    await transport.close();
  });
});
