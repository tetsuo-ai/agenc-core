/**
 * RUN_ID_AMBIGUOUS names the right reason, and a reason that cannot be
 * worked out never replaces the refusal. Findings of the independent review
 * of this change: a run with rows in a second database and no single
 * admission owner was named `admission_owner_unproved`, and the read that
 * tells two chats with one id from a split could throw a raw SQLite error.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/state/split-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/split-run.js")>();
  return { ...actual, countRunJournalHomes: vi.fn(actual.countRunJournalHomes) };
});

import { AgenCDaemonRunInspectionService } from "../../src/app-server/run-inspection.js";
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

/** A chat journal of RUN_ID in its own project at `name`. */
function chatIn(name: string): string {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const store = new RolloutStore({ cwd, sessionId: RUN_ID, agencVersion: VERSION, agencHome: home,
    sessionTempRoot: join(root, "session-tmp"), autoStartScheduler: false });
  store.open({ sessionId: RUN_ID, timestamp: new Date().toISOString(), cwd, originator: "agenc-cli",
    source: "interactive-root", agencVersion: VERSION, model: "base-model", modelProvider: "grok" });
  store.close();
  return cwd;
}

function inspection(): AgenCDaemonRunInspectionService {
  return new AgenCDaemonRunInspectionService({ agencHome: home, stateDatabasePaths: () => discoverStateDatabasePaths(home) });
}

describe("the reason of RUN_ID_AMBIGUOUS", () => {
  it("names a project split when another database holds only the run's daemon row", () => {
    chatIn("first");
    // Another project's database holds a run row of the same id, and no admission or journal.
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    const driver = openStateDatabases({ cwd: other, agencHome: home });
    try {
      const now = new Date().toISOString();
      upsertAgentRun(driver, { id: RUN_ID, objective: "Interactive session", status: "suspended", startedAt: now, lastActiveAt: now });
    } finally {
      driver.close();
    }
    expect(() => inspection().status({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "project_split" }));
  });

  it("still refuses with RUN_ID_AMBIGUOUS when the reason cannot be read", () => {
    chatIn("first");
    chatIn("second");
    expect(() => inspection().replay({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "duplicate_run_id" }));
    vi.mocked(countRunJournalHomes).mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(() => inspection().replay({ runId: RUN_ID })).toThrow(expect.objectContaining({ code: "RUN_ID_AMBIGUOUS", reason: "project_split" }));
  });
});
