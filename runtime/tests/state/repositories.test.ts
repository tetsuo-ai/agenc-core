import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogsRepository } from "./logs.js";
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
});
