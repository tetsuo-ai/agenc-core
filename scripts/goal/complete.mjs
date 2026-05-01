#!/usr/bin/env node
// Final completion stamp for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/complete.mjs <item-id>
//
// Steps:
//   1. Run verify.mjs (no skip flags). Exit on failure.
//   2. Verify the working tree is clean (no uncommitted changes).
//   3. Switch to main, merge port/<id> with --no-ff (local only).
//   4. Delete the feature branch.
//   5. Write .goal-completed/<id>.json marker (excluded from git).
//   6. Flip PORT_CHECKLIST.md row from [ ] / [~] to [x].
//   7. Print a one-line success summary.
//
// Strict invariants:
//   - Never push to any remote.
//   - Never fetch / pull / sync from origin/*.
//   - Never bypass git hooks (--no-verify is not used).
//
// The goal is "done" if and only if this script exits 0.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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

// ---- step 4: switch to main + merge ------------------------------------

header(`step 3 — local merge ${expected} → main (--no-ff)`);
const checkoutMain = run("git", ["checkout", "main"]);
if (checkoutMain.status !== 0) abort("git checkout main failed");

const dir = markerDir();
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(markerPath(id), JSON.stringify({
  itemId: id,
  title: item.title,
  phase: item.phase,
  pendingMerge: true,
  branch: expected,
  startedAt: new Date().toISOString(),
}, null, 2) + "\n");

const mergeMsg = `Merge branch '${expected}'`;
const mergeRes = run("git", ["merge", "--no-ff", expected, "-m", mergeMsg]);
if (mergeRes.status !== 0) {
  try {
    unlinkSync(markerPath(id));
  } catch {
    // Best effort cleanup; the merge failure above is the useful error.
  }
  abort(`git merge --no-ff ${expected} failed`);
}
ok("merged into main");

// ---- step 5: delete feature branch -------------------------------------

const deleteRes = run("git", ["branch", "-d", expected]);
if (deleteRes.status !== 0) {
  process.stderr.write(`${BOLD}${RED}!${RESET} could not delete branch ${expected}; check manually.\n`);
} else {
  ok(`feature branch ${expected} deleted`);
}

// ---- step 6: marker file -----------------------------------------------

header("step 4 — writing completion marker");
const markerData = {
  itemId: id,
  title: item.title,
  phase: item.phase,
  completedAt: new Date().toISOString(),
  mergedHead: run("git", ["rev-parse", "HEAD"], { silent: true }).stdout.trim(),
};
writeFileSync(markerPath(id), JSON.stringify(markerData, null, 2) + "\n");
ok(`marker written: .goal-completed/${id}.json`);

// ---- step 7: flip checklist status -------------------------------------

header("step 5 — flipping PORT_CHECKLIST.md row to [x]");
const flip = await setItemStatus(id, STATUS.DONE);
if (flip.changed) {
  ok(`PORT_CHECKLIST.md updated`);
  // The checklist is local-only (excluded from git); no commit needed.
} else {
  process.stderr.write(`${DIM}(no change to PORT_CHECKLIST.md row)${RESET}\n`);
}

process.stdout.write(`\n${BOLD}${GREEN}✓ ${id} complete${RESET} — ${item.title}\n`);
process.stdout.write(`${DIM}You may now call update_goal complete.${RESET}\n`);
process.exit(0);
