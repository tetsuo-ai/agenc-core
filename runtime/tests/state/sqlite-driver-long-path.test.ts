import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  openStateDatabasePaths,
  openStateDatabasePathReader,
  type StateDatabasePaths,
} from "../../src/state/sqlite-driver.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("writes and reopens state and logs beyond MAX_PATH (deferLogs=%s)", (deferLogs) => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-long-path-"));
  roots.push(root);
  const projectDir = join(root, "project".repeat(15), "nested".repeat(20));
  const paths: StateDatabasePaths = {
    projectDir,
    stateDbPath: join(projectDir, "state.sqlite"),
    logsDbPath: join(projectDir, "logs.sqlite"),
  };
  expect(paths.stateDbPath.length).toBeGreaterThan(260);
  const writer = openStateDatabasePaths(paths, undefined, { deferLogs });
  try {
    expect(writer.stateDbPath).toBe(paths.stateDbPath);
    expect(writer.logsDbPath).toBe(paths.logsDbPath);
    for (const db of [writer.state, writer.logs]) {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      db.exec("CREATE TABLE long_path_probe (value TEXT NOT NULL)");
      db.prepare("INSERT INTO long_path_probe VALUES (?)").run("durable");
    }
  } finally {
    writer.close();
  }
  const reader = openStateDatabasePathReader(paths, { deferLogs });
  try {
    expect(reader.stateDbPath).toBe(paths.stateDbPath);
    for (const db of [reader.state, reader.logs]) {
      expect(db.prepare("SELECT value FROM long_path_probe").get()).toEqual({ value: "durable" });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(() => db.exec("DELETE FROM long_path_probe")).toThrow(/readonly/u);
    }
  } finally {
    reader.close();
  }
});
