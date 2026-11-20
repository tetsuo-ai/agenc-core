/**
 * RUN_ID_AMBIGUOUS says why.
 *
 * run.status, run.replay, run.result and run.evidence refuse a run id they
 * cannot read safely with one code, RUN_ID_AMBIGUOUS, for several different
 * reasons, so a client could only name one of them (Desktop named an earlier
 * restart's split for all). The error now carries a machine-readable reason
 * in its data. The split, duplicate and unproved-owner cases are asserted
 * where their fixtures live (run-inspection.split-reason, .split-authority,
 * .compaction-admission and .contract tests); this file holds the record
 * limit and the wire shape.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { JSON_RPC_VERSION, type JsonObject } from "../../src/app-server/protocol/index.js";
import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

let root = "";
let home = "";
let workspace = "";

beforeEach(() => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-ambiguous-reason-"));
  home = join(root, "agenc-home");
  workspace = join(root, "project");
  mkdirSync(join(workspace, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

/** A chat whose rollout holds `count` admission events of its own run, none of them journaled. */
function chatWithAdmissionEvents(runId: string, count: number, foreignAt?: number): void {
  const store = new RolloutStore({ cwd: workspace, sessionId: runId, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  store.open({ sessionId: runId, timestamp: new Date().toISOString(), cwd: workspace, originator: "agenc-cli",
    source: "interactive-root", agencVersion: VERSION, model: "base-model", modelProvider: "grok" });
  try {
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const eventId = `admission-${sequence}`;
      store.append({ id: eventId, eventId, seq: sequence, msg: { type: "execution_admission", payload: {
        sequence, eventId, timestamp: "2026-11-19T00:00:00.000Z", runId: sequence === foreignAt ? "conv-another" : runId,
        stepId: `model:${sequence}`, kind: "model_turn", event: "queued",
      } } }, { durable: sequence === count });
    }
  } finally {
    store.close();
  }
}

function request(id: string, method: string, params: JsonObject): JsonObject {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

describe("RUN_ID_AMBIGUOUS says why", () => {
  it("names the record limit when a rollout holds more admission records than one read checks", () => {
    // The session header and 100,000 admission events: one record over the limit.
    chatWithAdmissionEvents("conv-long", 100_000);
    expect(() => inspection().status({ runId: "conv-long" })).toThrow(expect.objectContaining({
      code: "RUN_ID_AMBIGUOUS",
      reason: "admission_record_limit",
      message: "run id conv-long has conflicting or unproved journal/admission owners: its rollout holds more than 100000 admission records",
    }));
  }, 120_000);

  it("sends the reason in the error data, and none with other codes", async () => {
    chatWithAdmissionEvents("conv-foreign", 3, 2);
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: new AgenCDaemonAgentManager(), runInspection: inspection() });
    const connection = dispatcher.createConnection({ sendNotification: () => {} });
    await connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id: "init", method: "initialize", params: { protocol: { version: "1.0.0" } } });
    for (const method of ["run.status", "run.replay", "run.result", "run.evidence"]) {
      const answer = await connection.dispatch(request(method, method, { runId: "conv-foreign" }));
      expect(answer).toMatchObject({ error: { code: -32602,
        message: "run id conv-foreign has conflicting or unproved journal/admission owners: an admission owner or admission record of its journal is not proven" } });
      expect((answer as { error: { data: unknown } }).error.data).toEqual({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" });
    }
    const missing = await connection.dispatch(request("missing", "run.status", { runId: "conv-missing" }));
    expect((missing as { error: { data: unknown } }).error.data).toEqual({ code: "RUN_NOT_FOUND" });
  });
});
