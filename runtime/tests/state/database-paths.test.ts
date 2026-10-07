import type { Dirent } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ readdirSync: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:fs", () => fs);
import { discoverStateDatabasePaths, LOGS_DATABASE_FILENAME, STATE_DATABASE_FILENAME } from "../../src/state/database-paths.js";

const entry = (name: string, directory: boolean): Dirent => ({
  name, isDirectory: () => directory,
}) as Dirent;

beforeEach(() => { vi.resetAllMocks(); });

describe("synchronous project database discovery", () => {
  it("retains directory order and checks only state paths of directory entries", () => {
    fs.readdirSync.mockReturnValue([entry("zeta", true), entry("file", false),
      entry("missing", true), entry("alpha", true), entry("symlink-dir", false)]);
    fs.existsSync.mockImplementation((path: string) => !path.includes("missing"));
    const home = join("root", "home with spaces");
    const result = discoverStateDatabasePaths(home);
    expect(result).toEqual(["zeta", "alpha"].map(name => ({
      projectDir: join(home, "projects", name),
      stateDbPath: join(home, "projects", name, STATE_DATABASE_FILENAME),
      logsDbPath: join(home, "projects", name, LOGS_DATABASE_FILENAME),
    })));
    expect(fs.readdirSync).toHaveBeenCalledExactlyOnceWith(join(home, "projects"), { withFileTypes: true });
    expect(fs.existsSync.mock.calls).toEqual(["zeta", "missing", "alpha"].map(name =>
      [join(home, "projects", name, "agenc-state_1.sqlite")]));
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns an empty array only for a missing projects directory", () => {
    fs.readdirSync.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    expect(discoverStateDatabasePaths("home")).toEqual([]);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "ENOTDIR", "EIO"])("preserves the exact %s error object", code => {
    const error = Object.assign(new Error("directory read refused"), { code });
    fs.readdirSync.mockImplementation(() => { throw error; });
    let caught: unknown;
    try { discoverStateDatabasePaths("home"); } catch (value) { caught = value; }
    expect(caught).toBe(error);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });
});
