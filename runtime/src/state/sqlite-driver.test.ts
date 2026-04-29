import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStateDatabases } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-state-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("openStateDatabases", () => {
  it("creates project-scoped state and logs databases with migrations", () => {
    const driver = openStateDatabases({ cwd });
    try {
      expect(driver.stateDbPath).toContain("agenc-state_1.sqlite");
      expect(driver.logsDbPath).toContain("agenc-logs_1.sqlite");
      expect(
        driver
          .prepareState<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
          )
          .get()?.name,
      ).toBe("threads");
      expect(
        driver
          .prepareLogs<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'",
          )
          .get()?.name,
      ).toBe("logs");
    } finally {
      driver.close();
    }
  });
});
