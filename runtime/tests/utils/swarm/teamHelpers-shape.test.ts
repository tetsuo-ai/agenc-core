import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getTeamDir, readTeamFile } from "../../../src/utils/swarm/teamHelpers.js";

// teamHelpers minor (core-todo.md): readTeamFile returned jsonParse(content) as TeamFile
// with no shape validation, so a config.json that parses but lacks a `members` array
// made downstream .members.filter/.findIndex throw — during SIGINT/SIGTERM cleanup that
// skips worktree/dir cleanup. The fix validates the shape and returns null instead.

let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.AGENC_HOME;
  home = mkdtempSync(join(tmpdir(), "agenc-teamhelpers-"));
  process.env.AGENC_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(teamName: string, json: string): void {
  const dir = getTeamDir(teamName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), json, "utf-8");
}

describe("readTeamFile shape validation", () => {
  it("returns null for valid JSON that lacks a members array", () => {
    writeConfig("teamx", JSON.stringify({ name: "teamx" })); // no members
    expect(readTeamFile("teamx")).toBeNull();
  });

  it("returns null when members is not an array", () => {
    writeConfig("teamy", JSON.stringify({ members: "oops" }));
    expect(readTeamFile("teamy")).toBeNull();
  });

  it("returns the config when members is a valid array", () => {
    writeConfig("teamz", JSON.stringify({ teamName: "teamz", members: [] }));
    const result = readTeamFile("teamz");
    expect(result).not.toBeNull();
    expect(Array.isArray(result?.members)).toBe(true);
  });
});
