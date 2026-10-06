import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../../src/state/database-paths.js";
import * as driver from "../../src/state/sqlite-driver.js";
import { measureAgenCDaemonStateDatabases } from "../../src/app-server/daemon-control.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agenc-discovery-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
function state(name: string): string {
  const project = join(home, "projects", name);
  mkdirSync(project, { recursive: true });
  const file = join(project, paths.STATE_DATABASE_FILENAME);
  writeFileSync(file, "not a SQLite database: discovery must not open it");
  return file;
}

describe("database discovery facade and native filesystem", () => {
  it("reexports the same function and filename bindings", () => {
    expect(driver.discoverStateDatabasePaths).toBe(paths.discoverStateDatabasePaths);
    expect(driver.STATE_DATABASE_FILENAME).toBe(paths.STATE_DATABASE_FILENAME);
    expect(driver.LOGS_DATABASE_FILENAME).toBe(paths.LOGS_DATABASE_FILENAME);
  });

  it("does not create an absent projects directory or SQLite files", () => {
    expect(paths.discoverStateDatabasePaths(home)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("preserves existing discovery semantics for native directories and symlinks", () => {
    const actual = state("actual");
    const root = join(home, "projects");
    for (const name of ["linked-db", "broken-db", "logs-only", "directory-db"]) mkdirSync(join(root, name));
    symlinkSync(join(root, "actual"), join(root, "linked-project"), "dir");
    symlinkSync(actual, join(root, "linked-db", paths.STATE_DATABASE_FILENAME), "file");
    symlinkSync(join(home, "absent"), join(root, "broken-db", paths.STATE_DATABASE_FILENAME), "file");
    writeFileSync(join(root, "logs-only", paths.LOGS_DATABASE_FILENAME), "logs");
    mkdirSync(join(root, "directory-db", paths.STATE_DATABASE_FILENAME));
    writeFileSync(join(root, "ordinary-file"), "file");
    const order = readdirSync(root).filter(name => ["actual", "linked-db", "directory-db"].includes(name));
    const discovered = paths.discoverStateDatabasePaths(home);
    expect(discovered.map(p => basename(p.projectDir))).toEqual(order);
    expect(discovered.every(p => p.logsDbPath === join(p.projectDir, "agenc-logs_1.sqlite"))).toBe(true);
    expect(existsSync(join(root, "actual", paths.LOGS_DATABASE_FILENAME))).toBe(false);
    expect(readdirSync(join(root, "actual"))).toEqual([paths.STATE_DATABASE_FILENAME]);
  });

  it("preserves zero exclusion, state plus WAL accounting, call order and first largest tie", () => {
    for (const name of ["zeta", "alpha", "zero"]) state(name);
    const discovered = paths.discoverStateDatabasePaths(home);
    const sizeOf = vi.fn((path: string) => path.includes(`${join("projects", "zero")}`) ? 0 : path.endsWith("-wal") ? 3 : 7);
    expect(measureAgenCDaemonStateDatabases(home, sizeOf)).toEqual({
      projects: 2, totalBytes: 20, largestBytes: 10,
      largestProject: basename(discovered.find(p => basename(p.projectDir) !== "zero")!.projectDir),
    });
    expect(sizeOf.mock.calls).toEqual(discovered.flatMap(p => [[p.stateDbPath], [p.stateDbPath+"-wal"]]));
  });

  it("propagates the exact footprint error without changing it", () => {
    state("one");
    const error = Object.assign(new Error("stat refused"), { code: "EACCES" });
    let caught: unknown;
    try { measureAgenCDaemonStateDatabases(home, () => { throw error; }); }
    catch (value) { caught = value; }
    expect(caught).toBe(error);
  });
});
