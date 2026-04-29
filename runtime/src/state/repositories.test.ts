import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentJobRepository } from "./agent-jobs.js";
import { LogsRepository } from "./logs.js";
import { MemoryJobRepository } from "./memories.js";
import { RemoteControlStorage } from "./remote-control.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-state-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
});

afterEach(() => {
  driver.close();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("state repositories", () => {
  it("stores project-scoped remote-control values", () => {
    const storage = new RemoteControlStorage(driver, "project-a");
    storage.set("ui", "mode", { value: "watch" });
    expect(storage.get("ui", "mode")).toEqual({ value: "watch" });
    storage.delete("ui", "mode");
    expect(storage.get("ui", "mode")).toBeUndefined();
  });

  it("mirrors logs without throwing through tryAppend", () => {
    const logs = new LogsRepository(driver);
    expect(
      logs.tryAppend({
        timestamp: new Date().toISOString(),
        level: "warning",
        message: "indexed",
        payload: { ok: true },
      }),
    ).toBe(true);
  });

  it("upserts memory and agent jobs", () => {
    new MemoryJobRepository(driver).upsert({
      id: "memory-1",
      kind: "extract",
      status: "queued",
      input: { threadId: "t1" },
    });
    const agents = new AgentJobRepository(driver);
    agents.upsertJob({
      id: "agent-1",
      kind: "spawn",
      status: "running",
      input: { role: "worker" },
    });
    agents.upsertItem({
      id: "agent-item-1",
      jobId: "agent-1",
      ordinal: 0,
      kind: "message",
      status: "queued",
      input: { text: "hello" },
    });
    expect(
      driver
        .prepareState<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM memory_jobs",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      driver
        .prepareState<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM agent_job_items",
        )
        .get()?.count,
    ).toBe(1);
  });
});
