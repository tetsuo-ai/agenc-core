import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateAgentRunStatus, upsertAgentRun } from "./agent-runs.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-agent-runs-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-agent-runs-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  driver.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("agent run metadata", () => {
  it("drops array-shaped stored metadata before applying a status metadata patch", () => {
    upsertAgentRun(driver, {
      id: "run-array-metadata",
      objective: "merge metadata",
      status: "running",
      startedAt: "2026-05-01T00:00:00.000Z",
      lastActiveAt: "2026-05-01T00:00:00.000Z",
      currentSessionId: "session-1",
      metadata: { preserved: true },
    });
    driver
      .prepareState<[string, string]>(
        "UPDATE agent_runs SET metadata_json = ? WHERE id = ?",
      )
      .run(JSON.stringify(["spoof"]), "run-array-metadata");

    updateAgentRunStatus(driver, {
      id: "run-array-metadata",
      status: "completed",
      lastActiveAt: "2026-05-01T00:01:00.000Z",
      metadataPatch: { patchApplied: true },
    });

    expect(readMetadata("run-array-metadata")).toEqual({
      patchApplied: true,
    });
  });
});

function readMetadata(agentId: string): unknown {
  const row = driver
    .prepareState<[string], { metadata_json: string | null }>(
      "SELECT metadata_json FROM agent_runs WHERE id = ?",
    )
    .get(agentId);
  if (row === undefined) throw new Error(`missing agent run ${agentId}`);
  return row.metadata_json === null ? null : JSON.parse(row.metadata_json);
}
