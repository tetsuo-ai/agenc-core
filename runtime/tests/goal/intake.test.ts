import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GOAL_INTEGRITY_CONSTRAINT } from "../../src/goal/goal.js";
import {
  buildSessionGoal,
  detectVerificationCommands,
  parseGoalCommand,
  tokenizeGoalArgs,
} from "../../src/goal/intake.js";

describe("parseGoalCommand", () => {
  test("no argument is status; lifecycle words and clear aliases are recognized", () => {
    expect(parseGoalCommand("  ")).toEqual({ kind: "status" });
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("Resume")).toEqual({ kind: "resume" });
    for (const alias of ["clear", "stop", "off", "cancel", "reset", "none"]) {
      expect(parseGoalCommand(alias)).toEqual({ kind: "clear" });
    }
  });

  test("keeps a quoted verify command whole and splits label from script once", () => {
    expect(tokenizeGoalArgs(`fix it --verify "tests=npm test -- --grep 'a b'"`)).toEqual(["fix", "it", "--verify", "tests=npm test -- --grep 'a b'"]);
    const parsed = parseGoalCommand(`all auth tests pass --verify "tests=npm test" --verify=lint="npx eslint src" --max-rounds 7 --max-cost 2.5`);
    expect(parsed).toEqual({
      kind: "set",
      request: {
        objective: "all auth tests pass",
        verify: [{ label: "tests", script: "npm test" }, { label: "lint", script: "npx eslint src" }],
        noVerify: false, maxRounds: 7, maxCostUsd: 2.5,
      },
    });
  });

  test("an unlabeled verify command gets a label; `--` keeps flag-like words in the objective", () => {
    expect(parseGoalCommand(`ship --verify "make check"`)).toMatchObject({ request: { verify: [{ label: "check 1", script: "make check" }] } });
    expect(parseGoalCommand("-- document the --verify flag")).toMatchObject({ request: { objective: "document the --verify flag", verify: [] } });
  });

  test.each([
    ["--verify", "needs a value"],
    ["do it --max-rounds 0", "whole number"],
    ["do it --max-rounds 101", "whole number"],
    ["do it --max-cost -1", "positive number"],
    ["--no-verify", "needs an objective"],
    ["do it --no-verify --verify x=y", "contradict"],
  ])("rejects %j", (args, fragment) => {
    const parsed = parseGoalCommand(args);
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") expect(parsed.message).toContain(fragment);
  });
});

describe("detectVerificationCommands", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agenc-goal-intake-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("uses the package manager's test script, not build or dev scripts", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", dev: "vite", test: "vitest run" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectVerificationCommands(dir)).toEqual([{ label: "tests", script: "pnpm test" }]);
  });

  test("ignores npm's placeholder test script", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectVerificationCommands(dir)).toEqual([]);
  });

  test("detects cargo, go, pytest with a tests directory, and a Makefile test target as a fallback", () => {
    writeFileSync(join(dir, "Cargo.toml"), "");
    writeFileSync(join(dir, "go.mod"), "");
    writeFileSync(join(dir, "pyproject.toml"), "");
    mkdirSync(join(dir, "tests"));
    expect(detectVerificationCommands(dir).map((c) => c.script)).toEqual(["cargo test", "go test ./...", "python -m pytest"]);
    const other = mkdtempSync(join(tmpdir(), "agenc-goal-make-"));
    try {
      writeFileSync(join(other, "Makefile"), "build:\n\tcc x.c\ntest:\n\t./run-tests\n");
      expect(detectVerificationCommands(other)).toEqual([{ label: "tests", script: "make test" }]);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  test("a python project without tests proves nothing, so nothing is detected", () => {
    writeFileSync(join(dir, "requirements.txt"), "requests\n");
    expect(detectVerificationCommands(dir)).toEqual([]);
  });
});

describe("buildSessionGoal", () => {
  const base = { cwd: "/repo", id: "g1", now: "2026-09-19T00:00:00.000Z", sessionCostUsd: 0.5, baseCommit: "abc1234" };

  test("refuses a goal that nothing can check, and says how to fix it", () => {
    const built = buildSessionGoal({ ...base, request: { objective: "make it better", verify: [], noVerify: false }, detect: () => [] });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.message).toContain('--verify "tests=<your test command>"');
      expect(built.message).toContain("--no-verify");
    }
  });

  test("adopts detected checks, the integrity constraint, and the cost baseline", () => {
    const built = buildSessionGoal({ ...base, request: { objective: "tests pass", verify: [], noVerify: false }, detect: () => [{ label: "tests", script: "npm test" }] });
    expect(built).toMatchObject({
      ok: true, detected: true,
      goal: { status: "active", rounds: 0, startCostUsd: 0.5, baseCommit: "abc1234", verification: [{ script: "npm test" }], constraints: [GOAL_INTEGRITY_CONSTRAINT], budget: { maxRounds: 20 } },
    });
  });

  test("explicit checks win over detection; --no-verify yields a judge-only goal; rounds are capped", () => {
    const explicit = buildSessionGoal({ ...base, request: { objective: "x", verify: [{ label: "lint", script: "eslint ." }], noVerify: false, maxRounds: 500 }, detect: () => { throw new Error("must not detect"); } });
    expect(explicit).toMatchObject({ ok: true, detected: false, goal: { verification: [{ label: "lint" }], budget: { maxRounds: 100 } } });
    const judgeOnly = buildSessionGoal({ ...base, request: { objective: "x", verify: [], noVerify: true }, detect: () => { throw new Error("must not detect"); } });
    expect(judgeOnly).toMatchObject({ ok: true, goal: { verification: [] } });
  });
});
