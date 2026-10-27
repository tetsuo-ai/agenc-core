import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, unlinkSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { canonicalTmpdir } from "../helpers/canonical-temp-dir.js";
import { defaultGoalGateDeps } from "../../src/goal/runtime-deps.js";
import { captureGoalWorkingTreeBaseline } from "../../src/goal/worktree-baseline.js";
import { buildGoalJudgeUserMessage, type SessionGoal } from "../../src/goal/goal.js";
import { goalFromRolloutItems } from "../../src/goal/session-goal.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(canonicalTmpdir(), "goal-baseline-")); roots.push(root);
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/dirty.txt"), "original\n");
  writeFileSync(join(root, "tests/target.txt"), "before\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
  writeFileSync(join(root, "tests/dirty.txt"), "pre-existing dirty\n");
  writeFileSync(join(root, "session-approval.txt"), "READY\n");
  writeFileSync(join(root, "tests/cache.pyc"), "pre-existing cache\n");
  const entry = (path: string) => ({ path, identity: { kind: "file" as const, mode: statSync(join(root, path)).mode & 0o7777, sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex") } });
  const baseline = { version: 1 as const, trackedChanges: [entry("tests/dirty.txt")], untrackedFiles: [entry("session-approval.txt"), entry("tests/cache.pyc")] };
  return { root, commit: git("rev-parse", "HEAD").trim(), baseline };
}

test("goal review attributes only changes after the working-tree baseline", async () => {
  const { root, commit, baseline } = fixture();
  writeFileSync(join(root, "tests/target.txt"), "changed by goal\n");
  const changed = await defaultGoalGateDeps.changedPaths(root, commit, baseline);
  expect(changed).toEqual(["tests/target.txt"]);
});

test("changed and deleted pre-existing untracked files stay in the integrity check", async () => {
  const { root, commit, baseline } = fixture();
  writeFileSync(join(root, "session-approval.txt"), "modified during goal\n");
  unlinkSync(join(root, "tests/cache.pyc"));
  const changed = await defaultGoalGateDeps.changedPaths(root, commit, baseline);
  expect([...changed].sort()).toEqual(["session-approval.txt", "tests/cache.pyc"]);
});

test("capture retains deleted tracked files, link identities and newline paths; later restores and mode changes count", async () => {
  const { root, commit } = fixture();
  unlinkSync(join(root, "tests/target.txt"));
  writeFileSync(join(root, "tests/line\nbreak.txt"), "existing\n");
  symlinkSync("../../outside-the-repo", join(root, "tests/link"));
  const baseline = await captureGoalWorkingTreeBaseline(root, commit);
  expect(baseline?.trackedChanges).toContainEqual({ path: "tests/target.txt", identity: null });
  expect(baseline?.untrackedFiles.find((file) => file.path === "tests/link")?.identity?.kind).toBe("symlink");
  expect(await defaultGoalGateDeps.changedPaths(root, commit, baseline)).toEqual([]);
  writeFileSync(join(root, "tests/target.txt"), "before\n");
  chmodSync(join(root, "tests/dirty.txt"), 0o755);
  unlinkSync(join(root, "tests/link"));
  symlinkSync("../different-target", join(root, "tests/link"));
  writeFileSync(join(root, "tests/line\nbreak.txt"), "changed\n");
  expect(await defaultGoalGateDeps.changedPaths(root, commit, baseline)).toEqual([
    "tests/dirty.txt", "tests/line\nbreak.txt", "tests/link", "tests/target.txt",
  ]);
});

test("journal validates and restores the captured baseline; legacy goals retain conservative checking with a note", async () => {
  const { root, commit } = fixture();
  const worktreeBaseline = await captureGoalWorkingTreeBaseline(root, commit);
  const goal: SessionGoal = {
    id: "goal", objective: "verify workspace", verification: [], criteria: [], constraints: [],
    budget: { maxRounds: 1 }, status: "active", rounds: 0, stalledRounds: 0,
    startedAt: "2026-10-13T00:00:00Z", startCostUsd: 0, baseCommit: commit, worktreeBaseline,
  };
  const payload = JSON.parse(JSON.stringify({ goal, cause: "set" }));
  expect(isCanonicalEventPayload("goal_changed", payload)).toBe(true);
  const restored = goalFromRolloutItems([{ type: "event_msg", payload: { msg: { type: "goal_changed", payload } } }]);
  expect(restored?.worktreeBaseline).toEqual(worktreeBaseline);
  expect(await defaultGoalGateDeps.changedPaths(root, commit, restored?.worktreeBaseline)).toEqual([]);
  payload.goal.worktreeBaseline.untrackedFiles[0].identity.sha256 = "corrupt";
  expect(isCanonicalEventPayload("goal_changed", payload)).toBe(false);
  payload.goal.worktreeBaseline.untrackedFiles[0].identity.sha256 = "a".repeat(64);
  payload.goal.worktreeBaseline.untrackedFiles[0].path = "../outside";
  expect(isCanonicalEventPayload("goal_changed", payload)).toBe(false);
  const { worktreeBaseline: _baseline, ...legacy } = goal;
  expect(isCanonicalEventPayload("goal_changed", { goal: legacy, cause: "set" })).toBe(true);
  const conservative = await defaultGoalGateDeps.changedPaths(root, commit);
  expect([...conservative].sort()).toEqual(["session-approval.txt", "tests/cache.pyc", "tests/dirty.txt"]);
  expect(buildGoalJudgeUserMessage({ goal: legacy, verification: [], tamperedPaths: conservative, diff: "", diffStat: "" })).toContain("which may predate the goal");
});

test("review diff excludes pre-existing edits and includes newly created untracked contents", async () => {
  const { root, commit } = fixture();
  const baseline = await captureGoalWorkingTreeBaseline(root, commit);
  writeFileSync(join(root, "goal-final.txt"), "VERIFIED\n");
  const result = await (defaultGoalGateDeps.diff as (...args: unknown[]) => Promise<{ diff: string; stat: string }>)(root, commit, baseline);
  expect(result.diff).toContain("+VERIFIED");
  expect(result.diff).toContain("goal-final.txt");
  expect(result.diff).not.toContain("tests/dirty.txt");
  expect(result.diff).not.toContain("pre-existing dirty");
  expect(result.stat).not.toContain("tests/dirty.txt");
});

test("durable baseline bytes survive recovery and compare later tracked, untracked and deleted contents exactly", async () => {
  const { root, commit } = fixture();
  const home = mkdtempSync(join(canonicalTmpdir(), "goal-content-home-")); roots.push(home);
  const baseline = await captureGoalWorkingTreeBaseline(root, commit, home);
  const recovered = JSON.parse(JSON.stringify(baseline));
  writeFileSync(join(root, "tests/dirty.txt"), "pre-existing dirty\nworker appended\n");
  writeFileSync(join(root, "tests/target.txt"), "new tracked content\n");
  writeFileSync(join(root, "session-approval.txt"), "READY AFTER\n");
  unlinkSync(join(root, "tests/cache.pyc"));
  const result = await defaultGoalGateDeps.diff(root, commit, recovered, home);
  expect(result.diff).toContain("+worker appended");
  expect(result.diff).not.toContain("-original");
  expect(result.diff).toContain("-READY");
  expect(result.diff).toContain("+READY AFTER");
  expect(result.diff).toContain("-pre-existing cache");
  expect(result.diff).toContain("-before");
  expect(result.diff).toContain("+new tracked content");
});

test("missing or corrupt retained bytes and old hash-only dirty baselines never become empty review evidence", async () => {
  const { root, commit, baseline: old } = fixture();
  const home = mkdtempSync(join(canonicalTmpdir(), "goal-content-integrity-")); roots.push(home);
  const baseline = await captureGoalWorkingTreeBaseline(root, commit, home);
  writeFileSync(join(root, "tests/dirty.txt"), "goal changed existing dirty file\n");
  await expect(defaultGoalGateDeps.diff(root, commit, old, home)).rejects.toThrow("older goal did not retain starting contents");
  const sha = baseline!.trackedChanges[0]!.identity!.sha256;
  const stored = join(home, `.goal-baseline-${sha}.blob`);
  writeFileSync(stored, "corrupt retained bytes\n");
  await expect(defaultGoalGateDeps.diff(root, commit, baseline, home)).rejects.toThrow("missing or corrupt");
  unlinkSync(stored);
  await expect(defaultGoalGateDeps.diff(root, commit, baseline, home)).rejects.toThrow("missing or corrupt");
});
