#!/usr/bin/env node
// Final completion stamp for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/complete.mjs <item-id>
//
// Steps:
//   1. Run verify.mjs (no skip flags). Exit on failure.
//   2. Verify the working tree is clean (no uncommitted changes).
//   3. Verify the branch shape is port/<id>.
//   4. Run reviewer subagent (review.mjs). Exit on NEEDS_REVISION/BLOCKED.
//   5. Switch to main, merge port/<id> with --no-ff (local only).
//   6. Delete the feature branch.
//   7. Write .goal-completed/<id>.json marker (excluded from git).
//   8. Flip PORT_CHECKLIST.md row from [ ] / [~] to [x].
//   9. Print a one-line success summary.
//
// Strict invariants:
//   - Never push to any remote.
//   - Never fetch / pull / sync from origin/*.
//   - Never bypass git hooks (--no-verify is not used).
//
// The goal is "done" if and only if this script exits 0.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { findItem, repoRoot, markerDir, markerPath, setItemStatus, STATUS, fail } from "./checklist-utils.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function usage() {
  process.stderr.write(`Usage: node scripts/goal/complete.mjs <item-id>\n`);
  process.exit(2);
}

const id = process.argv[2];
if (!id) usage();

const root = repoRoot();
const { item } = await findItem(id);

if (item.statusToken === STATUS.DONE) {
  fail(`Item ${id} is already marked done. Refusing to re-run.`);
}

// Atomicity recovery: refuse to start if any in-flight journal exists from
// a previously-killed complete.mjs run. The user must inspect the journal
// and either complete or roll back the half-finished work before any new
// item can be completed.
{
  const dir = markerDir();
  if (existsSync(dir)) {
    const inFlight = readdirSync(dir).filter((f) => f.startsWith("IN-FLIGHT-") && f.endsWith(".json"));
    if (inFlight.length > 0) {
      const journalContents = inFlight.map((f) => {
        try { return `--- ${f} ---\n${readFileSync(path.join(dir, f), "utf8")}`; }
        catch { return `--- ${f} (could not read) ---`; }
      }).join("\n\n");
      fail(
        `Refusing to start: ${inFlight.length} in-flight journal(s) from previous complete.mjs run(s):\n\n${journalContents}\n\n` +
        `A previous complete.mjs was killed mid-flight (between merge and checklist-flip). Inspect the journal, ` +
        `decide whether the merge happened, then either complete the work manually (flip checklist + delete journal) ` +
        `or roll back (git reset to preMergeHead + delete journal).`,
      );
    }
  }
}

function header(name) {
  process.stdout.write(`\n${BOLD}━━ ${name}${RESET}\n`);
}

function ok(msg) {
  process.stdout.write(`${GREEN}✓${RESET} ${msg}\n`);
}

function abort(msg) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} ${msg}\n`);
  process.exit(1);
}

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, {
    cwd: opts.cwd ?? root,
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function git(...argv) {
  // Hard guard: forbid any remote-touching arg.
  for (const a of argv) {
    if (typeof a !== "string") continue;
    if (/^origin\//.test(a)) abort(`refusing git arg "${a}" — remote refs are forbidden`);
    if (a === "fetch" || a === "pull" || a === "push") {
      abort(`refusing git subcommand "${a}" — local-only operation`);
    }
    if (a === "--no-verify") abort(`refusing --no-verify`);
  }
  return spawnSync("git", argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

// ---- step 1: verify ----------------------------------------------------

header("step 1 — running all gates (verify.mjs)");
const verifyScript = path.join(root, "scripts/goal/verify.mjs");
const verifyRes = run("node", [verifyScript, id]);
if (verifyRes.status !== 0) {
  abort(`verify.mjs failed for ${id}; fix the gate failures and re-run.`);
}
ok("all gates passed");

// ---- step 2: working tree clean? ---------------------------------------

header("step 2 — working tree must be clean");
const statusRes = git("status", "--porcelain");
if (statusRes.status !== 0) abort("git status failed");
if (statusRes.stdout.trim()) {
  abort(
    `working tree is dirty:\n${statusRes.stdout}\nCommit or discard everything before completing.`,
  );
}
ok("working tree clean");

// ---- step 3: branch shape ----------------------------------------------

const branchRes = git("rev-parse", "--abbrev-ref", "HEAD");
const branch = branchRes.stdout.trim();
const expected = `port/${id}`;
if (branch !== expected) {
  abort(`current branch is "${branch}", expected "${expected}".`);
}
ok(`on ${expected}`);

// ---- step 4: senior-engineer reviewer subagent -------------------------

// branding-scan: allow names the reviewer CLI binary in the gate header
header("step 4 — reviewer subagent (codex exec review)");
const reviewScript = path.join(root, "scripts/goal/review.mjs");
const reviewRes = run("node", [reviewScript, id]);
if (reviewRes.status !== 0) {
  abort(
    `reviewer subagent rejected ${id}; address the issues above and re-run scripts/goal/complete.mjs ${id}.`,
  );
}
ok("reviewer APPROVED");

// ---- step 5: switch to main + merge ------------------------------------

header(`step 5 — local merge ${expected} → main (--no-ff)`);

// Atomicity: write an in-flight journal BEFORE the merge so that if the
// process is killed between merge and checklist-flip, recovery on next
// run can detect the half-completed state. The journal includes the
// expected end state so a re-run can complete it or surface manual fix.
const dir = markerDir();
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const journalPath = path.join(dir, `IN-FLIGHT-${id}.json`);
const preMergeHead = run("git", ["rev-parse", "HEAD"], { silent: true }).stdout.trim();
writeFileSync(journalPath, JSON.stringify({
  itemId: id,
  title: item.title,
  phase: item.phase,
  branch: expected,
  startedAt: new Date().toISOString(),
  preMergeHead,
  expectedEndState: "checklist=[x] + branch deleted + marker written",
  recovery: "If this file exists at next complete.mjs invocation, the previous run was killed mid-flight. Either: (a) inspect git log to see if the merge happened; if yes, manually flip the checklist row to [x] and delete this file, or (b) git reset --hard <preMergeHead>, delete this file, and re-run complete.mjs.",
}, null, 2) + "\n");

const checkoutMain = run("git", ["checkout", "main"]);
if (checkoutMain.status !== 0) {
  try { unlinkSync(journalPath); } catch {}
  abort("git checkout main failed");
}

const mergeMsg = `Merge branch '${expected}'`;
const mergeRes = run("git", ["merge", "--no-ff", expected, "-m", mergeMsg]);
if (mergeRes.status !== 0) {
  try { unlinkSync(journalPath); } catch {}
  abort(`git merge --no-ff ${expected} failed`);
}
ok("merged into main");

// ---- step 6: delete feature branch -------------------------------------

const deleteRes = run("git", ["branch", "-d", expected]);
if (deleteRes.status !== 0) {
  process.stderr.write(`${BOLD}${RED}!${RESET} could not delete branch ${expected}; check manually.\n`);
} else {
  ok(`feature branch ${expected} deleted`);
}

// ---- step 7: marker file -----------------------------------------------

header("step 7 — writing completion marker");
const markerData = {
  itemId: id,
  title: item.title,
  phase: item.phase,
  completedAt: new Date().toISOString(),
  mergedHead: run("git", ["rev-parse", "HEAD"], { silent: true }).stdout.trim(),
};
writeFileSync(markerPath(id), JSON.stringify(markerData, null, 2) + "\n");
ok(`marker written: .goal-completed/${id}.json`);

// ---- step 8: flip checklist status -------------------------------------

header("step 8 — flipping PORT_CHECKLIST.md row to [x]");
const flip = await setItemStatus(id, STATUS.DONE);
if (flip.changed) {
  ok(`PORT_CHECKLIST.md updated`);
  // The checklist is local-only (excluded from git); no commit needed.
} else {
  process.stderr.write(`${DIM}(no change to PORT_CHECKLIST.md row)${RESET}\n`);
}

// ---- step 9: clear in-flight journal -----------------------------------
//
// All steps succeeded. Remove the journal so a future complete.mjs run
// doesn't think this item is half-completed.
try {
  unlinkSync(journalPath);
} catch {
  // If the journal can't be removed, log it but don't abort — the work
  // is done; the journal is just for recovery.
  process.stderr.write(`${YELLOW}!${RESET} could not remove in-flight journal ${journalPath}; remove manually.\n`);
}

process.stdout.write(`\n${BOLD}${GREEN}✓ ${id} complete${RESET} — ${item.title}\n`);
process.stdout.write(`${DIM}You may now call update_goal complete.${RESET}\n`);
process.exit(0);
