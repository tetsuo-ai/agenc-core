/**
 * RUN_ID_AMBIGUOUS names the right reason, and a reason that cannot be
 * worked out never replaces the refusal. Findings of the independent reviews
 * of this change: a run with rows in a second database and no admission
 * records was named `admission_owner_unproved`; with two admission candidates
 * it must stay so; and a read of the bindings that cannot be done (the one
 * that tells two chats with one id from a split) threw a raw SQLite error
 * instead of RUN_ID_AMBIGUOUS.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/state/split-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/split-run.js")>();
  return {
    ...actual,
    countRunJournalHomes: vi.fn(actual.countRunJournalHomes),
  };
});

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { discoverStateDatabasePaths } from "../../src/state/database-paths.js";
import { countRunJournalHomes } from "../../src/state/split-run.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { VERSION } from "../../src/version.js";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";

const RUN_ID = "conv-reason";
let root = "";
let home = "";

beforeEach(async () => {
  root = mkdtempSync(join(canonicalTmpdir(), "agenc-reason-fallback-"));
  home = join(root, "agenc-home");
  const actual = await vi.importActual<typeof import("../../src/state/split-run.js")>("../../src/state/split-run.js");
  vi.mocked(countRunJournalHomes).mockReset().mockImplementation(actual.countRunJournalHomes);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function projectDir(name: string): string {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return cwd;
}

/** A chat journal of RUN_ID in its own project at `name`. */
function chatIn(name: string): string {
  const cwd = projectDir(name);
  const store = new RolloutStore({ cwd, sessionId: RUN_ID, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  store.open({ sessionId: RUN_ID, timestamp: new Date().toISOString(), cwd, originator: "agenc-cli",
    source: "interactive-root", agencVersion: VERSION, model: "base-model", modelProvider: "grok" });
  store.close();
  return cwd;
}

/** One admitted model call of RUN_ID, recorded in the database of the project at `cwd`. */
async function admissionIn(cwd: string): Promise<void> {
  const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "reason-fallback-test", ownerPid: process.pid });
  try {
    const client = kernel.bindClient({ cwd, scope: { runId: RUN_ID, sessionId: RUN_ID, autonomous: false }, budget: { runMaxCostUsd: 1 } });
    const lease = await client.acquire({ stepId: "model:1", kind: "model_turn", maxInputTokens: 10, maxOutputTokens: 5, maxCostUsd: 0.1 });
    client.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    client.reconcile(lease.reservation.reservationId, { inputTokens: 4, outputTokens: 1, costUsd: 0.01 });
  } finally {
    kernel.close();
  }
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

describe("the reason of RUN_ID_AMBIGUOUS", () => {
  it("names a project split when another database holds only the run's daemon row", () => {
    chatIn("first");
    // Another project's database holds a run row of the same id, and no admission or journal.
    const driver = openStateDatabases({ cwd: projectDir("other"), agencHome: home });
    try {
      const now = new Date().toISOString();
      upsertAgentRun(driver, { id: RUN_ID, objective: "Interactive session", status: "suspended", startedAt: now, lastActiveAt: now });
    } finally {
      driver.close();
    }
    expect(() => inspection().status({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "project_split" }));
  });

  it("names an unproved admission owner when two databases hold admission records and none is declared", async () => {
    const first = chatIn("first");
    await admissionIn(first);
    await admissionIn(projectDir("other"));
    expect(() => inspection().status({ runId: RUN_ID }))
      .toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "admission_owner_unproved" }));
  });

  it("still refuses with RUN_ID_AMBIGUOUS, and no reason, when the reason cannot be read", () => {
    chatIn("first");
    chatIn("second");
    expect(() => inspection().replay({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "duplicate_run_id" }));
    vi.mocked(countRunJournalHomes).mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    let refusal: unknown;
    try {
      inspection().replay({ runId: RUN_ID });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "RUN_ID_AMBIGUOUS", message: `run id ${RUN_ID} has conflicting or unproved journal/admission owners` });
    expect((refusal as { reason?: unknown }).reason).toBeUndefined();
  });
});
