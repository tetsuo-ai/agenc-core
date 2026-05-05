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
import { findItem, repoRoot, mainCheckoutRoot, worktreePath, markerDir, markerPath, setItemStatus, STATUS, fail } from "./checklist-utils.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

function usage() {
  process.stderr.write(`Usage: node scripts/goal/complete.mjs <item-id>\n`);
  process.exit(2);
}

const id = process.argv[2];
if (!id) usage();

const root = repoRoot();
const mainRoot = mainCheckoutRoot();
const isWorktree = root !== mainRoot;
const expectedWorktreePath = worktreePath(id);
const { item } = await findItem(id);

function collectInFlightJournals() {
  const dir = markerDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("IN-FLIGHT-") && f.endsWith(".json"))
    .map((file) => {
      const fullPath = path.join(dir, file);
      try {
        return { file, body: readFileSync(fullPath, "utf8") };
      } catch {
        return { file, body: "(could not read)" };
      }
    });
}

function failIfInFlightJournalsFound() {
  const inFlight = collectInFlightJournals();
  if (inFlight.length === 0) return;
  const journalContents = inFlight
    .map((entry) => `--- ${entry.file} ---\n${entry.body}`)
    .join("\n\n");
  fail(
    `Refusing to start: ${inFlight.length} in-flight journal(s) from previous complete.mjs run(s):\n\n${journalContents}\n\n` +
      `A previous complete.mjs was killed mid-flight (between merge and checklist-flip). Inspect the journal, ` +
      `decide whether the merge happened, then either complete the work manually (flip checklist + delete journal) ` +
      `or roll back (git reset to preMergeHead + delete journal).`,
  );
}

let mergeLockPath = null;
let mergeLockHeld = false;

function releaseMergeLock() {
  if (!mergeLockHeld || mergeLockPath === null) return;
  try {
    unlinkSync(mergeLockPath);
  } catch {
    // Best effort; a stale lock is intentionally fail-closed on the next run.
  }
  mergeLockHeld = false;
}

function acquireMergeLock() {
  const dir = markerDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  mergeLockPath = path.join(dir, "COMPLETE-MERGE.lock");
  const payload =
    JSON.stringify(
      {
        itemId: id,
        branch: `port/${id}`,
        pid: process.pid,
        worktree: isWorktree ? root : null,
        mainCheckout: mainRoot,
        acquiredAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n";
  try {
    writeFileSync(mergeLockPath, payload, {
      flag: "wx",
      mode: 0o600,
    });
    mergeLockHeld = true;
    process.once("exit", releaseMergeLock);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      let lockContents = "(could not read lock)";
      try {
        lockContents = readFileSync(mergeLockPath, "utf8");
      } catch {}
      fail(
        `Refusing to merge: completion merge lock already exists at ${mergeLockPath}.\n\n` +
          `${lockContents}\n` +
          `Another complete.mjs may be merging. If no such process is active, inspect any ` +
          `IN-FLIGHT-* journals before removing the stale lock.`,
      );
    }
    throw error;
  }
}

if (item.statusToken === STATUS.DONE) {
  fail(`Item ${id} is already marked done. Refusing to re-run.`);
}

// Atomicity recovery: refuse to start if any in-flight journal exists from
// a previously-killed complete.mjs run. The user must inspect the journal
// and either complete or roll back the half-finished work before any new
// item can be completed.
failIfInFlightJournalsFound();

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

header(`step 5 — local merge ${expected} → main (--no-ff)${isWorktree ? ` (from worktree)` : ""}`);
if (isWorktree) {
  process.stdout.write(`${DIM}worktree: ${root}${RESET}\n`);
  process.stdout.write(`${DIM}main:     ${mainRoot}${RESET}\n`);
}

// Atomicity: write an in-flight journal BEFORE the merge so that if the
// process is killed between merge and checklist-flip, recovery on next
// run can detect the half-completed state. The journal includes the
// expected end state so a re-run can complete it or surface manual fix.
//
// The journal lives in mainRoot/.goal-completed (not the worktree's local
// copy), so any future complete.mjs run from any worktree sees it.
const dir = markerDir();
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
acquireMergeLock();
failIfInFlightJournalsFound();
const mainStatusRes = spawnSync("git", ["-C", mainRoot, "status", "--porcelain"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (mainStatusRes.status !== 0) {
  abort("git status failed in main checkout");
}
if (mainStatusRes.stdout.trim()) {
  abort(
    `main checkout is dirty:\n${mainStatusRes.stdout}\nCommit or discard main checkout changes before completing.`,
  );
}
const journalPath = path.join(dir, `IN-FLIGHT-${id}.json`);
const preMergeHead = spawnSync("git", ["-C", mainRoot, "rev-parse", "HEAD"], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).stdout.trim();
writeFileSync(journalPath, JSON.stringify({
  itemId: id,
  title: item.title,
  phase: item.phase,
  branch: expected,
  worktree: isWorktree ? root : null,
  mainCheckout: mainRoot,
  startedAt: new Date().toISOString(),
  preMergeHead,
  expectedEndState: "checklist=[x] + branch deleted + worktree removed + marker written",
  recovery: "If this file exists at next complete.mjs invocation, the previous run was killed mid-flight. Either: (a) inspect git log to see if the merge happened; if yes, manually flip the checklist row to [x] and delete this file, or (b) git reset --hard <preMergeHead> in the main checkout, delete this file, and re-run complete.mjs.",
}, null, 2) + "\n", { flag: "wx", mode: 0o600 });

// Checkout main + merge — ALWAYS performed in the main checkout via `git -C`,
// regardless of whether complete.mjs was launched from the main checkout or
// from a per-item worktree. This keeps the merge target consistent across
// parallel sessions.
const checkoutMain = run("git", ["-C", mainRoot, "checkout", "main"]);
if (checkoutMain.status !== 0) {
  try { unlinkSync(journalPath); } catch {}
  abort("git checkout main failed (in main checkout)");
}

const mergeMsg = `Merge branch '${expected}'`;
const mergeRes = run("git", ["-C", mainRoot, "merge", "--no-ff", expected, "-m", mergeMsg]);
if (mergeRes.status !== 0) {
  try { unlinkSync(journalPath); } catch {}
  abort(`git merge --no-ff ${expected} failed (in main checkout)`);
}
ok("merged into main");

// ---- step 5b: remove worktree (if any) ---------------------------------
//
// Must happen BEFORE branch delete: `git branch -d` refuses to delete a
// branch that is currently checked out anywhere — including in this
// worktree. Once the worktree is gone, the branch can be deleted from
// the main checkout.
if (isWorktree && existsSync(expectedWorktreePath)) {
  // chdir to mainRoot first so we're not inside the directory we're about
  // to remove (script files are already loaded into Node memory; cwd is
  // the only thing that pins this worktree's tree).
  try { process.chdir(mainRoot); } catch (e) {
    process.stderr.write(`${BOLD}${RED}!${RESET} could not chdir to ${mainRoot} before worktree removal: ${e?.message || e}\n`);
  }
  const wtRemove = run("git", ["-C", mainRoot, "worktree", "remove", "--force", expectedWorktreePath]);
  if (wtRemove.status !== 0) {
    abort(
      `could not remove worktree ${expectedWorktreePath}; completion left ${journalPath} for recovery. ` +
        `Run \`git worktree remove --force ${expectedWorktreePath}\` manually, inspect the merge, then rerun or recover from the journal.`,
    );
  } else {
    ok(`worktree removed: ${expectedWorktreePath}`);
  }
}

// ---- step 6: delete feature branch -------------------------------------

const deleteRes = run("git", ["-C", mainRoot, "branch", "-d", expected]);
if (deleteRes.status !== 0) {
  abort(
    `could not delete branch ${expected}; completion left ${journalPath} for recovery. ` +
      `Delete or inspect the branch manually, then rerun or recover from the journal.`,
  );
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
  mergedHead: spawnSync("git", ["-C", mainRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout.trim(),
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
releaseMergeLock();

process.stdout.write(`\n${BOLD}${GREEN}✓ ${id} complete${RESET} — ${item.title}\n`);
process.stdout.write(`${DIM}You may now call update_goal complete.${RESET}\n`);
process.exit(0);
